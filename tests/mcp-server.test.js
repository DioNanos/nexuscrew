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
const { createMcpServer, resolveSession, resolveIdentity } = require('../lib/mcp/server.js');
const { TOOLS, commandForDiagnostics, failureForDiagnostics } = require('../lib/mcp/tools.js');

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

function makeSrv({ env = {}, responder, execFileImpl, tokenPath, idFactory } = {}) {
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
    ...(idFactory ? { idFactory } : {}),
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
  assert.match(r.result.instructions, /Discover the current client tools/);
  assert.match(r.result.instructions, /mcp-memory-rs/);
  assert.match(r.result.instructions, /mcp-vl-msa-rs/);
  assert.match(r.result.instructions, /mcp-crewd-rs/);
  assert.match(r.result.instructions, /mcp-email-rs/);
  assert.match(r.result.instructions, /does not install or configure companions automatically/);
  // notification: nessuna risposta
  await srv.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  assert.equal(out.lines.length, 1);
});

test('tools/list: 10 tool nc_* con readOnlyHint sui read-only', async () => {
  const { srv, out } = makeSrv();
  await srv.handleLine(rpc(2, 'tools/list'));
  const tools = out.lines[0].result.tools;
  assert.deepEqual(tools.map((t) => t.name).sort(),
    ['nc_ask', 'nc_cell_diagnostics', 'nc_cells', 'nc_deck', 'nc_identity', 'nc_inbox', 'nc_notify', 'nc_send_cell', 'nc_send_file', 'nc_status']);
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  assert.equal(byName.nc_status.annotations.readOnlyHint, true);
  assert.equal(byName.nc_deck.annotations.readOnlyHint, true);
  assert.equal(byName.nc_cells.annotations.readOnlyHint, true);
  assert.equal(byName.nc_cell_diagnostics.annotations.readOnlyHint, true);
  assert.equal(byName.nc_inbox.annotations.readOnlyHint, true);
  assert.equal(byName.nc_identity.annotations.readOnlyHint, true);
  assert.equal(byName.nc_notify.annotations, undefined);
  assert.equal(byName.nc_send_cell.annotations, undefined);
  for (const t of tools) assert.equal(t.inputSchema.type, 'object');
});

test('nc_cells: aggrega celle locali e remote con id owner-qualified', async () => {
  const localId = 'a'.repeat(32); const remoteId = 'b'.repeat(32);
  const { srv, out } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cloud-Dev' },
    responder: (call) => {
      const p = new URL(call.url).pathname;
      if (p === '/api/config') return { status: 200, json: { instanceId: localId } };
      if (p === '/api/topology') return { status: 200, json: { nodes: [{ instanceId: remoteId, route: ['pixel'], label: 'Pixel' }] } };
      if (p === '/api/cells') return { status: 200, json: { instanceId: localId, cells: [
        { instanceId: localId, cell: 'Dev', tmuxSession: 'cloud-Dev', engine: 'codex.native', active: true, canReceive: true, lastSeen: 1 },
      ] } };
      if (p === '/api/route/pixel/_/cells') return { status: 200, json: { instanceId: remoteId, cells: [
        { instanceId: remoteId, cell: 'Worker', tmuxSession: 'cloud-Worker', engine: 'claude.native', active: false, canReceive: false },
      ] } };
      return { status: 404, json: { error: p } };
    },
  });
  await srv.handleLine(rpc(20, 'tools/call', { name: 'nc_cells', arguments: {} }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.equal(j.nodeId, localId);
  assert.deepEqual(j.cells.map((cell) => [cell.id, cell.route, cell.self, cell.canReceive]), [
    [`${localId}:Dev`, 'local', true, true],
    [`${remoteId}:Worker`, 'pixel', false, false],
  ]);
  assert.deepEqual(j.unavailable, []);
});

