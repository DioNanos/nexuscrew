'use strict';
// Fetta 2b — lease-client lato supervisore: detiene l'ultimo proof ricevuto sul
// canale (lease frame all'attach, ack a ogni refresh) e lo presenta al
// reconnect. La capability statica non esiste piu' (A2): il payload porta solo
// i dati di routing (cellId, launchEpoch, stablePath).
const { test } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startLeaseClient } = require('../lib/fleet/lease-client.js');

function recvLine(sock, predicate, timeoutMs = 500) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const to = setTimeout(() => { cleanup(); reject(new Error('recv timeout')); }, timeoutMs);
    function cleanup() { clearTimeout(to); sock.removeListener('data', on); }
    function on(chunk) {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
        if (!predicate || predicate(msg)) { cleanup(); resolve(msg); }
      }
    }
    sock.on('data', on);
  });
}

// Canale iniziale: pair TCP come broker one-shot.
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

// Server di prova per lo stable path: tiene traccia dei socket accettati e
// ne assorbe gli errori — dopo lo stop il client chiude il pendente e un
// reset del peer non deve diventare un errore non gestito che sopravvive al
// test. chiudiTutto distrugge i socket accettati nel cleanup.
function stableDiProva(stablePath, rispondi) {
  const accettati = [];
  const server = net.createServer((sock) => {
    accettati.push(sock);
    sock.on('error', () => { /* reset del peer dopo lo stop: assorbito */ });
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => rispondi(sock, chunk));
  });
  const pronto = new Promise((resolve) => server.listen(stablePath, resolve));
  return {
    server,
    accettati,
    pronto,
    chiudiTutto: () => { for (const s of accettati) { try { s.destroy(); } catch (_) {} } },
  };
}

const PROOF = {
  kind: 'lease', cellId: 'Dev', launchEpoch: 'a'.repeat(16), leaseId: 'b'.repeat(16),
  generation: '0', jti: 'c'.repeat(16), issuedAt: 1_000, expiresAt: 61_000,
  proof: 'd'.repeat(64),
};

test('client conserva il proof del canale e lo presenta al reconnect (nessuna capability)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leasecli-'));
  const stablePath = path.join(dir, 'cell-Dev.sock');
  // Endpoint stabile finto: raccoglie il messaggio di reconnect.
  let reconnectMsg = null;
  const stable = stableDiProva(stablePath, (sock, chunk) => {
    if (reconnectMsg) return;
    const nl = chunk.indexOf('\n');
    if (nl === -1) return;
    try { reconnectMsg = JSON.parse(chunk.slice(0, nl)); } catch (_) { reconnectMsg = { parse: 'fail' }; }
    sock.write(`${JSON.stringify({ type: 'deny' })}\n`); // il client ara' il retry: ci basta il primo msg
  });
  await stable.pronto;

  const { serverSide, client } = await pair();
  const ctl = startLeaseClient(serverSide, {
    stablePath,
    launchEpoch: PROOF.launchEpoch,
    generation: 0,
    onLost: () => {},
  }, {});
  assert.ok(ctl, 'client partito senza capability nel payload');

  try {
    // Il peer (il lato server del canale) consegna il proof sul canale, come
    // fanno attach (frame lease) e refresh (ack) in 2b.
    client.write(`${JSON.stringify({ type: 'lease', leaseId: PROOF.leaseId, proof: PROOF })}\n`);
    await new Promise((r) => setTimeout(r, 20));
    // EOF lato server: il client deve reconnectare allo stable path col proof.
    client.destroy();
    const msg = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('nessun reconnect entro il timeout')), 1500);
      const wait = () => {
        if (reconnectMsg) { clearTimeout(to); resolve(reconnectMsg); }
        else setTimeout(wait, 5);
      };
      wait();
    });
    assert.equal(msg.type, 'reconnect');
    assert.deepEqual(msg.proof, PROOF, 'il proof detenuto (ricevuto sul canale) e presentato tale e quale');
    assert.equal('capability' in msg, false, 'nessuna capability nel messaggio (revocata)');
  } finally {
    ctl.stop();
    stable.chiudiTutto();
    stable.server.close();
    try { fs.unlinkSync(stablePath); } catch (_) {}
    client.destroy();
  }
});

test('senza proof ricevuto il reconnect parte comunque senza proof (il deny e del server)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leasecli2-'));
  const stablePath = path.join(dir, 'cell-Dev.sock');
  let reconnectMsg = null;
  const stable = stableDiProva(stablePath, (sock, chunk) => {
    if (reconnectMsg) return;
    const nl = chunk.indexOf('\n');
    if (nl === -1) return;
    try { reconnectMsg = JSON.parse(chunk.slice(0, nl)); } catch (_) { reconnectMsg = { parse: 'fail' }; }
    sock.write(`${JSON.stringify({ type: 'deny' })}\n`);
  });
  await stable.pronto;
  const { serverSide, client } = await pair();
  const ctl = startLeaseClient(serverSide, { stablePath, launchEpoch: 'a'.repeat(16), generation: 0, onLost: () => {} }, {});
  try {
    client.destroy(); // EOF senza che il server abbia mai consegnato proof
    const msg = await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error('nessun reconnect entro il timeout')), 1500);
      const wait = () => {
        if (reconnectMsg) { clearTimeout(to); resolve(reconnectMsg); }
        else setTimeout(wait, 5);
      };
      wait();
    });
    assert.equal(msg.type, 'reconnect');
    assert.equal(msg.proof, undefined, 'nessun proof detenuto: messaggio senza proof, deny affidato al server');
  } finally {
    ctl.stop();
    stable.chiudiTutto();
    stable.server.close();
    try { fs.unlinkSync(stablePath); } catch (_) {}
    client.destroy();
  }
});

