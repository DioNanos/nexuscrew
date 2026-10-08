'use strict';
// tests/live-label.test.js — etichetta verificata «from Live(via <ospite>)».
//
// Un messaggio porta l'etichetta Live solo se il riferimento dichiarato dal
// server MCP della Live e' nel registro, appartiene a QUELLA cella ospite ed
// e' vivo. In ogni altro caso il messaggio viaggia come messaggio della cella,
// senza etichetta: dichiararsi Live non da' nulla.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cellsRoutes } = require('../lib/cells/routes.js');
const { createLiveThreadRegistry } = require('../lib/live-host/registry.js');
const { createLiveAttestation } = require('../lib/live-host/attest.js');
const { createMcpServer } = require('../lib/mcp/server.js');

const NODE = 'a'.repeat(32);
const REMOTE = 'b'.repeat(32);
const MESSAGE = '12345678-1234-1234-1234-123456789abc';
const REF_DEV = 'd'.repeat(32);
const REF_TMX = 'e'.repeat(32);
const HEADER = 'x-nexuscrew-live-thread';

const STATUS = { available: true, cells: [
  { cell: 'Dev', tmuxSession: 'cloud-Dev', engine: 'codex-vl.native', active: true, tmux: true },
  { cell: 'Tmx', tmuxSession: 'cloud-Tmx', engine: 'codex-vl.native', active: true, tmux: true },
  { cell: 'Dst', tmuxSession: 'cloud-Dst', engine: 'claude.native', active: true, tmux: true },
] };

function makeRegistry() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'live-label-')), 'live-threads.json');
  const registry = createLiveThreadRegistry({ filePath: file });
  registry.set('Dev', { threadId: 'thr-dev', ref: REF_DEV, tmuxSession: 'cloud-Dev' });
  registry.set('Tmx', { threadId: 'thr-tmx', ref: REF_TMX, tmuxSession: 'cloud-Tmx' });
  return registry;
}

