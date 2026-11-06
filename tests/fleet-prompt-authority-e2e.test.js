'use strict';
// 0.9.80 strato 2c — consultazione fresca, di sola lettura, del fence del
// proprietario sul lease autenticato. Lease manager e lease-client REALI su
// socket TCP di test (nessun tmux, nessun NC vivo).
const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const { startLeaseClient } = require('../lib/fleet/lease-client.js');
const snap = require('../lib/fleet/prompt-snapshot.js');

const LAUNCH = 'a1b2c3d4e5f60718';

function pair() {
  return new Promise((resolve, reject) => {
    let pending = null;
    const srv = net.createServer((sock) => { pending = sock; });
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const client = net.createConnection(srv.address().port, '127.0.0.1', () => {
        const wait = () => {
          if (pending) { srv.close(() => {}); resolve({ serverSide: pending, client }); }
          else setTimeout(wait, 2);
        };
        wait();
      });
      client.once('error', reject);
    });
  });
}

function recv(client, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => { cleanup(); reject(new Error('recv timeout')); }, timeoutMs);
    function cleanup() { clearTimeout(to); client.removeListener('data', on); }
    function on(chunk) {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
        if (!predicate || predicate(msg)) { cleanup(); resolve(msg); }
      }
    }
    client.on('data', on);
  });
}

function mondo() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'promptauth-'));
  const clock = { t: 10_000 };
  const mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
  return { home, clock, mgr };
}

// Lease vivo con un client "a mano": il test risponde (o no) alle richieste.
async function conClientGrezzo(mgr, cellId = 'Dev') {
  await mgr.track(cellId);
  const { serverSide, client } = await pair();
  assert.equal(mgr.attachInitial(cellId, serverSide, { generation: 0 }), true);
  return client;
}

const risposta = (nonce, extra = {}) => ({
  type: 'promptSnapshotResult', v: 1, nonce, launchId: LAUNCH, applicable: true, generation: 1, ...extra,
});

test('schema: richiesta e risposta a chiavi chiuse, nonce e launchId esatti', () => {
  const nonce = 'f'.repeat(32);
  assert.equal(snap.validRequest({ type: 'promptSnapshot', v: 1, nonce }), true);
  assert.equal(snap.validRequest({ type: 'promptSnapshot', v: 1, nonce, extra: 1 }), false);
  assert.equal(snap.validRequest({ type: 'promptSnapshot', v: 2, nonce }), false);
  assert.equal(snap.validRequest({ type: 'promptSnapshot', v: 1, nonce: 'ZZ' }), false);
  assert.equal(snap.validResult(risposta(nonce)), true);
  assert.equal(snap.validResult(risposta(nonce, { generation: null })), true);
  for (const male of [
    { launchId: '../etc/passwd' }, { launchId: 'ABCDEF0123456789' }, { generation: -1 },
    { generation: 1.5 }, { generation: '1' }, { applicable: 'yes' }, { path: '/x' },
    { mcp: { state: 'degraded', failed: ['x'.repeat(65)], pending: [] } },
    { mcp: { state: 'degraded', failed: Array.from({ length: 17 }, (_, i) => `s${i}`), pending: [] } },
    { mcp: { state: 'weird', failed: [], pending: [] } },
  ]) {
    assert.equal(snap.validResult(risposta(nonce, male)), false, JSON.stringify(male));
  }
  assert.equal(snap.validResult(risposta(nonce, { mcp: { state: 'degraded', failed: ['a'], pending: ['b'] } })), true);
});

