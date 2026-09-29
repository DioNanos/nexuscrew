'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { smartUp } = require('../lib/cli/commands.js');
const { start } = require('../lib/server.js');

const freePort = () => new Promise((resolve) => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const occupy = (port) => new Promise((resolve) => {
  const s = net.createServer((c) => c.on('error', () => {})); s.listen(port, '127.0.0.1', () => resolve(s));
});
const canBind = (port) => new Promise((resolve) => {
  const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});
function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncport-'));
  fs.mkdirSync(path.join(dir, '.nexuscrew'), { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const serverOpts = (dir, port, extra = {}) => ({
  home: dir, configDir: path.join(dir, '.nexuscrew'), configPath: path.join(dir, '.nexuscrew', 'config.json'),
  tokenPath: path.join(dir, '.nexuscrew', 'token'), nodesPath: path.join(dir, '.nexuscrew', 'nodes.json'),
  filesRoot: path.join(dir, 'files'), bind: '127.0.0.1', port, panelPort: 0, autoUpdate: false, fleetEnabled: false, log: () => {}, lang: 'en', ...extra,
});

// ---- P1: il ripiego della porta principale non si persiste piu' -------------------------------------------------

test('P1: porta principale occupata -> errore chiaro, nessuna porta nuova, config.json intatto', async (t) => {
  const dir = home(t); const port = await freePort(); const next = port + 1;
  const blocker = await occupy(port); t.after(() => blocker.close());
  const cfgPath = path.join(dir, '.nexuscrew', 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ port }));
  const errors = [];
  const made = start(serverOpts(dir, port, { onListenError: (e) => errors.push(e), ownPortWaitMs: 0 }));
  t.after(() => { try { made.close(); } catch (_) { /* non in ascolto */ } });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'EADDRINUSE');
  assert.match(errors[0].message, new RegExp(`${port}`));
  assert.match(errors[0].message, /--port/);
  assert.deepEqual(JSON.parse(fs.readFileSync(cfgPath, 'utf8')), { port }, 'config.json invariato');
  assert.equal(await canBind(next), true, 'nessun listener sulla porta successiva');
});

test('P1: il proprio processo orfano sulla porta -> si attende e si riprende la STESSA porta', async (t) => {
  const dir = home(t); const port = await freePort();
  const blocker = await occupy(port);
  let checks = 0;
  const errors = [];
  const made = start(serverOpts(dir, port, {
    onListenError: (e) => errors.push(e), ownPortWaitMs: 5000, ownPortRetryMs: 50,
    isOwnRuntimeImpl: () => { checks += 1; return true; },
  }));
  t.after(() => { try { made.close(); } catch (_) {} });
  setTimeout(() => blocker.close(), 300); // l'orfano muore
  await new Promise((resolve) => made.once('listening', resolve));
  assert.equal(made.address().port, port);
  assert.ok(checks >= 1);
  assert.deepEqual(errors, []);
  assert.equal(fs.existsSync(path.join(dir, '.nexuscrew', 'config.json')), false, 'nessuna scrittura di config');
});

test('P1: l\'attesa e\' limitata: se l\'orfano non muore, errore chiaro (non si sposta la porta)', async (t) => {
  const dir = home(t); const port = await freePort();
  const blocker = await occupy(port); t.after(() => blocker.close());
  const errors = [];
  const made = start(serverOpts(dir, port, { onListenError: (e) => errors.push(e), ownPortWaitMs: 300, ownPortRetryMs: 50, isOwnRuntimeImpl: () => true }));
  t.after(() => { try { made.close(); } catch (_) {} });
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(errors.length, 1); assert.equal(errors[0].code, 'EADDRINUSE');
  assert.equal(await canBind(port + 1), true);
});

test('P1: con peer pairati resta il rifiuto esplicito (codice dedicato)', async (t) => {
  const dir = home(t); const port = await freePort();
  const blocker = await occupy(port); t.after(() => blocker.close());
  fs.writeFileSync(path.join(dir, '.nexuscrew', 'nodes.json'), JSON.stringify({ schemaVersion: 1, nodes: [{ name: 'peer', paired: true, nodeId: 'a'.repeat(32) }] }));
  const errors = [];
  const made = start(serverOpts(dir, port, { onListenError: (e) => errors.push(e), ownPortWaitMs: 0 }));
  t.after(() => { try { made.close(); } catch (_) {} });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(errors.length, 1);
  assert.ok(['EADDRINUSE', 'EADDRINUSE_PAIRED'].includes(errors[0].code));
});

// ---- P2: pannello mai sulla porta principale, log una volta sola -------------------------------------------------