test('revoked owner omitted from topology is absent from nc_cells and nc_deck, not unavailable', async () => {
  const localId = 'a'.repeat(32); const pixelId = 'b'.repeat(32);
  const { srv, out, calls } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cloud-Dev' },
    responder: (call) => {
      const p = new URL(call.url).pathname;
      if (p === '/api/config') return { status: 200, json: { instanceId: localId } };
      if (p === '/api/topology') return { status: 200, json: { instanceId: localId, nodes: [] } };
      if (p === '/api/cells') return { status: 200, json: { instanceId: localId, cells: [
        { instanceId: localId, cell: 'Dev', tmuxSession: 'cloud-Dev', active: true, canReceive: true },
      ] } };
      if (p === '/api/decks') return { status: 200, json: { decks: [{
        name: 'main', revision: 1, layout: { columns: [{ width: 100, tiles: [
          { session: 'cloud-Dev', height: 50, fontSize: 14 },
          { session: 'cloud-Worker', ownerId: pixelId, node: 'pixel', height: 50, fontSize: 14 },
        ] }] },
      }] } };
      if (p === '/api/fleet/status') return { status: 200, json: { available: true, cells: [
        { cell: 'Dev', tmuxSession: 'cloud-Dev' },
      ] } };
      return { status: 404, json: { error: p } };
    },
  });
  await srv.handleLine(rpc(201, 'tools/call', { name: 'nc_cells', arguments: {} }));
  const directory = JSON.parse(out.lines[0].result.content[0].text);
  assert.deepEqual(directory.cells.map((cell) => cell.id), [`${localId}:Dev`]);
  assert.deepEqual(directory.unavailable, []);

  await srv.handleLine(rpc(202, 'tools/call', { name: 'nc_deck', arguments: {} }));
  const deck = JSON.parse(out.lines[1].result.content[0].text);
  assert.equal(deck.decks.length, 1);
  assert.deepEqual(deck.decks[0].members, [
    { cell: 'Dev', tmuxSession: 'cloud-Dev', ownerId: localId, route: 'local', self: true },
  ]);
  assert.equal(calls.some((call) => /pixel/.test(new URL(call.url).pathname)), false,
    'authoritatively withdrawn owners are never probed through a stale route');
});

test('nc_cell_diagnostics: command locale + ultima causa bounded, senza interrogare la federazione', async () => {
  const localId = 'a'.repeat(32);
  const { srv, out, calls } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cloud-DevBis' },
    responder: (call) => {
      const u = new URL(call.url); const p = u.pathname;
      if (p === '/api/config') return { status: 200, json: { instanceId: localId } };
      if (p === '/api/cells') return { status: 200, json: { instanceId: localId, cells: [
        { instanceId: localId, cell: 'DevBis', tmuxSession: 'cloud-DevBis', engine: 'codex-vl.native', active: true, canReceive: true },
        { instanceId: localId, cell: 'agy.native', tmuxSession: 'cloud-agy.native', engine: 'shell.local', active: false, canReceive: false },
      ] } };
      if (p === '/api/fleet/definitions') return { status: 200, json: { cells: [
        { id: 'agy.native', tmuxSession: 'cloud-agy.native', engine: 'shell.local', commands: { 'shell.local': 'agy' } },
      ] } };
      if (p === '/api/diagnostics/logs') return { status: 200, json: { records: [{
        seq: 7, ts: '2026-07-22T11:00:00.000Z', component: 'fleet', code: 'FLEET_ACTION_FAILED',
        message: 'must not escape', meta: {
          cell: 'agy.native', status: 500, code: 'SHELL_COMMAND_FAILED', phase: 'readiness', command: 'secret',
        },
      }], cursor: 7 } };
      return { status: 404, json: { error: p } };
    },
  });
  await srv.handleLine(rpc(22, 'tools/call', {
    name: 'nc_cell_diagnostics', arguments: { target: `${localId}:agy.native` },
  }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.deepEqual(j, {
    target: `${localId}:agy.native`, cell: 'agy.native', tmuxSession: 'cloud-agy.native',
    engine: 'shell.local', active: false,
    command: { configured: true, value: 'agy', redacted: false, truncated: false },
    lastFailure: {
      event: 'FLEET_ACTION_FAILED', at: '2026-07-22T11:00:00.000Z', status: 500,
      code: 'SHELL_COMMAND_FAILED', phase: 'readiness',
    },
  });
  assert.equal(JSON.stringify(j).includes('must not escape'), false);
  assert.equal(JSON.stringify(j).includes('secret'), false);
  assert.ok(calls.some((call) => new URL(call.url).pathname === '/api/fleet/definitions'));
  assert.ok(calls.every((call) => !/\/api\/(?:topology|route\/)/.test(new URL(call.url).pathname)));
});