test('la fotografia viene dal proprietario: gen 1 mentre la cache del lease annuncia 0', async () => {
  const { mgr } = mondo();
  await mgr.track('Dev');
  const { serverSide, client } = await pair();
  assert.equal(mgr.attachInitial('Dev', serverSide, { generation: 0 }), true);
  // Supervisore REALE: il lease cache dice 0, il fence del proprietario 1
  // (ammissione gen1 avvenuta, annuncio non ancora fatto o fallito).
  let fence = 1;
  const ctl = startLeaseClient(client, {
    stablePath: path.join(os.tmpdir(), 'nessuno.sock'), launchEpoch: 'a'.repeat(16), generation: () => 0,
    promptSnapshot: () => ({ launchId: LAUNCH, applicable: true, generation: fence }),
  }, {});
  try {
    assert.equal(mgr.status('Dev').generation, 0);
    const r = await mgr.readPromptSnapshot('Dev');
    assert.equal(r.ok, true);
    assert.equal(r.generation, 1);
    assert.equal(r.launchId, LAUNCH);
    assert.equal(r.applicable, true);
    assert.equal(mgr.promptSnapshotBinding('Dev', r), true);
    // Prima della prima ammissione: nessuna generazione, mai 0 inventata.
    fence = null;
    const prima = await mgr.readPromptSnapshot('Dev');
    assert.equal(prima.ok, true);
    assert.equal(prima.generation, null);
  } finally { ctl.stop(); mgr.close(); }
});

test('peer senza capacita\' (nessun hook) o fotografia non valida: timeout bounded, non successo', async () => {
  const { mgr } = mondo();
  await mgr.track('Dev');
  const { serverSide, client } = await pair();
  mgr.attachInitial('Dev', serverSide, { generation: 0 });
  const ctl = startLeaseClient(client, {
    stablePath: path.join(os.tmpdir(), 'nessuno.sock'), launchEpoch: 'a'.repeat(16), generation: () => 0,
  }, {});
  try {
    const t0 = process.hrtime.bigint();
    const r = await mgr.readPromptSnapshot('Dev', { timeoutMs: 60 });
    assert.deepEqual(r, { ok: false, reason: 'timeout' });
    assert.ok(Number(process.hrtime.bigint() - t0) / 1e6 < 2000);
  } finally { ctl.stop(); mgr.close(); }
});

test('binding: nonce vecchio, nonce ripetuto, schema ostile e socket altrui sono scartati', async () => {
  const { mgr } = mondo();
  const client = await conClientGrezzo(mgr);
  try {
    const p1 = mgr.readPromptSnapshot('Dev', { timeoutMs: 150 });
    const req = await recv(client, (m) => m.type === 'promptSnapshot');
    assert.equal(snap.validRequest(req), true);
    // nonce sbagliato, chiave in piu', launchId ostile: nessuno risolve
    client.write(`${JSON.stringify(risposta('0'.repeat(32)))}\n`);
    client.write(`${JSON.stringify(risposta(req.nonce, { extra: true }))}\n`);
    client.write(`${JSON.stringify(risposta(req.nonce, { launchId: '../../x' }))}\n`);
    assert.deepEqual(await p1, { ok: false, reason: 'timeout' });
    // una risposta valida al nonce ormai scaduto non risolve niente di nuovo
    client.write(`${JSON.stringify(risposta(req.nonce))}\n`);
    const p2 = mgr.readPromptSnapshot('Dev', { timeoutMs: 150 });
    const req2 = await recv(client, (m) => m.type === 'promptSnapshot' && m.nonce !== req.nonce);
    client.write(`${JSON.stringify(risposta(req2.nonce))}\n`);
    const ok = await p2;
    assert.equal(ok.ok, true);
    // ripetuta: il waiter e' gia' consumato, nessun effetto
    client.write(`${JSON.stringify(risposta(req2.nonce, { generation: 7 }))}\n`);
    assert.equal(ok.generation, 1);
  } finally { client.destroy(); mgr.close(); }
});

