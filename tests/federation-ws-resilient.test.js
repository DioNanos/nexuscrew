'use strict';
// tests/federation-ws-resilient.test.js — la morte dell'hop federato deve
// essere DETTA al client, non subita come troncamento TCP.
//
// L'upgrade federato e' una pipe TCP trasparente: quando l'hop muore, il
// browser vedeva un close 1006 senza motivo (o byte di rifiuto HTTP non
// interpretabili). Qui il proxy deve invece chiudere con un codice leggibile:
// 4402 «upstream gone», sia quando l'hop non risponde sia quando muore a
// stream avviato.
//
// Harness: coppia di socket REALI (server + client connesso). Passare un
// net.Socket() non connesso non basta — i byte scritti dal proxy non
// riapparirebbero in ingresso e il test non proverebbe nulla.
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const federation = require('../lib/proxy/federation.js');
const store = require('../lib/nodes/store.js');

const PEER_ID = 'b'.repeat(32);
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function bootStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncws-resilient-'));
  const nodesPath = path.join(dir, 'nodes.json');
  store.initStore(nodesPath);
  let st = store.loadStoreStrict(nodesPath);
  st = store.addNode(st, {
    name: 'peer-a', remotePort: 41999, localPort: 44999, nodeId: PEER_ID,
    acceptToken: 'ACC', direction: 'inbound', shared: true, visibility: 'network',
  });
  store.atomicWriteStore(nodesPath, st);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { nodesPath };
}

function makeBrowserKey() { return crypto.randomBytes(16).toString('base64'); }
function upgradeReq(key) {
  return {
    url: '/federation/route/_/ws',
    method: 'GET',
    headers: {
      host: '127.0.0.1',
      'x-nexuscrew-visited': PEER_ID,
      'sec-websocket-key': key,
      'sec-websocket-version': '13',
      upgrade: 'websocket',
      connection: 'Upgrade',
    },
  };
}

// Apre la coppia reale: il socket LATO SERVER e' quello che forwardUpgrade
// usera' come `socket`; il lato client e' cio' che il browser vedrebbe. Il
// watcher si registra SUBITO (prima dell'accept), o i primi byte andrebbero
// persi; `startForwarding(sock)` fa partire il proxy quando la coppia c'e'.
async function openBrowserPair(t, startForwarding) {
  let serverSock = null;
  const srv = net.createServer((sock) => { serverSock = sock; sock.on('error', () => {}); });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  t.after(() => srv.close());
  const client = net.connect(srv.address().port, '127.0.0.1');
  client.on('error', () => {});
  const outcome = watchClient(client);
  await new Promise((res) => {
    const i = setInterval(() => { if (serverSock) { clearInterval(i); res(); } }, 5);
  });
  startForwarding(serverSock);
  return { client, seen: await outcome };
}

// Accumula i byte visti dal "browser" e vi cerca 101 + frame di close WS.
function watchClient(client) {
  const seen = { got101: false, closeCode: null, raw: Buffer.alloc(0), done: false };
  const tryParse = () => {
    if (seen.done) return;
    const headerEnd = seen.raw.indexOf('\r\n\r\n');
    if (headerEnd >= 0) seen.got101 = seen.raw.slice(0, headerEnd).toString('latin1').startsWith('HTTP/1.1 101');
    const frame = headerEnd >= 0 ? seen.raw.slice(headerEnd + 4) : Buffer.alloc(0);
    if (frame.length >= 4 && frame[0] === 0x88) {
      const len = frame[1] & 0x7f;
      if (frame.length >= 2 + len) {
        seen.closeCode = frame.readUInt16BE(2);
        seen.done = true;
      }
    }
  };
  client.on('data', (chunk) => { seen.raw = Buffer.concat([seen.raw, chunk]); tryParse(); });
  client.on('end', () => { seen.done = true; });
  client.on('close', () => { seen.done = true; });
  return new Promise((resolve) => {
    const t0 = Date.now();
    const i = setInterval(() => { tryParse(); if (seen.done || Date.now() - t0 > 4000) { clearInterval(i); resolve(seen); } }, 20);
  });
}

test('hop morto PRIMA dell\'handshake: il client riceve 101 + close 4402 leggibile', async (t) => {
  const { nodesPath } = bootStore(t);
  const key = makeBrowserKey();
  const { seen } = await openBrowserPair(t, (sock) => {
    federation.forwardUpgrade({
      req: upgradeReq(key), socket: sock, head: null, nodesPath,
      localPort: 1, // porta chiusa: net.connect fallisce prima di connettersi
      localCredential: () => 'LOCAL-TOKEN',
      ingress: { nodeId: PEER_ID, visibility: 'network', shared: true, peerOperatorAccess: true },
    });
  });
  assert.equal(seen.got101, true, 'handshake completato localmente per poter dire il motivo');
  assert.equal(seen.closeCode, 4402, 'close 4402 «upstream gone» invece di un troncamento muto');
});

test('hop morto DOPO lo stream: frame di close 4402, non TCP troncata', async (t) => {
  const { nodesPath } = bootStore(t);
  const key = makeBrowserKey();
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  // Upstream che completa l'handshake e poi MUORE senza close (destroy).
  const upstream = net.createServer((sock) => {
    sock.once('data', () => {
      sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
      setTimeout(() => sock.destroy(), 30);
    });
    sock.on('error', () => {});
  });
  await new Promise((res) => upstream.listen(0, '127.0.0.1', res));
  t.after(() => upstream.close());

  const { seen } = await openBrowserPair(t, (sock) => {
    federation.forwardUpgrade({
      req: upgradeReq(key), socket: sock, head: null, nodesPath,
      localPort: upstream.address().port,
      localCredential: () => 'LOCAL-TOKEN',
      ingress: { nodeId: PEER_ID, visibility: 'network', shared: true, peerOperatorAccess: true },
    });
  });
  assert.equal(seen.got101, true, 'il 101 dell\'owner e\' stato relayato');
  assert.equal(seen.closeCode, 4402, 'frame di close 4402 dopo la morte dell\'hop, non EOF muto');
});
