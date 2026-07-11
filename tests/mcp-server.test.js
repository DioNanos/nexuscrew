'use strict';
// MCP bridge — server stdio (lib/mcp/server.js). MAI tmux reale: identita' via
// NEXUSCREW_MCP_SESSION o execFileImpl finto; la suite resta verde con TMUX
// rimosso dall'env (i test costruiscono SEMPRE il proprio env esplicito).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createMcpServer, resolveSession } = require('../lib/mcp/server.js');

function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'ncmcp-')); }

function writeToken(dir, value = 'tok-mcp') {
  const p = path.join(dir, 'token');
  fs.writeFileSync(p, `${value}\n`, { mode: 0o600 });
  return p;
}

// Output finto: al server serve solo .write — niente stream reali, niente tick.
function makeOut() {
  const lines = [];
  return { lines, write: (s) => { for (const l of String(s).split('\n')) if (l.trim()) lines.push(JSON.parse(l)); } };
}

// fetch finto: registra le chiamate e risponde canned.
function makeFetch(responder) {
  const calls = [];
  const impl = async (url, opts = {}) => {
    const call = { url: String(url), method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : undefined };
    calls.push(call);
    const r = responder(call);
    return { ok: r.status < 400, status: r.status, json: async () => r.json };
  };
  return { calls, impl };
}

function makeSrv({ env = {}, responder, execFileImpl, tokenPath } = {}) {
  const dir = tmpdir();
  const tp = tokenPath || writeToken(dir);
  const out = makeOut();
  const f = makeFetch(responder || (() => ({ status: 200, json: {} })));
  const srv = createMcpServer({
    output: out,
    env,
    config: { port: 4242, tokenPath: tp, tmuxBin: 'tmux' },
    fetchImpl: f.impl,
    execFileImpl: execFileImpl || (() => { throw new Error('tmux non deve essere chiamato'); }),
    errlog: () => {},
  });
  return { srv, out, calls: f.calls, dir };
}

const rpc = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });

test('initialize: echo protocolVersion, capabilities.tools, serverInfo', async () => {
  const { srv, out } = makeSrv();
  await srv.handleLine(rpc(1, 'initialize', { protocolVersion: '2026-01-01', capabilities: {} }));
  const r = out.lines[0];
  assert.equal(r.id, 1);
  assert.equal(r.result.protocolVersion, '2026-01-01');
  assert.deepEqual(r.result.capabilities, { tools: {} });
  assert.equal(r.result.serverInfo.name, 'nexuscrew');
  // notification: nessuna risposta
  await srv.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.equal(out.lines.length, 1);
});

test('tools/list: 5 tool nc_* con readOnlyHint sui read-only', async () => {
  const { srv, out } = makeSrv();
  await srv.handleLine(rpc(2, 'tools/list'));
  const tools = out.lines[0].result.tools;
  assert.deepEqual(tools.map((t) => t.name).sort(),
    ['nc_ask', 'nc_inbox', 'nc_notify', 'nc_send_file', 'nc_status']);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(byName.nc_status.annotations.readOnlyHint, true);
  assert.equal(byName.nc_inbox.annotations.readOnlyHint, true);
  assert.equal(byName.nc_notify.annotations, undefined);
  for (const t of tools) assert.equal(t.inputSchema.type, 'object');
});

test('nc_notify: POST /api/notify con Bearer + sessione da NEXUSCREW_MCP_SESSION', async () => {
  const { srv, out, calls } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cell-a' },
    responder: () => ({ status: 200, json: { delivered: { ui: 2, push: 1 } } }),
  });
  await srv.handleLine(rpc(3, 'tools/call', { name: 'nc_notify', arguments: { title: 'fatto', urgency: 'high' } }));
  const r = out.lines[0];
  assert.equal(r.result.isError, undefined);
  assert.deepEqual(JSON.parse(r.result.content[0].text), { delivered: { ui: 2, push: 1 } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:4242/api/notify');
  assert.equal(calls[0].headers.authorization, 'Bearer tok-mcp');
  assert.deepEqual(calls[0].body, { title: 'fatto', urgency: 'high', session: 'cell-a' });
});

test('identita cella: con $TMUX la sessione viene da display-message (execFile finto)', async () => {
  const execFileImpl = (bin, args, _opts, cb) => {
    assert.equal(bin, 'tmux');
    assert.deepEqual(args, ['display-message', '-p', '#S']);
    cb(null, 'work-build\n');
  };
  const { srv, calls } = makeSrv({
    env: { TMUX: '/tmp/fake-tmux,1,0' },
    execFileImpl,
    responder: () => ({ status: 200, json: { delivered: { ui: 0, push: 0 } } }),
  });
  await srv.handleLine(rpc(4, 'tools/call', { name: 'nc_notify', arguments: { title: 'x' } }));
  assert.equal(calls[0].body.session, 'work-build');
});