test('P2: panelPort uguale alla porta principale -> il pannello prende un\'altra porta', async (t) => {
  const dir = home(t); const port = await freePort();
  const logs = [];
  const made = start(serverOpts(dir, port, { panelPort: port, log: (m) => logs.push(String(m)) }));
  t.after(() => { try { made.close(); } catch (_) {} });
  await new Promise((resolve) => made.once('listening', resolve));
  await new Promise((r) => setTimeout(r, 300));
  const panel = made.panelServer && made.panelServer.address();
  assert.ok(panel && panel.port !== port, `panel ${panel && panel.port} vs main ${port}`);
});

test('P2: il ripiego del pannello si scrive nel log una sola volta per coppia richiesta/scelta', async (t) => {
  const dir = home(t); const port = await freePort(); const panelPort = await freePort();
  const blocker = await occupy(panelPort); t.after(() => blocker.close());
  const runs = [];
  for (let i = 0; i < 2; i += 1) {
    const logs = [];
    const p = await freePort();
    const made = start(serverOpts(dir, p, { panelPort, log: (m) => logs.push(String(m)) }));
    await new Promise((resolve) => made.once('listening', resolve));
    await new Promise((r) => setTimeout(r, 300));
    runs.push(logs.filter((l) => /panel port \d+ busy/.test(l)).length);
    made.close(); try { made.panelServer.close(); } catch (_) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.deepEqual(runs, [1, 0]);
});

// ---- P0: show non sposta la porta se il nodo non risponde entro 700 ms ---------------------------------------------

function smartOpts(dir, port, extra = {}) {
  const cfg = path.join(dir, '.nexuscrew', 'config.json');
  fs.writeFileSync(cfg, JSON.stringify({ port })); fs.writeFileSync(path.join(dir, '.nexuscrew', 'token'), 'tok-test\n', { mode: 0o600 });
  const calls = { init: 0 };
  return { calls, cfg, opts: {
    home: dir, configDir: path.join(dir, '.nexuscrew'), configPath: cfg, tokenPath: path.join(dir, '.nexuscrew', 'token'),
    platform: 'linux', tmuxOk: true, execImpl: () => '', ensureFleetDefaultsImpl: () => ({ created: false }),
    runInitImpl: () => { calls.init += 1; }, startImpl: () => ({ started: false }), startPortableImpl: () => ({ started: false }),
    openImpl: () => true, noOpen: true, waitAttempts: 2, waitDelayMs: 5, port, lang: 'en', ...extra,
  } };
}

test('P0: nodo lento (risponde dopo 1,2 s): show lo riconosce e non tocca porta ne\' config', async (t) => {
  const dir = home(t); const port = await freePort();
  const { calls, cfg, opts } = smartOpts(dir, port, {
    portAvailableImpl: async () => false,
    probeImpl: async () => false, // il probe rapido (700 ms) e' scaduto
    probeStatusImpl: async () => { await new Promise((r) => setTimeout(r, 50)); return 200; }, // il probe paziente riceve 200
  });
  const before = fs.readFileSync(cfg, 'utf8');
  const result = await smartUp(opts);
  assert.equal(result.running, true);
  assert.equal(result.port, port);
  assert.equal(calls.init, 0);
  assert.equal(fs.readFileSync(cfg, 'utf8'), before);
});

test('P0: porta occupata da un NexusCrew che risponde 401 -> errore chiaro, nessuno spostamento', async (t) => {
  const dir = home(t); const port = await freePort();
  const { calls, cfg, opts } = smartOpts(dir, port, { portAvailableImpl: async () => false, probeImpl: async () => false, probeStatusImpl: async () => 401 });
  const before = fs.readFileSync(cfg, 'utf8');
  await assert.rejects(smartUp(opts), (e) => /token/i.test(e.message) && new RegExp(String(port)).test(e.message));
  assert.equal(calls.init, 0); assert.equal(fs.readFileSync(cfg, 'utf8'), before);
});

test('P0: porta occupata da un altro processo (nessuna risposta) -> errore chiaro con --port, config intatto', async (t) => {
  const dir = home(t); const port = await freePort();
  const { calls, cfg, opts } = smartOpts(dir, port, { portAvailableImpl: async () => false, probeImpl: async () => false, probeStatusImpl: async () => null });
  const before = fs.readFileSync(cfg, 'utf8');
  await assert.rejects(smartUp(opts), (e) => /--port/.test(e.message) && /in use/i.test(e.message));
  assert.equal(calls.init, 0); assert.equal(fs.readFileSync(cfg, 'utf8'), before);
});
