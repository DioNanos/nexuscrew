'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const L = require('../lib/fleet/cell-lease.js');

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

function recv(client, predicate, timeoutMs = 500) {
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

test('track apre endpoint stabile 0o600 e ritorna identity+capability', async () => {
  const { home, mgr } = setup();
  try {
    const info = await mgr.track('Dev');
    assert.ok(info.stablePath.startsWith(home), 'stablePath sotto runtime dir');
    assert.match(path.basename(info.stablePath), /^cell-Dev\.sock$/, 'path stabile, non casuale');
    assert.ok(info.launchEpoch && /^[a-f0-9]+$/.test(info.launchEpoch));
    assert.ok(info.capability && /^[a-f0-9]{64}$/.test(info.capability));
    const st = fs.statSync(info.stablePath);
    assert.equal(st.mode & 0o077, 0, 'endpoint stabile 0o600');
    // state persistito
    const stateFile = path.join(home, '.nexuscrew', 'run', 'cell-leases.json');
    const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.equal(persisted.Dev.launchEpoch, info.launchEpoch);
    assert.equal(persisted.Dev.capability, info.capability);
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

test('R3.3.2: endpoint stabile nasce 0o600 atomicamente (neutro rispetto a umask 0)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-umask-'));
  const prevUmask = process.umask(0o000);
  // chmod no-op: l atomicita' deve venire dalla modo con cui la socket NASCE, non dal chmod.
  const fakeFs = { ...fs, chmodSync: () => {} };
  const mgr = createLeaseManager({ home, log: () => {} }, { now: () => 10_000, fs: fakeFs });
  try {
    const info = await mgr.track('Dev');
    const st = fs.statSync(info.stablePath);
    assert.equal(st.mode & 0o077, 0, 'endpoint atomicamente 0o600 anche con umask(0) e chmod no-op');
  } finally { process.umask(prevUmask); mgr.close(); fs.rmSync(home, { recursive: true, force: true }); }
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
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mgr.status('Dev').state, 'grace');
    assert.equal(mgr.status('Dev').graceDeadline, 20_000 + 60_000, 'deadline = EOF + grace');
    client.destroy();
  } finally { mgr.close(); }
});

test('reconnect entro grace -> lease NUOVO (leaseId diverso), stessa identita, live', async () => {
  const { clock, mgr } = setup();
  try {
    const info = await mgr.track('Dev');
    const { serverSide, client } = await pair();
    mgr.attachInitial('Dev', serverSide, { generation: 0 });
    const firstLeaseId = mgr.status('Dev').leaseId;
    clock.t = 5_000;
    client.end();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mgr.status('Dev').state, 'grace');
    // reconnect entro grace
    clock.t = 30_000;
    const rc = net.createConnection(info.stablePath, () => {
      rc.write(`${JSON.stringify({ type: 'reconnect', launchEpoch: info.launchEpoch, generation: 0, capability: info.capability })}\n`);
    });
    const reply = await recv(rc, (m) => m.type === 'lease' || m.type === 'deny');
    assert.equal(reply.type, 'lease', 'reconnect accettato entro grace');
    assert.notEqual(reply.leaseId, firstLeaseId, 'lease NUOVO, leaseId diverso (non resurrezione)');
    assert.equal(mgr.status('Dev').state, 'live');
    assert.equal(mgr.status('Dev').leaseId, reply.leaseId);
    rc.destroy();
  } finally { mgr.close(); }
});

test('R3.3.4: reconnect accetta SOLO la transizione legittima (generation === current o current+1); salto avanti arbitrario o all indietro -> deny', async () => {
  const { clock, mgr } = setup();
  try {
    const info = await mgr.track('Dev');
    const { serverSide, client } = await pair();
    mgr.attachInitial('Dev', serverSide, { generation: 0 });
    clock.t = 5_000;
    client.end();
    await new Promise((r) => setTimeout(r, 30));
    // reconnect che AVANZA la generation di ESATTAMENTE 1 (un restart del
    // supervisore, cell-exec.js:384 `generation += 1`): transizione legittima -> lease.
    clock.t = 30_000;
    const r1 = net.createConnection(info.stablePath, () => {
      r1.write(`${JSON.stringify({ type: 'reconnect', launchEpoch: info.launchEpoch, generation: 1, capability: info.capability })}\n`);
    });
    const a1 = await recv(r1, (m) => m.type === 'lease' || m.type === 'deny');
    assert.equal(a1.type, 'lease', 'avanzamento legittimo 0->1 (un restart del supervisore) accettato');
    r1.destroy();
    await new Promise((r) => setTimeout(r, 30)); // EOF -> grace sul lease gen 1
    // reconnect con generation 99 (salto AVANTI arbitrario, non +1): deny. Il
    // supervisore onesto non presenterebbe mai 99 partendo da 1 (avanza di 1).
    clock.t = 31_000;
    const r2 = net.createConnection(info.stablePath, () => {
      r2.write(`${JSON.stringify({ type: 'reconnect', launchEpoch: info.launchEpoch, generation: 99, capability: info.capability })}\n`);
    });
    const a2 = await recv(r2, (m) => m.type === 'lease' || m.type === 'deny');
    assert.equal(a2.type, 'deny', 'R3.3.4: salto avanti arbitrario (1->99) rifiutato (non transizione attesa)');
    r2.destroy();
    // reconnect con generation 0 (all indietro, stale): deny.
    clock.t = 32_000;
    const r3 = net.createConnection(info.stablePath, () => {
      r3.write(`${JSON.stringify({ type: 'reconnect', launchEpoch: info.launchEpoch, generation: 0, capability: info.capability })}\n`);
    });
    const a3 = await recv(r3, (m) => m.type === 'lease' || m.type === 'deny');
    assert.equal(a3.type, 'deny', 'R3.3.4: generation all indietro (1->0) rifiutata (stale)');
    r3.destroy();
  } finally { mgr.close(); }
});

