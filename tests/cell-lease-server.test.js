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

test('restart server fail-closed: nuovo manager ricarica identity ma nessun lease vivo; reconnect ricostruisce', async () => {
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
    mgr.loadPersisted();
    assert.equal(mgr.status('Dev').state, 'none', 'fail-closed: nessun lease sopravvive al restart');
    // Riapre l'endpoint stabile; track() rispetta l'identity persistita (non genera la nuova).
    await mgr.track('Dev');
    clock.t = 12_000;
    rc = net.createConnection(info.stablePath, () => {
      rc.write(`${JSON.stringify({ type: 'reconnect', launchEpoch: info.launchEpoch, generation: 0, capability: info.capability })}\n`);
    });
    const reply = await recv(rc, (m) => m.type === 'lease' || m.type === 'deny');
    assert.equal(reply.type, 'lease', 'reconnect post-restart ricostruisce il lease (identity persistita)');
    assert.equal(mgr.status('Dev').state, 'live');
  } finally {
    try { if (rc) rc.destroy(); } catch (_) {}
    try { if (pairClient) pairClient.destroy(); } catch (_) {}
    try { if (mgr) mgr.close(); } catch (_) {}
    try { fs.rmSync(home, { recursive: true, force: true }); } catch (_) {}
  }
});
