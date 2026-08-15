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
  const stable = net.createServer((sock) => {
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      if (reconnectMsg) return;
      const nl = chunk.indexOf('\n');
      if (nl === -1) return;
      try { reconnectMsg = JSON.parse(chunk.slice(0, nl)); } catch (_) { reconnectMsg = { parse: 'fail' }; }
      sock.write(`${JSON.stringify({ type: 'deny' })}\n`); // il client ara' il retry: ci basta il primo msg
    });
  });
  await new Promise((resolve) => stable.listen(stablePath, resolve));

  const { serverSide, client } = await pair();
  const ctl = startLeaseClient(serverSide, {
    stablePath,
    launchEpoch: PROOF.launchEpoch,
    generation: 0,
    onLost: () => {},
  }, {});
  assert.ok(ctl, 'client partito senza capability nel payload');

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
  ctl.stop();
  stable.close();
  try { fs.unlinkSync(stablePath); } catch (_) {}
  client.destroy();
});

test('senza proof ricevuto il reconnect parte comunque senza proof (il deny e del server)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'leasecli2-'));
  const stablePath = path.join(dir, 'cell-Dev.sock');
  let reconnectMsg = null;
  const stable = net.createServer((sock) => {
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      if (reconnectMsg) return;
      const nl = chunk.indexOf('\n');
      if (nl === -1) return;
      try { reconnectMsg = JSON.parse(chunk.slice(0, nl)); } catch (_) { reconnectMsg = { parse: 'fail' }; }
      sock.write(`${JSON.stringify({ type: 'deny' })}\n`);
    });
  });
  await new Promise((resolve) => stable.listen(stablePath, resolve));
  const { serverSide, client } = await pair();
  const ctl = startLeaseClient(serverSide, { stablePath, launchEpoch: 'a'.repeat(16), generation: 0, onLost: () => {} }, {});
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
  ctl.stop();
  stable.close();
  try { fs.unlinkSync(stablePath); } catch (_) {}
  client.destroy();
});