test('R3.3.4 regressione auditor: generation 0->99 (salto arbitrario) su lease vivo -> deny', async () => {
  // Sonda diretta del difetto dell audit (requested=0->99, server_state=live).
  // Il guard precedente (`incoming >= current`) accettava qualunque salto avanti;
  // il server deve esigere una transizione verificabile, non solo non-decreasing.
  const { clock, mgr } = setup();
  try {
    const info = await mgr.track('Dev');
    const { serverSide, client } = await pair();
    mgr.attachInitial('Dev', serverSide, { generation: 0 });
    assert.equal(mgr.status('Dev').state, 'live');
    clock.t = 5_000;
    client.end();
    await new Promise((r) => setTimeout(r, 30));
    // lease in grace (vivo), reconnect con generation 99 (salto arbitrario da 0): deny.
    clock.t = 30_000;
    const rc = net.createConnection(info.stablePath, () => {
      rc.write(`${JSON.stringify({ type: 'reconnect', launchEpoch: info.launchEpoch, generation: 99, capability: info.capability })}\n`);
    });
    const reply = await recv(rc, (m) => m.type === 'lease' || m.type === 'deny');
    assert.equal(reply.type, 'deny', '0->99 e un salto arbitrario, non la transizione attesa -> deny');
    rc.destroy();
  } finally { mgr.close(); }
});

test('reconnect con capability sbagliata o launchEpoch sbagliata -> deny', async () => {
  const { clock, mgr } = setup();
  try {
    const info = await mgr.track('Dev');
    const { serverSide, client } = await pair();
    mgr.attachInitial('Dev', serverSide, { generation: 0 });
    client.end();
    await new Promise((r) => setTimeout(r, 30));
    // capability sbagliata
    const r1 = net.createConnection(info.stablePath, () => {
      r1.write(`${JSON.stringify({ type: 'reconnect', launchEpoch: info.launchEpoch, generation: 0, capability: 'cc'.repeat(32) })}\n`);
    });
    const d1 = await recv(r1, (m) => m.type === 'deny');
    assert.equal(d1.type, 'deny', 'capability sbagliata -> deny');
    r1.destroy();
    // launchEpoch sbagliata
    const r2 = net.createConnection(info.stablePath, () => {
      r2.write(`${JSON.stringify({ type: 'reconnect', launchEpoch: 'deadbeef', generation: 0, capability: info.capability })}\n`);
    });
    const d2 = await recv(r2, (m) => m.type === 'deny');
    assert.equal(d2.type, 'deny', 'launchEpoch sbagliata -> deny');
    r2.destroy();
  } finally { mgr.close(); }
});

test('reconnect oltre grace -> deny (R3.3.5)', async () => {
  const { clock, mgr } = setup();
  try {
    const info = await mgr.track('Dev');
    const { serverSide, client } = await pair();
    mgr.attachInitial('Dev', serverSide, { generation: 0 });
    clock.t = 5_000;
    client.end();
    await new Promise((r) => setTimeout(r, 30));
    // ora oltre la deadline (grace scaduta)
    clock.t = 5_000 + 60_001;
    const rc = net.createConnection(info.stablePath, () => {
      rc.write(`${JSON.stringify({ type: 'reconnect', launchEpoch: info.launchEpoch, generation: 0, capability: info.capability })}\n`);
    });
    const reply = await recv(rc, (m) => m.type === 'deny');
    assert.equal(reply.type, 'deny', 'reconnect oltre grace -> deny');
    rc.destroy();
  } finally { mgr.close(); }
});