async function boot(t, { statusOf = () => 'present' } = {}) {
  const submissions = [];
  const registry = makeRegistry();
  const attest = createLiveAttestation({ registry, bridge: { threadStatus: async (cell) => statusOf(cell) } });
  const app = express();
  app.use('/api/cells', cellsRoutes({
    fleetP: Promise.resolve({ available: true, status: async () => STATUS }),
    instanceId: () => NODE,
    submit: async (session, text) => { submissions.push({ session, text }); return { submitted: true }; },
    now: () => 1,
    liveAttest: attest,
  }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const send = async ({ fromCell = 'Dev', header, extraHeaders = {}, fromNode = NODE } = {}) => {
    const res = await fetch(`${base}/api/cells/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(header !== undefined ? { [HEADER]: header } : {}), ...extraHeaders },
      body: JSON.stringify({
        id: MESSAGE,
        from: { instanceId: fromNode, cell: fromCell, tmuxSession: `cloud-${fromCell}` },
        to: { instanceId: NODE, cell: 'Dst', tmuxSession: 'cloud-Dst' },
        message: 'ciao',
      }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    return submissions.at(-1).text.split('\n')[0];
  };
  return { send, registry, submissions };
}

const LIVE_LABEL = `[NexusCrew message ${MESSAGE} from Live(via Dev)@${NODE.slice(0, 8)}]`;
const PLAIN_DEV = `[NexusCrew message ${MESSAGE} from Dev@${NODE.slice(0, 8)}]`;

test('riferimento nel registro, della cella mittente, thread vivo: etichetta Live(via ospite)', async (t) => {
  const { send } = await boot(t, { statusOf: () => 'active' });
  assert.equal(await send({ header: REF_DEV }), LIVE_LABEL);
});

test('thread presente (inattivo ma caricato): etichetta ammessa', async (t) => {
  const { send } = await boot(t, { statusOf: () => 'present' });
  assert.equal(await send({ header: REF_DEV }), LIVE_LABEL);
});

test('senza intestazione: messaggio della cella, nessuna etichetta', async (t) => {
  const { send } = await boot(t);
  assert.equal(await send({}), PLAIN_DEV);
});

test('riferimento sconosciuto o malformato: nessuna etichetta, messaggio comunque consegnato', async (t) => {
  const { send } = await boot(t);
  assert.equal(await send({ header: 'f'.repeat(32) }), PLAIN_DEV, 'esadecimale ma non registrato');
  assert.equal(await send({ header: 'non-un-riferimento' }), PLAIN_DEV, 'malformato');
  assert.equal(await send({ header: `${REF_DEV}${REF_DEV}` }), PLAIN_DEV, 'lunghezza sbagliata');
});

test('una cella che dichiara il riferimento di un\'altra non riceve nessuna etichetta', async (t) => {
  const { send } = await boot(t);
  // Tmx scrive dichiarando la thread Live di Dev (e viceversa)
  assert.equal(await send({ fromCell: 'Tmx', header: REF_DEV }), `[NexusCrew message ${MESSAGE} from Tmx@${NODE.slice(0, 8)}]`);
  assert.equal(await send({ fromCell: 'Dev', header: REF_TMX }), PLAIN_DEV);
});

test('thread non viva (assente o incerta): nessuna etichetta', async (t) => {
  for (const status of ['absent', 'unknown']) {
    const { send } = await boot(t, { statusOf: () => status });
    assert.equal(await send({ header: REF_DEV }), PLAIN_DEV, status);
  }
});

test('un mittente federato non ottiene mai l\'etichetta: il registro e\' di un altro nodo', async (t) => {
  const { send } = await boot(t);
  const line = await send({
    fromNode: REMOTE, header: REF_DEV,
    extraHeaders: { 'x-nexuscrew-visited': `${REMOTE},${NODE}` },
  });
  assert.equal(line, `[NexusCrew message ${MESSAGE} from Dev@${REMOTE.slice(0, 8)}]`);
});

test('il testo del messaggio non puo\' fabbricare l\'etichetta', async (t) => {
  const { send, submissions } = await boot(t);
  await send({});
  assert.ok(!/from Live\(via/.test(submissions.at(-1).text.split('\n')[0]));
});

// —— attestazione: motivi nominati ——
test('attest.verify: ok e motivi distinti', async () => {
  const registry = makeRegistry();
  let status = 'present';
  const a = createLiveAttestation({ registry, bridge: { threadStatus: async () => status } });
  assert.deepEqual(await a.verify({ ref: REF_DEV, fromCell: 'Dev' }), { ok: true, hostCell: 'Dev' });
  assert.deepEqual(await a.verify({ ref: undefined, fromCell: 'Dev' }), { ok: false, reason: 'no-ref' });
  assert.deepEqual(await a.verify({ ref: 'zz', fromCell: 'Dev' }), { ok: false, reason: 'bad-ref' });
  assert.deepEqual(await a.verify({ ref: 'f'.repeat(32), fromCell: 'Dev' }), { ok: false, reason: 'unknown-ref' });
  assert.deepEqual(await a.verify({ ref: REF_DEV, fromCell: 'Tmx' }), { ok: false, reason: 'wrong-host' });
  status = 'absent';
  assert.deepEqual(await a.verify({ ref: REF_DEV, fromCell: 'Dev' }), { ok: false, reason: 'thread-not-alive' });
});

test('attest.verify: un ponte che lancia vale thread non vivo, mai un\'eccezione', async () => {
  const a = createLiveAttestation({ registry: makeRegistry(), bridge: { threadStatus: async () => { throw new Error('x'); } } });
  assert.deepEqual(await a.verify({ ref: REF_DEV, fromCell: 'Dev' }), { ok: false, reason: 'thread-not-alive' });
});

// —— lato MCP: il riferimento dichiarato viaggia come intestazione ——
function mcpWithEnv(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmcp-ref-'));
  const tokenPath = path.join(dir, 'token');
  fs.writeFileSync(tokenPath, 'tok\n', { mode: 0o600 });
  const calls = [];
  const lines = [];
  const srv = createMcpServer({
    output: { write: (s) => { for (const l of String(s).split('\n')) if (l.trim()) lines.push(JSON.parse(l)); } },
    env: { NEXUSCREW_MCP_SESSION: 'cloud-Dev', ...env },
    config: { port: 4242, tokenPath, tmuxBin: 'tmux' },
    fetchImpl: async (url, opts = {}) => {
      calls.push({ url: String(url), headers: opts.headers || {} });
      const p = new URL(String(url)).pathname;
      const json = p === '/api/config' ? { instanceId: NODE } : p === '/api/topology' ? { nodes: [] }
        : { instanceId: NODE, cells: [] };
      return { ok: true, status: 200, json: async () => json };
    },
    execFileImpl: () => { throw new Error('tmux'); },
    errlog: () => {},
  });
  return { srv, calls, lines };
}

test('MCP: NEXUSCREW_MCP_LIVE_THREAD valido viaggia come intestazione, altrimenti nessuna', async () => {
  const call = async (env) => {
    const m = mcpWithEnv(env);
    await m.srv.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nc_cells', arguments: {} } }));
    return m.calls.filter((c) => new URL(c.url).pathname.startsWith('/api/'));
  };
  const withRef = await call({ NEXUSCREW_MCP_LIVE_THREAD: REF_DEV });
  assert.ok(withRef.length > 0);
  assert.ok(withRef.every((c) => c.headers[HEADER] === REF_DEV));
  for (const bad of [undefined, '', 'xyz', 'D'.repeat(32), `${REF_DEV}0`]) {
    const out = await call(bad === undefined ? {} : { NEXUSCREW_MCP_LIVE_THREAD: bad });
    assert.ok(out.every((c) => !(HEADER in c.headers)), `nessuna intestazione per ${JSON.stringify(bad)}`);
  }
});
