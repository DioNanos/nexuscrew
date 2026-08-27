'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const L = require('../lib/fleet/cell-lease.js');
const { loadOrCreateVerifier, signProof } = require('../lib/fleet/lease-verifier.js');

// Coppia server/client su un server TCP throwaway: lato "server" passato al
// manager come connessione broker one-shot, lato "client" per scrivere/EOF.
function pair() {
  return new Promise((resolve, reject) => {
    let pending = null;
    const srv = net.createServer((sock) => {
      pending = sock;
    });
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      const client = net.createConnection(port, '127.0.0.1', () => {
        // attendi che il server abbia il socket
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

// Il timeout di recv e' una guardia di liveness, non un'asserzione sul tempo:
// il messaggio o arriva (loopback in-process, di norma pochi ms) o non arriva
// mai (difetto). Il vecchio default di 500ms non proteggeva niente e sotto load
// di base >7 (flotta attiva, runner a concorrenza 2) un event loop satura
// superava i 500ms di scheduling e il file dava rossi casuali nel gate, verdi
// in isolamento — la firma esatta del debito soglie di README-flake.md.
// 5000ms coprono il «mai» restando invisibili quando tutto va bene.
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

function setup() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-'));
  const clock = { t: 10_000 };
  const mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
  return { home, clock, mgr };
}

const runDir = (home) => path.join(home, '.nexuscrew', 'run');

// L'EOF arma la grace in modo asincrono (il FIN attraversa il pair): un'attesa
// fissa e' una race sotto carico — nel runner completo il FIN non arrivava
// sempre entro 30ms e il test falsava «live». La proprieta' da provare e'
// «EOF arma la grace (una volta, con quella deadline)», non «entro 30ms».
async function untilNotLive(mgr, cellId, timeoutMs = 2000) {
  const t0 = Date.now();
  for (;;) {
    const st = mgr.status(cellId);
    if (st.state !== 'live') return st;
    if (Date.now() - t0 > timeoutMs) return st;
    await new Promise((r) => setTimeout(r, 5));
  }
}

const cellStateFile = (home, cellId) => path.join(runDir(home), 'cell-leases', `${cellId}.json`);

// 2b: apre il lease dal percorso di produzione e cattura il primo proof che il
// server consegna — con l'ACK del refresh immediato del supervisore
// (attachInitial NON scrive sul canale: durante la consegna del payload il
// canale appartiene al protocollo del broker). E' l'equivalente 2b del vecchio
// `info.capability`: il proof sostituisce la capability statica revocata (A2).
async function attachWithProof(mgr, cellId, clock, { generation = 0 } = {}) {
  const info = await mgr.track(cellId);
  const { serverSide, client } = await pair();
  assert.equal(mgr.attachInitial(cellId, serverSide, { generation }), true);
  client.write(`${JSON.stringify({ type: 'refresh' })}\n`);
  const ack = await recv(client, (m) => m.type === 'ack' && m.proof);
  return { info, client, proof: ack.proof, leaseId: mgr.status(cellId).leaseId };
}

// 2b: firma un proof con la chiave per-installazione della dir di test — la
// stessa che userebbe il server. Per fixture sintetiche (identity scritta a
// mano) e per isolare la causa di un deny (proof fresco => la scadenza NON e'
// il motivo, resta il bound di grace).
function forgeProof(home, clock, claims, { issuedAt = null } = {}) {
  const v = loadOrCreateVerifier({ dir: runDir(home) });
  return signProof(v, { ...claims, issuedAt: issuedAt == null ? clock.t : issuedAt }, { now: () => clock.t });
}

// Scrive una entry per-cella a mano (formato 2b: {launchEpoch, graceDeadline}).
function writeLeaseEntry(home, cellId, entry) {
  const file = cellStateFile(home, cellId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(entry), { mode: 0o600 });
  return file;
}

function reconnect(stablePath, msg) {
  return new Promise((resolve, reject) => {
    const rc = net.createConnection(stablePath, () => {
      rc.write(`${JSON.stringify(msg)}\n`);
    });
    recv(rc, (m) => m.type === 'lease' || m.type === 'deny').then(resolve, reject);
    rc.once('error', reject);
  });
}

test('track apre endpoint stabile 0o600, identity per-cell; nessuna capability (A2/B1)', async () => {
  const { home, mgr } = setup();
  try {
    const info = await mgr.track('Dev');
    assert.ok(info.stablePath.startsWith(home), 'stablePath sotto runtime dir');
    assert.match(path.basename(info.stablePath), /^cell-Dev\.sock$/, 'path stabile, non casuale');
    assert.ok(info.launchEpoch && /^[a-f0-9]+$/.test(info.launchEpoch));
    assert.equal('capability' in info, false, '2b: nessuna capability statica nel ritorno di track');
    const st = fs.statSync(info.stablePath);
    assert.equal(st.mode & 0o077, 0, 'endpoint stabile 0o600');
    // state persistito PER CELLA (D1), senza segreti (C5)
    const persisted = JSON.parse(fs.readFileSync(cellStateFile(home, 'Dev'), 'utf8'));
    assert.equal(persisted.launchEpoch, info.launchEpoch);
    assert.equal('capability' in persisted, false);
    assert.ok(Number.isInteger(persisted.graceDeadline));
  } finally { mgr.close(); }
});

test('R3.3.2: il fallimento del chmod sull endpoint stabile NON viene ingoiato (track reject)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-chmod-'));
  // chmodSync throwa: il suo fallimento deve propagarsi, non essere ingoiato.
  const fakeFs = { ...fs, chmodSync: () => { throw new Error('chmod denied'); } };
  const mgr = createLeaseManager({ home, log: () => {} }, { now: () => 10_000, fs: fakeFs });
  try {
    await assert.rejects(() => mgr.track('Dev'), /chmod denied/, 'chmod fallito -> track reject (non ingoiato)');
  } finally { mgr.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

// F-C (audit 2a @ 142e272): il contratto del mode e' cambiato PER DECISIONE
// approvata. Prima: la socket NASCEVA 0o600 via umask(0o177) al bind — atomica
// rispetto a un umask di processo permissivo, ma process.umask e' GLOBALE e la
// coppia set/restore non e' atomica sotto openEndpoint concorrenti (40/40 drift,
// sonda). A CHE COSA SI RINUNCIA: l'atomicita' del mode di nascita. Ora la
// socket PUO' nascere permissiva quanto l'umask di processo; la protezione e'
// (1) la directory owner-only verificata a OGNI bind (ensureRuntimeDir, sul
// percorso stesso, subito prima del listen) e (2) il chmod 0o600 FORZATO subito
// dopo, che NON ingoia il fallimento (test sopra: chmod denied -> track reject).
// Questo test pinna il nuovo contratto per intero, umask(0) incluso.
test('F-C: socket puo\' nascere permissiva; chmod 0o600 forzato la chiude; dir 0o700 copre la finestra; umask mai toccato', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-mode-'));
  const prevUmask = process.umask(0o000);
  try {
    const mgr = createLeaseManager({ home, log: () => {} }, { now: () => 10_000 });
    try {
      const info = await mgr.track('Dev');
      // umask(0) di processo: senza l'umask al bind la socket nascerebbe 0o777;
      // il chmod 0o600 forzato (reale, non no-op) porta il mode finale a 0o600.
      const st = fs.statSync(info.stablePath);
      assert.equal(st.mode & 0o077, 0, 'umask(0): il chmod forzato chiude il mode a 0o600');
      // La finestra listen->chmod e' coperta dalla DIRECTORY owner-only, non dal
      // mode di nascita: nessun altro utente puo' attraversarla.
      const run = fs.statSync(path.dirname(info.stablePath));
      assert.equal(run.mode & 0o077, 0, 'la dir runtime e\' 0o700 (owner-only)');
      // E il manager non muta MAI process.umask: il drift e' impossibile per
      // costruzione, non per contenimento.
      assert.equal(process.umask(), 0o000, 'process.umask resta quello del processo (nessun drift)');
    } finally { mgr.close(); }
  } finally { process.umask(prevUmask); fs.rmSync(home, { recursive: true, force: true }); }
});

test('attachInitial -> live; EOF -> grace con deadline = EOF+60s NON estendibile', async () => {
  const { clock, mgr } = setup();
  try {
    const info = await mgr.track('Dev');
    const { serverSide, client } = await pair();
    assert.equal(mgr.attachInitial('Dev', serverSide, { generation: 0 }), true);
    assert.equal(mgr.status('Dev').state, 'live');
    // EOF dal client
    clock.t = 20_000;
    client.end();
    const g = await untilNotLive(mgr, 'Dev');
    assert.equal(g.state, 'grace');
    assert.equal(g.graceDeadline, 20_000 + 60_000, 'deadline = EOF + grace');
    client.destroy();
  } finally { mgr.close(); }
});

test('reconnect con proof entro grace -> lease NUOVO (leaseId diverso), stessa identita, live', async () => {
  const { clock, mgr } = setup();
  try {
    const { info, client, proof } = await attachWithProof(mgr, 'Dev', clock);
    const firstLeaseId = mgr.status('Dev').leaseId;
    clock.t = 5_000;
    client.end();
    await untilNotLive(mgr, 'Dev');
    assert.equal(mgr.status('Dev').state, 'grace');
    // reconnect entro grace col proof detenuto (2b: niente capability)
    clock.t = 30_000;
    const reply = await reconnect(info.stablePath, { type: 'reconnect', generation: 0, proof });
    assert.equal(reply.type, 'lease', 'reconnect accettato entro grace');
    assert.notEqual(reply.leaseId, firstLeaseId, 'lease NUOVO, leaseId diverso (non resurrezione)');
    assert.equal(mgr.status('Dev').state, 'live');
    assert.equal(mgr.status('Dev').leaseId, reply.leaseId);
    assert.ok(reply.proof && reply.proof.leaseId === reply.leaseId, 'il lease nuovo consegna il proprio proof');
  } finally { mgr.close(); }
});

test('R3.3.4: reconnect accetta SOLO la transizione legittima (generation === current o current+1); salto avanti arbitrario o all indietro -> deny', async () => {
  const { clock, mgr } = setup();
  try {
    const { info, client, proof } = await attachWithProof(mgr, 'Dev', clock);
    clock.t = 5_000;
    client.end();
    // EOF attraverso il pair: attesa guidata dall'evento (stato non piu' live),
    // non dal cronometro — 30ms fissi erano una race sotto carico (vedi
    // untilNotLive). Il gemello «regressione auditor» aspetta gia' cosi'.
    await untilNotLive(mgr, 'Dev');
    // reconnect che AVANZA la generation di ESATTAMENTE 1 (un restart del
    // supervisore, cell-exec.js `generation += 1`): transizione legittima -> lease.
    clock.t = 30_000;
    const a1 = await reconnect(info.stablePath, { type: 'reconnect', generation: 1, proof });
    assert.equal(a1.type, 'lease', 'avanzamento legittimo 0->1 (un restart del supervisore) accettato');
    await untilNotLive(mgr, 'Dev'); // EOF -> grace sul lease gen 1
    // reconnect con generation 99 (salto AVANTI arbitrario, non +1): deny. Il
    // supervisore onesto non presenterebbe mai 99 partendo da 1 (avanza di 1).
    // Il proof qui e' quello del lease gen-1 (fresco, jti non consumato): il
    // deny deve arrivare dalla GENERATION, non dal proof.
    clock.t = 31_000;
    const a2 = await reconnect(info.stablePath, { type: 'reconnect', generation: 99, proof: a1.proof });
    assert.equal(a2.type, 'deny', 'R3.3.4: salto avanti arbitrario (1->99) rifiutato (non transizione attesa)');
    // reconnect con generation 0 (all indietro, stale): deny.
    clock.t = 32_000;
    const a3 = await reconnect(info.stablePath, { type: 'reconnect', generation: 0, proof: a1.proof });
    assert.equal(a3.type, 'deny', 'R3.3.4: generation all indietro (1->0) rifiutata (stale)');
  } finally { mgr.close(); }
});

test('R3.3.4 regressione auditor: generation 0->99 (salto arbitrario) su lease in grace -> deny', async () => {
  // Sonda diretta del difetto dell audit (requested=0->99, server_state=grace).
  // Il guard precedente (`incoming >= current`) accettava qualunque salto avanti;
  // il server deve esigere una transizione verificabile, non solo non-decreasing.
  const { clock, mgr } = setup();
  try {
    const { info, client, proof } = await attachWithProof(mgr, 'Dev', clock);
    assert.equal(mgr.status('Dev').state, 'live');
    clock.t = 5_000;
    client.end();
    await untilNotLive(mgr, 'Dev');
    // lease in grace (vivo), reconnect con generation 99 (salto arbitrario da 0): deny.
    clock.t = 30_000;
    const reply = await reconnect(info.stablePath, { type: 'reconnect', generation: 99, proof });
    assert.equal(reply.type, 'deny', '0->99 e un salto arbitrario, non la transizione attesa -> deny');
  } finally { mgr.close(); }
});

test('reconnect con proof di un altra cella, contraffatto o di kind sbagliato -> deny', async () => {
  const { home, clock, mgr } = setup();
  try {
    const { info, client, proof } = await attachWithProof(mgr, 'Dev', clock);
    client.end();
    await untilNotLive(mgr, 'Dev');
    // proof di un altra cella (claims firmati per Beta): la firma e' valida ma
    // i claims attesi (cellId=Dev) non combaciano -> deny.
    const betaProof = forgeProof(home, clock, { kind: 'lease', cellId: 'Beta', launchEpoch: proof.launchEpoch, leaseId: proof.leaseId, generation: '0', jti: 'a'.repeat(16) });
    const d1 = await reconnect(info.stablePath, { type: 'reconnect', generation: 0, proof: betaProof });
    assert.equal(d1.type, 'deny', 'proof di un altra cella -> deny');
    // firma contraffatta
    const d2 = await reconnect(info.stablePath, { type: 'reconnect', generation: 0, proof: { ...proof, proof: '0'.repeat(64) } });
    assert.equal(d2.type, 'deny', 'firma contraffatta -> deny');
    // kind sbagliato (scope separation, B4)
    const childProof = forgeProof(home, clock, { kind: 'child', cellId: 'Dev', incarnationId: 'b'.repeat(16), jti: 'c'.repeat(16) });
    const d3 = await reconnect(info.stablePath, { type: 'reconnect', generation: 0, proof: childProof });
    assert.equal(d3.type, 'deny', 'proof kind child non vale per il reconnect (proofKind firmato) -> deny');
  } finally { mgr.close(); }
});

test('reconnect oltre grace -> deny (R3.3.5) — proof fresco: il deny e della grace, non della scadenza', async () => {
  const { home, clock, mgr } = setup();
  try {
    const { info, client, proof } = await attachWithProof(mgr, 'Dev', clock);
    clock.t = 5_000;
    client.end();
    await untilNotLive(mgr, 'Dev');
    // ora oltre la deadline (grace scaduta). Il proof detenuto e' scaduto pure:
    // per isolare la CAUSA firmino un proof fresco (il server ne emetterebbe uno
    // legittimo fino all'ultimo refresh) — resta solo il bound di grace a negare.
    clock.t = 5_000 + 60_001;
    const fresh = forgeProof(home, clock, { kind: 'lease', cellId: 'Dev', launchEpoch: info.launchEpoch, leaseId: proof.leaseId, generation: '0', jti: 'd'.repeat(16) });
    const reply = await reconnect(info.stablePath, { type: 'reconnect', generation: 0, proof: fresh });
    assert.equal(reply.type, 'deny', 'reconnect oltre grace -> deny');
  } finally { mgr.close(); }
});

test('R3.3.5 post-restart: reconnect oltre la grace rifiutato anche con lease null (bound persistito per-cell)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-beyond-'));
  const clock = { t: 10_000 };
  let mgr = null; let pairClient = null;
  try {
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    const { info, client, proof } = await attachWithProof(mgr, 'Dev', clock);
    pairClient = client;
    // EOF arma la grace: deadline = 5_000 + 60_000 = 65_000, persistita come bound per-cell.
    clock.t = 5_000;
    client.end();
    await untilNotLive(mgr, 'Dev');
    pairClient = null;
    // restart del server: nessun lease sopravvive, ma il bound di grace resta persistito.
    mgr.close(); mgr = null;
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    await mgr.boot();
    assert.equal(mgr.status('Dev').state, 'none', 'lease null post-restart (fail-closed)');
    // reconnect OLTRE la grace con proof FRESCO (isola la causa): lease null ma bound noto -> deny.
    clock.t = 65_000 + 600_001;
    const fresh = forgeProof(home, clock, { kind: 'lease', cellId: 'Dev', launchEpoch: info.launchEpoch, leaseId: proof.leaseId, generation: '0', jti: 'e'.repeat(16) });
    const reply = await reconnect(info.stablePath, { type: 'reconnect', generation: 0, proof: fresh });
    assert.equal(reply.type, 'deny', 'R3.3.5: reconnect oltre la grace rifiutato anche post-restart (lease null)');
  } finally {
    try { if (pairClient) pairClient.destroy(); } catch (_) {}
    try { if (mgr) mgr.close(); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});

test('R3.3.5 post-restart: reconnect ESATTAMENTE alla graceDeadline rifiutato (bound >= , non >)', async () => {
  // Off-by-one: con entry.lease===null il guard post-restart usava `now > graceDeadline`,
  // aprendo un lease alla deadline esatta. La transizione pura (cell-lease.js) usa `>=`:
  // alla deadline la grace e' gia scaduta.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-deadline-'));
  const clock = { t: 10_000 };
  let mgr = null; let pairClient = null;
  try {
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    const { info, client, proof } = await attachWithProof(mgr, 'Dev', clock);
    pairClient = client;
    clock.t = 5_000;
    client.end();
    await untilNotLive(mgr, 'Dev');
    pairClient = null;
    // restart: lease null, bound di grace persistito.
    mgr.close(); mgr = null;
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    await mgr.boot();
    assert.equal(mgr.status('Dev').state, 'none', 'lease null post-restart (fail-closed)');
    // reconnect ESATTAMENTE alla deadline (now === graceDeadline) con proof fresco: deny.
    // IC1.2 (rev28): il bound non regredisce piu' — il back-step del fixture
    // (clock.t=5_000 prima dell'EOF) non abbassa piu' il bound a 65_000: resta
    // 70_000 (il max). La proprieta' off-by-one pinna da questo test (`>=`,
    // non `>`) si conserva ancorando il reconnect alla deadline REALE su disco,
    // non a quella che il bound avrebbe con la regressione vietata.
    const boundOnDisk = JSON.parse(fs.readFileSync(cellStateFile(home, 'Dev'), 'utf8')).graceDeadline;
    clock.t = boundOnDisk;
    const fresh = forgeProof(home, clock, { kind: 'lease', cellId: 'Dev', launchEpoch: info.launchEpoch, leaseId: proof.leaseId, generation: '0', jti: 'f'.repeat(16) });
    const reply = await reconnect(info.stablePath, { type: 'reconnect', generation: 0, proof: fresh });
    assert.equal(reply.type, 'deny', 'alla deadline esatta (now === graceDeadline) la grace e gia scaduta -> deny');
  } finally {
    try { if (pairClient) pairClient.destroy(); } catch (_) {}
    try { if (mgr) mgr.close(); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});

test('refresh: heartbeat -> ack (+ proof nuovo); non cambia state live', async () => {
  const { clock, mgr } = setup();
  try {
    await mgr.track('Dev');
    const { serverSide, client } = await pair();
    mgr.attachInitial('Dev', serverSide, { generation: 0 });
    clock.t = 25_000;
    client.write(`${JSON.stringify({ type: 'refresh' })}\n`);
    const ack = await recv(client, (m) => m.type === 'ack');
    assert.equal(ack.type, 'ack');
    assert.ok(ack.proof && ack.proof.kind === 'lease', 'il refresh consegna un proof nuovo (B1)');
    assert.equal(mgr.status('Dev').state, 'live', 'refresh mantiene live');
    client.destroy();
  } finally { mgr.close(); }
});

test('restart server fail-closed: boot() recovery ripristina identity + endpoint; reconnect col proof detenuto ricostruisce (percorso produzione)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-restart-'));
  const clock = { t: 10_000 };
  let mgr = null; let pairClient = null;
  try {
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    const { info, client, proof } = await attachWithProof(mgr, 'Dev', clock);
    pairClient = client;
    assert.equal(mgr.status('Dev').state, 'live');
    try { client.destroy(); pairClient = null; } catch (_) {}
    // restart del server: manager chiuso e ricreato. Nessun lease sopravvive.
    mgr.close(); mgr = null;
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    // PRODUZIONE: boot() ripristina l'identity persistita e RIAPRE l'endpoint
    // stabile. Il proof detenuto dal supervisore verifica con la chiave
    // per-installazione persistita: la recovery non ha bisogno di capability.
    await mgr.boot();
    assert.equal(mgr.status('Dev').state, 'none', 'fail-closed: nessun lease sopravvive al restart');
    clock.t = 12_000;
    const reply = await reconnect(info.stablePath, { type: 'reconnect', generation: 0, proof });
    assert.equal(reply.type, 'lease', 'reconnect post-restart ricostruisce il lease (proof verificato dal verifier persistito)');
    assert.equal(mgr.status('Dev').state, 'live');
  } finally {
    try { if (pairClient) pairClient.destroy(); } catch (_) {}
    try { if (mgr) mgr.close(); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});

test('B3/GC1: post-restart con cella LIVE il reconnect oltre il bound live (now+GRACE_MS) e negato (no fail-open null)', async () => {
  // GC1.1: graceDeadline sempre valorizzato (cella live = now+GRACE_MS), mai null.
  // Su HEAD il bound live persistito era null -> post-restart un reconnect oltre era lease (fail-open).
  // Con GC1 il bound e' now+GRACE_MS -> oltre quel bound, deny.
  // Fixture dal percorso di produzione (track + attachInitial -> bindLiveSocket). Nessun EOF.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-b3-livebound-'));
  const clock = { t: 10_000 };
  let mgr = null; let pairClient = null;
  try {
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    const { info, client, proof } = await attachWithProof(mgr, 'Dev', clock);
    pairClient = client;
    assert.equal(mgr.status('Dev').state, 'live');
    // Chiusura del manager SENZA processare l'EOF (detachSocket rimuove i listener
    // close/end prima del destroy): il bound persistito resta quello live.
    mgr.close(); mgr = null;
    pairClient = null;
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    await mgr.boot();
    assert.equal(mgr.status('Dev').state, 'none', 'fail-closed: lease null post-restart');
    // reconnect OLTRE il bound live (10_000 + GRACE_MS) con proof FRESCO: deny del bound.
    clock.t = 10_000 + L.GRACE_MS + 1;
    const fresh = forgeProof(home, clock, { kind: 'lease', cellId: 'Dev', launchEpoch: info.launchEpoch, leaseId: proof.leaseId, generation: '0', jti: '1'.repeat(16) });
    const reply = await reconnect(info.stablePath, { type: 'reconnect', generation: 0, proof: fresh });
    assert.equal(reply.type, 'deny', 'B3: reconnect oltre il bound live valorizzato -> deny (no piu fail-open null)');
  } finally {
    try { if (pairClient) pairClient.destroy(); } catch (_) {}
    try { if (mgr) mgr.close(); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});

test('B3/GC1.6: graceDeadline illeggibile/non-intero su disco = grace gia scaduta = deny', async () => {
  // GC1.6: assente/illeggibile/non-intero -> grace scaduta -> deny.
  // Fixture prodotta dal percorso (track + attachInitial + EOF), poi bound corroto.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-b3-corrupt-'));
  const clock = { t: 10_000 };
  let mgr = null; let pairClient = null;
  try {
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    const { info, client, proof } = await attachWithProof(mgr, 'Dev', clock);
    pairClient = client;
    clock.t = 5_000;
    client.end();
    await untilNotLive(mgr, 'Dev'); // EOF -> bound armGrace persistito
    try { pairClient.destroy(); pairClient = null; } catch (_) {}
    mgr.close(); mgr = null;
    // Corrompi il bound su disco (file per-cell): valore non-intero.
    const raw = JSON.parse(fs.readFileSync(cellStateFile(home, 'Dev'), 'utf8'));
    raw.graceDeadline = 'NOT-AN-INTEGER';
    fs.writeFileSync(cellStateFile(home, 'Dev'), JSON.stringify(raw), { mode: 0o600 });
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    await mgr.boot();
    // qualunque now con proof fresco: bound non-intero -> scaduto -> deny
    clock.t = 5_000 + 1;
    const fresh = forgeProof(home, clock, { kind: 'lease', cellId: 'Dev', launchEpoch: info.launchEpoch, leaseId: proof.leaseId, generation: '0', jti: '2'.repeat(16) });
    const reply = await reconnect(info.stablePath, { type: 'reconnect', generation: 0, proof: fresh });
    assert.equal(reply.type, 'deny', 'GC1.6: graceDeadline non-intero -> grace scaduta -> deny');
  } finally {
    try { if (pairClient) pairClient.destroy(); } catch (_) {}
    try { if (mgr) mgr.close(); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});

test('B3/GC1.2: refresh rinfresca il bound durevole su disco (now+GRACE_MS), per-cell', async () => {
  // GC1.1/GC1.2: il refresh rinfresca il bound e lo persiste PRIMA dell'ACK.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-b3-refresh-'));
  const clock = { t: 10_000 };
  let mgr = null; let client = null;
  try {
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    await mgr.track('Dev');
    const { serverSide, client: c } = await pair();
    client = c;
    mgr.attachInitial('Dev', serverSide, { generation: 0 });
    const stateFile = cellStateFile(home, 'Dev');
    const boundBefore = JSON.parse(fs.readFileSync(stateFile, 'utf8')).graceDeadline;
    clock.t = 30_000;
    client.write(`${JSON.stringify({ type: 'refresh' })}\n`);
    const ack = await recv(client, (m) => m.type === 'ack');
    assert.equal(ack.type, 'ack');
    const boundAfter = JSON.parse(fs.readFileSync(stateFile, 'utf8')).graceDeadline;
    assert.equal(boundAfter, 30_000 + L.GRACE_MS, 'GC1.2: refresh rinfresca il bound a now+GRACE_MS');
    assert.notEqual(boundAfter, boundBefore, 'il bound e cambiato dopo il refresh');
  } finally {
    try { if (client) client.destroy(); } catch (_) {}
    try { if (mgr) mgr.close(); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});

test('B3/GC1.2: persistenza fallita nel refresh = nessun ACK e nessun proof (errore non ingoiato)', async () => {
  // GC1.2: se writePersisted non committa al refresh, nessun ACK (e nessun proof
  // nuovo: il detentore resta col proof vecchio, che scade per conto suo).
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-b3-noack-'));
  const clock = { t: 10_000 };
  let writeFail = false;
  const fakeFs = { ...fs, writeFileSync(...args) { if (writeFail) throw new Error('disk full'); return fs.writeFileSync(...args); } };
  let mgr = null; let client = null;
  try {
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t, fs: fakeFs });
    await mgr.track('Dev');
    const { serverSide, client: c } = await pair();
    client = c;
    mgr.attachInitial('Dev', serverSide, { generation: 0 });
    writeFail = true; // da qui writePersisted fallisce
    clock.t = 30_000;
    client.write(`${JSON.stringify({ type: 'refresh' })}\n`);
    await assert.rejects(() => recv(client, (m) => m.type === 'ack', 250), /recv timeout/, 'GC1.2: nessun ACK quando la persistenza del bound fallisce');
  } finally {
    writeFail = false;
    try { if (client) client.destroy(); } catch (_) {}
    try { if (mgr) mgr.close(); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});

// P1-1 (audit 3405df0) nasceva con lo store unico: la RMW del refresh che
// rileggeva TUTTO lo store poteva cancellare le altre celle su errore di
// lettura. Con lo storage per-cell (D1) il refresh non rilegge piu' nulla e
// scrive solo il proprio file: la garanzia equivalente ("il refresh di una
// cella non tocca le altre") e' provata in tests/cell-lease-proof.test.js
// (test D1/E3). Nessuna RMW condivisa, nessuna cancellazione possibile.

// Fixture normativa (FC1 rev26 / P1-3 audit 3405df0): produce lo stato della cella
// DAL PERCORSO DI PRODUZIONE — track + attachInitial (bindLiveSocket) + almeno un
// refresh con ACK — verifica che il bound rinfrescato sia un intero riletto da disco,
// poi restart via boot(). I casi di reconnect (entro/alla deadline/oltre) e la
// corruzione negativa poggiano su questa fixture, MAI su un file scritto a mano:
// il formato riletto dopo restart deve essere quello emesso dal refresh.
async function liveBoundFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-fixture-'));
  const clock = { t: 10_000 };
  const stateFile = cellStateFile(home, 'Dev');
  let mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
  const info = await mgr.track('Dev');
  const { serverSide, client } = await pair();
  mgr.attachInitial('Dev', serverSide, { generation: 0 });
  // almeno un refresh con ACK: rinfresca il bound a now+GRACE_MS, lo persiste (GC1)
  // e consegna un proof nuovo (2b) — quello che il supervisore detiene da qui.
  clock.t = 30_000;
  client.write(`${JSON.stringify({ type: 'refresh' })}\n`);
  const ack = await recv(client, (m) => m.type === 'ack');
  if (!ack || ack.type !== 'ack' || !ack.proof) { try { client.destroy(); mgr.close(); } catch (_) {} throw new Error('fixture: refresh non ACKato con proof'); }
  const proof = ack.proof;
  // verifica: il bound riletto da disco e' l'intero atteso (now+GRACE_MS), non null.
  const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const bound = onDisk.graceDeadline;
  try { client.destroy(); } catch (_) {}
  if (!Number.isInteger(bound) || bound !== 30_000 + L.GRACE_MS) { try { mgr.close(); } catch (_) {} throw new Error(`fixture: bound atteso ${30_000 + L.GRACE_MS}, got ${bound}`); }
  // restart via boot(): nessun lease sopravvive (fail-closed); il bound persistito resta.
  mgr.close(); mgr = null;
  mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
  await mgr.boot();
  const f = { home, clock, mgr, info, stateFile, bound, proof };
  f.cleanup = () => { try { f.mgr.close(); } catch (_) {} try { fs.rmSync(f.home, { recursive: true, force: true }); } catch (_) {} };
  return f;
}

test('P1-3 fixture normativa: bind + refresh(ACK) + restart/boot; reconnect entro il bound col proof -> lease', async () => {
  const f = await liveBoundFixture();
  try {
    assert.equal(f.mgr.status('Dev').state, 'none', 'fail-closed: lease null post-restart');
    assert.equal(f.bound, 30_000 + L.GRACE_MS, 'bound intero rinfrescato dal refresh, riletto da disco');
    f.clock.t = f.bound - 1;
    const reply = await reconnect(f.info.stablePath, { type: 'reconnect', generation: 0, proof: f.proof });
    assert.equal(reply.type, 'lease', 'entro il bound rinfrescato, col proof del refresh -> lease (recovery)');
  } finally { f.cleanup(); }
});

test('P1-3 fixture normativa: reconnect ALLA deadline (bound rinfrescato) -> deny', async () => {
  const f = await liveBoundFixture();
  try {
    f.clock.t = f.bound;
    const reply = await reconnect(f.info.stablePath, { type: 'reconnect', generation: 0, proof: f.proof });
    assert.equal(reply.type, 'deny', 'alla deadline (bound rinfrescato dal refresh) -> deny');
  } finally { f.cleanup(); }
});

test('P1-3 fixture normativa: reconnect OLTRE il bound (rinfrescato), proof fresco -> deny', async () => {
  const f = await liveBoundFixture();
  try {
    f.clock.t = f.bound + 1;
    // proof fresco firmato adesso: il deny non puo' venire dalla scadenza.
    const fresh = forgeProof(f.home, f.clock, { kind: 'lease', cellId: 'Dev', launchEpoch: f.info.launchEpoch, leaseId: f.proof.leaseId, generation: '0', jti: '3'.repeat(16) });
    const reply = await reconnect(f.info.stablePath, { type: 'reconnect', generation: 0, proof: fresh });
    assert.equal(reply.type, 'deny', 'oltre il bound (rinfrescato) -> deny');
  } finally { f.cleanup(); }
});

test('P1-3 fixture normativa, negativo: bound corroto (non-intero) partito dalla fixture reale -> deny', async () => {
  const f = await liveBoundFixture();
  try {
    // corrompe solo il bound, partendo dalla fixture reale (non riscrive l'intera entry).
    const raw = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
    raw.graceDeadline = 'CORRUPT';
    fs.writeFileSync(f.stateFile, JSON.stringify(raw), { mode: 0o600 });
    f.mgr.close();
    f.mgr = createLeaseManager({ home: f.home, log: () => {} }, { now: () => f.clock.t });
    await f.mgr.boot();
    f.clock.t = 30_001;
    const fresh = forgeProof(f.home, f.clock, { kind: 'lease', cellId: 'Dev', launchEpoch: f.info.launchEpoch, leaseId: f.proof.leaseId, generation: '0', jti: '4'.repeat(16) });
    const reply = await reconnect(f.info.stablePath, { type: 'reconnect', generation: 0, proof: fresh });
    assert.equal(reply.type, 'deny', 'bound corroto (non-intero) partito dalla fixture reale -> deny');
  } finally { f.cleanup(); }
});

// P1-1b (audit 2a05db2): la guardia era a livello I/O; il difetto era la FORMA
// del dato. Con lo store per-cell la radice non-oggetto riguarda il SINGOLO file
// della cella: boot() deve saltare quella cella (fail-closed), non trattarla
// come vuota ne' caricarla.
test('P1-1b schema: file per-cell con root valida-JSON ma non-oggetto -> cella saltata al boot', async () => {
  const badRoots = ['[]', 'null', '42', '"oops"'];
  for (const badRoot of badRoots) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-p1-schema-'));
    const clock = { t: 10_000 };
    let mgr = null;
    try {
      mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
      await mgr.track('Dev');
      await mgr.track('Research');
      mgr.close(); mgr = null;
      // sovrascrivi il file DI DEV con una root valida-JSON ma non-oggetto
      fs.writeFileSync(cellStateFile(home, 'Dev'), badRoot, { mode: 0o600 });
      mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
      await mgr.boot();
      const ids = [...mgr._cells.keys()].sort();
      assert.deepEqual(ids, ['Research'], `P1-1b: root '${badRoot}' non e' una entry -> solo quella cella saltata`);
    } finally {
      try { if (mgr) mgr.close(); } catch (_) {}
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
    }
  }
});

// P1-2b (audit 2a): il record durevole e' essenziale. Con lo store unico la
// lettura illeggibile PROPAGAVA perche' la RMW avrebbe riscritto TUTTO lo store
// alla cieca. Con lo storage per-cell la lettura illeggibile riguarda SOLO il
// file di quella cella: track rigenera l'identity e RIPARA il file (il danno e'
// contenuto alla cella, non all'intero store). Il guarantee originale — track
// non promette recovery senza record durevole — resta provato dal fallimento
// della SCRITTURA (test P1-2 e chmod: persist fallita -> track reject).
test('P1-2b per-cell: file della cella illeggibile -> track rigenera e ripara il record (danno contenuto alla cella)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-p1-track-'));
  const clock = { t: 10_000 };
  const stateFile = cellStateFile(home, 'Dev');
  let mgr = null;
  try {
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    const first = await mgr.track('Dev');
    mgr.close(); mgr = null;
    // rende il file illeggibile (permessi): la identity vecchia e' persa per Dev,
    // ma Research non e' coinvolta.
    fs.chmodSync(stateFile, 0o000);
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    const second = await mgr.track('Dev');
    fs.chmodSync(stateFile, 0o600);
    const repaired = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(repaired.launchEpoch, second.launchEpoch, 'record riparato con la nuova identity');
    assert.notEqual(repaired.launchEpoch, first.launchEpoch, 'identity rigenerata (il file era illeggibile)');
  } finally {
    try { fs.chmodSync(stateFile, 0o600); } catch (_) {}
    try { if (mgr) mgr.close(); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});

test('P1-2b: reconnect con bound non durevole (persist fallita) -> deny, nessun lease', async () => {
  // P1-2b: handleReconnect mandava lease anche quando il nuovo bound non committava.
  // Dev e' caricato in memoria (boot OK); poi la SCRITTURA si rompe: il reattach
  // non persiste il bound -> bindLiveSocket false -> deny (no lease finto).
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-p1-reconnect-'));
  const clock = { t: 10_000 };
  let writeFail = false;
  const fakeFs = { ...fs, writeFileSync(...args) { if (writeFail) throw new Error('disk full'); return fs.writeFileSync(...args); } };
  let mgr1 = null; let mgr2 = null; let pairClient = null;
  try {
    mgr1 = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    const { info, client, proof } = await attachWithProof(mgr1, 'Dev', clock);
    pairClient = client;
    try { client.destroy(); pairClient = null; } catch (_) {}
    mgr1.close(); mgr1 = null;
    mgr2 = createLeaseManager({ home, log: () => {} }, { now: () => clock.t, fs: fakeFs });
    await mgr2.boot(); // carica Dev dal disco OK (identity in memoria)
    writeFail = true; // da qui ogni persist fallisce
    clock.t = 12_000;
    const reply = await reconnect(info.stablePath, { type: 'reconnect', generation: 0, proof });
    assert.equal(reply.type, 'deny', 'P1-2b: reconnect con bound non durevole -> deny (no lease finto)');
  } finally {
    writeFail = false;
    try { if (pairClient) pairClient.destroy(); } catch (_) {}
    try { if (mgr2) mgr2.close(); } catch (_) {}
    try { if (mgr1) mgr1.close(); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});

// P1-1 (reaudit dd38c83): __proto__ come cellId produceva un finto successo con
// lo store unico (obj['__proto__'] invocava il setter del prototype invece di
// creare una proprieta' propria -> JSON.stringify produceva {} -> nessun record
// durevole). Con lo storage per-cell non esiste piu' NESSUN contenitore mappato
// per cellId: il cellId diventa un NOME FILE via sanitizeCell e il file contiene
// una entry a campi fissi. I tre test storici restano nella forma per-cell.
test('P1-1: __proto__ come cellId crea un file per-cell proprio (record durevole)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-proto1-'));
  const clock = { t: 10_000 };
  let mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
  try {
    const info = await mgr.track('__proto__');
    assert.ok(info.launchEpoch, 'track restituisce identity');
    const raw = fs.readFileSync(cellStateFile(home, '__proto__'), 'utf8');
    const persisted = JSON.parse(raw);
    assert.equal(persisted.launchEpoch, info.launchEpoch, 'launchEpoch durevole nel file proprio');
    assert.ok(Number.isInteger(persisted.graceDeadline));
  } finally { try { mgr.close(); } catch (_) {} try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }
});

test('P1-1: __proto__ record durevole sopravvive al restart (boot recovery)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-proto2-'));
  const clock = { t: 10_000 };
  let mgr = null; let pairClient = null;
  try {
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    const { info, client, proof } = await attachWithProof(mgr, '__proto__', clock);
    pairClient = client;
    assert.equal(mgr.status('__proto__').state, 'live');
    try { client.destroy(); pairClient = null; } catch (_) {}
    mgr.close(); mgr = null;
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    await mgr.boot();
    assert.notEqual(mgr.status('__proto__').state, undefined, 'cella __proto__ caricata dopo restart');
    clock.t = 12_000;
    const reply = await reconnect(info.stablePath, { type: 'reconnect', generation: 0, proof });
    assert.equal(reply.type, 'lease', 'P1-1: __proto__ recovery funziona dopo restart (record durevole per-cell)');
  } finally {
    try { if (pairClient) pairClient.destroy(); } catch (_) {}
    try { if (mgr) mgr.close(); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});

test('P1-1: __proto__ non inquina altre celle (file separati per construction)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-proto3-'));
  const clock = { t: 10_000 };
  let mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
  try {
    await mgr.track('Dev');
    await mgr.track('__proto__');
    assert.ok(fs.existsSync(cellStateFile(home, 'Dev')), 'Dev presente (file proprio)');
    assert.ok(fs.existsSync(cellStateFile(home, '__proto__')), '__proto__ presente (file proprio)');
  } finally { try { mgr.close(); } catch (_) {} try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }
});

// P1-2 (reaudit dd38c83): un secondo track() che non persiste cancella una lease
// gia' viva e orfana la socket del supervisore. Fix: il cleanup ripristina l'entry
// preesistente invece di cancellarla.
test('P1-2: secondo track() con persist fallita NON cancella lease viva esistente', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-p1_2-'));
  const clock = { t: 10_000 };
  let writeFail = false;
  const fakeFs = {
    ...fs,
    writeFileSync(...args) { if (writeFail) throw new Error('disk full'); return fs.writeFileSync(...args); },
  };
  let mgr = null; let client = null;
  try {
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t, fs: fakeFs });
    const info = await mgr.track('Dev');
    const { serverSide, client: c } = await pair();
    client = c;
    mgr.attachInitial('Dev', serverSide, { generation: 0 });
    assert.equal(mgr.status('Dev').state, 'live', 'cella viva dopo primo track');
    writeFail = true;
    try { await mgr.track('Dev'); } catch (e) { /* track propaga l'errore */ }
    writeFail = false;
    const st = mgr.status('Dev');
    assert.equal(st.state, 'live', 'P1-2: cella ancora viva dopo secondo track fallito (non cancellata)');
  } finally {
    writeFail = false;
    try { if (client) client.destroy(); } catch (_) {}
    try { if (mgr) mgr.close(); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});

