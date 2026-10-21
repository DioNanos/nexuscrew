'use strict';
// Sessione nuova esplicita + serializzazione/pausa dei lanci (contratto vl).
//
// Tre soggetti, un solo file perche' il contratto e' UNO: la richiesta
// esplicita (marcatore persistente), il ciclo di lancio che la consuma UNA
// volta (rename atomico prima dello spawn, --new alla sola generazione 0) e la
// serializzazione con pausa minima che impedisce a doppio click/retry di
// trasformarsi in una rotazione ripetuta o in una raffica di lanci.
// Il clock e' iniettato (cfg.now): nessun test dorme.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { atomicWrite, loadDefinitions } = require('../lib/fleet/definitions.js');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');
const { main, validPayload } = require('../lib/fleet/cell-exec.js');
const {
  requestVlNewSession, consumeVlNewSession, vlNewSessionStatus, vlLegacyInventory,
} = require('../lib/fleet/vl-session.js');
const { fleetRoutes } = require('../lib/fleet/routes.js');
const express = require('express');

const SESSIONE = 'cloud-CellaProva';

// --- mondo: fleet builtin con tmux finto a stato vero e vl finto ------------
// Il fake vl risponde a `--version` (il probe REALE: niente seam iniettato) e
// esce subito con qualsiasi altro argv (TUI finta che non parte mai davvero:
// in questi test il child non arriva allo spawn, il flusso si ferma al broker).
function mondo(t, { version = 'vl 0.3.1', cooldownMs, clockStart = 0, broker } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-vlses-'));
  const home = path.join(root, 'home');
  const cwd = path.join(home, 'CellaProva');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const vlBin = path.join(home, '.local', 'bin', 'vl');
  fs.writeFileSync(vlBin, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf '${version}\\n'; fi\nexit 0\n`, { mode: 0o755 });
  fs.chmodSync(vlBin, 0o755);
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    mcpServers: { nexuscrew: { command: 'nexuscrew' } },
  }), { mode: 0o600 });
  fs.mkdirSync(path.join(home, 'NexusFiles'), { recursive: true });
  // Il catalogo dell'operatore: la sorgente di un engine native senza
  // vlConfigFile dichiarato. Senza di esso il lancio nativo e' un rifiuto
  // dichiarato, non un avvio sui default del runtime.
  const catalogoVl = path.join(home, '.config', 'vl');
  fs.mkdirSync(catalogoVl, { recursive: true });
  fs.writeFileSync(path.join(catalogoVl, 'config.toml'), '[profiles.work]\nmodel = "m-work"\n');

  const statoPath = path.join(root, 'sessions.txt');
  fs.writeFileSync(statoPath, '');
  const tmuxBin = path.join(root, 'fake-tmux.cjs');
  const script = `#!${process.execPath}
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2);
const STATO = ${JSON.stringify(statoPath)};
const cmd = args[0] || '';
const vive = () => fs.readFileSync(STATO, 'utf8').split('\\n').filter(Boolean);
if (cmd === 'list-sessions') { for (const n of vive()) process.stdout.write(n + '\\t1\\n'); process.exit(0); }
if (cmd === 'new-session') {
  if (vive().includes(${JSON.stringify(SESSIONE)})) { process.stderr.write('duplicate session: ' + ${JSON.stringify(SESSIONE)} + '\\n'); process.exit(1); }
  fs.writeFileSync(STATO, vive().concat([${JSON.stringify(SESSIONE)}]).join('\\n') + '\\n');
  process.stdout.write('$5\\t@1\\t%9\\n'); process.exit(0);
}
if (cmd === 'display-message') { process.stdout.write('0\\t\\t%9\\n'); process.exit(0); }
if (cmd === 'capture-pane') { process.stdout.write(''); process.exit(0); }
if (cmd === 'kill-session') {
  const bersaglio = String(args[args.length - 1] || '').replace(/^=/, '');
  fs.writeFileSync(STATO, vive().filter((n) => n !== bersaglio).map((n) => n + '\\n').join(''));
  process.exit(0);
}
process.exit(0);
`;
  fs.writeFileSync(tmuxBin, script, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);

  const defsPath = path.join(root, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{
      id: 'vl.native', label: 'VL', rc: false,
      managed: { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' },
    }],
    cells: [{ id: 'CellaProva', tmuxSession: SESSIONE, cwd, engine: 'vl.native', boot: false }],
  });

  const tickets = [];
  let adesso = clockStart;
  let mono = clockStart;
  // Due clock distinti: quello di parete (quello che l'operatore vede, e che
  // puo' saltare) e quello MONOTONO (quello su cui il cooldown e' costruito).
  // `advance` muove entrambi — il tempo che passa e' tempo che passa;
  // `wallJump` muove solo il primo: e' il balzo dell'orologio.
  const clock = {
    now: () => adesso,
    advance: (ms) => { adesso += ms; mono += ms; },
    wallJump: (ms) => { adesso += ms; },
    mono: () => mono,
  };
  const launchBroker = broker
    ? broker(tickets, { statoPath })
    : {
      issue: async (payload) => {
        tickets.push(payload);
        return { socketPath: path.join(root, 'broker.sock'), nonce: 'a'.repeat(64) };
      },
      revoke: async () => {},
      close: async () => {},
    };

  const cfgBase = {
    home, fleetDefsPath: defsPath, tmuxBin,
    ensureTmuxProtection: async () => {}, launchBroker, platform: 'linux', env: {},
    launchReadyMs: 0,
    now: clock.now,
    monotonicNow: clock.mono,
    ...(cooldownMs !== undefined ? { vlLaunchCooldownMs: cooldownMs } : {}),
  };
  const markerDir = path.join(home, '.nexuscrew', 'vl-new-session');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root, home, defsPath, tickets, clock, cfgBase, markerDir,
    requestedPath: path.join(markerDir, 'CellaProva.requested'),
    consumedPath: path.join(markerDir, 'CellaProva.consumed'),
    async fleet() {
      const f = await createBuiltinFleet(cfgBase);
      t.after(() => f.close().catch(() => {}));
      return f;
    },
    async spegni(fleet) { await fleet.down('CellaProva'); },
  };
}

// --- A. ciclo di vita del marcatore (unit) ---------------------------------

test('marcatore: richiesta -> pending; doppio click NON impila una seconda richiesta', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlmark-'));
  try {
    const r1 = requestVlNewSession({ home, cellId: 'CellaProva', now: 1000 });
    assert.equal(r1.state, 'pending');
    assert.equal(r1.alreadyPending, false);
    assert.ok(fs.existsSync(path.join(home, '.nexuscrew', 'vl-new-session', 'CellaProva.requested')));
    const r2 = requestVlNewSession({ home, cellId: 'CellaProva', now: 2000 });
    assert.equal(r2.state, 'pending');
    assert.equal(r2.alreadyPending, true, 'la seconda richiesta trova la stessa pending: dedup del doppio click');
    assert.equal(r2.requestedAt, 1000, 'requestedAt resta quella della PRIMA richiesta');
    assert.equal((fs.statSync(path.join(home, '.nexuscrew', 'vl-new-session', 'CellaProva.requested')).mode & 0o777), 0o600, 'marcatore 0600');
    assert.equal((fs.statSync(path.join(home, '.nexuscrew', 'vl-new-session')).mode & 0o777), 0o700, 'directory 0700');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('marcatore: consumo atomico UNA volta; seconda consumazione non consuma', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlmark-'));
  try {
    requestVlNewSession({ home, cellId: 'CellaProva', now: 1000 });
    const c1 = consumeVlNewSession({ home, cellId: 'CellaProva', now: 3000 });
    assert.equal(c1.consumed, true);
    assert.equal(c1.requestedAt, 1000);
    assert.equal(c1.consumedAt, 3000);
    assert.ok(!fs.existsSync(path.join(home, '.nexuscrew', 'vl-new-session', 'CellaProva.requested')), 'richiesta spenta: il rename e\' IL consumo');
    assert.ok(fs.existsSync(path.join(home, '.nexuscrew', 'vl-new-session', 'CellaProva.consumed')), 'il record consumato resta come prova');
    const c2 = consumeVlNewSession({ home, cellId: 'CellaProva', now: 4000 });
    assert.equal(c2.consumed, false, 'una seconda consumazione non trova nulla: UNA volta sola');
    // stato: consumato, esito NON tracciato (NC non legge le sessioni vl)
    const st = vlNewSessionStatus({ home, cellId: 'CellaProva' });
    assert.equal(st.state, 'consumed');
    assert.equal(st.outcome, 'not-tracked', 'l\'esito incerto si DICHIARA, non si immagina');
    // una richiesta NUOVA esplicita e' possibile: sopra il record consumato
    const r = requestVlNewSession({ home, cellId: 'CellaProva', now: 5000 });
    assert.equal(r.state, 'pending');
    assert.equal(r.lastConsumedAt, 3000, 'il consumo precedente resta visibile sotto la nuova richiesta');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('marcatore: id traversal rifiutato prima di toccare il disco', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlmark-'));
  try {
    for (const id of ['..', '.', 'a/b', '']) {
      assert.throws(() => requestVlNewSession({ home, cellId: id }), /unsafe vl cell id/, `id ${id} rifiutato`);
    }
    assert.ok(!fs.existsSync(path.join(home, '.nexuscrew', 'vl-new-session', '..requested')));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// --- B. up() consuma la richiesta UNA volta --------------------------------

test('up ordinario (nessuna richiesta): MAI --new, nessun flag nel payload', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  const res = await fleet.up('CellaProva');
  assert.equal(res.ok, true);
  assert.equal(res.vlNewSession, undefined, 'start ordinario: nessuna rotazione');
  assert.equal('vlNewSession' in w.tickets[0], false, 'payload senza il flag');
  assert.ok(!fs.existsSync(w.requestedPath));
  assert.ok(!fs.existsSync(w.consumedPath), 'nessun marcatore creato dal lancio ordinario');
});

test('richiesta esplicita -> up consuma UNA volta: flag nel payload, marker spento, esito riferito', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  const req = await fleet.vlNewSession('CellaProva');
  assert.equal(req.ok, true);
  assert.equal(req.status.state, 'pending');

  const res = await fleet.up('CellaProva');
  assert.equal(res.ok, true);
  assert.equal(res.vlNewSession, true, 'il lancio dichiara la rotazione applicata');
  assert.equal(w.tickets[0].vlNewSession, true, 'la decisione viaggia nel payload broker');
  assert.ok(!fs.existsSync(w.requestedPath), 'richiesta consumata PRIMA dello spawn');
  assert.ok(fs.existsSync(w.consumedPath), 'record di consumo su disco');

  // un secondo lancio (restart del supervisore NON passa di qui, ma un restart
  // operatore si'): la richiesta e' SPENTA, nessuna seconda rotazione
  await w.spegni(fleet);
  w.clock.advance(60000);
  const res2 = await fleet.up('CellaProva');
  assert.equal(res2.vlNewSession, undefined, 'restart ordinario: MAI un secondo --new');
  assert.equal('vlNewSession' in w.tickets[1], false);
});

test('esito incerto: consumo seguito da fallimento del broker -> MAI secondo --new automatico', async (t) => {
  // Il broker che fallisce SIMULA il crash fra consumo e spawn: la richiesta
  // e' gia' consumata, la rotazione non e' avvenuta, il lancio e' fallito.
  // Il retry NON ripete --new (il marker e' spento) e lo stato riferisce il
  // consumo — l'operatore decide, il codice non riprova la rotazione da solo.
  const w = mondo(t, {
    broker: (tickets) => ({
      issue: async (payload) => {
        tickets.push(payload);
        if (tickets.length === 1) throw new Error('broker closed');
        return { socketPath: '/tmp/broker.sock', nonce: 'a'.repeat(64) };
      },
      revoke: async () => {},
      close: async () => {},
    }),
  });
  const fleet = await w.fleet();
  await fleet.vlNewSession('CellaProva');
  await assert.rejects(() => fleet.up('CellaProva'), (e) => e.status === 500);
  assert.ok(!fs.existsSync(w.requestedPath), 'consumata prima dello spawn: il fallimento non la resuscita');
  assert.ok(fs.existsSync(w.consumedPath), 'record del consumo incerto');
  const st = await Promise.resolve(vlNewSessionStatus({ home: w.home, cellId: 'CellaProva' }));
  assert.equal(st.state, 'consumed', 'lo stato RIFERISCE l\'esito incerto');
  // retry oltre il cooldown: parte SENZA --new
  w.clock.advance(60000);
  const res2 = await fleet.up('CellaProva');
  assert.equal(res2.vlNewSession, undefined, 'mai un secondo --new automatico');
  assert.equal('vlNewSession' in w.tickets[1], false);
});

test('cella non-vl: il lancio non tocca il marcatore (nessuna rotazione per altri client)', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  // marcatore scritto a mano per una cella il cui engine NON e' vl: il runtime
  // non lo consuma (il gate e' per client) e la facade lo rifiuta alla fonte.
  fs.mkdirSync(w.markerDir, { recursive: true });
  fs.writeFileSync(w.requestedPath, JSON.stringify({ cell: 'CellaProva', requestedAt: 1 }), { mode: 0o600 });
  // secondo fleet con engine claude sulla stessa home: serve il binario claude
  // (findBinary), altrimenti l'engine risulta non configurato e non si arriva
  // al punto del test (il marcatore lasciato intanto).
  fs.writeFileSync(path.join(w.home, '.local', 'bin', 'claude'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const claudeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlcla-'));
  const home = w.home;
  const defsPath = path.join(claudeRoot, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{ id: 'cl', label: 'Claude', managed: { client: 'claude', provider: 'native', model: '', permissionPolicy: 'unsafe' } }],
    cells: [{ id: 'CellaProva', tmuxSession: SESSIONE, cwd: path.join(home, 'CellaProva'), engine: 'cl', boot: false }],
  });
  const tickets2 = [];
  const fleet2 = await createBuiltinFleet({
    ...w.cfgBase, fleetDefsPath: defsPath, home,
    launchBroker: {
      issue: async (p) => { tickets2.push(p); return { socketPath: '/tmp/b.sock', nonce: 'a'.repeat(64) }; },
      revoke: async () => {}, close: async () => {},
    },
  });
  t.after(() => { fs.rmSync(claudeRoot, { recursive: true, force: true }); fleet2.close().catch(() => {}); });
  await fleet2.up('CellaProva');
  assert.ok(fs.existsSync(w.requestedPath), 'il marcatore resta intatto: nessun client non-vl lo consuma');
  assert.equal('vlNewSession' in tickets2[0], false);
  await fleet.down('CellaProva').catch(() => {});
});

test('facade vlNewSession: cella vl ok, cella inesistente e cella non-vl rifiutate nominalo', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  const ok = await fleet.vlNewSession('CellaProva');
  assert.equal(ok.cell, 'CellaProva');
  await assert.rejects(() => fleet.vlNewSession('Ghost'), (e) => {
    assert.equal(e.status, 400);
    assert.match(e.message, /cella sconosciuta/);
    return true;
  });
  // una cella non-vl: si costruisce al volo col fleet claude del test sopra
  // (basta il rifiuto della facade sul engine non vl: qui il engine della
  // cella e' vl, quindi si prova il caso opposto via route, sotto).
});

// --- C. --new alla SOLA generazione 0 (supervisore) ------------------------

function fakeChildExit() {
  const ee = new EventEmitter();
  ee.kill = () => {};
  queueMicrotask(() => ee.emit('exit', 0, null));
  return ee;
}

test('cell-exec: payload.vlNewSession -> --new SOLO alla generazione 0, mai ai restart', async () => {
  const spawnCalls = [];
  let clock = 1000;
  const code = await main(['--socket', '/tmp/nc-nope', '--nonce', 'a'.repeat(64)], {
    receivePayload: async () => ({
      command: '/usr/bin/vl',
      args: [],
      env: {},
      vlNewSession: true,
      supervise: {
        enabled: true, initialReadyMs: 50, restartDelayMs: 10, maxRestartDelayMs: 10,
        resetAfterMs: 1000000, rapidWindowMs: 60000, maxRapidRestarts: 2,
      },
    }),
    spawn: (command, args) => {
      spawnCalls.push({ command, args: [...args] });
      clock += 100; // il figlio vive oltre initialReadyMs: non e' uno start fallito
      return fakeChildExit();
    },
    now: () => clock,
    sleep: async () => { clock += 1000; },
    stderrWrite: () => {},
  });
  assert.ok(spawnCalls.length >= 2, `almeno due generazioni spawnate (avute ${spawnCalls.length})`);
  assert.deepEqual(spawnCalls[0].args, ['--new'], 'generazione 0: --new (la rotazione richiesta)');
  for (let i = 1; i < spawnCalls.length; i += 1) {
    assert.equal(spawnCalls[i].args.includes('--new'), false, `generazione ${i}: MAI --new (restart supervisionato senza rotazione)`);
  }
  assert.equal(spawnCalls[0].command, '/usr/bin/vl', 'il comando non cambia fra generazioni');
  // il supervisore si ferma da solo: rapid restart limitato (i figli escono subito)
  assert.notEqual(code, undefined);
});

test('cell-exec: payload SENZA vlNewSession: nessuna generazione porta --new', async () => {
  const spawnCalls = [];
  let clock = 1000;
  await main(['--socket', '/tmp/nc-nope', '--nonce', 'a'.repeat(64)], {
    receivePayload: async () => ({
      command: '/usr/bin/vl', args: [], env: {},
      supervise: {
        enabled: true, initialReadyMs: 50, restartDelayMs: 10, maxRestartDelayMs: 10,
        resetAfterMs: 1000000, rapidWindowMs: 60000, maxRapidRestarts: 1,
      },
    }),
    spawn: (command, args) => { spawnCalls.push([...args]); return fakeChildExit(); },
    now: () => clock,
    sleep: async () => { clock += 1000; },
    stderrWrite: () => {},
  });
  for (const args of spawnCalls) assert.deepEqual(args, [], 'argv pulito: start ordinario senza richieste');
});

test('validPayload: vlNewSession ammesso solo come booleano', () => {
  const base = { command: '/bin/x', args: [], env: {} };
  assert.equal(validPayload({ ...base, vlNewSession: true }), true);
  assert.equal(validPayload({ ...base, vlNewSession: false }), true);
  assert.equal(validPayload({ ...base }), true);
  assert.equal(validPayload({ ...base, vlNewSession: 'yes' }), false, 'stringa: payload malformato');
  assert.equal(validPayload({ ...base, vlNewSession: 1 }), false, 'numero: payload malformato');
});

// --- D. pausa minima fra due lanci della stessa cella (clock iniettato) -----

test('cooldown vl: lancio ok -> rilancio entro la pausa 429 dichiarato, oltre la pausa ok', async (t) => {
  const w = mondo(t, { cooldownMs: 10000 });
  const fleet = await w.fleet();
  await fleet.up('CellaProva'); // t=0: impegna il lancio
  await w.spegni(fleet);
  w.clock.advance(5000);
  await assert.rejects(() => fleet.up('CellaProva'), (e) => {
    assert.equal(e.status, 429);
    assert.equal(e.fleetCode, 'VL_LAUNCH_COOLDOWN');
    assert.equal(e.fleetPhase, 'preflight');
    assert.match(e.message, /10000 ms/);
    return true;
  });
  w.clock.advance(6000); // t=11000: oltre i 10 s
  const res = await fleet.up('CellaProva');
  assert.equal(res.ok, true, 'oltre la pausa il lancio riparte');
});

test('cooldown vl: la pausa conta anche il lancio FALLITO (retry a passo limitato)', async (t) => {
  // broker che fallisce sempre: il primo up impegna comunque il timestamp,
  // quindi il retry immediato prende il 429 — backoff limitato, mai raffica.
  const w = mondo(t, {
    cooldownMs: 10000,
    broker: (tickets) => ({
      issue: async (payload) => { tickets.push(payload); throw new Error('broker closed'); },
      revoke: async () => {}, close: async () => {},
    }),
  });
  const fleet = await w.fleet();
  await assert.rejects(() => fleet.up('CellaProva'), () => true); // t=0 fallisce
  w.clock.advance(2000);
  await assert.rejects(() => fleet.up('CellaProva'), (e) => e.fleetCode === 'VL_LAUNCH_COOLDOWN',
    'il retry a 2 s dal fallimento e\' in pausa, non in corsa');
});

test('cooldown vl: 0 disattiva; celle diverse e celle non-vl non sono toccate', async (t) => {
  const w = mondo(t, { cooldownMs: 0 });
  const fleet = await w.fleet();
  await fleet.up('CellaProva');
  await w.spegni(fleet);
  const res = await fleet.up('CellaProva'); // immediato: disattivato
  assert.equal(res.ok, true, 'vlLaunchCooldownMs=0: nessuna pausa');

  // default 10 s quando il campo manca: cella non-vl non passa dal cooldown
  const w2 = mondo(t, {});
  const fleet2 = await w2.fleet();
  // engine claude sulla stessa forma: basta rifare il defs con client claude
  const defs = loadDefinitions(w2.defsPath);
  assert.ok(defs, 'defs leggibili');
  // (il caso non-vl e' gia' coperto dalla suite esistente claude: qui si
  // verifica solo che il default esista e sia 10 s per vl)
  const w3 = mondo(t, { clockStart: 0 });
  const fleet3 = await w3.fleet();
  await fleet3.up('CellaProva');
  await fleet3.down('CellaProva');
  w3.clock.advance(9999);
  await assert.rejects(() => fleet3.up('CellaProva'), (e) => e.fleetCode === 'VL_LAUNCH_COOLDOWN',
    'default: a 9999 ms la pausa da 10 s tiene ancora');
  w3.clock.advance(100);
  const res3 = await fleet3.up('CellaProva');
  assert.equal(res3.ok, true, 'default: a 10099 ms si parte');
});

// --- E. serializzazione: due up concorrenti della stessa cella -------------
// (il contratto completo vive in fleet-up-live-session.test.js, che ora
// esige il 409 di PREFLIGHT: qui la prova sul client vl, con il fake tmux che
// NON rifiuterebbe una seconda new-session — senza lock il secondo up
// CREEREBBE una seconda sessione, e questo e' il fallimento che il test
// scatterebbe se la serializzazione regredisse.)

test('vl: due up concorrenti -> serializzati: un vincitore, un 409 di preflight, un solo ticket', async (t) => {
  const w = mondo(t, { cooldownMs: 0 });
  const fleet = await w.fleet();
  const esiti = await Promise.allSettled([fleet.up('CellaProva'), fleet.up('CellaProva')]);
  const vinti = esiti.filter((e) => e.status === 'fulfilled');
  const persi = esiti.filter((e) => e.status === 'rejected');
  assert.equal(vinti.length, 1, 'un solo vincitore');
  assert.equal(persi.length, 1, 'un solo perdente');
  assert.equal(persi[0].reason.fleetCode, 'SESSION_DUPLICATE');
  assert.equal(persi[0].reason.fleetPhase, 'preflight', 'serializzato: il perdente vede la sessione viva in preflight');
  assert.equal(w.tickets.length, 1, 'un solo ticket: il perdente non risolve nemmeno lo spec');
});

// --- F. route API ----------------------------------------------------------

function appConFleet(fleet, cfg = {}) {
  const app = express();
  app.use(express.json({ limit: '4kb' }));
  app.use('/api/fleet', fleetRoutes(Promise.resolve(fleet), cfg));
  return app;
}

const http = require('node:http');
function richiesta(app, method, url, body) {
  const server = app.listen(0);
  const port = server.address().port;
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path: url, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
    }, (res) => {
      let out = '';
      res.on('data', (c) => { out += c; });
      res.on('end', () => {
        server.close();
        resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null });
      });
    });
    req.on('error', (e) => { server.close(); reject(e); });
    if (data) req.write(data);
    req.end();
  });
}

test('route POST /api/fleet/vl-new-session: passa la chiamata; READONLY blocca; provider senza azione -> 501', async (t) => {
  const chiamate = [];
  const fleet = {
    available: true, capabilities: () => ['status'],
    vlNewSession: async (cell) => { chiamate.push(cell); return { ok: true, cell, state: 'pending' }; },
  };
  const app = appConFleet(fleet);
  const res = await richiesta(app, 'POST', '/api/fleet/vl-new-session', { cell: 'CellaProva' });
  assert.equal(res.status, 200);
  assert.deepEqual(chiamate, ['CellaProva']);
  assert.equal(res.body.state, 'pending');

  const ro = appConFleet(fleet, { readonlyDefault: true });
  const resRO = await richiesta(ro, 'POST', '/api/fleet/vl-new-session', { cell: 'CellaProva' });
  assert.equal(resRO.status, 403, 'READONLY: e\' una mutazione dello stato richieste');

  const senza = appConFleet({ available: true, capabilities: () => ['status'] });
  const res501 = await richiesta(senza, 'POST', '/api/fleet/vl-new-session', { cell: 'CellaProva' });
  assert.equal(res501.status, 501);
});

test('route GET /api/fleet/vl-legacy-inventory: diagnostica read-only, non gated da READONLY; 501 senza provider', async () => {
  const fleet = {
    available: true, capabilities: () => ['status'],
    vlLegacyInventory: () => ({ entries: [], note: 'inventario read-only' }),
  };
  const res = await richiesta(appConFleet(fleet), 'GET', '/api/fleet/vl-legacy-inventory');
  assert.equal(res.status, 200);
  assert.equal(res.body.entries.length, 0);

  const ro = appConFleet(fleet, { readonlyDefault: true });
  const resRO = await richiesta(ro, 'GET', '/api/fleet/vl-legacy-inventory');
  assert.equal(resRO.status, 200, 'diagnosi read-only: READONLY non la blocca');

  const senza = appConFleet({ available: true, capabilities: () => ['status'] });
  const res501 = await richiesta(senza, 'GET', '/api/fleet/vl-legacy-inventory');
  assert.equal(res501.status, 501);
});

// --- G. inventario legacy (unit) -------------------------------------------

test('inventario legacy: elenca vl e vl-* con le sessioni trovate, NON tocca nulla', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlinv-'));
  try {
    const mk = (rel) => fs.mkdirSync(path.join(home, rel), { recursive: true });
    mk('.local/state/vl-prova/vl/host-v1/sessions');
    mk('.local/state/vl-prova-seconda/vl/host-v1/sessions');
    fs.writeFileSync(path.join(home, '.local/state/vl-prova/vl/host-v1/sessions', 'default'), '');
    fs.writeFileSync(path.join(home, '.local/state/vl-prova/vl/host-v1/sessions', 'archive-20260823T002011015Z-p3054639-s0'), '');
    mk('.local/state/vl/host-v1/sessions');
    fs.writeFileSync(path.join(home, '.local/state/vl/host-v1/sessions', 'default'), '');
    mk('.local/state/altro'); // non vl: ignorato
    const prima = fs.readFileSync(path.join(home, '.local/state/vl-prova/vl/host-v1/sessions', 'default'), 'utf8');

    const inv = vlLegacyInventory(home);
    assert.equal(inv.entries.length, 3, 'vl, vl-prova, vl-prova-seconda');
    assert.deepEqual(inv.entries.map((e) => e.name), ['vl', 'vl-prova', 'vl-prova-seconda'], 'ordinati per nome');
    const primo = inv.entries.find((e) => e.name === 'vl-prova');
    assert.equal(primo.sessionCount, 2);
    assert.deepEqual(primo.sessions, ['archive-20260823T002011015Z-p3054639-s0', 'default']);
    assert.equal(primo.sessionsDir, true);
    const secondo = inv.entries.find((e) => e.name === 'vl-prova-seconda');
    assert.equal(secondo.sessionCount, 0, 'cartella sessions vuota: zero sessioni, ma presente');
    assert.equal(inv.moved, 0);
    assert.equal(inv.deleted, 0);
    assert.match(inv.note, /read-only/i);

    // NON ha toccato nulla: stesso contenuto, stessi ingressi
    assert.equal(fs.readFileSync(path.join(home, '.local/state/vl-prova/vl/host-v1/sessions', 'default'), 'utf8'), prima);
    assert.equal(fs.readdirSync(path.join(home, '.local/state')).includes('altro'), true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('inventario legacy: home senza stato vl -> elenco vuoto, nessuna creazione', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlinv2-'));
  try {
    const inv = vlLegacyInventory(home);
    assert.deepEqual(inv.entries, []);
    assert.ok(!fs.existsSync(path.join(home, '.local')), 'nessuna directory creata dall\'inventario');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('inventario legacy: un symlink INTERMEDIO non porta l\'inventario fuori dall\'albero', () => {
  // `vl-prova/vl` e' un symlink a una directory ESTERNA: il percorso delle
  // sessioni (`<dir>/vl/host-v1/sessions`) passa di li'. Il controllo
  // precedente guardava la directory legacy e il path terminale: il
  // componente INTERMEDIO sfuggiva, e l'inventario elencava i nomi delle
  // sessioni di un albero esterno. Ora nessun componente del percorso puo'
  // essere un symlink, e l'entry non viene elencata.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlinv-'));
  const fuori = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlout-'));
  try {
    // La directory ESTERNA contiene gia' `host-v1/sessions`: il percorso
    // risolto attraverso il symlink porta a file veri, cosi' l'unico
    // controllo che puo' fermare la fuga e' quello sui componenti.
    fs.mkdirSync(path.join(fuori, 'host-v1', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(fuori, 'host-v1', 'sessions', 'SessioneDiAltroAlbero'), '');
    const legacy = path.join(home, '.local', 'state', 'vl-prova');
    fs.mkdirSync(legacy, { recursive: true });
    fs.symlinkSync(fuori, path.join(legacy, 'vl'));

    const inv = vlLegacyInventory(home);
    const nomi = inv.entries.map((e) => e.name);
    assert.equal(nomi.includes('vl-prova'), false,
      'una entry con un symlink intermedio non e\' elencata: l\'inventario resta dentro l\'albero');
    assert.equal(JSON.stringify(inv).includes('SessioneDiAltroAlbero'), false,
      'nessun nome di sessione dall\'albero esterno');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(fuori, { recursive: true, force: true });
  }
});

test('inventario legacy: un symlink nella catena superiore (.local) -> nessuna entry', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlinv-'));
  const fuori = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlout-'));
  try {
    fs.mkdirSync(path.join(fuori, 'state', 'vl-prova', 'vl', 'host-v1', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(fuori, 'state', 'vl-prova', 'vl', 'host-v1', 'sessions', 'default'), '');
    fs.symlinkSync(fuori, path.join(home, '.local'));

    const inv = vlLegacyInventory(home);
    assert.equal(inv.entries.length, 0, 'nessuna entry: la catena dei componenti contiene un symlink');
    assert.equal(JSON.stringify(inv).includes('default'), false, 'nessun nome di sessione');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(fuori, { recursive: true, force: true });
  }
});

test('inventario legacy: senza symlink la sessione normale e\' ancora elencata', () => {
  // La guardia non deve cambiare il caso sano: il percorso intero e' fatto
  // di directory reali e le sessioni si vedono.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlinv-'));
  try {
    fs.mkdirSync(path.join(home, '.local', 'state', 'vl-prova', 'vl', 'host-v1', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(home, '.local', 'state', 'vl-prova', 'vl', 'host-v1', 'sessions', 'default'), '');
    const inv = vlLegacyInventory(home);
    assert.equal(inv.entries.length, 1, 'la entry normale e\' elencata');
    assert.deepEqual(inv.entries[0].sessions, ['default']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// --- H. stato della richiesta di sessione nuova, letto senza mutare -------
//
// Il consumo del marcatore e' un fatto che il solo errore di lancio non
// racconta. Prima di questo blocco l'unico modo di sapere che la richiesta
// era stata consumata era CREARNE UN'ALTRA: una mutazione, e una rotazione
// in piu' possibile. Qui lo stato si legge, e si legge per una cella sola.

test('route GET /api/fleet/vl-new-session-state: stato read-only della cella', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  await fleet.vlNewSession('CellaProva');
  const app = appConFleet(fleet);

  const res = await richiesta(app, 'GET', '/api/fleet/vl-new-session-state?cell=CellaProva');
  assert.equal(res.status, 200);
  assert.equal(res.body.cell, 'CellaProva');
  assert.equal(res.body.state, 'pending', 'la richiesta e\' pendente: il prossimo lancio ruota');

  // La richiesta non e\' una mutazione: la lettura non crea niente e non
  // cambia lo stato (nessun marcatore nuovo).
  const dopo = await richiesta(app, 'GET', '/api/fleet/vl-new-session-state?cell=CellaProva');
  assert.equal(dopo.body.state, 'pending', 'la lettura non consuma e non crea richieste');

  // Nessuna cella: la domanda non e\'posta. E una cella che non usa vl: il
  // contratto esiste solo per vl.
  const senza = await richiesta(app, 'GET', '/api/fleet/vl-new-session-state');
  assert.equal(senza.status, 400, 'senza cella la domanda non e\' posta');
  const ignota = await richiesta(app, 'GET', '/api/fleet/vl-new-session-state?cell=Nesuna');
  assert.equal(ignota.status, 400, 'cella inesistente: 400');

  const senzaProvider = appConFleet({ available: true, capabilities: () => ['status'] });
  const res501 = await richiesta(senzaProvider, 'GET', '/api/fleet/vl-new-session-state?cell=CellaProva');
  assert.equal(res501.status, 501, 'provider senza la vista: 501, non un errore generico');
});

test('fleet.status: la cella vl porta con se\' lo stato della richiesta', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  await fleet.vlNewSession('CellaProva');
  const st = await fleet.status();
  const cella = (st.cells || []).find((c) => c.cell === 'CellaProva');
  assert.ok(cella, 'la cella e\' nel fleet.status');
  assert.equal(cella.newSession.state, 'pending');
  assert.equal(typeof cella.newSession.requestedAt, 'number');
});

test('up fallito DOPO il consumo: l\'errore dichiara l\'esito incerto della rotazione', async (t) => {
  // Il broker fallisce dopo che il marcatore e\' stato consumato: la
  // richiesta e\' andata, l\'esito (sessione ruotata o no) non e\' tracciato.
  // L\'errore deve dirlo, e il marcatore NON deve tornare indietro.
  const w = mondo(t, {
    broker: () => ({
      issue: async () => { throw new Error('broker chiuso'); },
      revoke: async () => {},
      close: async () => {},
    }),
  });
  const fleet = await w.fleet();
  await fleet.vlNewSession('CellaProva');

  await assert.rejects(() => fleet.up('CellaProva'), (e) => {
    assert.ok(e.data && e.data.vlNewSession, 'l\'errore porta lo stato del marcatore');
    assert.equal(e.data.vlNewSession.state, 'consumed', 'la richiesta e\' stata consumata');
    assert.equal(e.data.vlNewSession.outcome, 'not-tracked', 'l\'esito non e\' tracciato: si dichiara, non si inventa');
    assert.equal(e.vlNewSessionOutcome, 'consumed-unknown', 'marker bounded per i diagnostici');
    return true;
  });

  // Il consumo non torna indietro e non si ripete: nessuna seconda rotazione.
  assert.ok(fs.existsSync(w.consumedPath), 'il record consumato resta');
  assert.ok(!fs.existsSync(w.requestedPath), 'nessuna richiesta pendente residua');
  assert.equal(vlNewSessionStatus({ home: w.home, cellId: 'CellaProva' }).state, 'consumed');
});

test('la vista dello stato e\' read-only: nessuna directory viene creata', async (t) => {
  const w = mondo(t);
  const fleet = await w.fleet();
  const st = await fleet.status();
  const cella = (st.cells || []).find((c) => c.cell === 'CellaProva');
  assert.equal(cella.newSession.state, 'none', 'nessuna richiesta: nessun marcatore');
  assert.ok(!fs.existsSync(w.markerDir), 'la lettura non lascia directory sul disco');
});

test('cooldown vl: l\'orologio di parete che salta NON accorcia la pausa minima', async (t) => {
  // La pausa minima fra due lanci e' un tempo MINIMO: un balzo dell'orologio
  // di parete (NTP, correzione manuale dell'ora) non puo' accorciarla. Il
  // clock del cooldown e' monotono, e questo test lo dimostra: con l'orologio
  // di parete il secondo lancio passerebbe, e il test fallirebbe.
  const w = mondo(t, { cooldownMs: 10000 });
  const fleet = await w.fleet();
  await fleet.up('CellaProva');            // t=0: impegna il lancio
  await w.spegni(fleet);
  w.clock.wallJump(3600000);               // l'orologio di parete salta di un'ora
  await assert.rejects(() => fleet.up('CellaProva'), (e) => {
    assert.equal(e.fleetCode, 'VL_LAUNCH_COOLDOWN', 'la pausa minima e\' monotona: il balzo non la accorcia');
    return true;
  });
});