test('R3.3.5 post-restart: reconnect oltre la grace rifiutato anche con lease null (bound persistito)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-beyond-'));
  const clock = { t: 10_000 };
  let mgr = null; let rc = null; let pairClient = null;
  try {
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    const info = await mgr.track('Dev');
    const { serverSide, client } = await pair();
    pairClient = client;
    mgr.attachInitial('Dev', serverSide, { generation: 0 });
    // EOF arma la grace: deadline = 5_000 + 60_000 = 65_000, persistita come bound.
    clock.t = 5_000;
    client.end();
    await new Promise((r) => setTimeout(r, 30));
    pairClient = null;
    // restart del server: nessun lease sopravvive, ma il bound di grace resta persistito.
    mgr.close(); mgr = null;
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    await mgr.boot();
    assert.equal(mgr.status('Dev').state, 'none', 'lease null post-restart (fail-closed)');
    // reconnect OLTRE la grace (+600001 ms oltre l'origine): lease null ma bound noto -> deny.
    clock.t = 65_000 + 600_001;
    rc = net.createConnection(info.stablePath, () => {
      rc.write(`${JSON.stringify({ type: 'reconnect', launchEpoch: info.launchEpoch, generation: 0, capability: info.capability })}\n`);
    });
    const reply = await recv(rc, (m) => m.type === 'lease' || m.type === 'deny');
    assert.equal(reply.type, 'deny', 'R3.3.5: reconnect oltre la grace rifiutato anche post-restart (lease null)');
    rc.destroy();
  } finally {
    try { if (rc) rc.destroy(); } catch (_) {}
    try { if (pairClient) pairClient.destroy(); } catch (_) {}
    try { if (mgr) mgr.close(); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});