// P1-3 (reaudit dd38c83): onLease in builtin.js ignorava il boolean di attachInitial.
// Se la persistenza del bind fallisce, il payload lease non deve essere consegnato:
// la socket va chiusa (EOF osservabile), non lasciata aperta su un manager vuoto.
// Test: simula il wiring onLease con pair() (socket TCP throwaway come fa il broker).
test('P1-3: onLease con attachInitial=false chiude la socket (EOF osservabile dal supervisore)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-p1_3fail-'));
  const clock = { t: 10_000 };
  let writeFail = false;
  const fakeFs = {
    ...fs,
    writeFileSync(...args) { if (writeFail) throw new Error('disk full'); return fs.writeFileSync(...args); },
  };
  let mgr = null; let client = null;
  try {
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t, fs: fakeFs });
    await mgr.track('Dev');
    // Crea la pair (simula la connessione broker one-shot)
    const { serverSide, client: c } = await pair();
    client = c;
    // Simula il wiring onLease di builtin.js (con fix P1-3)
    writeFail = true; // ora writePersisted fallisce dentro bindLiveSocket->persistEntry
    const ok = mgr.attachInitial('Dev', serverSide, { generation: 0 });
    assert.equal(ok, false, 'attachInitial fallisce (persistenza fallita)');
    // Fix: onLease chiude la socket quando attachInitial restituisce false
    if (!ok) { try { serverSide.destroy(); } catch (_) {} }
    // Il client deve vedere la chiusura (EOF)
    const closed = await new Promise((resolve) => {
      const to = setTimeout(() => resolve(false), 2000);
      client.once('close', () => { clearTimeout(to); resolve(true); });
    });
    assert.ok(closed, 'P1-3: socket chiusa quando attachInitial fallisce (EOF al supervisore)');
    assert.equal(mgr.status('Dev').state, 'none', 'manager resta state=none');
    writeFail = false;
  } finally {
    writeFail = false;
    try { if (client) client.destroy(); } catch (_) {}
    try { if (mgr) mgr.close(); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});