test('connessione sostituita o persa durante la consultazione: nessun dato qualificato', async () => {
  const { mgr } = mondo();
  const client = await conClientGrezzo(mgr);
  try {
    const p = mgr.readPromptSnapshot('Dev', { timeoutMs: 250 });
    await recv(client, (m) => m.type === 'promptSnapshot');
    client.destroy();
    const r = await p;
    assert.equal(r.ok, false);
    assert.ok(['connection-lost', 'connection-replaced', 'timeout'].includes(r.reason), r.reason);
    // dopo la perdita nessuna nuova consultazione e' attestabile
    const dopo = await mgr.readPromptSnapshot('Dev', { timeoutMs: 50 });
    assert.equal(dopo.ok, false);
  } finally { mgr.close(); }
});

test('shutdown del manager durante la consultazione: waiter chiuso, nessun timer pendente', async () => {
  const { mgr } = mondo();
  const client = await conClientGrezzo(mgr);
  try {
    const p = mgr.readPromptSnapshot('Dev', { timeoutMs: 250 });
    await recv(client, (m) => m.type === 'promptSnapshot');
    mgr.close();
    assert.deepEqual(await p, { ok: false, reason: 'shutdown' });
  } finally { client.destroy(); }
});

test('tetto di consultazioni in volo per cella: la quinta e\' rifiutata senza accumulo', async () => {
  const { mgr } = mondo();
  const client = await conClientGrezzo(mgr);
  try {
    const volo = [1, 2, 3, 4].map(() => mgr.readPromptSnapshot('Dev', { timeoutMs: 120 }));
    const quinta = await mgr.readPromptSnapshot('Dev', { timeoutMs: 120 });
    assert.deepEqual(quinta, { ok: false, reason: 'busy' });
    for (const p of volo) assert.equal((await p).ok, false);
    // liberato: ora una nuova consultazione parte
    const nuova = mgr.readPromptSnapshot('Dev', { timeoutMs: 60 });
    assert.deepEqual(await nuova, { ok: false, reason: 'timeout' });
  } finally { client.destroy(); mgr.close(); }
});

test('cella senza lease: non attestabile, nessuna scrittura', async () => {
  const { mgr } = mondo();
  try {
    assert.deepEqual(await mgr.readPromptSnapshot('Dev'), { ok: false, reason: 'no-lease' });
    assert.deepEqual(await mgr.readPromptSnapshot('../x'), { ok: false, reason: 'invalid-cell' });
  } finally { mgr.close(); }
});

// ── Supervisore REALE in un processo distinto + runtime reale ────────────────
// Il processo figlio esegue cell-exec main() (lease-client, fence di
// generazione e scrittura del record veri); il padre e' il daemon: lease
// manager vero e runtime vero. Niente autorita' iniettata: la generazione
// arriva dal proprietario sul canale lease. Ogni prova ha timeout e cleanup
// anche sul rosso.
const { spawn } = require('node:child_process');
const { mondoStato, SESSIONE } = require('./helpers/prompt-stato-world.js');
const { registraLancioCorrente, leggiRecordPrompt } = require('../lib/files/activity.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
const { loadDefinitions } = require('../lib/fleet/definitions.js');

const CHILD = path.join(__dirname, 'helpers', 'prompt-supervisor-child.cjs');
const CELLA = 'Cella';

function leggiEventi(proc) {
  const eventi = [];
  let buf = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (c) => {
    buf += c;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const riga = buf.slice(0, i); buf = buf.slice(i + 1);
      try { eventi.push(JSON.parse(riga)); } catch (_) { /* rumore */ }
    }
  });
  return eventi;
}

async function finche(fn, { timeoutMs = 8000, passoMs = 10 } = {}) {
  const fine = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > fine) return v;
    await new Promise((r) => setTimeout(r, passoMs));
  }
}

