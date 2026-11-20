'use strict';
// 0.9.83 S4a (B8) — ramo «dead-boot» con la sonda del socket ESATTO.
// Un record v2 di un'incarnazione precedente dello stesso nodo/owner/ns
// (proveBoot) non ha processi vivi per costruzione: il suo socket e il suo
// serverPid sono del boot morto. La prova richiesta diventa «nessuna sessione
// omonima puo' esistere sul socket CORRENTE», letta con una sonda connect(2)
// read-only e bounded (mai stderr di un comando, mai errno dello spawn).
// Timeout/EACCES/altro restano unknown: nessuna chiusura.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const launchTarget = require('../lib/fleet/launch-target.js');
const radici = require('../lib/fleet/vl-roots.js');
const { leggiStarttimeProc } = require('../lib/fleet/definitions.js');
const { sondaSocketCorrente } = require('../lib/fleet/launch-reconcile.js');
const W = require('./helpers/launch-world.js');

const { OWNER_INSTANCE_ID } = W;
const LID = 'ab'.repeat(8);
const BOOT_ORA = '11111111-1111-4111-8111-111111111111';
const BOOT_PRIMA = '22222222-2222-4222-8222-222222222222';
const NS = '4026531836';
const SOCKET_MORTO = '/tmp/nc-socket-del-boot-precedente.sock';

const nodoOra = () => () => ({ bootId: BOOT_ORA, pidNamespaceInode: NS });

function figlioVivo(t) {
  const f = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000000);'], { detached: true, stdio: 'ignore' });
  f.unref();
  t.after(() => { try { process.kill(f.pid, 'SIGKILL'); } catch (_) { /* gia' uscito */ } });
  return f;
}

async function morto(pid) {
  process.kill(pid, 'SIGKILL');
  const fine = Date.now() + 5000;
  while (Date.now() < fine) {
    try { process.kill(pid, 0); } catch (_) { return; }
    await new Promise((r) => setTimeout(r, 20));
  }
}