test('stop con risposta a metà: nessun errore non gestito residuo sui socket del server di prova', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leasecli3-'));
  const stablePath = path.join(dir, 'cell.sock');
  let halfSent = false;
  const stable = stableDiProva(stablePath, (sock, chunk) => {
    if (halfSent) return;
    const nl = chunk.indexOf('\n');
    if (nl === -1) return;
    halfSent = true;
    sock.write('{"type":"den'); // meta' senza newline: nessun esito lato client
  });
  await stable.pronto;
  const { serverSide, client } = await pair();
  const ctl = startLeaseClient(serverSide, {
    stablePath, launchEpoch: PROOF.launchEpoch, generation: 0, onLost: () => {},
  }, {});
  try {
    client.write(`${JSON.stringify({ type: 'lease', leaseId: PROOF.leaseId, proof: PROOF })}\n`);
    await new Promise((r) => setTimeout(r, 20));
    client.destroy(); // EOF: tentativo immediato verso lo stable
    for (let i = 0; i < 500 && !halfSent; i += 1) await new Promise((r) => setTimeout(r, 2));
    assert.ok(halfSent, 'tentativo ricevuto dal server di prova');
    // Lo stop chiude il socket del tentativo (pendente): la seconda meta'
    // della risposta parte DOPO la chiusura del peer e il server di prova non
    // deve produrre un errore non gestito che sopravviva alla fine del test.
    ctl.stop();
    const accepted = stable.accettati[stable.accettati.length - 1];
    accepted.write('y"}\n');
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(ctl._isConnected(), false, 'client fermo dopo lo stop');
  } finally {
    ctl.stop();
    stable.chiudiTutto();
    stable.server.close();
    try { fs.unlinkSync(stablePath); } catch (_) {}
    client.destroy();
  }
});

test('reconnect delivers frames coalesced in the same chunk as lease to the live parser', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leasecli-residuo-'));
  const stablePath = path.join(dir, 'cell-Dev.sock');
  const SNAP_NONCE = '1'.repeat(32);
  const LAUNCH_ID = 'a'.repeat(16);
  const accepted = [];
  let replyPromise = null;
  const server = net.createServer((sock) => {
    accepted.push(sock);
    sock.on('error', () => {});
    let reqBuf = '';
    sock.setEncoding('utf8');
    const onReq = (chunk) => {
      reqBuf += chunk;
      const nl = reqBuf.indexOf('\n');
      if (nl === -1) return;
      sock.removeListener('data', onReq);
      const msg = JSON.parse(reqBuf.slice(0, nl));
      assert.equal(msg.type, 'reconnect');
      replyPromise = recvLine(sock, (m) => m && m.type === 'promptSnapshotResult', 1000);
      const leaseFrame = JSON.stringify({ type: 'lease', leaseId: 'e'.repeat(16), proof: PROOF });
      const snapFrame = JSON.stringify({ type: 'promptSnapshot', v: 1, nonce: SNAP_NONCE });
      sock.write(`${leaseFrame}\n${snapFrame}\n`);
    };
    sock.on('data', onReq);
  });
  await new Promise((resolve) => server.listen(stablePath, resolve));

  const { serverSide, client } = await pair();
  const ctl = startLeaseClient(serverSide, {
    stablePath,
    launchEpoch: PROOF.launchEpoch,
    generation: 0,
    promptSnapshot: () => ({ launchId: LAUNCH_ID, applicable: true, generation: 0 }),
    onLost: () => {},
  }, {});
  try {
    client.write(`${JSON.stringify({ type: 'lease', leaseId: PROOF.leaseId, proof: PROOF })}\n`);
    for (let i = 0; i < 200 && !ctl._heldProof(); i += 1) await new Promise((r) => setTimeout(r, 2));
    assert.ok(ctl._heldProof(), 'initial proof held before disconnect');
    client.destroy();
    for (let i = 0; i < 500 && !replyPromise; i += 1) await new Promise((r) => setTimeout(r, 2));
    assert.ok(replyPromise, 'reconnect received by fake server');
    const snapRes = await replyPromise;
    assert.equal(snapRes.type, 'promptSnapshotResult');
    assert.equal(snapRes.nonce, SNAP_NONCE);
    assert.equal(snapRes.launchId, LAUNCH_ID);
    assert.equal(snapRes.applicable, true);
    assert.equal(snapRes.generation, 0);
  } finally {
    ctl.stop();
    for (const s of accepted) { try { s.destroy(); } catch (_) {} }
    server.close();
    try { fs.unlinkSync(stablePath); } catch (_) {}
    try { fs.rmdirSync(dir); } catch (_) {}
    client.destroy();
  }
});