test('nc_cell_diagnostics: rifiuta target remoto senza leggere topologia, definitions o logs', async () => {
  const localId = 'a'.repeat(32); const remoteId = 'b'.repeat(32);
  const { srv, out, calls } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cloud-DevBis' },
    responder: (call) => {
      const p = new URL(call.url).pathname;
      if (p === '/api/config') return { status: 200, json: { instanceId: localId } };
      if (p === '/api/cells') return { status: 200, json: { instanceId: localId, cells: [
        { instanceId: localId, cell: 'DevBis', tmuxSession: 'cloud-DevBis', active: true, canReceive: true },
      ] } };
      return { status: 500, json: { error: `unexpected ${p}` } };
    },
  });
  await srv.handleLine(rpc(23, 'tools/call', {
    name: 'nc_cell_diagnostics', arguments: { target: `${remoteId}:Worker` },
  }));
  assert.equal(out.lines[0].result.isError, true);
  assert.match(out.lines[0].result.content[0].text, /target remoto rifiutato/);
  assert.equal(calls.some((call) => /topology|\/api\/route\/|fleet\/definitions|diagnostics\/logs/.test(call.url)), false);
});

test('nc_cell_diagnostics helpers: redigono credential command e coercizzano cause ignote', () => {
  const command = commandForDiagnostics('deploy --token TOPSECRET OPENAI_API_KEY=plain-secret ZAI_API_KEY=sk_test_123456789');
  assert.equal(command.configured, true);
  assert.equal(command.redacted, true);
  assert.equal(command.value.includes('TOPSECRET'), false);
  assert.equal(command.value.includes('plain-secret'), false);
  assert.equal(command.value.includes('sk_test_123456789'), false);
  const failure = failureForDiagnostics({
    ts: '2026-07-22T11:00:00Z', component: 'fleet', code: 'FLEET_ACTION_FAILED',
    meta: { cell: 'Ops', status: 999, code: 'UNBOUNDED', phase: 'raw-path', payload: 'secret' },
  }, 'Ops');
  assert.deepEqual(failure, {
    event: 'FLEET_ACTION_FAILED', at: '2026-07-22T11:00:00Z', status: null,
    code: 'UNKNOWN', phase: 'UNKNOWN',
  });
});

test('commandForDiagnostics redigono le env maiuscole generiche (ZAIKEY/PASSWD/MYPASS)', () => {
  const command = commandForDiagnostics('run ZAIKEY=abc123456789 PASSWD=hunter2hunter2 MYPASS=hunter2hunter2 deploy');
  assert.equal(command.configured, true);
  assert.equal(command.redacted, true);
  // nessun segreto in chiaro
  for (const secret of ['abc123456789', 'hunter2hunter2']) {
    assert.equal(command.value.includes(secret), false, `secret leaked: ${secret}`);
  }
  // il nome della variabile e' preservato, il valore redatto (forma $1=[redacted])
  for (const name of ['ZAIKEY', 'PASSWD', 'MYPASS']) {
    assert.ok(command.value.includes(`${name}=[redacted]`), `missing redaction for ${name}`);
  }
});

test('commandForDiagnostics redigono per intero i valori env quotati (con spazi)', () => {
  const command = commandForDiagnostics('run DB_URL="postgres://u:secret@host/db space" next');
  assert.equal(command.redacted, true);
  assert.equal(command.value.includes('postgres://u:secret@host/db space'), false);
  assert.equal(command.value.includes('secret'), false);
  assert.ok(command.value.includes('DB_URL=[redacted]'));
});