function scrivi(d, fase, {
  bootId = BOOT_PRIMA, pidNs = NS, owner = null, socket = SOCKET_MORTO,
  created = {}, attested = null, famiglia = d.famiglia, launchId = LID,
} = {}) {
  const vl = famiglia === 'vl';
  const own = vl ? OWNER_INSTANCE_ID : owner;
  const r = launchTarget.registraPrepared(d.filesRoot, d.sessione, {
    launchId, family: famiglia, cellId: d.cella, ownerInstanceId: own, tmuxSocket: socket,
    bootId, pidNs, daemonInc: 'inc-0',
    res: vl ? { vlOwner: OWNER_INSTANCE_ID, vlRoot: radici.radiceServer(d.home, OWNER_INSTANCE_ID, d.cella) } : null,
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  const passi = ['creating', 'created', 'attested'];
  let da = 'prepared';
  for (const a of passi) {
    if (fase === da) break;
    const campi = a === 'created' ? { sessionId: '$5', windowId: '@7', paneId: '%9', ...created }
      : a === 'attested' ? { ...attested } : {};
    const av = launchTarget.avanza(d.filesRoot, d.sessione, { launchId, da, a, campi });
    assert.equal(av.ok, true, JSON.stringify(av));
    da = a;
  }
}

// Mondo con un record v2 attested di un BOOT PRECEDENTE: supervisore e server
// del record sono processi figli del test, gia' morti per PID esatto.
async function mondoDeadBoot(t, { sonda, record = {}, cfg = {}, scenario = {} } = {}) {
  const d = W.scriviMondo({ famiglia: 'other', scenario });
  t.after(() => W.pulisci(d));
  const sup = figlioVivo(t);
  const nascitaSup = leggiStarttimeProc(sup.pid);
  const srv = figlioVivo(t);
  const nascitaSrv = leggiStarttimeProc(srv.pid);
  await morto(sup.pid);
  await morto(srv.pid);
  scrivi(d, 'attested', {
    owner: OWNER_INSTANCE_ID,
    created: { serverPid: srv.pid, serverStarttime: nascitaSrv },
    attested: { panePid: sup.pid, paneStarttime: nascitaSup },
    ...record,
  });
  const { runtime } = W.apriRuntime(d, {
    owner: true, ...(sonda ? { sondaSocket: sonda } : {}),
    cfg: { identitaNodoKernel: nodoOra(), ...cfg },
  });
  t.after(() => { try { runtime.shutdown(); } catch (_) {} });
  return { d, runtime };
}

const sonda = (esito, motivo = null) => async () => (motivo ? { esito, motivo } : { esito });

// --- sonda: campioni REALI, nessun esito fabbricato -------------------------

test('S4a sonda: connect / post-mortem / ENOENT misurati su un listener scratch', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-sonda-'));
  const srv = net.createServer(() => {});
  t.after(() => { try { srv.close(); } catch (_) { /* gia' chiuso */ } });
  try {
    const p = path.join(dir, 's.sock');
    await new Promise((r) => srv.listen(p, r));
    assert.equal((await sondaSocketCorrente(p)).esito, 'connect', 'listener vivo: servito');
    await new Promise((r) => srv.close(r));
    const post = await sondaSocketCorrente(p);
    // Il pathname resta dopo la close(): lo stato REALE e' quello che si misura.
    assert.equal(post.esito, fs.existsSync(p) ? 'econnrefused' : 'enoent',
      `stato post-mortem reale: ${JSON.stringify(post)} (path presente: ${fs.existsSync(p)})`);
    try { fs.unlinkSync(p); } catch (_) { /* gia' via */ }
    assert.equal((await sondaSocketCorrente(p)).esito, 'enoent', 'pathname assente');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('S4a sonda: un tmux usa-e-getta su socket noto e\' servito; dopo lo stop il pathname si osserva', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-sonda-tmux-'));
  const sock = path.join(dir, 'probe.sock');
  try {
    const crea = spawnSync('tmux', ['-S', sock, 'new-session', '-d', '-s', 'sonda'], { encoding: 'utf8' });
    assert.equal(crea.status, 0, `tmux usa-e-getta: ${crea.stderr}`);
    assert.equal((await sondaSocketCorrente(sock)).esito, 'connect', 'il server del test e\' servito');
    const pidOut = spawnSync('tmux', ['-S', sock, 'display-message', '-p', '#{pid}'], { encoding: 'utf8' });
    const pid = Number(String(pidOut.stdout || '').trim());
    assert.ok(Number.isSafeInteger(pid) && pid > 0, 'pid esatto del server avviato da me');
    spawnSync('tmux', ['-S', sock, 'kill-server'], { encoding: 'utf8' });
    // Se kill-server non l'ha chiuso, si ferma per PID ESATTO (mai per pattern).
    try { process.kill(pid, 'SIGTERM'); } catch (_) { /* gia' uscito */ }
    for (let i = 0; i < 100; i += 1) {
      let vivo = true;
      try { process.kill(pid, 0); } catch (_) { vivo = false; }
      if (!vivo) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    const post = await sondaSocketCorrente(sock);
    assert.ok(post.esito === 'econnrefused' || post.esito === 'enoent',
      `esito post-mortem reale: ${JSON.stringify(post)}`);
    try { fs.unlinkSync(sock); } catch (_) { /* kill-server puo' averlo rimosso */ }
    assert.equal((await sondaSocketCorrente(sock)).esito, 'enoent', 'pathname assente');
  } finally {
    try { spawnSync('tmux', ['-S', sock, 'kill-server'], { encoding: 'utf8' }); } catch (_) { /* niente */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- ramo dead-boot: la prova e' la sonda, con proveBoot qualificata -------

for (const [nome, esito] of [['ECONNREFUSED', 'econnrefused'], ['ENOENT', 'enoent']]) {
  test(`S4a: dead-boot con sonda ${nome} -> proven-dead e riconciliabile (server: dead-boot, sessione assente)`, async (t) => {
    const { d, runtime } = await mondoDeadBoot(t, { sonda: sonda(esito) });
    const st = await runtime.launchState(d.cella);
    assert.equal(st.classification, 'proven-dead', JSON.stringify(st));
    assert.equal(st.reconcilable, true, JSON.stringify(st.blockers));
    assert.equal(st.proofs.server, 'dead-boot');
    assert.equal(st.proofs.session, 'absent');
  });
}

test('S4a: dead-boot con un server che SERVE il socket corrente e nessuna omonima -> assente', async (t) => {
  const { d, runtime } = await mondoDeadBoot(t, { sonda: sonda('connect') });
  const st = await runtime.launchState(d.cella);
  assert.equal(st.proofs.server, 'dead-boot', JSON.stringify(st.proofs));
  assert.equal(st.proofs.session, 'absent', 'has-session sul server corrente, predicato stretto');
  assert.equal(st.reconcilable, true);
});

test('S4a: dead-boot con omonima PRESENTE sul server corrente -> SESSION_PRESENT, non riconciliabile', async (t) => {
  const { d, runtime } = await mondoDeadBoot(t, { sonda: sonda('connect'), scenario: { omonima: true } });
  const st = await runtime.launchState(d.cella);
  assert.ok(st.blockers.includes('SESSION_PRESENT'), JSON.stringify(st.blockers));
  assert.equal(st.reconcilable, false);
});

for (const [nome, esito] of [['timeout', 'timeout'], ['EACCES', 'eacces'], ['altro errore', 'unknown']]) {
  test(`S4a: sonda ${nome} -> SESSION_UNKNOWN, nessuna chiusura`, async (t) => {
    const { d, runtime } = await mondoDeadBoot(t, { sonda: sonda(esito) });
    const st = await runtime.launchState(d.cella);
    assert.ok(st.blockers.includes('SESSION_UNKNOWN'), `${nome}: ${JSON.stringify(st.blockers)}`);
    assert.equal(st.reconcilable, false, nome);
  });
}

test('S4a: sonda oltre la deadline -> BUDGET, mai assenza tardiva', async (t) => {
  const lenta = async () => {
    await new Promise((r) => setTimeout(r, 300));
    return { esito: 'econnrefused' };
  };
  const { d, runtime } = await mondoDeadBoot(t, { sonda: lenta, cfg: { groupStopBudgetMs: 200 } });
  const st = await runtime.launchState(d.cella);
  assert.ok(st.blockers.includes('BUDGET'), JSON.stringify(st.blockers));
  assert.equal(st.reconcilable, false);
});

// --- le vie STRETTE di sempre restano strette ------------------------------

test('S4a: stesso boot -> ramo dead-boot NON si apre (socket diverso = SERVER_UNKNOWN)', async (t) => {
  const { d, runtime } = await mondoDeadBoot(t, {
    sonda: sonda('econnrefused'), record: { bootId: BOOT_ORA },
  });
  const st = await runtime.launchState(d.cella);
  assert.ok(st.blockers.includes('SERVER_UNKNOWN'), JSON.stringify(st.blockers));
  assert.notEqual(st.proofs.server, 'dead-boot');
});

test('S4a: owner diverso -> proveBoot false, via stretta', async (t) => {
  const { d, runtime } = await mondoDeadBoot(t, {
    sonda: sonda('econnrefused'), record: { owner: 'cd'.repeat(16) },
  });
  const st = await runtime.launchState(d.cella);
  assert.ok(st.blockers.includes('SERVER_UNKNOWN'), JSON.stringify(st.blockers));
});

test('S4a: namespace diverso -> proveBoot false, via stretta', async (t) => {
  const { d, runtime } = await mondoDeadBoot(t, {
    sonda: sonda('econnrefused'), record: { pidNs: '4026531999' },
  });
  const st = await runtime.launchState(d.cella);
  assert.ok(st.blockers.includes('SERVER_UNKNOWN'), JSON.stringify(st.blockers));
});

test('S4a: dead-boot con lo STESSO socket del record -> via stretta, la sonda non si chiama', async (t) => {
  const { sharedTmuxSocketPath } = require('../lib/runtime/env.js');
  let chiamata = 0;
  const mai = async () => { chiamata += 1; return { esito: 'econnrefused' }; };
  const { d, runtime } = await mondoDeadBoot(t, {
    sonda: mai, record: { socket: sharedTmuxSocketPath() },
  });
  const st = await runtime.launchState(d.cella);
  assert.equal(chiamata, 0, 'il ramo dead-boot si apre solo con un socket diverso');
  assert.equal(st.proofs.server, 'dead', JSON.stringify(st));
  assert.equal(st.proofs.session, 'absent');
});

test('S4a: dead-boot con il PID del server riusato da un processo vivo -> resta dead-boot', async (t) => {
  // PID riusato: il numero del record ora appartiene a un processo VIVO del
  // test con una nascita diversa. Nel ramo dead-boot l'identita' del server del
  // boot morto non entra nel giudizio: la prova resta la sonda.
  const vivo = figlioVivo(t);
  const { d, runtime } = await mondoDeadBoot(t, {
    sonda: sonda('econnrefused'),
    record: { created: { serverPid: vivo.pid, serverStarttime: 1 } },
  });
  const st = await runtime.launchState(d.cella);
  assert.equal(st.classification, 'proven-dead', JSON.stringify(st));
  assert.equal(st.proofs.server, 'dead-boot');
  assert.equal(st.proofs.session, 'absent');
});

// --- end-to-end: il caso B8 chiude da solo ---------------------------------

test('S4a end-to-end: dead-boot + sonda ECONNREFUSED -> up 200, vecchio record in quarantena, nuovo lancio', async (t) => {
  const { d, runtime } = await mondoDeadBoot(t, { sonda: sonda('econnrefused') });
  const primaLettura = launchTarget.leggi(d.filesRoot, d.sessione);
  assert.equal(primaLettura.record.launchId, LID);
  const esito = await runtime.up(d.cella).then((r) => ({ ok: r.ok === true }), (e) => ({ ok: false, code: e.fleetCode, msg: e.message }));
  assert.equal(esito.ok, true, `up rifiutato: ${JSON.stringify(esito)}`);
  assert.ok(fs.existsSync(launchTarget.percorsoQuarantena(d.filesRoot, d.sessione, LID)), 'vecchio record in quarantena');
  const dopo = launchTarget.leggi(d.filesRoot, d.sessione);
  assert.equal(dopo.stato, 'presente');
  assert.notEqual(dopo.record.launchId, LID, 'record nuovo');
});