async function avviaSupervisore(w, leaseHome) {
  const clock = { t: 10_000 };
  let mgr = createLeaseManager({ home: leaseHome, log: () => {} }, { now: () => Date.now() });
  const info = await mgr.track(CELLA);
  const server = net.createServer();
  const adottato = new Promise((resolve) => server.once('connection', resolve));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const launchId = 'a1b2c3d4e5f60718';
  const logPath = path.join(w.root, 'deliveries.log');
  fs.writeFileSync(logPath, '');
  fs.mkdirSync(w.dirSessione, { recursive: true, mode: 0o700 });
  const proc = spawn(process.execPath, [CHILD, JSON.stringify({
    port: server.address().port, cellId: CELLA, stablePath: info.stablePath, launchEpoch: info.launchEpoch,
    dir: w.dirSessione, launchId, logPath,
  })], { stdio: ['pipe', 'pipe', 'inherit'] });
  const eventi = leggiEventi(proc);
  const lato = await adottato;
  assert.equal(mgr.attachInitial(CELLA, lato, { generation: 0 }), true);
  registraLancioCorrente(w.filesRoot, SESSIONE, { launchId, canale: 'none' });
  const stato = {
    logB: [], mgr, info, proc, eventi, launchId, logPath, clock,
    comando: (c) => proc.stdin.write(`${c}\n`),
    consegne: () => fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length,
    riavviaDaemon: async () => {
      mgr.close();
      // Il demone B nasce DOPO che il supervisore ha visto la chiusura e ha
      // fatto il suo primo tentativo a vuoto: il reconnect arriva alla cadenza
      // del client, come in un restart vero (il client riprova ogni 20 s).
      await new Promise((r) => setTimeout(r, 400));
      mgr = createLeaseManager({ home: leaseHome, log: (m) => stato.logB.push(`${Date.now() % 100000} ${String(m).slice(0, 80)}`) }, { now: () => Date.now() });
      stato.mgr = mgr;
      await mgr.boot();
      return mgr;
    },
    chiudi: () => {
      try { proc.stdin.write('quit\n'); } catch (_) {}
      try { proc.kill('SIGKILL'); } catch (_) {}
      try { stato.mgr.close(); } catch (_) {}
      try { server.close(); } catch (_) {}
      try { fs.chmodSync(w.dirSessione, 0o700); } catch (_) {}
    },
  };
  return stato;
}

function runtimeCon(w, mgr) {
  return createBuiltinRuntime({
    cfg: { filesRoot: w.filesRoot, activityHooks: false, log: () => {}, env: {} },
    home: w.home, defsPath: w.defsPath, tmuxBin: w.tmuxBin, readonly: () => false,
    launchBroker: { issue: async () => ({}), revoke: async () => {}, close: async () => {} },
    leaseManager: mgr, boot: loadDefinitions(w.defsPath),
  });
}

test('E2E processo distinto: gen1 ammessa con pending non persistito -> la fotografia del proprietario dice 1, mai il vecchio submitted', async () => {
  const w = mondoStato({ engineExtra: { submit: 'enter' } });
  const sup = await avviaSupervisore(w, fs.mkdtempSync(path.join(os.tmpdir(), 'promptauth-home-')));
  try {
    assert.ok(await finche(() => sup.eventi.find((e) => e.ev === 'spawned')), 'supervisore avviato');
    // gen0 consegnata e terminale scritto dal proprietario
    assert.ok(await finche(() => leggiRecordPrompt(w.dirSessione, sup.launchId)
      && leggiRecordPrompt(w.dirSessione, sup.launchId).state === 'submitted'), 'terminale gen0 su disco');
    assert.ok(await finche(() => sup.mgr.status(CELLA).state === 'live'));
    const rt = runtimeCon(w, sup.mgr);
    const prima = (await rt.status({})).cells[0].promptDelivery;
    assert.equal(prima.state, 'submitted');
    assert.equal(prima.generation, 0);
    assert.equal(sup.consegne(), 1);
    // il proprietario ammette gen1 con la scrittura del pending che FALLISCE
    sup.comando('lock-dir');
    assert.ok(await finche(() => sup.eventi.find((e) => e.ev === 'locked')));
    sup.comando('exit-child');
    assert.ok(await finche(() => sup.eventi.filter((e) => e.ev === 'spawned').length >= 2), 'respawn gen1');
    // il record su disco e' ancora quello della gen0 (submitted)
    assert.equal(leggiRecordPrompt(w.dirSessione, sup.launchId).generation, 0);
    const dopo = (await rt.status({})).cells[0].promptDelivery;
    assert.equal(dopo.state, 'unknown');
    assert.equal(dopo.reason, 'generation-not-recorded');
    assert.equal(dopo.generation, 1, 'la generazione viene dal proprietario reale');
    assert.notEqual(dopo.state, 'submitted');
    assert.equal(sup.consegne(), 1, 'zero paste per la generazione con pending non persistito');
  } finally { sup.chiudi(); fs.rmSync(w.root, { recursive: true, force: true }); }
});