test('nc_ask senza sessione: errore chiaro, NESSUNA chiamata HTTP', async () => {
  const { srv, out, calls } = makeSrv({ env: {} }); // no TMUX, no NEXUSCREW_MCP_SESSION
  await srv.handleLine(rpc(5, 'tools/call', { name: 'nc_ask', arguments: { question: 'procedo?' } }));
  const r = out.lines[0];
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /NEXUSCREW_MCP_SESSION/);
  assert.equal(calls.length, 0);
});

test('nc_ask con sessione: ritorna subito askId + nota', async () => {
  const { srv, out } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cell-b' },
    responder: (c) => {
      assert.equal(c.url, 'http://127.0.0.1:4242/api/asks');
      assert.deepEqual(c.body, { question: 'procedo?', options: ['si', 'no'], session: 'cell-b' });
      return { status: 201, json: { id: 'abc123' } };
    },
  });
  await srv.handleLine(rpc(6, 'tools/call', { name: 'nc_ask', arguments: { question: 'procedo?', options: ['si', 'no'] } }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.equal(j.askId, 'abc123');
  assert.match(j.note, /incollat/);
});

test('nc_send_file: valida path sotto HOME e chiama /api/files/outbox', async () => {
  const home = tmpdir();
  fs.writeFileSync(path.join(home, 'report.txt'), 'dati');
  const { srv, out, calls } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cell-c', HOME: home },
    responder: () => ({ status: 200, json: { name: '20260711-1200_report.txt', box: 'outbox', size: 4 } }),
  });
  await srv.handleLine(rpc(7, 'tools/call', {
    name: 'nc_send_file', arguments: { path: path.join(home, 'report.txt'), caption: 'il report' },
  }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.deepEqual(j, { name: '20260711-1200_report.txt', box: 'outbox' });
  assert.deepEqual(calls[0].body, { session: 'cell-c', path: path.join(home, 'report.txt'), caption: 'il report' });

  // fuori HOME -> errore locale, nessuna chiamata
  await srv.handleLine(rpc(8, 'tools/call', { name: 'nc_send_file', arguments: { path: '/etc/hostname' } }));
  assert.equal(out.lines[1].result.isError, true);
  assert.equal(calls.length, 1);
});

test('nc_status: sessioni compatte + fleet null se non disponibile', async () => {
  const { srv, out } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cell-a' },
    responder: (c) => {
      if (c.url.endsWith('/api/sessions')) {
        return { status: 200, json: { sessions: [{ name: 'cloud-Sys', attached: true, outbox: {} }, { name: 'work', attached: false }] } };
      }
      return { status: 200, json: { available: false } };
    },
  });
  await srv.handleLine(rpc(9, 'tools/call', { name: 'nc_status', arguments: {} }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.deepEqual(j.sessions, [{ name: 'cloud-Sys', active: true }, { name: 'work', active: false }]);
  assert.equal(j.fleet, null);
});

test('garbage e protocollo: JSON rotto -> -32700, metodo ignoto -> -32601, tool ignoto -> -32602, MAI crash', async () => {
  const { srv, out } = makeSrv({ env: {} });
  await srv.handleLine('garbage{{{ non json');
  assert.equal(out.lines[0].error.code, -32700);
  assert.equal(out.lines[0].id, null);
  await srv.handleLine(JSON.stringify([1, 2, 3])); // batch/array: invalid request
  assert.equal(out.lines[1].error.code, -32600);
  await srv.handleLine(rpc(10, 'resources/list'));
  assert.equal(out.lines[2].error.code, -32601);
  await srv.handleLine(rpc(11, 'tools/call', { name: 'nc_boom', arguments: {} }));
  assert.equal(out.lines[3].error.code, -32602);
  // il server e' ancora vivo: ping risponde
  await srv.handleLine(rpc(12, 'ping'));
  assert.deepEqual(out.lines[4], { jsonrpc: '2.0', id: 12, result: {} });
});

// F6: il server accetta SOLO JSON-RPC 2.0 — versione assente/errata -> -32600.
test('jsonrpc version: assente o !== "2.0" -> -32600, notification valida resta no-op', async () => {
  const { srv, out } = makeSrv({ env: {} });
  // richiesta senza campo jsonrpc -> -32600 (prima rispondeva col result)
  await srv.handleLine(JSON.stringify({ id: 1, method: 'tools/list' }));
  assert.equal(out.lines[0].error.code, -32600);
  assert.equal(out.lines[0].id, 1);
  // versione sbagliata -> -32600
  await srv.handleLine(JSON.stringify({ jsonrpc: '1.0', id: 2, method: 'tools/list' }));
  assert.equal(out.lines[1].error.code, -32600);
  assert.equal(out.lines[1].id, 2);
  // notification NON 2.0 -> errore (il no-op vale solo per notification 2.0 valide)
  await srv.handleLine(JSON.stringify({ method: 'notifications/initialized' }));
  assert.equal(out.lines[2].error.code, -32600);
  assert.equal(out.lines[2].id, null);
  // notification 2.0 valida -> nessuna risposta; server ancora vivo
  await srv.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.equal(out.lines.length, 3);
  await srv.handleLine(rpc(3, 'ping'));
  assert.deepEqual(out.lines[3], { jsonrpc: '2.0', id: 3, result: {} });
});