test('P1-3: onLease con attachInitial=true NON chiude la socket (lease vivo, happy path)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-p1_3ok-'));
  const clock = { t: 10_000 };
  let mgr = null; let client = null;
  try {
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    await mgr.track('Dev');
    const { serverSide, client: c } = await pair();
    client = c;
    const ok = mgr.attachInitial('Dev', serverSide, { generation: 0 });
    assert.equal(ok, true, 'attachInitial ha successo (disco OK)');
    // Happy path: la socket resta aperta (il manager ha il lease)
    assert.equal(mgr.status('Dev').state, 'live', 'lease vivo');
  } finally {
    try { if (client) client.destroy(); } catch (_) {}
    try { if (mgr) mgr.close(); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});

// P1-4 (reaudit dd38c83): forma ≠ semantica. loadPersisted accetta solo cio'
// che il runtime produce: launchEpoch hex-16 e bound entro now+2*GRACE_MS.
// Fail-closed: entry con valori non producibili = saltata (nessun endpoint,
// nessun lease). La capability non esiste piu' (A2): l'autenticazione al
// reconnect e' il proof firmato con la chiave per-installazione della dir.

test('P1-4: identity di un byte (launchEpoch="x") rifiutata — entry saltata, nessun endpoint', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-p1_4id-'));
  const clock = { t: 10_000 };
  let mgr = null;
  try {
    writeLeaseEntry(home, 'Dev', { launchEpoch: 'x', graceDeadline: 10_000 + L.GRACE_MS });
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    await mgr.boot();
    // La entry con identity di 1 byte NON deve essere caricata: nessun endpoint aperto
    const stablePath = path.join(home, '.nexuscrew', 'run', 'cell-Dev.sock');
    assert.equal(fs.existsSync(stablePath), false, 'P1-4: identity di 1 byte -> entry saltata, endpoint NON aperto');
  } finally {
    try { if (mgr) mgr.close(); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});

test('P1-4: graceDeadline = MAX_SAFE_INTEGER rifiutata (bound assurdo -> scaduto -> deny anche con proof fresco)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-p1_4gd-'));
  const clock = { t: 10_000 };
  let mgr = null;
  try {
    const crypto = require('node:crypto');
    const ep = crypto.randomBytes(8).toString('hex');
    writeLeaseEntry(home, 'Dev', { launchEpoch: ep, graceDeadline: Number.MAX_SAFE_INTEGER });
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    await mgr.boot();
    // MAX_SAFE_INTEGER non e' producibile da now()+GRACE_MS: trattato come scaduto (0)
    const stablePath = path.join(home, '.nexuscrew', 'run', 'cell-Dev.sock');
    // proof legittimo (firmato con la chiave per-installazione), fresco: il deny
    // puo' venire SOLO dal bound assurdo.
    const proof = forgeProof(home, clock, { kind: 'lease', cellId: 'Dev', launchEpoch: ep, leaseId: '5'.repeat(16), generation: '0', jti: '6'.repeat(16) });
    const reply = await reconnect(stablePath, { type: 'reconnect', generation: 0, proof });
    assert.equal(reply.type, 'deny', 'P1-4: graceDeadline assurdo -> deny (no lease illimitato)');
  } finally {
    try { if (mgr) mgr.close(); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});