test('E2E restart del demone: prima della nuova fotografia unknown, dopo il recupero la stessa tupla; nessun armControl di stop', { timeout: 90000 }, async () => {
  const w = mondoStato({ engineExtra: { submit: 'enter' } });
  const sup = await avviaSupervisore(w, fs.mkdtempSync(path.join(os.tmpdir(), 'promptauth-home-')));
  try {
    assert.ok(await finche(() => leggiRecordPrompt(w.dirSessione, sup.launchId)
      && leggiRecordPrompt(w.dirSessione, sup.launchId).state === 'submitted'), 'terminale gen0 su disco');
    assert.ok(await finche(() => sup.mgr.status(CELLA).state === 'live'));
    // il demone A termina: supervisore e file restano
    const mgrB = await sup.riavviaDaemon();
    assert.equal(mgrB.status(CELLA).state, 'none', 'nessun lease sopravvive al restart');
    const rtB = runtimeCon(w, mgrB);
    const prima = (await rtB.status({})).cells[0].promptDelivery;
    assert.deepEqual(prima, { state: 'unknown', launchId: sup.launchId }, 'senza prova: unknown, niente terminale vecchio');
    // il storico resta leggibile come storia
    assert.equal(leggiRecordPrompt(w.dirSessione, sup.launchId).state, 'submitted');
    // il supervisore si riconnette con le prove gia' previste
    const trans = []; const t0 = Date.now();
    assert.ok(await finche(() => { const st = mgrB.status(CELLA).state; if (trans[trans.length - 1] !== st) trans.push(`${Date.now() - t0}:${st}`); return st === 'live'; }, { timeoutMs: 45000, passoMs: 50 }), `reconnect vero: ${JSON.stringify(sup.logB.slice(0, 6))} ${JSON.stringify(trans)}`);
    const dopo = (await rtB.status({})).cells[0].promptDelivery;
    assert.equal(dopo.state, 'submitted');
    assert.equal(dopo.launchId, sup.launchId);
    assert.equal(dopo.generation, 0);
    assert.equal(mgrB.controlArmato(CELLA), false, 'la lettura non riarma il controllo di stop');
    assert.equal(sup.consegne(), 1, 'nessuna consegna ripetuta dal restart del demone');
  } finally { sup.chiudi(); fs.rmSync(w.root, { recursive: true, force: true }); }
});

// ── Demone A e demone B in PROCESSI distinti, supervisore rimasto vivo ───────
const DAEMON = path.join(__dirname, 'helpers', 'prompt-daemon-child.cjs');

function processoFiglio(script, arg) {
  const proc = spawn(process.execPath, [script, JSON.stringify(arg)], { stdio: ['pipe', 'pipe', 'inherit'] });
  const eventi = leggiEventi(proc);
  return {
    proc, eventi,
    chiedi: async (cmd, ev, timeoutMs = 8000) => {
      const n = eventi.length;
      proc.stdin.write(`${cmd}\n`);
      return finche(() => eventi.slice(n).find((e) => e.ev === ev), { timeoutMs });
    },
    chiudi: () => { try { proc.stdin.write('quit\n'); } catch (_) {} try { proc.kill('SIGKILL'); } catch (_) {} },
  };
}

