'use strict';
// Fetta 2b — proof HMAC al posto della capability statica nella gestione lease
// del supervisore (contratto rev1: PREMESSA, A2/B1, D1/D2, C4, C3-sospesa).
// Il canale e i side effect sono quelli veri del manager (TCP pair come nella
// suite 2a): qui si prova che il modello di autorizzazione e' cambiato.
const { test, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const { verifyProof, loadOrCreateVerifier } = require('../lib/fleet/lease-verifier.js');

// I socket aperti da pair(): senza chiuderli il processo NON ESCE dopo l'ultimo
// test — con `--test-timeout=0` il gate intero resta appeso senza un rosso, e
// sembra lento invece che rotto. Cinque socket misurati con
// process._getActiveHandles().
const socketAperti = [];
after(() => {
  for (const s of socketAperti) { try { s.destroy(); } catch (_) { /* gia' chiuso */ } }
});

function pair() {
  return new Promise((resolve, reject) => {
    let pending = null;
    const srv = net.createServer((sock) => { pending = sock; });
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      const client = net.createConnection(port, '127.0.0.1', () => {
        const wait = () => {
          if (pending) {
            srv.close(() => {});
            socketAperti.push(pending, client);
            resolve({ serverSide: pending, client });
          }
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease2b-'));
  const clock = { t: 10_000 };
  const mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
  return { home, clock, mgr };
}

const leasesDir = (home) => path.join(home, '.nexuscrew', 'run', 'cell-leases');
const verifierKeyPath = (home) => path.join(home, '.nexuscrew', 'run', 'lease-verifier.key');

// Flusso completo: track + attachInitial (broker) → il supervisore riceve il
// primo proof gia' sul canale iniziale.
async function openLease(mgr, clock, cellId = 'Research', generation = 0) {
  const info = await mgr.track(cellId);
  const { serverSide, client } = await pair();
  const ok = mgr.attachInitial(cellId, serverSide, { generation });
  assert.equal(ok, true);
  const first = await recv(client, (m) => m.type === 'lease' && m.proof);
  return { info, client, first };
}

test('track non emette piu capability statica; lo stato durevole e per-cella senza segreti', async () => {
  const { home, clock, mgr } = setup();
  const info = await mgr.track('Research');
  assert.ok(info.stablePath && info.launchEpoch);
  assert.equal('capability' in info, false); // A2/B1: revocata, non affiancata
  const dir = leasesDir(home);
  const files = fs.readdirSync(dir);
  assert.deepEqual(files, ['Research.json']); // D1: un file per cella
  const entry = JSON.parse(fs.readFileSync(path.join(dir, 'Research.json'), 'utf8'));
  assert.equal(entry.launchEpoch, info.launchEpoch);
  assert.equal('capability' in entry, false); // mai segreti nello stato durevole (C5)
  assert.ok(Number.isInteger(entry.graceDeadline));
  mgr.close();
});

test('D1/E3: il refresh di una cella non legge né riscrive il file delle altre', async () => {
  const { home, clock, mgr } = setup();
  await mgr.track('Alpha');
  await mgr.track('Beta');
  const { client } = await openLease(mgr, clock, 'Alpha');
  const betaFile = path.join(leasesDir(home), 'Beta.json');
  const betaBefore = fs.readFileSync(betaFile, 'utf8');
  const betaMtime = fs.statSync(betaFile).mtimeMs;
  const ack = await (async () => {
    client.write(`${JSON.stringify({ type: 'refresh' })}\n`);
    return recv(client, (m) => m.type === 'ack');
  })();
  assert.ok(ack.proof, 'il refresh consegna un proof (hook 2b gia dichiarato in 2a)');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fs.readFileSync(betaFile, 'utf8'), betaBefore);
  assert.equal(fs.statSync(betaFile).mtimeMs, betaMtime, 'il file di Beta non e stato toccato');
  mgr.close();
});

test('attachInitial consegna lease + proof firmato kind lease con leaseId del lease aperto', async () => {
  const { home, clock, mgr } = setup();
  const { first } = await openLease(mgr, clock, 'Research');
  assert.equal(first.proof.kind, 'lease');
  assert.equal(first.proof.cellId, 'Research');
  assert.equal(first.proof.leaseId, first.leaseId);
  assert.equal(first.proof.launchEpoch.length, 16);
  mgr.close();
});

test('refresh: nessun proof senza commit del bound (norma GC1.2 estesa al proof)', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'celllease2b-'));
  const clock = { t: 10_000 };
  let failWrites = false;
  const fsImpl = new Proxy({}, {
    get(target, prop) {
      if (prop === 'writeFileSync' && failWrites) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return Reflect.get(fs, prop);
    },
  });
  const mgr = createLeaseManager({ home, log: () => {} }, { now: () => clock.t, fs: fsImpl });
  await mgr.track('Research');
  const { serverSide, client } = await pair();
  // attachInitial: la persistenza del bind fallisce -> no lease, no proof.
  failWrites = true;
  assert.equal(mgr.attachInitial('Research', serverSide, { generation: 0 }), false);
  mgr.close();
});

test('reconnect con proof valido riapre il lease; il proof e consumato una volta in-process (A3)', async () => {
  const { home, clock, mgr } = setup();
  const { info, client, first } = await openLease(mgr, clock, 'Research');
  const proof1 = first.proof;
  client.destroy(); // EOF
  await new Promise((r) => setTimeout(r, 10));
  // Riconnessione all'endpoint stabile col proof detenuto.
  const c2 = net.createConnection(info.stablePath);
  const leaseAgain = await new Promise((resolve) => {
    c2.once('connect', () => {
      c2.write(`${JSON.stringify({ type: 'reconnect', launchEpoch: info.launchEpoch, generation: 0, proof: proof1 })}\n`);
    });
    recv(c2, (m) => m.type === 'lease' || m.type === 'deny').then(resolve);
  });
  assert.equal(leaseAgain.type, 'lease', JSON.stringify(leaseAgain));
  assert.notEqual(leaseAgain.leaseId, first.leaseId); // lease NUOVO, stessa identita'
  assert.ok(leaseAgain.proof.proof, 'il reconnect vittorioso consegna il proof del lease nuovo');
  c2.destroy();
  await new Promise((r) => setTimeout(r, 10));
  // Single-use IN-PROCESS (A3): lo stesso jti non passa due volte.
  const c3 = net.createConnection(info.stablePath);
  const replay = await new Promise((resolve) => {
    c3.once('connect', () => {
      c3.write(`${JSON.stringify({ type: 'reconnect', launchEpoch: info.launchEpoch, generation: 0, proof: proof1 })}\n`);
    });
    recv(c3, (m) => m.type === 'lease' || m.type === 'deny').then(resolve);
  });
  assert.equal(replay.type, 'deny');
  c3.destroy();
  mgr.close();
});

test('reconnect col vecchio modello 2a (capability statica) e negato: norma revocata (A2)', async () => {
  const { home, clock, mgr } = setup();
  const { info, client, first } = await openLease(mgr, clock, 'Research');
  client.destroy();
  await new Promise((r) => setTimeout(r, 10));
  const c2 = net.createConnection(info.stablePath);
  const out = await new Promise((resolve) => {
    c2.once('connect', () => {
      c2.write(`${JSON.stringify({ type: 'reconnect', launchEpoch: info.launchEpoch, generation: 0, capability: 'f'.repeat(64) })}\n`);
    });
    recv(c2, (m) => m.type === 'lease' || m.type === 'deny').then(resolve);
  });
  assert.equal(out.type, 'deny');
  c2.destroy();
  mgr.close();
});

test('reconnect con proof scaduto, contraffatto o di kind sbagliato: deny (C4 fail-closed)', async () => {
  const { home, clock, mgr } = setup();
  const { info, client, first } = await openLease(mgr, clock, 'Research');
  const good = first.proof;
  client.destroy();
  await new Promise((r) => setTimeout(r, 10));
  const attempt = async (proof) => {
    const c = net.createConnection(info.stablePath);
    const out = await new Promise((resolve) => {
      c.once('connect', () => {
        c.write(`${JSON.stringify({ type: 'reconnect', launchEpoch: info.launchEpoch, generation: 0, proof })}\n`);
      });
      recv(c, (m) => m.type === 'lease' || m.type === 'deny').then(resolve);
    });
    c.destroy();
    return out.type;
  };
  clock.t += 61_000; // il proof emesso a t=10_000 e' scaduto (B8: 60s)
  assert.equal(await attempt(good), 'deny', 'scaduto');
  clock.t -= 61_000;
  assert.equal(await attempt({ ...good, proof: '0'.repeat(64) }), 'deny', 'firma contraffatta');
  assert.equal(await attempt({ ...good, kind: 'child' }), 'deny', 'kind sbagliato');
  assert.equal(await attempt({ ...good, cellId: 'Beta' }), 'deny', 'claims manomessi');
  mgr.close();
});

test('post-restart: il proof emesso prima resta valido (verifier per-installazione) e il bound grace per-cell rifiuta oltre (R3.3.5)', async () => {
  const { home, clock, mgr } = setup();
  const { info, client, first } = await openLease(mgr, clock, 'Research');
  const proof = first.proof;
  client.destroy();
  mgr.close(); // restart del processo server: la map muore, il verifier resta su disco
  const clock2 = { t: clock.t + 5_000 };
  const mgr2 = createLeaseManager({ home, log: () => {} }, { now: () => clock2.t });
  await mgr2.boot();
  const c2 = net.createConnection(info.stablePath);
  const again = await new Promise((resolve) => {
    c2.once('connect', () => {
      c2.write(`${JSON.stringify({ type: 'reconnect', launchEpoch: info.launchEpoch, generation: 0, proof })}\n`);
    });
    recv(c2, (m) => m.type === 'lease' || m.type === 'deny').then(resolve);
  });
  assert.equal(again.type, 'lease', 'la firma verifica con la chiave persistita: recovery senza capability persistita');
  c2.destroy();
  // Oltre la grace persistita per-cell: rifiuto (invariante 2a preservata).
  clock2.t += 120_000;
  const c3 = net.createConnection(info.stablePath);
  const late = await new Promise((resolve) => {
    c3.once('connect', () => {
      c3.write(`${JSON.stringify({ type: 'reconnect', launchEpoch: info.launchEpoch, generation: 0, proof: again.proof })}\n`);
    });
    recv(c3, (m) => m.type === 'lease' || m.type === 'deny').then(resolve);
  });
  assert.equal(late.type, 'deny');
  c3.destroy();
  mgr2.close();
});

test('E3: boot con un file per-cella corrotto carica le altre (join non rotto dalla partizione)', async () => {
  const { home, clock, mgr } = setup();
  await mgr.track('Alpha');
  await mgr.track('Beta');
  await mgr.track('Gamma');
  mgr.close();
  fs.writeFileSync(path.join(leasesDir(home), 'Beta.json'), '{non json');
  const mgr2 = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
  mgr2.loadPersisted();
  const ids = [...mgr2._cells.keys()].sort();
  assert.deepEqual(ids, ['Alpha', 'Gamma']);
  mgr2.close();
});

test('il proof supervisore verifica con la chiave per-installazione letta da disco', async () => {
  const { home, clock, mgr } = setup();
  const { info, client, first } = await openLease(mgr, clock, 'Research');
  // Proprieta' del modello: chi ha la chiave verifier (il server, anche dopo
  // restart) verifica il proof SENZA stato di sessione condiviso.
  const v = loadOrCreateVerifier({ dir: path.dirname(verifierKeyPath(home)) });
  const out = verifyProof([v], first.proof, {
    now: () => clock.t + 100,
    expect: { kind: 'lease', cellId: 'Research', launchEpoch: info.launchEpoch, leaseId: first.leaseId },
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  client.destroy();
  mgr.close();
});
