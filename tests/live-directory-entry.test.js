'use strict';
// tests/live-directory-entry.test.js — la Live come voce propria della directory.
//
// `<instanceId>:Live`, kind 'live': visibile solo quando c'e' qualcosa di vivo
// (thread nativo presente/attivo, oppure modalita' tmux con ospite attivo),
// mai indirizzabile finche' non esiste una consegna dedicata, e MAI sostituita
// dalla cella ospite.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');
const { buildLiveEntry } = require('../lib/live-host/entry.js');
const { cellsRoutes, publicCells } = require('../lib/cells/routes.js');
const { createMcpServer } = require('../lib/mcp/server.js');

const NODE = 'a'.repeat(32);
const REMOTE = 'b'.repeat(32);
const MESSAGE = '12345678-1234-1234-1234-123456789abc';

const roster = (over = {}) => ({
  available: true,
  cells: [
    { cell: 'Dev', tmuxSession: 'cloud-Dev', engine: 'codex-vl.native', active: true, tmux: true, cwd: '/tmp' },
    { cell: 'Tmx', tmuxSession: 'cloud-Tmx', engine: 'claude.native', active: true, tmux: true, cwd: '/tmp' },
    { cell: 'Off', tmuxSession: 'cloud-Off', engine: 'codex-vl.native', active: false, tmux: false, cwd: '/tmp' },
    ...(over.extra || []),
  ],
});
const mk = ({ hostCell = null, ownerId = null, status = 'absent', cells = roster() } = {}) => ({
  store: { snapshot: () => ({ revision: 1, hostCell, ownerId }) },
  bridge: { threadStatus: async () => status },
  fleetP: Promise.resolve({ available: true, status: async () => cells }),
  instanceId: NODE,
  now: () => 99,
});

test('nativa con thread presente o attivo: voce Live visibile, non indirizzabile, senza legame con l\'ospite', async () => {
  for (const status of ['present', 'active']) {
    const e = await buildLiveEntry(mk({ hostCell: 'Dev', status }));
    assert.equal(e.id, `${NODE}:Live`);
    assert.equal(e.kind, 'live');
    assert.equal(e.cell, 'Live');
    assert.equal(e.instanceId, NODE);
    assert.equal(e.mode, 'native');
    assert.equal(e.state, status);
    assert.equal(e.active, true);
    assert.equal(e.canReceive, false);
    assert.equal(e.reason, 'live-not-addressable');
    assert.equal(e.lastSeen, 99);
    // niente che la leghi di piu' alla cella ospite: ne' sessione tmux, ne' nome
    assert.ok(!('tmuxSession' in e));
    assert.ok(!('hostCell' in e));
    assert.ok(!JSON.stringify(e).includes('Dev'));
  }
});

test('nativa senza thread vivo (absent/unknown): la Live NON compare', async () => {
  for (const status of ['absent', 'unknown']) {
    assert.equal(await buildLiveEntry(mk({ hostCell: 'Dev', status })), null, status);
  }
});

test('modalita\' tmux con ospite attivo: voce visibile con canReceive false e motivo tmux-mode', async () => {
  const e = await buildLiveEntry(mk({ hostCell: 'Tmx' }));
  assert.equal(e.kind, 'live');
  assert.equal(e.mode, 'tmux');
  assert.equal(e.state, 'tmux');
  assert.equal(e.canReceive, false);
  assert.equal(e.reason, 'tmux-mode');
  assert.ok(!('tmuxSession' in e));
});

test('assente: nessuna designazione, ospite spento, designazione remota, ospite fuori roster', async () => {
  assert.equal(await buildLiveEntry(mk({})), null, 'nessuna designazione');
  assert.equal(await buildLiveEntry(mk({ hostCell: 'Off', status: 'present' })), null, 'ospite spento');
  assert.equal(await buildLiveEntry(mk({ hostCell: 'Dev', ownerId: REMOTE, status: 'present' })), null, 'designazione remota');
  assert.equal(await buildLiveEntry(mk({ hostCell: 'Ghost', status: 'present' })), null, 'ospite non nel roster');
});

