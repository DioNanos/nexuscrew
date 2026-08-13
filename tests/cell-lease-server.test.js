'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');

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