test('E2E demone B in un processo NUOVO: unknown, poi la stessa tupla dal supervisore vivo; nessun armControl, nessun replay', { timeout: 120000 }, async () => {
  const w = mondoStato({ engineExtra: { submit: 'enter' } });
  const leaseHome = fs.mkdtempSync(path.join(os.tmpdir(), 'promptauth-dprocs-'));
  const launchId = 'a1b2c3d4e5f60718';
  fs.mkdirSync(w.dirSessione, { recursive: true, mode: 0o700 });
  registraLancioCorrente(w.filesRoot, SESSIONE, { launchId, canale: 'none' });
  const baseArg = { leaseHome, defsPath: w.defsPath, tmuxBin: w.tmuxBin, home: w.home, filesRoot: w.filesRoot, cellId: CELLA };
  const A = processoFiglio(DAEMON, { ...baseArg, role: 'A' });
  let B = null; let sup = null;
  try {
    const ascolto = await finche(() => A.eventi.find((e) => e.ev === 'listening'));
    assert.ok(ascolto, 'demone A in ascolto');
    const logPath = path.join(w.root, 'deliveries.log');
    fs.writeFileSync(logPath, '');
    sup = spawn(process.execPath, [CHILD, JSON.stringify({
      port: ascolto.port, cellId: CELLA, stablePath: ascolto.stablePath, launchEpoch: ascolto.launchEpoch,
      dir: w.dirSessione, launchId, logPath,
    })], { stdio: ['pipe', 'pipe', 'inherit'] });
    leggiEventi(sup);
    assert.ok(await finche(() => leggiRecordPrompt(w.dirSessione, launchId)
      && leggiRecordPrompt(w.dirSessione, launchId).state === 'submitted'), 'terminale gen0 su disco');
    const stA = await finche(async () => { const s = await A.chiedi('status', 'status'); return s && s.lease === 'live' && s.promptDelivery ? s : null; });
    assert.equal(stA.promptDelivery.state, 'submitted');
    assert.equal(stA.promptDelivery.generation, 0);
    // il demone A muore (SIGKILL): supervisore e file restano
    A.proc.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 400));
    B = processoFiglio(DAEMON, { ...baseArg, role: 'B' });
    assert.ok(await finche(() => B.eventi.find((e) => e.ev === 'booted')), 'demone B avviato su un processo nuovo');
    const prima = await B.chiedi('status', 'status');
    assert.equal(prima.lease, 'none');
    assert.deepEqual(prima.promptDelivery, { state: 'unknown', launchId }, 'senza prova: unknown, mai il terminale vecchio');
    assert.equal(leggiRecordPrompt(w.dirSessione, launchId).state, 'submitted', 'la storia resta leggibile');
    // il supervisore si riconnette a B con le prove gia' previste
    const dopo = await finche(async () => {
      const s = await B.chiedi('status', 'status');
      return s && s.lease === 'live' && s.promptDelivery && s.promptDelivery.state === 'submitted' ? s : null;
    }, { timeoutMs: 60000 });
    assert.ok(dopo, 'la stessa tupla dopo il recupero');
    assert.equal(dopo.promptDelivery.launchId, launchId);
    assert.equal(dopo.promptDelivery.generation, 0);
    assert.equal(dopo.armato, false, 'nessun armControl dalla lettura');
    assert.equal(dopo.eventi, 0, 'nessun replay diagnostico al riavvio del demone');
    assert.equal(fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean).length, 1, 'nessuna consegna ripetuta');
  } finally {
    try { A.chiudi(); } catch (_) {}
    try { if (B) B.chiudi(); } catch (_) {}
    try { if (sup) { sup.stdin.write('quit\n'); sup.kill('SIGKILL'); } } catch (_) {}
    fs.rmSync(w.root, { recursive: true, force: true });
    fs.rmSync(leaseHome, { recursive: true, force: true });
  }
});