test('un errore del roster o del ponte vale «non visibile», mai un\'eccezione', async () => {
  const args = mk({ hostCell: 'Dev', status: 'present' });
  args.fleetP = Promise.reject(new Error('fleet giu'));
  assert.equal(await buildLiveEntry(args), null);
  const args2 = mk({ hostCell: 'Dev' });
  args2.bridge = { threadStatus: async () => { throw new Error('socket'); } };
  assert.equal(await buildLiveEntry(args2), null);
});

test('publicCells filtra il nome riservato Live in qualunque grafia', () => {
  const out = publicCells({ available: true, cells: [
    { cell: 'Dev', tmuxSession: 'cloud-Dev', engine: 'x', active: true },
    { cell: 'Live', tmuxSession: 'cloud-Live', engine: 'x', active: true },
    { cell: 'live', tmuxSession: 'cloud-live', engine: 'x', active: true },
    { cell: 'LIVE', tmuxSession: 'cloud-LIVE', engine: 'x', active: true },
    { cell: 'Liveness', tmuxSession: 'cloud-Liveness', engine: 'x', active: true },
  ] }, NODE, 1);
  assert.deepEqual(out.map((c) => c.cell), ['Dev', 'Liveness']);
});

async function bootCells(t, { liveEntry, submit } = {}) {
  const submissions = [];
  const app = express();
  app.use('/api/cells', cellsRoutes({
    fleetP: Promise.resolve({ available: true, status: async () => roster({ extra: [
      { cell: 'Live', tmuxSession: 'cloud-Live', engine: 'claude.native', active: true, tmux: true },
    ] }) }),
    instanceId: () => NODE,
    submit: submit || (async (session, text) => { submissions.push({ session, text }); return { submitted: true }; }),
    now: () => 1234,
    ...(liveEntry ? { liveEntry } : {}),
  }));
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  return { base: `http://127.0.0.1:${server.address().port}`, submissions };
}

test('GET /cells include la voce Live quando c\'e\', e non la inventa quando manca', async (t) => {
  const entry = { id: `${NODE}:Live`, instanceId: NODE, cell: 'Live', kind: 'live', mode: 'native', state: 'present', active: true, canReceive: false, reason: 'live-not-addressable', lastSeen: 1234 };
  const withLive = await bootCells(t, { liveEntry: async () => entry });
  const a = await (await fetch(`${withLive.base}/api/cells`)).json();
  assert.deepEqual(a.cells.filter((c) => c.kind === 'live'), [entry]);
  assert.ok(!a.cells.some((c) => c.cell === 'Live' && c.kind !== 'live'), 'nessuna cella chiamata Live accanto alla voce');
  const without = await bootCells(t, { liveEntry: async () => null });
  const b = await (await fetch(`${without.base}/api/cells`)).json();
  assert.ok(!b.cells.some((c) => c.cell === 'Live'));
  const failing = await bootCells(t, { liveEntry: async () => { throw new Error('boom'); } });
  const c = await fetch(`${failing.base}/api/cells`);
  assert.equal(c.status, 200, 'un errore della voce Live non rompe la directory');
});

test('POST /cells/send verso il nome Live: 409 live-not-addressable, nessuna consegna, nessun ripiego', async (t) => {
  const { base, submissions } = await bootCells(t);
  const res = await fetch(`${base}/api/cells/send`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      id: MESSAGE,
      from: { instanceId: NODE, cell: 'Dev', tmuxSession: 'cloud-Dev' },
      to: { instanceId: NODE, cell: 'Live', tmuxSession: 'cloud-Live' },
      message: 'ciao',
    }),
  });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /live-not-addressable/);
  assert.deepEqual(submissions, [], 'niente incollato in nessun TUI');
});