test('commandForDiagnostics: la regola generica env non fa regredire le redazioni specifiche', () => {
  const command = commandForDiagnostics(
    'deploy --token TOPSECRET OPENAI_API_KEY=plain-secret Bearer xyz123 sk-test_1234567890abc',
  );
  assert.equal(command.redacted, true);
  for (const secret of ['TOPSECRET', 'plain-secret', 'xyz123', 'sk-test_1234567890abc']) {
    assert.equal(command.value.includes(secret), false, `regression: ${secret} leaked`);
  }
  assert.ok(command.value.includes('OPENAI_API_KEY=[redacted]'));
});

test('commandForDiagnostics: over-redaction benigno (NODE_ENV), shape e ACL invariate', () => {
  // comandi del tutto benigni risultano redacted:true: prezzo accettato per la
  // regola generica, coerente con lib/diagnostics/store.js. Il nome resta leggibile.
  const benign = commandForDiagnostics('NODE_ENV=production npm start');
  assert.equal(benign.redacted, true);
  assert.equal(benign.value.includes('production'), false);
  assert.ok(benign.value.includes('NODE_ENV=[redacted]'));
  assert.ok(benign.value.includes('npm start'));
  // la shape di output e' invariata
  assert.deepEqual(Object.keys(commandForDiagnostics('TOKEN=xyz')).sort(),
    ['configured', 'redacted', 'truncated', 'value']);
  // la redazione non tocca il registry tool: nc_cell_diagnostics resta read-only
  // e identity-gated (nessuna estensione di ACL/local-only).
  const diag = TOOLS.find((tool) => tool.name === 'nc_cell_diagnostics');
  assert.ok(diag, 'nc_cell_diagnostics presente');
  assert.equal(diag.annotations.readOnlyHint, true);
  assert.equal(TOOLS.length, 10, 'registry tool invariato (10 tool)');
});