test('token mancante: errore tool pulito (niente crash, niente segreti)', async () => {
  const dir = tmpdir();
  const { srv, out } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cell-a' },
    tokenPath: path.join(dir, 'assente'),
  });
  await srv.handleLine(rpc(13, 'tools/call', { name: 'nc_notify', arguments: { title: 'x' } }));
  const r = out.lines[0];
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /token/i);
});

// --- end-to-end: subcomando reale `nexuscrew mcp` via pipe stdio ---------------
test('subprocess: handshake + tools/call nc_notify contro server HTTP finto', async (t) => {
  const dir = tmpdir();
  const tokenPath = writeToken(dir, 'tok-e2e');

  // server HTTP finto locale (porta effimera) che registra la richiesta
  const seen = [];
  const fake = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: body ? JSON.parse(body) : null });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ delivered: { ui: 1, push: 0 } }));
    });
  });
  await new Promise((res) => fake.listen(0, '127.0.0.1', res));
  t.after(() => fake.close());

  const bin = path.join(__dirname, '..', 'bin', 'nexuscrew.js');
  // env ESPLICITO e minimale: niente TMUX, config file inesistente (isolato).
  const child = spawn(process.execPath, [bin, 'mcp'], {
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      NEXUSCREW_CONFIG_FILE: path.join(dir, 'config.json'),
      NEXUSCREW_PORT: String(fake.address().port),
      NEXUSCREW_TOKEN_FILE: tokenPath,
      NEXUSCREW_MCP_SESSION: 'cell-e2e',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { try { child.kill(); } catch (_) {} });

  const pending = new Map();
  const noId = [];
  let waitNoId = null;
  let buf = '';
  child.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.id !== null && msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg); pending.delete(msg.id);
      } else {
        noId.push(msg);
        if (waitNoId) { waitNoId(); waitNoId = null; }
      }
    }
  });
  const call = (id, method, params) => new Promise((resolve) => {
    pending.set(id, resolve);
    child.stdin.write(`${rpc(id, method, params)}\n`);
  });

  const init = await call(1, 'initialize', { protocolVersion: '2026-01-01' });
  assert.equal(init.result.protocolVersion, '2026-01-01');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const list = await call(2, 'tools/list');
  assert.equal(list.result.tools.length, 5);

  const notif = await call(3, 'tools/call', { name: 'nc_notify', arguments: { title: 'e2e ok' } });
  assert.deepEqual(JSON.parse(notif.result.content[0].text), { delivered: { ui: 1, push: 0 } });
  assert.equal(seen[0].url, '/api/notify');
  assert.equal(seen[0].auth, 'Bearer tok-e2e');
  assert.deepEqual(seen[0].body, { title: 'e2e ok', session: 'cell-e2e' });

  // garbage in mezzo allo stream: errore JSON-RPC, il processo NON muore
  const gp = new Promise((resolve) => { waitNoId = resolve; });
  child.stdin.write('!!!garbage!!!\n');
  await gp;
  assert.equal(noId[0].error.code, -32700);
  const pong = await call(4, 'ping');
  assert.deepEqual(pong.result, {});

  // chiusura pulita: stdin end -> exit 0
  const exit = new Promise((resolve) => child.on('exit', resolve));
  child.stdin.end();
  assert.equal(await exit, 0);
});

test('subprocess: EOF immediato non tronca una tools/call asincrona', async (t) => {
  const dir = tmpdir();
  const tokenPath = writeToken(dir, 'tok-eof');
  const fake = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      setTimeout(() => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ delivered: { ui: 1, push: 0 } }));
      }, 50);
    });
  });
  await new Promise((res) => fake.listen(0, '127.0.0.1', res));
  t.after(() => fake.close());

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'nexuscrew.js'), 'mcp'], {
    env: {
      PATH: process.env.PATH,
      HOME: dir,
      NEXUSCREW_CONFIG_FILE: path.join(dir, 'config.json'),
      NEXUSCREW_PORT: String(fake.address().port),
      NEXUSCREW_TOKEN_FILE: tokenPath,
      NEXUSCREW_MCP_SESSION: 'cell-eof',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => { try { child.kill(); } catch (_) {} });

  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stdin.end([
    rpc(1, 'initialize', { protocolVersion: '2026-01-01' }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    rpc(2, 'tools/call', { name: 'nc_notify', arguments: { title: 'EOF safe' } }),
    '',
  ].join('\n'));

  const exitCode = await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(exitCode, 0);
  const messages = stdout.trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(messages.find((m) => m.id === 1)?.result?.serverInfo?.name, 'nexuscrew');
  const toolReply = messages.find((m) => m.id === 2);
  assert.deepEqual(JSON.parse(toolReply.result.content[0].text), { delivered: { ui: 1, push: 0 } });
});