// —— MCP: directory e nc_send_cell ——
const rpc = (id, method, params) => JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
function makeSrv(responder) {
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'ncmcp-live-'));
  const tokenPath = require('node:path').join(dir, 'token');
  require('node:fs').writeFileSync(tokenPath, 'tok\n', { mode: 0o600 });
  const lines = [];
  const calls = [];
  const srv = createMcpServer({
    output: { write: (s) => { for (const l of String(s).split('\n')) if (l.trim()) lines.push(JSON.parse(l)); } },
    env: { NEXUSCREW_MCP_SESSION: 'cloud-Dev' },
    config: { port: 4242, tokenPath, tmuxBin: 'tmux' },
    fetchImpl: async (url, opts = {}) => {
      const call = { url: String(url), method: opts.method || 'GET', headers: opts.headers || {}, body: opts.body ? JSON.parse(opts.body) : undefined };
      calls.push(call);
      const r = responder(call);
      return { ok: r.status < 400, status: r.status, json: async () => r.json };
    },
    execFileImpl: () => { throw new Error('tmux non deve essere chiamato'); },
    idFactory: () => MESSAGE,
    errlog: () => {},
  });
  return { srv, lines, calls };
}
const liveRow = (instanceId, extra = {}) => ({
  id: `${instanceId}:Live`, instanceId, cell: 'Live', kind: 'live', mode: 'native', state: 'present',
  active: true, canReceive: false, reason: 'live-not-addressable', lastSeen: 5, ...extra,
});
const responderWith = (rows) => (call) => {
  const p = new URL(call.url).pathname;
  if (p === '/api/config') return { status: 200, json: { instanceId: NODE } };
  if (p === '/api/topology') return { status: 200, json: { nodes: [] } };
  if (p === '/api/cells') return { status: 200, json: { instanceId: NODE, cells: [
    { instanceId: NODE, cell: 'Dev', tmuxSession: 'cloud-Dev', engine: 'codex-vl.native', active: true, canReceive: true },
    ...rows,
  ] } };
  return { status: 404, json: { error: p } };
};

test('nc_cells mostra la voce Live con kind, e scarta una voce Live malformata', async () => {
  const { srv, lines } = makeSrv(responderWith([
    liveRow(NODE),
    { ...liveRow(NODE), id: `${NODE}:Fake`, cell: 'Fake' },                  // kind live con nome diverso
    { ...liveRow(NODE), mode: 'telepatia' },                                  // modalita' sconosciuta
    { instanceId: NODE, cell: 'NoSession', active: true, canReceive: true },  // cella senza sessione
  ]));
  await srv.handleLine(rpc(1, 'tools/call', { name: 'nc_cells', arguments: {} }));
  const out = JSON.parse(lines[0].result.content[0].text);
  const live = out.cells.filter((c) => c.kind === 'live');
  assert.equal(live.length, 1);
  assert.equal(live[0].id, `${NODE}:Live`);
  assert.equal(live[0].canReceive, false);
  assert.equal(live[0].self, false);
  assert.ok(!('tmuxSession' in live[0]));
  assert.ok(!out.cells.some((c) => c.cell === 'Fake' || c.cell === 'NoSession'));
});

test('nc_cells: una voce Live che si dichiara ricevibile resta non ricevibile', async () => {
  const { srv, lines } = makeSrv(responderWith([liveRow(NODE, { canReceive: true })]));
  await srv.handleLine(rpc(1, 'tools/call', { name: 'nc_cells', arguments: {} }));
  const out = JSON.parse(lines[0].result.content[0].text);
  assert.equal(out.cells.find((c) => c.kind === 'live').canReceive, false);
});

test('nc_send_cell verso :Live: errore live-not-addressable, nessun POST, nessun ripiego sull\'ospite', async () => {
  const { srv, lines, calls } = makeSrv(responderWith([liveRow(NODE)]));
  await srv.handleLine(rpc(2, 'tools/call', { name: 'nc_send_cell', arguments: { target: `${NODE}:Live`, message: 'ciao Live' } }));
  const res = lines[0].result;
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /live-not-addressable/);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0, 'nessuna consegna, nemmeno all\'ospite');
});

test('nc_send_cell verso :Live con la Live assente: errore di lookup, non un invio ad altra cella', async () => {
  const { srv, lines, calls } = makeSrv(responderWith([]));
  await srv.handleLine(rpc(3, 'tools/call', { name: 'nc_send_cell', arguments: { target: `${NODE}:Live`, message: 'ciao' } }));
  assert.equal(lines[0].result.isError, true);
  assert.equal(calls.filter((c) => c.method === 'POST').length, 0);
});