test('nc_send_cell: risolve sender e target dalla directory e restituisce receipt onesto', async () => {
  const localId = 'a'.repeat(32); const remoteId = 'b'.repeat(32);
  const messageId = '12345678-1234-1234-1234-123456789abc';
  const { srv, out, calls } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cloud-Dev' }, idFactory: () => messageId,
    responder: (call) => {
      const p = new URL(call.url).pathname;
      if (p === '/api/config') return { status: 200, json: { instanceId: localId } };
      if (p === '/api/topology') return { status: 200, json: { nodes: [{ instanceId: remoteId, route: ['pixel'], label: 'Pixel' }] } };
      if (p === '/api/cells') return { status: 200, json: { instanceId: localId, cells: [
        { instanceId: localId, cell: 'Dev', tmuxSession: 'cloud-Dev', active: true, canReceive: true },
      ] } };
      if (p === '/api/route/pixel/_/cells') return { status: 200, json: { instanceId: remoteId, cells: [
        { instanceId: remoteId, cell: 'Worker', tmuxSession: 'cloud-Worker', active: true, canReceive: true },
      ] } };
      if (p === '/api/route/pixel/_/cells/send') return { status: 200, json: {
        id: messageId, status: 'submitted', at: 42,
        to: { instanceId: remoteId, cell: 'Worker', tmuxSession: 'cloud-Worker' },
        note: 'transport only',
      } };
      return { status: 404, json: { error: p } };
    },
  });
  await srv.handleLine(rpc(21, 'tools/call', {
    name: 'nc_send_cell', arguments: { target: `${remoteId}:Worker`, message: 'fai il debug' },
  }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.deepEqual(j, {
    id: messageId, status: 'submitted', at: 42,
    to: { instanceId: remoteId, cell: 'Worker', tmuxSession: 'cloud-Worker' }, note: 'transport only',
  });
  const post = calls.find((call) => call.method === 'POST');
  assert.equal(new URL(post.url).pathname, '/api/route/pixel/_/cells/send');
  assert.deepEqual(post.body.from, { instanceId: localId, cell: 'Dev', tmuxSession: 'cloud-Dev' });
  assert.deepEqual(post.body.to, { instanceId: remoteId, cell: 'Worker', tmuxSession: 'cloud-Worker' });
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

// --- nc_identity: diagnostica read-only, nessuna API/token call (P0) ---------
test('nc_identity: missing (nessun TMUX/NEXUSCREW_MCP_SESSION), NESSUNA chiamata HTTP/token', async () => {
  const { srv, out, calls } = makeSrv({ env: {} });
  await srv.handleLine(rpc(31, 'tools/call', { name: 'nc_identity', arguments: {} }));
  const r = out.lines[0];
  assert.equal(r.result.isError, undefined); // non e' un errore tool
  const j = JSON.parse(r.result.content[0].text);
  assert.equal(j.identified, false);
  assert.equal(j.session, undefined); // session solo se validata
  assert.equal(j.source, 'missing');
  assert.equal(j.code, 'NEXUSCREW_MCP_IDENTITY_MISSING');
  assert.deepEqual(j.envPresence, { TMUX: false, TMUX_PANE: false, NEXUSCREW_MCP_SESSION: false });
  assert.deepEqual(j.requiredEnvVars, ['TMUX', 'TMUX_PANE', 'NEXUSCREW_MCP_SESSION']);
  assert.match(j.remediation, /--env-var/); // suggerimento senza valori
  assert.equal(calls.length, 0); // NESSUNA API HTTP
});

test('nc_identity: invalid (NEXUSCREW_MCP_SESSION presente ma non valida) -> code INVALID', async () => {
  const { srv, out, calls } = makeSrv({ env: { NEXUSCREW_MCP_SESSION: 'sessione non valida!' } });
  await srv.handleLine(rpc(32, 'tools/call', { name: 'nc_identity', arguments: {} }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.equal(j.identified, false);
  assert.equal(j.session, undefined);
  assert.equal(j.source, 'missing');
  assert.equal(j.code, 'NEXUSCREW_MCP_IDENTITY_INVALID');
  assert.deepEqual(j.envPresence, { TMUX: false, TMUX_PANE: false, NEXUSCREW_MCP_SESSION: true });
  assert.equal(calls.length, 0);
});

test('nc_identity: fallback valido (no TMUX, NEXUSCREW_MCP_SESSION valido) -> source NEXUSCREW_MCP_SESSION', async () => {
  const { srv, out, calls } = makeSrv({ env: { NEXUSCREW_MCP_SESSION: 'cloud-Dev' } });
  await srv.handleLine(rpc(33, 'tools/call', { name: 'nc_identity', arguments: {} }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.equal(j.identified, true);
  assert.equal(j.session, 'cloud-Dev');
  assert.equal(j.source, 'NEXUSCREW_MCP_SESSION');
  assert.equal(j.code, 'OK');
  assert.equal(calls.length, 0);
});

test('nc_identity: tmux valido (TMUX set, display-message ok) -> source tmux', async () => {
  const execFileImpl = (bin, args, _opts, cb) => {
    assert.deepEqual([bin, args], ['tmux', ['display-message', '-p', '#S']]);
    cb(null, 'work-build\n');
  };
  const { srv, out, calls } = makeSrv({
    env: { TMUX: '/tmp/fake-tmux,1,0', TMUX_PANE: '%5' },
    execFileImpl,
  });
  await srv.handleLine(rpc(34, 'tools/call', { name: 'nc_identity', arguments: {} }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.equal(j.identified, true);
  assert.equal(j.session, 'work-build');
  assert.equal(j.source, 'tmux');
  assert.equal(j.code, 'OK');
  assert.deepEqual(j.envPresence, { TMUX: true, TMUX_PANE: true, NEXUSCREW_MCP_SESSION: false });
  assert.equal(calls.length, 0);
});

test('nc_identity: tmux fallito + fallback valido -> source NEXUSCREW_MCP_SESSION (precedenza preservata)', async () => {
  const execFileImpl = (_bin, _args, _opts, cb) => cb(new Error('no server')); // tmux fallisce
  const { srv, out, calls } = makeSrv({
    env: { TMUX: '/tmp/fake-tmux,1,0', NEXUSCREW_MCP_SESSION: 'cloud-Dev' },
    execFileImpl,
  });
  await srv.handleLine(rpc(35, 'tools/call', { name: 'nc_identity', arguments: {} }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.equal(j.identified, true);
  assert.equal(j.session, 'cloud-Dev');
  assert.equal(j.source, 'NEXUSCREW_MCP_SESSION'); // caduto sul fallback
  assert.equal(j.code, 'OK');
  assert.equal(calls.length, 0);
});

test('nc_identity: risponde anche con token mancante (nessun readToken)', async () => {
  const dir = tmpdir();
  const { srv, out, calls } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cell-x' },
    tokenPath: path.join(dir, 'inesistente'),
  });
  await srv.handleLine(rpc(36, 'tools/call', { name: 'nc_identity', arguments: {} }));
  const r = out.lines[0];
  assert.equal(r.result.isError, undefined); // token mancante NON blocca nc_identity
  const j = JSON.parse(r.result.content[0].text);
  assert.equal(j.identified, true);
  assert.equal(j.session, 'cell-x');
  assert.equal(j.code, 'OK');
  assert.equal(calls.length, 0); // NESSUNA chiamata HTTP / nessun readToken
});

test('resolveIdentity: sorgente/code osservabili senza cambiare resolveSession', async () => {
  // missing
  const missing = await resolveIdentity({ env: {}, tmuxBin: 'tmux', execFileImpl: () => { throw new Error('nope'); } });
  assert.equal(missing.session, null);
  assert.equal(missing.source, 'missing');
  assert.equal(missing.code, 'NEXUSCREW_MCP_IDENTITY_MISSING');
  // invalid (fallback presente ma non valido)
  const invalid = await resolveIdentity({ env: { NEXUSCREW_MCP_SESSION: ' ' }, tmuxBin: 'tmux', execFileImpl: () => { throw new Error('nope'); } });
  // ' '.trim() = '' -> fallbackPresent false -> MISSING (stringa vuota dopo trim non e' un segnale)
  assert.equal(invalid.code, 'NEXUSCREW_MCP_IDENTITY_MISSING');
  const invalidReal = await resolveIdentity({ env: { NEXUSCREW_MCP_SESSION: 'bad/session' }, tmuxBin: 'tmux', execFileImpl: () => { throw new Error('nope'); } });
  assert.equal(invalidReal.session, null);
  assert.equal(invalidReal.source, 'missing');
  assert.equal(invalidReal.code, 'NEXUSCREW_MCP_IDENTITY_INVALID');
  // fallback valido
  const fb = await resolveIdentity({ env: { NEXUSCREW_MCP_SESSION: 'cloud-Dev' }, tmuxBin: 'tmux', execFileImpl: () => { throw new Error('nope'); } });
  assert.equal(fb.session, 'cloud-Dev');
  assert.equal(fb.source, 'NEXUSCREW_MCP_SESSION');
  assert.equal(fb.code, 'OK');
  // resolveSession wrapper resta Promise<string|null>
  assert.equal(await resolveSession({ env: { NEXUSCREW_MCP_SESSION: 'cloud-Dev' }, tmuxBin: 'tmux', execFileImpl: () => {} }), 'cloud-Dev');
  assert.equal(await resolveSession({ env: {}, tmuxBin: 'tmux', execFileImpl: () => {} }), null);
});

test('nc_ask senza sessione: errore chiaro, NESSUNA chiamata HTTP', async () => {
  const { srv, out, calls } = makeSrv({ env: {} }); // no TMUX, no NEXUSCREW_MCP_SESSION
  await srv.handleLine(rpc(5, 'tools/call', { name: 'nc_ask', arguments: { question: 'procedo?' } }));
  const r = out.lines[0];
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /NEXUSCREW_MCP_SESSION/);
  // P0: codice stabile di identita nel messaggio umano, isError preservato.
  assert.match(r.result.content[0].text, /NEXUSCREW_MCP_IDENTITY_MISSING/);
  assert.equal(calls.length, 0);
});

test('nc_ask con identita presente ma invalida usa il codice INVALID e non chiama HTTP', async () => {
  const { srv, out, calls } = makeSrv({ env: { NEXUSCREW_MCP_SESSION: 'bad/session' } });
  await srv.handleLine(rpc(51, 'tools/call', { name: 'nc_ask', arguments: { question: 'procedo?' } }));
  const r = out.lines[0];
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /NEXUSCREW_MCP_IDENTITY_INVALID/);
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

test('nc_deck: trova i deck propri e risolve celle locali/remote in ordine visuale', async () => {
  const localId = 'a'.repeat(32); const relayId = 'b'.repeat(32);
  const layout = (columns) => ({ columns });
  const tile = (session, node, ownerId) => ({ session, ...(node ? { node } : {}), ...(ownerId ? { ownerId } : {}), height: 50, fontSize: 14 });
  const { srv, out, calls } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cloud-Dev' },
    responder: (c) => {
      const pathname = new URL(c.url).pathname;
      if (pathname === '/api/config') return { status: 200, json: { instanceId: localId } };
      if (pathname === '/api/topology') return { status: 200, json: { instanceId: localId, nodes: [{ instanceId: relayId, name: 'relay', route: ['relay'] }] } };
      if (pathname === '/api/route/relay/_/decks') return { status: 200, json: { schemaVersion: 1, decks: [] } };
      if (pathname === '/api/route/relay/_/topology') return { status: 200, json: { instanceId: relayId, nodes: [] } };
      if (pathname === '/api/decks') {
        return {
          status: 200,
          json: {
            schemaVersion: 1,
            decks: [
              {
                name: 'main', revision: 2,
                layout: layout([
                  { width: 50, tiles: [tile('cloud-Dev'), tile('shell')] },
                  { width: 50, tiles: [tile('cloud-Auditor', 'relay', relayId)] },
                ]),
              },
              {
                name: 'research', revision: 1,
                layout: layout([{ width: 100, tiles: [tile('cloud-Dev')] }]),
              },
              {
                name: 'remote-only', revision: 0,
                layout: layout([{ width: 100, tiles: [tile('cloud-Dev', 'relay')] }]),
              },
            ],
          },
        };
      }
      if (pathname === '/api/fleet/status') {
        return { status: 200, json: { available: true, cells: [{ cell: 'Dev', tmuxSession: 'cloud-Dev' }] } };
      }
      if (pathname === '/api/route/relay/_/fleet/status') {
        return { status: 200, json: { available: true, cells: [{ cell: 'Auditor', tmuxSession: 'cloud-Auditor' }] } };
      }
      return { status: 404, json: { error: 'unexpected' } };
    },
  });

  await srv.handleLine(rpc(14, 'tools/call', { name: 'nc_deck', arguments: {} }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.deepEqual(j, {
    tmuxSession: 'cloud-Dev', nodeId: localId,
    decks: [
      {
        id: `${localId}:main`, name: 'main',
        owner: { instanceId: localId, route: 'local', label: 'Local' },
        members: [
          { cell: 'Dev', tmuxSession: 'cloud-Dev', ownerId: localId, route: 'local', self: true },
          { cell: 'Auditor', tmuxSession: 'cloud-Auditor', ownerId: relayId, route: 'relay', self: false },
          { cell: null, tmuxSession: 'shell', ownerId: localId, route: 'local', self: false },
        ],
      },
      {
        id: `${localId}:research`, name: 'research',
        owner: { instanceId: localId, route: 'local', label: 'Local' },
        members: [{ cell: 'Dev', tmuxSession: 'cloud-Dev', ownerId: localId, route: 'local', self: true }],
      },
    ],
  });
  assert.deepEqual(new Set(calls.map((call) => new URL(call.url).pathname)), new Set([
    '/api/config', '/api/topology', '/api/decks',
    '/api/route/relay/_/decks', '/api/route/relay/_/topology',
    '/api/fleet/status', '/api/route/relay/_/fleet/status',
  ]));
});

test('nc_deck: scopre un deck posseduto da un nodo condiviso che contiene la cella locale', async () => {
  const localId = 'a'.repeat(32); const relayId = 'b'.repeat(32);
  const { srv, out } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cloud-Dev' },
    responder: (c) => {
      const pathname = new URL(c.url).pathname;
      if (pathname === '/api/config') return { status: 200, json: { instanceId: localId } };
      if (pathname === '/api/topology') return { status: 200, json: { nodes: [{ instanceId: relayId, name: 'relay', route: ['relay'], label: 'Relay' }] } };
      if (pathname === '/api/decks') return { status: 200, json: { decks: [{ name: 'main', revision: 0, layout: { columns: [] } }] } };
      if (pathname === '/api/route/relay/_/topology') return { status: 200, json: { nodes: [] } };
      if (pathname === '/api/route/relay/_/decks') return { status: 200, json: { decks: [{
        name: 'shared', revision: 1, layout: { columns: [{ width: 1, tiles: [
          { session: 'cloud-Dev', ownerId: localId, height: 1, fontSize: 11 },
          { session: 'cloud-Research', ownerId: relayId, height: 1, fontSize: 11 },
        ] }] },
      }] } };
      if (pathname === '/api/fleet/status') return { status: 200, json: { available: true, cells: [{ cell: 'Dev', tmuxSession: 'cloud-Dev' }] } };
      if (pathname === '/api/route/relay/_/fleet/status') return { status: 200, json: { available: true, cells: [{ cell: 'Research', tmuxSession: 'cloud-Research' }] } };
      return { status: 404, json: { error: pathname } };
    },
  });
  await srv.handleLine(rpc(17, 'tools/call', { name: 'nc_deck', arguments: {} }));
  const j = JSON.parse(out.lines[0].result.content[0].text);
  assert.equal(j.decks.length, 1);
  assert.deepEqual(j.decks[0], {
    id: `${relayId}:shared`, name: 'shared',
    owner: { instanceId: relayId, route: 'relay', label: 'Relay' },
    members: [
      { cell: 'Dev', tmuxSession: 'cloud-Dev', ownerId: localId, route: 'local', self: true },
      { cell: 'Research', tmuxSession: 'cloud-Research', ownerId: relayId, route: 'relay', self: false },
    ],
  });
});

test('nc_deck: senza identita tmux fallisce prima di leggere le API', async () => {
  const { srv, out, calls } = makeSrv({ env: {} });
  await srv.handleLine(rpc(15, 'tools/call', { name: 'nc_deck', arguments: {} }));
  assert.equal(out.lines[0].result.isError, true);
  assert.match(out.lines[0].result.content[0].text, /NEXUSCREW_MCP_SESSION/);
  // P0: codice stabile di identita nel messaggio umano, isError preservato.
  assert.match(out.lines[0].result.content[0].text, /NEXUSCREW_MCP_IDENTITY_MISSING/);
  assert.equal(calls.length, 0);
});

test('nc_deck: sessione fuori dai deck ritorna vuoto senza interrogare Fleet', async () => {
  const localId = 'a'.repeat(32);
  const { srv, out, calls } = makeSrv({
    env: { NEXUSCREW_MCP_SESSION: 'cloud-Other' },
    responder: (c) => {
      const pathname = new URL(c.url).pathname;
      if (pathname === '/api/config') return { status: 200, json: { instanceId: localId } };
      if (pathname === '/api/topology') return { status: 200, json: { nodes: [] } };
      assert.equal(pathname, '/api/decks');
      return {
        status: 200,
        json: {
          schemaVersion: 1,
          decks: [{
            name: 'main', revision: 0,
            layout: { columns: [{ width: 100, tiles: [{ session: 'cloud-Dev', height: 100, fontSize: 14 }] }] },
          }],
        },
      };
    },
  });
  await srv.handleLine(rpc(16, 'tools/call', { name: 'nc_deck', arguments: {} }));
  assert.deepEqual(JSON.parse(out.lines[0].result.content[0].text), {
    tmuxSession: 'cloud-Other', nodeId: localId, decks: [],
  });
  assert.equal(calls.length, 3);
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
  assert.equal(list.result.tools.length, 10);

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