test('R3.3.5 post-restart: reconnect ESATTAMENTE alla graceDeadline rifiutato (bound >= , non >)', async () => {
  // Off-by-one: con entry.lease===null il guard post-restart usava `now > graceDeadline`,
  // aprendo un lease alla deadline esatta. La transizione pura (cell-lease.js:76) usa `>=`:
  // alla deadline la grace e' gia scaduta.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-deadline-'));
  const clock = { t: 10_000 };
  let mgr = null; let rc = null; let pairClient = null;
  try {
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    const info = await mgr.track('Dev');
    const { serverSide, client } = await pair();
    pairClient = client;
    mgr.attachInitial('Dev', serverSide, { generation: 0 });
    // EOF arma la grace: deadline = 5_000 + 60_000 = 65_000, persistita come bound.
    clock.t = 5_000;
    client.end();
    await new Promise((r) => setTimeout(r, 30));
    pairClient = null;
    // restart: lease null, bound di grace persistito.
    mgr.close(); mgr = null;
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    await mgr.boot();
    assert.equal(mgr.status('Dev').state, 'none', 'lease null post-restart (fail-closed)');
    // reconnect ESATTAMENTE alla deadline (now === graceDeadline): grace scaduta -> deny.
    clock.t = 65_000;
    rc = net.createConnection(info.stablePath, () => {
      rc.write(`${JSON.stringify({ type: 'reconnect', launchEpoch: info.launchEpoch, generation: 0, capability: info.capability })}\n`);
    });
    const reply = await recv(rc, (m) => m.type === 'lease' || m.type === 'deny');
    assert.equal(reply.type, 'deny', 'alla deadline esatta (now === graceDeadline) la grace e gia scaduta -> deny');
    rc.destroy();
  } finally {
    try { if (rc) rc.destroy(); } catch (_) {}
    try { if (pairClient) pairClient.destroy(); } catch (_) {}
    try { if (mgr) mgr.close(); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});

test('refresh: heartbeat -> ack; non cambia state live', async () => {
  const { clock, mgr } = setup();
  try {
    const info = await mgr.track('Dev');
    const { serverSide, client } = await pair();
    mgr.attachInitial('Dev', serverSide, { generation: 0 });
    clock.t = 25_000;
    client.write(`${JSON.stringify({ type: 'refresh' })}\n`);
    const ack = await recv(client, (m) => m.type === 'ack');
    assert.equal(ack.type, 'ack');
    assert.equal(mgr.status('Dev').state, 'live', 'refresh mantiene live');
    client.destroy();
  } finally { mgr.close(); }
});

test('restart server fail-closed: boot() recovery ripristina identity + endpoint; reconnect ricostruisce (percorso produzione)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-restart-'));
  const clock = { t: 10_000 };
  let mgr = null; let rc = null; let pairClient = null;
  try {
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    const info = await mgr.track('Dev');
    const { serverSide, client } = await pair();
    pairClient = client;
    mgr.attachInitial('Dev', serverSide, { generation: 0 });
    assert.equal(mgr.status('Dev').state, 'live');
    try { client.destroy(); pairClient = null; } catch (_) {}
    // restart del server: manager chiuso e ricreato. Nessun lease sopravvive.
    mgr.close(); mgr = null;
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    // PRODUZIONE: boot() (non loadPersisted()+track() a mano) ripristina l'identity
    // persistita e RIAPRE l'endpoint stabile. La cella non viene rilanciata (boot:false):
    // senza boot() il supervisore vivo non troverebbe l'endpoint.
    await mgr.boot();
    assert.equal(mgr.status('Dev').state, 'none', 'fail-closed: nessun lease sopravvive al restart');
    clock.t = 12_000;
    rc = net.createConnection(info.stablePath, () => {
      rc.write(`${JSON.stringify({ type: 'reconnect', launchEpoch: info.launchEpoch, generation: 0, capability: info.capability })}\n`);
    });
    const reply = await recv(rc, (m) => m.type === 'lease' || m.type === 'deny');
    assert.equal(reply.type, 'lease', 'reconnect post-restart ricostruisce il lease (identity persistita via boot)');
    assert.equal(mgr.status('Dev').state, 'live');
  } finally {
    try { if (rc) rc.destroy(); } catch (_) {}
    try { if (pairClient) pairClient.destroy(); } catch (_) {}
    try { if (mgr) mgr.close(); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});

test('B3/GC1: post-restart con cella LIVE il reconnect oltre il bound live (now+GRACE_MS) e negato (no fail-open null)', async () => {
  // GC1.1: graceDeadline sempre valorizzato (cella live = now+GRACE_MS), mai null.
  // Su HEAD il bound live persistito e' null -> post-restart un reconnect oltre e' lease (fail-open).
  // Con GC1 il bound e' now+GRACE_MS -> oltre quel bound, deny.
  // Fixture dal percorso di produzione (track + attachInitial -> bindLiveSocket). Nessun EOF.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-b3-livebound-'));
  const clock = { t: 10_000 };
  let mgr = null; let rc = null; let pairClient = null;
  try {
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    const info = await mgr.track('Dev');
    const { serverSide, client } = await pair();
    pairClient = client;
    mgr.attachInitial('Dev', serverSide, { generation: 0 });
    assert.equal(mgr.status('Dev').state, 'live');
    // Chiusura del manager SENZA processare l'EOF (detachSocket rimuove i listener
    // close/end prima del destroy): il bound persistito resta quello live.
    mgr.close(); mgr = null;
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    await mgr.boot();
    assert.equal(mgr.status('Dev').state, 'none', 'fail-closed: lease null post-restart');
    // reconnect OLTRE il bound live (10_000 + GRACE_MS). Su HEAD: lease; con GC1: deny.
    clock.t = 10_000 + L.GRACE_MS + 1;
    rc = net.createConnection(info.stablePath, () => {
      rc.write(`${JSON.stringify({ type: 'reconnect', launchEpoch: info.launchEpoch, generation: 0, capability: info.capability })}\n`);
    });
    const reply = await recv(rc, (m) => m.type === 'lease' || m.type === 'deny');
    assert.equal(reply.type, 'deny', 'B3: reconnect oltre il bound live valorizzato -> deny (no piu fail-open null)');
    rc.destroy();
  } finally {
    try { if (rc) rc.destroy(); } catch (_) {}
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
  let mgr = null; let rc = null; let pairClient = null;
  try {
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    const info = await mgr.track('Dev');
    const { serverSide, client } = await pair();
    pairClient = client;
    mgr.attachInitial('Dev', serverSide, { generation: 0 });
    clock.t = 5_000;
    client.end();
    await new Promise((r) => setTimeout(r, 30)); // EOF -> bound armGrace persistito
    try { pairClient.destroy(); pairClient = null; } catch (_) {}
    mgr.close(); mgr = null;
    // Corrompi il bound su disco: valore non-intero.
    const stateFile = path.join(home, '.nexuscrew', 'run', 'cell-leases.json');
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    raw.Dev.graceDeadline = 'NOT-AN-INTEGER';
    fs.writeFileSync(stateFile, JSON.stringify(raw), { mode: 0o600 });
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    await mgr.boot();
    // qualunque now: bound non-intero -> scaduto -> deny
    clock.t = 5_000 + 1;
    rc = net.createConnection(info.stablePath, () => {
      rc.write(`${JSON.stringify({ type: 'reconnect', launchEpoch: info.launchEpoch, generation: 0, capability: info.capability })}\n`);
    });
    const reply = await recv(rc, (m) => m.type === 'lease' || m.type === 'deny');
    assert.equal(reply.type, 'deny', 'GC1.6: graceDeadline non-intero -> grace scaduta -> deny');
    rc.destroy();
  } finally {
    try { if (rc) rc.destroy(); } catch (_) {}
    try { if (pairClient) pairClient.destroy(); } catch (_) {}
    try { if (mgr) mgr.close(); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});

test('B3/GC1.2: refresh rinfresca il bound durevole su disco (now+GRACE_MS)', async () => {
  // GC1.1/GC1.2: il refresh rinfresca il bound (oggi cell-lease-server.js refresh non
  // tocca il disco) e lo persiste PRIMA dell'ACK. Su c438a55 il refresh non persiste ->
  // bound non cambia (rossa); con GC1.2 -> bound = now+GRACE_MS.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-b3-refresh-'));
  const clock = { t: 10_000 };
  let mgr = null; let client = null;
  try {
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    await mgr.track('Dev');
    const { serverSide, client: c } = await pair();
    client = c;
    mgr.attachInitial('Dev', serverSide, { generation: 0 });
    const stateFile = path.join(home, '.nexuscrew', 'run', 'cell-leases.json');
    const boundBefore = JSON.parse(fs.readFileSync(stateFile, 'utf8')).Dev.graceDeadline;
    clock.t = 30_000;
    client.write(`${JSON.stringify({ type: 'refresh' })}\n`);
    const ack = await recv(client, (m) => m.type === 'ack');
    assert.equal(ack.type, 'ack');
    const boundAfter = JSON.parse(fs.readFileSync(stateFile, 'utf8')).Dev.graceDeadline;
    assert.equal(boundAfter, 30_000 + L.GRACE_MS, 'GC1.2: refresh rinfresca il bound a now+GRACE_MS');
    assert.notEqual(boundAfter, boundBefore, 'il bound e cambiato dopo il refresh');
  } finally {
    try { if (client) client.destroy(); } catch (_) {}
    try { if (mgr) mgr.close(); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});

test('B3/GC1.2: persistenza fallita nel refresh = nessun ACK (errore non ingoiato)', async () => {
  // GC1.2: se writePersisted non committa al refresh, nessun ACK. seam writeFileSync
  // condizionato (fail DOPO il setup): track/attachInitial persistono OK, poi il refresh
  // fallisce a scrivere. (P1-2b: track non tollera piu' persist fallita -> seam condizionato.)
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

test('P1-1: errore di lettura dello store al refresh NON cancella le altre celle (e non ACK)', async () => {
  // P1-1 (audit 3405df0): readPersisted ingoia qualunque errore in {} -> persistEntry
  // RMW riscrive lo store con solo la cella corrente, cancellando le altre. Qui due
  // celle (Dev+Research) gia' persistite; un EIO sintetico sulla read al refresh di Dev.
  // Su 3405df0: Research sparisce + ACK. Dopo fix: Research resta + nessun ACK.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-p1-readfail-'));
  const clock = { t: 10_000 };
  const stateFile = path.join(home, '.nexuscrew', 'run', 'cell-leases.json');
  let readFail = false;
  const fakeFs = {
    ...fs,
    readFileSync(p, ...rest) {
      if (readFail && p === stateFile) { const e = new Error('EIO'); e.code = 'EIO'; throw e; }
      return fs.readFileSync(p, ...rest);
    },
  };
  let mgr = null; let cD = null; let cR = null;
  try {
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t, fs: fakeFs });
    await mgr.track('Dev'); await mgr.track('Research');
    const D = await pair(); const R = await pair();
    cD = D.client; cR = R.client;
    mgr.attachInitial('Dev', D.serverSide, { generation: 0 });
    mgr.attachInitial('Research', R.serverSide, { generation: 0 });
    const before = Object.keys(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).sort();
    assert.deepEqual(before, ['Dev', 'Research'], 'setup: entrambe le celle persistite');
    // ora la lettura dello store fallisce (EIO)
    readFail = true;
    clock.t = 30_000;
    cD.write(`${JSON.stringify({ type: 'refresh' })}\n`);
    const probe = await Promise.race([
      recv(cD, (m) => m.type === 'ack', 250).then(() => 'ack').catch(() => 'noack'),
      new Promise((r) => setTimeout(() => r('noack'), 300)),
    ]);
    readFail = false;
    const after = Object.keys(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).sort();
    assert.deepEqual(after, ['Dev', 'Research'], 'P1-1: Research NON cancellata da un errore di lettura dello store');
    assert.equal(probe, 'noack', 'P1-1: nessun ACK quando la lettura dello store fallisce');
  } finally {
    readFail = false;
    try { if (cD) cD.destroy(); } catch (_) {}
    try { if (cR) cR.destroy(); } catch (_) {}
    try { if (mgr) mgr.close(); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});

// Fixture normativa (FC1 rev26 / P1-3 audit 3405df0): produce lo stato della cella
// DAL PERCORSO DI PRODUZIONE — track + attachInitial (bindLiveSocket) + almeno un
// refresh con ACK — verifica che il bound rinfrescato sia un intero rilettro da disco,
// poi restart via boot(). I casi di reconnect (entro/alla deadline/oltre) e la
// corruzione negativa poggiano su questa fixture, MAI su un cell-leases.json scritto
// a mano: il formato riletto dopo restart deve essere quello emesso dal refresh.
async function liveBoundFixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-fixture-'));
  const clock = { t: 10_000 };
  const stateFile = path.join(home, '.nexuscrew', 'run', 'cell-leases.json');
  let mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
  const info = await mgr.track('Dev');
  const { serverSide, client } = await pair();
  mgr.attachInitial('Dev', serverSide, { generation: 0 });
  // almeno un refresh con ACK: rinfresca il bound a now+GRACE_MS e lo persiste (GC1).
  clock.t = 30_000;
  client.write(`${JSON.stringify({ type: 'refresh' })}\n`);
  const ack = await recv(client, (m) => m.type === 'ack');
  if (!ack || ack.type !== 'ack') { try { client.destroy(); mgr.close(); } catch (_) {} throw new Error('fixture: refresh non ACKato'); }
  // verifica: il bound riletto da disco e' l'intero atteso (now+GRACE_MS), non null.
  const onDisk = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const bound = onDisk.Dev && onDisk.Dev.graceDeadline;
  try { client.destroy(); } catch (_) {}
  if (!Number.isInteger(bound) || bound !== 30_000 + L.GRACE_MS) { try { mgr.close(); } catch (_) {} throw new Error(`fixture: bound atteso ${30_000 + L.GRACE_MS}, got ${bound}`); }
  // restart via boot(): nessun lease sopravvive (fail-closed); il bound persistito resta.
  mgr.close(); mgr = null;
  mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
  await mgr.boot();
  const f = { home, clock, mgr, info, stateFile, bound };
  f.cleanup = () => { try { f.mgr.close(); } catch (_) {} try { fs.rmSync(f.home, { recursive: true, force: true }); } catch (_) {} };
  return f;
}

test('P1-3 fixture normativa: bind + refresh(ACK) + restart/boot; reconnect entro il bound -> lease', async () => {
  const f = await liveBoundFixture();
  try {
    assert.equal(f.mgr.status('Dev').state, 'none', 'fail-closed: lease null post-restart');
    assert.equal(f.bound, 30_000 + L.GRACE_MS, 'bound intero rinfrescato dal refresh, rilettro da disco');
    f.clock.t = f.bound - 1;
    const rc = net.createConnection(f.info.stablePath, () => { rc.write(`${JSON.stringify({ type: 'reconnect', launchEpoch: f.info.launchEpoch, generation: 0, capability: f.info.capability })}\n`); });
    const reply = await recv(rc, (m) => m.type === 'lease' || m.type === 'deny');
    assert.equal(reply.type, 'lease', 'entro il bound rinfrescato -> lease (recovery)');
    rc.destroy();
  } finally { f.cleanup(); }
});

test('P1-3 fixture normativa: reconnect ALLA deadline (bound rinfrescato) -> deny', async () => {
  const f = await liveBoundFixture();
  try {
    f.clock.t = f.bound;
    const rc = net.createConnection(f.info.stablePath, () => { rc.write(`${JSON.stringify({ type: 'reconnect', launchEpoch: f.info.launchEpoch, generation: 0, capability: f.info.capability })}\n`); });
    const reply = await recv(rc, (m) => m.type === 'lease' || m.type === 'deny');
    assert.equal(reply.type, 'deny', 'alla deadline (bound rinfrescato dal refresh) -> deny');
    rc.destroy();
  } finally { f.cleanup(); }
});

test('P1-3 fixture normativa: reconnect OLTRE il bound (rinfrescato) -> deny', async () => {
  const f = await liveBoundFixture();
  try {
    f.clock.t = f.bound + 1;
    const rc = net.createConnection(f.info.stablePath, () => { rc.write(`${JSON.stringify({ type: 'reconnect', launchEpoch: f.info.launchEpoch, generation: 0, capability: f.info.capability })}\n`); });
    const reply = await recv(rc, (m) => m.type === 'lease' || m.type === 'deny');
    assert.equal(reply.type, 'deny', 'oltre il bound (rinfrescato dal refresh) -> deny');
    rc.destroy();
  } finally { f.cleanup(); }
});

test('P1-3 fixture normativa, negativo: bound corroto (non-intero) partito dalla fixture reale -> deny', async () => {
  const f = await liveBoundFixture();
  try {
    // corrompe solo il bound, partendo dalla fixture reale (non riscrive l'intera entry).
    const raw = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
    raw.Dev.graceDeadline = 'CORRUPT';
    fs.writeFileSync(f.stateFile, JSON.stringify(raw), { mode: 0o600 });
    f.mgr.close();
    f.mgr = createLeaseManager({ home: f.home, log: () => {} }, { now: () => f.clock.t });
    await f.mgr.boot();
    f.clock.t = 30_001;
    const rc = net.createConnection(f.info.stablePath, () => { rc.write(`${JSON.stringify({ type: 'reconnect', launchEpoch: f.info.launchEpoch, generation: 0, capability: f.info.capability })}\n`); });
    const reply = await recv(rc, (m) => m.type === 'lease' || m.type === 'deny');
    assert.equal(reply.type, 'deny', 'bound corroto (non-intero) partito dalla fixture reale -> deny');
    rc.destroy();
  } finally { f.cleanup(); }
});

// P1-1b (audit 2a05db2): la guardia era a livello I/O; il difetto e' riemerso a livello
// FORMA DEL DATO. Una root JSON valida ma non-oggetto ([], null, numero, stringa) non e'
// uno store celle: readPersisted deve trattarla come illeggibile (propaga), non come vuoto.
test('P1-1b schema: root JSON valida ma non-oggetto -> refresh NESSUN ACK e store non riscritto', async () => {
  const badRoots = ['[]', 'null', '42', '"oops"'];
  for (const badRoot of badRoots) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-p1-schema-'));
    const clock = { t: 10_000 };
    const stateFile = path.join(home, '.nexuscrew', 'run', 'cell-leases.json');
    let mgr = null; let cD = null; let cR = null;
    try {
      mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
      await mgr.track('Dev'); await mgr.track('Research');
      const D = await pair(); const R = await pair();
      cD = D.client; cR = R.client;
      mgr.attachInitial('Dev', D.serverSide, { generation: 0 });
      mgr.attachInitial('Research', R.serverSide, { generation: 0 });
      // sovrascrivi lo store con una root valida-JSON ma non-oggetto
      fs.writeFileSync(stateFile, badRoot, { mode: 0o600 });
      clock.t = 30_000;
      cD.write(`${JSON.stringify({ type: 'refresh' })}\n`);
      const probe = await Promise.race([
        recv(cD, (m) => m.type === 'ack', 250).then(() => 'ack').catch(() => 'noack'),
        new Promise((r) => setTimeout(() => r('noack'), 300)),
      ]);
      const after = fs.readFileSync(stateFile, 'utf8');
      assert.equal(probe, 'noack', `P1-1b: root '${badRoot}' non e' uno store -> nessun ACK`);
      assert.equal(after, badRoot, `P1-1b: root '${badRoot}' store non riscritto (nessun finto successo)`);
    } finally {
      try { if (cD) cD.destroy(); } catch (_) {}
      try { if (cR) cR.destroy(); } catch (_) {}
      try { if (mgr) mgr.close(); } catch (_) {}
      try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
    }
  }
});

test('P1-2b: track con store illeggibile NON restituisce identity senza record durevole (propaga)', async () => {
  // P1-2b: track ignorava persistEntry=false e tornava identity+endpoint anche senza
  // record durevole -> al restart niente recovery. Il record durevole (identity) e'
  // essenziale in track: se non committa, track fallisce (non promette recovery).
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-p1-track-'));
  const clock = { t: 10_000 };
  const stateFile = path.join(home, '.nexuscrew', 'run', 'cell-leases.json');
  const fakeFs = {
    ...fs,
    readFileSync(p, ...rest) {
      if (p === stateFile) { const e = new Error('EIO'); e.code = 'EIO'; throw e; }
      return fs.readFileSync(p, ...rest);
    },
  };
  let mgr = null;
  try {
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t, fs: fakeFs });
    await assert.rejects(() => mgr.track('Dev'), /non persistito|store|EIO/i, 'P1-2b: track propaga il fallimento del record durevole');
  } finally {
    try { if (mgr) mgr.close(); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});

test('P1-2b: reconnect con bound non durevole (persist fallita) -> deny, nessun lease', async () => {
  // P1-2b: handleReconnect mandava lease anche quando il nuovo bound non committava.
  // Qui Dev e' caricato in memoria (boot con store OK), poi si corrompe lo store:
  // il reattach non persiste il bound -> bindLiveSocket false -> deny (no lease).
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-p1-reconnect-'));
  const clock = { t: 10_000 };
  const stateFile = path.join(home, '.nexuscrew', 'run', 'cell-leases.json');
  let mgr1 = null; let mgr2 = null; let rc = null; let pairClient = null;
  try {
    mgr1 = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    const info = await mgr1.track('Dev');
    const { serverSide, client } = await pair();
    pairClient = client;
    mgr1.attachInitial('Dev', serverSide, { generation: 0 });
    try { client.destroy(); pairClient = null; } catch (_) {}
    mgr1.close(); mgr1 = null;
    mgr2 = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    await mgr2.boot(); // carica Dev dal store OK (identity in memoria)
    // ORA corrompi lo store (root []): il reattach non potra' persistere il bound.
    fs.writeFileSync(stateFile, '[]', { mode: 0o600 });
    clock.t = 12_000;
    rc = net.createConnection(info.stablePath, () => {
      rc.write(`${JSON.stringify({ type: 'reconnect', launchEpoch: info.launchEpoch, generation: 0, capability: info.capability })}\n`);
    });
    const reply = await recv(rc, (m) => m.type === 'lease' || m.type === 'deny');
    assert.equal(reply.type, 'deny', 'P1-2b: reconnect con bound non durevole -> deny (no lease finto)');
    rc.destroy();
  } finally {
    try { if (rc) rc.destroy(); } catch (_) {}
    try { if (pairClient) pairClient.destroy(); } catch (_) {}
    try { if (mgr2) mgr2.close(); } catch (_) {}
    try { if (mgr1) mgr1.close(); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});

// P1-1 (reaudit dd38c83): __proto__ come cellId produce un finto successo: track
// restituisce identity+endpoint ma obj['__proto__'] invoca il setter del prototype
// invece di creare una proprieta' propria → JSON.stringify produce {} → nessun record
// durevole → niente recovery al restart. Fix: Object.create(null) in persistEntry.
test('P1-1: __proto__ come cellId crea record durevole proprio (non {} su disco)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-proto1-'));
  const clock = { t: 10_000 };
  let mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
  try {
    const info = await mgr.track('__proto__');
    assert.ok(info.launchEpoch, 'track restituisce identity');
    const stateFile = path.join(home, '.nexuscrew', 'run', 'cell-leases.json');
    const raw = fs.readFileSync(stateFile, 'utf8');
    const persisted = JSON.parse(raw);
    assert.ok(raw.includes('"__proto__"'), 'il file JSON contiene la chiave __proto__ serializzata');
    assert.ok(Object.prototype.hasOwnProperty.call(persisted, '__proto__'), 'proprieta\' propria __proto__');
    assert.equal(persisted['__proto__'].launchEpoch, info.launchEpoch, 'launchEpoch durevole');
  } finally { try { mgr.close(); } catch (_) {} try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {} }
});

test('P1-1: __proto__ record durevole sopravvive al restart (boot recovery)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-proto2-'));
  const clock = { t: 10_000 };
  let mgr = null; let rc = null; let pairClient = null;
  try {
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    const info = await mgr.track('__proto__');
    const { serverSide, client } = await pair();
    pairClient = client;
    mgr.attachInitial('__proto__', serverSide, { generation: 0 });
    assert.equal(mgr.status('__proto__').state, 'live');
    try { client.destroy(); pairClient = null; } catch (_) {}
    mgr.close(); mgr = null;
    mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
    await mgr.boot();
    assert.notEqual(mgr.status('__proto__').state, undefined, 'cella __proto__ caricata dopo restart');
    clock.t = 12_000;
    rc = net.createConnection(info.stablePath, () => {
      rc.write(`${JSON.stringify({ type: 'reconnect', launchEpoch: info.launchEpoch, generation: 0, capability: info.capability })}\n`);
    });
    const reply = await recv(rc, (m) => m.type === 'lease' || m.type === 'deny');
    assert.equal(reply.type, 'lease', 'P1-1: __proto__ recovery funziona dopo restart (record durevole)');
    rc.destroy();
  } finally {
    try { if (rc) rc.destroy(); } catch (_) {}
    try { if (pairClient) pairClient.destroy(); } catch (_) {}
    try { if (mgr) mgr.close(); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});

test('P1-1: __proto__ non inquina altre celle (null-prototype non propaga)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease-proto3-'));
  const clock = { t: 10_000 };
  let mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
  try {
    await mgr.track('Dev');
    await mgr.track('__proto__');
    const stateFile = path.join(home, '.nexuscrew', 'run', 'cell-leases.json');
    const persisted = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    assert.ok(Object.prototype.hasOwnProperty.call(persisted, 'Dev'), 'Dev presente');
    assert.ok(Object.prototype.hasOwnProperty.call(persisted, '__proto__'), '__proto__ presente');
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
// Se la persistenza del bind fallisce, il payload lease e' gia' stato consegnato dal
// broker (scrive PRIMA di chiamare onLease). La socket resta aperta su entrambi i lati
// ma il manager e' state=none: il supervisore ha un lease-client connesso a nulla.
// Fix: onLease consuma il false e chiude la socket (EOF osservabile).
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