test('P1-4: identity con formato valido (hex 16) accettata; reconnect con proof verificato -> lease', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-p1_4ok-'));
  const clock = { t: 10_000 };
  let mgr = null;
  try {
    const crypto = require('node:crypto');
    const ep = crypto.randomBytes(8).toString('hex');
    writeLeaseEntry(home, 'Dev', { launchEpoch: ep, graceDeadline: 10_000 + L.GRACE_MS });
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    await mgr.boot();
    const stablePath = path.join(home, '.nexuscrew', 'run', 'cell-Dev.sock');
    assert.equal(fs.existsSync(stablePath), true, 'identity valida -> endpoint aperto');
    // 2b: il proof e' emesso dal server (chiave per-installazione) e presentato
    // dal detentore; post-boot non c'e' lease in memoria, quindi il gate e'
    // firma+expiry+bound — esattamente il caso recovery post-restart.
    const proof = forgeProof(home, clock, { kind: 'lease', cellId: 'Dev', launchEpoch: ep, leaseId: '7'.repeat(16), generation: '0', jti: '8'.repeat(16) });
    const reply = await reconnect(stablePath, { type: 'reconnect', generation: 0, proof });
    assert.equal(reply.type, 'lease', 'identity valida entro bound, proof verificato -> lease (recovery normale)');
  } finally {
    try { if (mgr) mgr.close(); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});
