'use strict';
// tests/live-host-bridge.test.js — ponte Live (fetta 3, contratto rev5).
//
// Il test costruisce il sistema REALE e le sue due dipendenze esterne finte:
//   - hub: server express VERO con le route live-host vere (designazione via
//     HTTP, come la legge il ponte) — nessuna fixture che costruisce la
//     designazione a mano;
//   - daemon: server WebSocket VERO su unix socket che parla il protocollo del
//     socket di controllo (initialize → initialized → thread/start) e registra
//     tutto ciò che riceve.
// Il ponte è quello di produzione (lib/live-host/bridge.js), montato come nel
// server reale: la GET va in loopback all'hub vero, il prompt è letto dal path
// vero (filesRoot/cloud-<Cella>/LIVE_PROMPT.md scritto su disco dal test).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const express = require('express');
const { WebSocketServer } = require('ws');
const { requireToken } = require('../lib/auth/middleware.js');
const { liveHostRoutes } = require('../lib/live-host/routes.js');
const { createLiveHostStore } = require('../lib/live-host/store.js');
const { createLiveBridge } = require('../lib/live-host/bridge.js');
const { baseDefaults, defaults } = require('../lib/config.js');

const TOKEN = 'bridge-token-123';
const H = () => ({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' });
const DIR = () => path.join(os.tmpdir(), `lh-bridge-${process.pid}-${Math.random().toString(36).slice(2)}`);

const mockFleet = (cells) => Promise.resolve({
  available: true,
  status: async () => ({ available: true, cells }),
});

// —— Daemon finto: WebSocket server su unix socket, protocollo V3 ——
// Registra ogni metodo ricevuto. Simula una cella VIVA E OCCUPATA: esiste una
// thread di TUI (existingThread) con un turno in corso — il requisito più
// vincolante del contratto è che il ponte crei conversazioni proprie ANCHE in
// questo stato, senza mai pilotare quella thread.
function makeFakeDaemon({ socketPath, threadId = 'bridge-thread-0001', failThreadStart = false, delayMs = 0 } = {}) {
  const seen = { connections: 0, methods: [], threadStarts: [] };
  const server = http.createServer((_req, res) => { res.writeHead(426); res.end(); });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => {
      seen.connections += 1;
      ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(String(data)); } catch (_) { return; }
        seen.methods.push(msg.method || `reply#${msg.id}`);
        if (msg.method === 'initialize') {
          ws.send(JSON.stringify({
            jsonrpc: '2.0', id: msg.id,
            result: { userAgent: 'fake-app-server/test', codexHome: '/tmp/fake-codex-home' },
          }));
        } else if (msg.method === 'initialized') {
          // notifica: il server non risponde
        } else if (msg.method === 'thread/start') {
          seen.threadStarts.push(msg.params || {});
          const respond = () => {
            const payload = failThreadStart
              ? { jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'thread/start rifiutato' } }
              : {
                jsonrpc: '2.0', id: msg.id,
                result: { thread: { id: threadId }, cwd: (msg.params || {}).cwd, model: 'fake', modelProvider: 'fake' },
              };
            ws.send(JSON.stringify(payload));
          };
          if (delayMs) setTimeout(respond, delayMs); else respond();
        } else if (msg.method) {
          // Metodo NON previsto dal ponte (turn/start, thread/resume, ...):
          // risponde errore. La SPIA seen.methods lo renderà visibile all'assert.
          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'metodo inatteso' } }));
        }
      });
    });
  });
  const listen = () => new Promise((resolve, reject) => {
    try { fs.rmSync(socketPath, { force: true }); } catch (_) { /* assente */ }
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  const close = () => new Promise((resolve) => {
    wss.clients.forEach((c) => { try { c.terminate(); } catch (_) { /* già chiuso */ } });
    server.close(() => { try { fs.rmSync(socketPath, { force: true }); } catch (_) { /* già rimosso */ } resolve(); });
  });
  return { seen, listen, close, existingThread: 'tui-thread-busy-9999' };
}

// —— Hub + ponte: UN server reale che monta le route live-host vere (col ponte
// dentro, come nel server di produzione) su porta effimera. Il ponte legge la
// designazione da questo stesso server via loopback: cfg.port è la porta reale.
// `slowHubMs > 0` inserisce PRIMA del router una GET / lenta (Express: la prima
// route che matcha vince) per provare il limite dichiarato senza toccare il ponte.
async function boot({
  cells = [],
  enabled = true,
  timeoutMs = 1500,
  daemonOpts = {},
  slowHubMs = 0,
} = {}) {
  const dir = DIR();
  const root = path.join(dir, 'NexusFiles');
  fs.mkdirSync(root, { recursive: true });
  const socketPath = path.join(dir, 'app-server-control.sock');
  const daemon = makeFakeDaemon({ socketPath, ...daemonOpts });
  await daemon.listen();

  const store = createLiveHostStore({ filePath: path.join(dir, 'live-host.json'), now: () => 42000 });
  const hubRequests = { gets: 0, lastAuth: null };
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const cfg = {
    port,
    liveBridgeEnabled: enabled,
    liveBridgeSocketPath: socketPath,
    liveBridgeTimeoutMs: timeoutMs,
    filesRoot: root,
  };
  const fleet = mockFleet(cells);
  const bridge = createLiveBridge({ cfg, fleetP: fleet, tokenGet: () => TOKEN, filesRoot: root });

  // readonly mutabile: il test designa a readonly OFF e poi accende il gate
  // solo per la chiamata al ponte (il readonly blocca anche la designate).
  let ro = false;
  const app = express();
  app.use('/api/live-host', (req, res, next) => {
    if (req.method === 'GET' && req.path === '/') { hubRequests.gets += 1; hubRequests.lastAuth = req.headers.authorization || null; }
    next();
  });
  if (slowHubMs > 0) {
    app.use('/api/live-host', (req, res, next) => {
      if (req.method === 'GET' && req.path === '/') {
        setTimeout(() => res.json({ hostCell: 'never', revision: 9, eligible: true, at: 0 }), slowHubMs);
        return;
      }
      next();
    });
  }
  app.use('/api/live-host', requireToken({ get: () => TOKEN }), liveHostRoutes({
    fleetP: fleet, store, readonly: () => ro, bridge,
  }));
  server.on('request', app);

  const base = `http://127.0.0.1:${port}`;
  const ctx = {
    base, dir, root, socketPath, daemon, store, hubRequests,
    setReadonly: (v) => { ro = v; },
    designate: async (cellId) => {
      const rev = (await (await fetch(`${base}/api/live-host`, { headers: H() })).json()).revision;
      return fetch(`${base}/api/live-host/designate`, {
        method: 'POST', headers: H(), body: JSON.stringify({ cellId, expectedRevision: rev }),
      });
    },
    bridgeCall: () => fetch(`${base}/api/live-host/bridge`, { method: 'POST', headers: H(), body: '{}' }),
    close: async () => {
      await new Promise((r) => server.close(r));
      await daemon.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return ctx;
}

const CELLS_NATIVE = (cwd) => ([
  { cell: 'cloud-DevAuditor', active: true, tmux: true, tmuxSession: 'cloud-DevAuditor', engine: 'codex-vl.native', cwd },
  { cell: 'cloud-Research', active: true, tmux: true, tmuxSession: 'cloud-Research', engine: 'claude.native', cwd },
  { cell: 'cloud-Off', active: false, tmux: false, tmuxSession: 'cloud-Off', engine: 'codex-vl.native', cwd },
]);

const j = (r) => r.json().catch(() => ({}));

test('ponte spento (MC0): nessuna GET, nessuna connessione, none/bridge-disabled', async () => {
  const ctx = await boot({ enabled: false, cells: CELLS_NATIVE('/tmp') });
  try {
    const r = await ctx.bridgeCall();
    assert.equal(r.status, 200);
    const b = await j(r);
    assert.equal(b.mode, 'none');
    assert.equal(b.reason, 'bridge-disabled');
    assert.equal(ctx.hubRequests.gets, 0, 'ponte spento non legge la designazione');
    assert.equal(ctx.daemon.seen.connections, 0, 'ponte spento non si connette mai');
  } finally { await ctx.close(); }
});

test('nessuna designazione: none/no-designation, daemon intatto', async () => {
  const ctx = await boot({ cells: CELLS_NATIVE('/tmp') });
  try {
    const b = await j(await ctx.bridgeCall());
    assert.equal(b.mode, 'none');
    assert.equal(b.reason, 'no-designation');
    assert.equal(ctx.hubRequests.gets, 1, 'una sola lettura per avvio (MC1.4)');
    assert.equal(ctx.hubRequests.lastAuth, `Bearer ${TOKEN}`, 'GET autenticata col token del nodo (MC1.2)');
    assert.equal(ctx.daemon.seen.connections, 0);
  } finally { await ctx.close(); }
});

test('designazione su cella non idonea: none/host-ineligible, distinto da no-designation', async () => {
  const ctx = await boot({ cells: CELLS_NATIVE('/tmp') });
  try {
    await ctx.designate('cloud-Off'); // nel roster, attiva NO -> eligible false
    const b = await j(await ctx.bridgeCall());
    assert.equal(b.mode, 'none');
    assert.equal(b.reason, 'host-ineligible');
    assert.equal(ctx.daemon.seen.connections, 0);
  } finally { await ctx.close(); }
});

test('cella senza cwd nello status: none/cell-cwd-unknown (dichiarato, non indovinato)', async () => {
  const cells = [{ cell: 'cloud-Bare', active: true, tmux: true, tmuxSession: 'cloud-Bare', engine: 'codex-vl.native' }];
  const ctx = await boot({ cells });
  try {
    await ctx.designate('cloud-Bare');
    const b = await j(await ctx.bridgeCall());
    assert.equal(b.mode, 'none');
    assert.equal(b.reason, 'cell-cwd-unknown');
    assert.equal(ctx.daemon.seen.connections, 0);
  } finally { await ctx.close(); }
});

test('engine non codex-vl: modalita\' tmux, nessuna thread ponte (JC2)', async () => {
  const cwd = path.join(os.tmpdir(), 'research-home');
  const ctx = await boot({ cells: CELLS_NATIVE(cwd) });
  try {
    await ctx.designate('cloud-Research');
    const b = await j(await ctx.bridgeCall());
    assert.equal(b.mode, 'tmux');
    assert.equal(b.cell, 'cloud-Research');
    assert.equal(b.engine, 'claude.native');
    assert.equal(b.cwd, cwd);
    assert.deepEqual(b.prompt, { applied: false, reason: 'tmux-mode' });
    assert.equal(ctx.daemon.seen.connections, 0, 'modalita\' tmux non tocca il socket di controllo');
  } finally { await ctx.close(); }
});

test('NATIVA con cella OCCUPATA: thread NUOVA del ponte, cwd e prompt per-cella arrivano davvero', async () => {
  const cwd = path.join(os.tmpdir(), 'cell-devauditor');
  fs.mkdirSync(cwd, { recursive: true });
  const ctx = await boot({ cells: CELLS_NATIVE(cwd) });
  try {
    // Prompt per-cella scritto nel path VERO da cui il ponte lo legge.
    const promptDir = path.join(ctx.root, 'cloud-DevAuditor');
    fs.mkdirSync(promptDir, { recursive: true });
    fs.writeFileSync(path.join(promptDir, 'LIVE_PROMPT.md'), 'Regole Live della cella DevAuditor: opera nel perimetro della cella.\n');

    await ctx.designate('cloud-DevAuditor');
    const b = await j(await ctx.bridgeCall());

    assert.equal(b.mode, 'native');
    assert.equal(b.cell, 'cloud-DevAuditor');
    // Thread PONTE, non quella della TUI occupata (MC3.1 + requisito a meta' lavoro).
    assert.equal(b.threadId, 'bridge-thread-0001');
    assert.notEqual(b.threadId, ctx.daemon.existingThread);
    assert.equal(b.cwd, cwd);

    // Il daemon ha ricevuto ESATTAMENTE il protocollo del ponte: mai turn/start,
    // mai thread/resume, mai fork (MC3 — la spia lo prova, non lo assume).
    assert.deepEqual(ctx.daemon.seen.methods, ['initialize', 'initialized', 'thread/start']);
    assert.equal(ctx.daemon.seen.connections, 1, 'connessione on-demand: una sola per risoluzione');

    // Il contesto è arrivato DAVVERO (non è un 200 che non dice nulla):
    // cwd = directory della cella, developerInstructions = testo del file letto.
    assert.equal(ctx.daemon.seen.threadStarts.length, 1);
    const params = ctx.daemon.seen.threadStarts[0];
    assert.equal(params.cwd, cwd);
    assert.equal(params.developerInstructions, 'Regole Live della cella DevAuditor: opera nel perimetro della cella.');

    // Prompt dichiarato applicato, e il testo NON viaggia in risposta (KC3-audit:
    // il contenuto del prompt resta lato nodo).
    assert.deepEqual(b.prompt, { applied: true, source: 'LIVE_PROMPT.md' });
  } finally { await ctx.close(); }
});

test('prompt per-cella ASSENTE (ENOENT): si procede senza, e senza developerInstructions (LC2.3)', async () => {
  const cwd = path.join(os.tmpdir(), 'cell-no-prompt');
  const ctx = await boot({ cells: CELLS_NATIVE(cwd) });
  try {
    await ctx.designate('cloud-DevAuditor');
    const b = await j(await ctx.bridgeCall());
    assert.equal(b.mode, 'native');
    assert.deepEqual(b.prompt, { applied: false, reason: 'missing' });
    assert.equal(ctx.daemon.seen.threadStarts.length, 1);
    assert.equal(ctx.daemon.seen.threadStarts[0].developerInstructions, undefined,
      'prompt mancante: l\'app-server applica il proprio gradino globale (MC2.4)');
  } finally { await ctx.close(); }
});

test('prompt ILEGGIBILE (c\'è ma non si può leggere): reason unreadable, DISTINTO da missing', async () => {
  const cwd = path.join(os.tmpdir(), 'cell-bad-prompt');
  const ctx = await boot({ cells: CELLS_NATIVE(cwd) });
  try {
    // LIVE_PROMPT.md come DIRECTORY: readFileSync fallisce con EISDIR — errore
    // NON-ENOENT affidabile indipendente dall'uid (chmod 000 non lo è su root).
    const promptDir = path.join(ctx.root, 'cloud-DevAuditor');
    fs.mkdirSync(path.join(promptDir, 'LIVE_PROMPT.md'), { recursive: true });
    await ctx.designate('cloud-DevAuditor');
    const b = await j(await ctx.bridgeCall());
    assert.equal(b.mode, 'native');
    assert.equal(b.prompt.applied, false);
    assert.equal(b.prompt.reason, 'unreadable');
    assert.equal(ctx.daemon.seen.threadStarts[0].developerInstructions, undefined);
  } finally { await ctx.close(); }
});

test('prompt VUOTO: reason empty (presente ma non dice nulla), nessuna iniezione', async () => {
  const cwd = path.join(os.tmpdir(), 'cell-empty-prompt');
  const ctx = await boot({ cells: CELLS_NATIVE(cwd) });
  try {
    const promptDir = path.join(ctx.root, 'cloud-DevAuditor');
    fs.mkdirSync(promptDir, { recursive: true });
    fs.writeFileSync(path.join(promptDir, 'LIVE_PROMPT.md'), '   \n');
    await ctx.designate('cloud-DevAuditor');
    const b = await j(await ctx.bridgeCall());
    assert.deepEqual(b.prompt, { applied: false, reason: 'empty' });
  } finally { await ctx.close(); }
});

test('socket di controllo irraggiungibile: none/bridge-socket-failed con cella e detail (MC1.5)', async () => {
  const cwd = path.join(os.tmpdir(), 'cell-no-daemon');
  const ctx = await boot({ cells: CELLS_NATIVE(cwd) });
  try {
    await ctx.designate('cloud-DevAuditor');
    await ctx.daemon.close(); // il daemon sparisce: la superficie upstream è rotta (MC0)
    const b = await j(await ctx.bridgeCall());
    assert.equal(b.mode, 'none');
    assert.equal(b.reason, 'bridge-socket-failed');
    assert.equal(b.cell, 'cloud-DevAuditor');
    assert.ok(typeof b.detail === 'string' && b.detail.length > 0, 'il fallimento è diagnosticabile');
  } finally { await ctx.close(); }
});

test('thread/start rifiutato dal daemon (error JSON-RPC): none/bridge-socket-failed', async () => {
  const ctx = await boot({ cells: CELLS_NATIVE('/tmp'), daemonOpts: { failThreadStart: true } });
  try {
    await ctx.designate('cloud-DevAuditor');
    const b = await j(await ctx.bridgeCall());
    assert.equal(b.mode, 'none');
    assert.equal(b.reason, 'bridge-socket-failed');
    assert.ok(/rifiutato/.test(String(b.detail)));
  } finally { await ctx.close(); }
});

test('socket LENTO oltre il limite: none/bridge-timeout senza allungare l\'attesa (MC1.5)', async () => {
  const cwd = path.join(os.tmpdir(), 'cell-slow-daemon');
  const ctx = await boot({ cells: CELLS_NATIVE(cwd), timeoutMs: 150, daemonOpts: { delayMs: 900 } });
  try {
    await ctx.designate('cloud-DevAuditor');
    const t0 = Date.now();
    const b = await j(await ctx.bridgeCall());
    const elapsed = Date.now() - t0;
    assert.equal(b.mode, 'none');
    assert.equal(b.reason, 'bridge-timeout');
    assert.ok(elapsed < 800, `la risoluzione non resta appesa (elapsed=${elapsed}ms)`);
  } finally { await ctx.close(); }
});

test('hub LENTO oltre il limite: none/live-host-timeout (la GET non aspetta)', async () => {
  const ctx = await boot({ cells: CELLS_NATIVE('/tmp'), timeoutMs: 150, slowHubMs: 900 });
  try {
    await ctx.designate('cloud-DevAuditor');
    const t0 = Date.now();
    const b = await j(await ctx.bridgeCall());
    const elapsed = Date.now() - t0;
    assert.equal(b.mode, 'none');
    assert.equal(b.reason, 'live-host-timeout');
    assert.ok(elapsed < 800, `la GET non allunga l'avvio (elapsed=${elapsed}ms)`);
  } finally { await ctx.close(); }
});

test('hub IRAGGIUNGIBILE (porta senza nessuno in ascolto): none/live-host-unreachable', async () => {
  // Il ponte con cfg.port verso una porta libera: la GET fallisce a monte.
  // Si chiama resolveForLive() direttamente perché in self-hosting hub e route
  // condividono il server — questo è l'unico modo di avere l'hub GIÙ.
  const dir = DIR();
  fs.mkdirSync(dir, { recursive: true });
  const socketPath = path.join(dir, 'ctrl.sock');
  const daemon = makeFakeDaemon({ socketPath });
  await daemon.listen();
  try {
    // porta libera: bind+close immediato
    const probe = net.createServer();
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const freePort = probe.address().port;
    await new Promise((r) => probe.close(r));
    const bridge = createLiveBridge({
      cfg: { port: freePort, liveBridgeEnabled: true, liveBridgeSocketPath: socketPath, liveBridgeTimeoutMs: 300 },
      fleetP: mockFleet(CELLS_NATIVE('/tmp')),
      tokenGet: () => TOKEN,
      filesRoot: dir,
    });
    const b = await bridge.resolveForLive();
    assert.equal(b.mode, 'none');
    assert.equal(b.reason, 'live-host-unreachable');
    assert.equal(daemon.seen.connections, 0);
  } finally {
    await daemon.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readonly: none/readonly, nessuna connessione (il ponte crea thread: è una mutazione)', async () => {
  const ctx = await boot({ cells: CELLS_NATIVE('/tmp') });
  try {
    await ctx.designate('cloud-DevAuditor'); // readonly ancora OFF
    ctx.setReadonly(true);
    const b = await j(await ctx.bridgeCall());
    assert.equal(b.mode, 'none');
    assert.equal(b.reason, 'readonly');
    assert.equal(ctx.daemon.seen.connections, 0);
  } finally { await ctx.close(); }
});

test('body con parametri: 400 — la risoluzione non è parametrizzabile (MC3.4)', async () => {
  const ctx = await boot({ cells: CELLS_NATIVE('/tmp') });
  try {
    const r = await fetch(`${ctx.base}/api/live-host/bridge`, {
      method: 'POST', headers: H(), body: JSON.stringify({ cell: 'cloud-Research' }),
    });
    assert.equal(r.status, 400);
    assert.equal(ctx.daemon.seen.connections, 0);
  } finally { await ctx.close(); }
});

test('senza token: 401 (il ponte sta dietro la stessa auth delle altre /api)', async () => {
  const ctx = await boot({ cells: CELLS_NATIVE('/tmp') });
  try {
    const r = await fetch(`${ctx.base}/api/live-host/bridge`, { method: 'POST', body: '{}' });
    assert.equal(r.status, 401);
  } finally { await ctx.close(); }
});

test('config: chiavi ponte nei default e negli env override (MC0 isolabile)', () => {
  const d = baseDefaults();
  assert.equal(d.liveBridgeEnabled, true);
  assert.ok(d.liveBridgeSocketPath.includes(path.join('.codex', 'app-server-control', 'app-server-control.sock')));
  assert.equal(d.liveBridgeTimeoutMs, 1500);
  const saved = {
    a: process.env.NEXUSCREW_LIVE_BRIDGE,
    b: process.env.NEXUSCREW_LIVE_BRIDGE_SOCKET,
    c: process.env.NEXUSCREW_LIVE_BRIDGE_TIMEOUT_MS,
  };
  try {
    process.env.NEXUSCREW_LIVE_BRIDGE = '0';
    process.env.NEXUSCREW_LIVE_BRIDGE_SOCKET = '/tmp/other.sock';
    process.env.NEXUSCREW_LIVE_BRIDGE_TIMEOUT_MS = '250';
    const e = defaults();
    assert.equal(e.liveBridgeEnabled, false);
    assert.equal(e.liveBridgeSocketPath, '/tmp/other.sock');
    assert.equal(e.liveBridgeTimeoutMs, 250);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
});
