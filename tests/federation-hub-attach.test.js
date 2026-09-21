'use strict';
// tests/federation-hub-attach.test.js — l'hub tiene viva l'attach federata
// quando il client cade, così chi torna con la STESSA identità riprende senza
// riaprire l'upstream. Vincoli: aggancio solo con stesso token (hash), stessa
// route e stessa sessione; cap 8; grazia; niente de-mascheramento dei frame.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const federation = require('../lib/proxy/federation.js');
const store = require('../lib/nodes/store.js');

const PEER_ID = 'b'.repeat(32);
const ATTACH_ID = 'a'.repeat(32);

function bootStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncws-hub-'));
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

// Upstream finto: completa l'handshake, conta le attach e sa mandare output.
function fakeUpstream(t) {
  const state = { connections: 0, sockets: [] };
  const srv = net.createServer((sock) => {
    state.connections += 1;
    state.sockets.push(sock);
    sock.on('error', () => {});
    sock.once('data', () => {
      sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: dummy\r\n\r\n');
    });
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      t.after(() => { for (const s of state.sockets) { try { s.destroy(); } catch (_) { /* idem */ } } srv.close(); });
      resolve({ port: srv.address().port, state });
    });
  });
}

function upgradeReq({ token = 'TOK', attachId = ATTACH_ID, session = 'work-build' } = {}) {
  const q = [`token=${encodeURIComponent(token)}`];
  if (attachId) q.push(`attachId=${attachId}`);
  if (session) q.push(`attachSession=${encodeURIComponent(session)}`);
  return {
    url: `/federation/route/_/ws?${q.join('&')}`,
    method: 'GET',
    headers: {
      host: '127.0.0.1',
      'x-nexuscrew-visited': PEER_ID,
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
      upgrade: 'websocket',
      connection: 'Upgrade',
    },
  };
}

// Apre la coppia reale browser↔proxy e tiene i byte ricevuti dal "browser".
async function openBrowser(t, { nodesPath, port, req, hubAttaches }) {
  let serverSock = null;
  const srv = net.createServer((sock) => { serverSock = sock; sock.on('error', () => {}); });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  t.after(() => { try { srv.close(); } catch (_) { /* idem */ } try { serverSock?.destroy(); } catch (_) { /* idem */ } });
  const client = net.connect(srv.address().port, '127.0.0.1');
  client.on('error', () => {});
  const seen = { raw: '' };
  client.on('data', (c) => { seen.raw += c.toString('latin1'); });
  t.after(() => { try { client.destroy(); } catch (_) { /* idem */ } });
  await new Promise((res) => {
    const i = setInterval(() => { if (serverSock) { clearInterval(i); res(); } }, 5);
  });
  federation.forwardUpgrade({
    req, socket: serverSock, head: null, nodesPath, localPort: port,
    localCredential: () => 'LOCAL-TOKEN',
    ingress: { nodeId: PEER_ID, visibility: 'network', shared: true, peerOperatorAccess: true },
    hubAttaches,
  });
  return { client, seen, serverSock };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn, ms = 1500) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await wait(10); }
  return false;
};
// Testo visibile al browser (dopo l'handshake), senza header.
const bodyOf = (seen) => seen.raw.slice(seen.raw.indexOf('\r\n\r\n') + 4);

test('hub: caduta e ritorno con la STESSA identità riprendono la stessa upstream', async (t) => {
  const { nodesPath } = bootStore(t);
  const { port, state } = await fakeUpstream(t);
  const hubAttaches = federation.createHubAttachStore({ graceMs: 500, maxAttaches: 8, ringBytes: 4096 });

  const a = await openBrowser(t, { nodesPath, port, req: upgradeReq(), hubAttaches });
  await waitFor(() => bodyOf(a.seen).includes('101'));
  assert.equal(state.connections, 1, 'una sola attach upstream');
  state.sockets[0].write('PRIMA');

  // Il client cade: l'hub NON deve distruggere l'upstream.
  a.client.destroy();
  // Attesa su CONDIZIONE, non su sleep: la chiusura del socket non e'
  // istantanea e sotto carico un tempo fisso produce un rosso casuale.
  assert.ok(await waitFor(() => hubAttaches.get(ATTACH_ID) && hubAttaches.get(ATTACH_ID).socket === null, 5000),
    'il record deve entrare in grazia');
  assert.equal(state.sockets[0].destroyed, false, 'upstream trattenuta in grazia');
  state.sockets[0].write('DURANTE-LA-CADUTA');
  await wait(40);

  // Torna con la stessa identità: stessa upstream, output continuo.
  const b = await openBrowser(t, { nodesPath, port, req: upgradeReq(), hubAttaches });
  await waitFor(() => bodyOf(b.seen).includes('DURANTE-LA-CADUTA'));
  assert.equal(state.connections, 1, 'nessuna nuova attach upstream');
  assert.ok(bodyOf(b.seen).includes('DURANTE-LA-CADUTA'), 'il ring copre l\'assenza');
  state.sockets[0].write('DOPO');
  await waitFor(() => bodyOf(b.seen).includes('DOPO'));
  assert.ok(bodyOf(b.seen).includes('DOPO'), 'e lo stream live riprende');
});

test('hub: token diverso con lo stesso attachId NON aggancia (attach nuova)', async (t) => {
  const { nodesPath } = bootStore(t);
  const { port, state } = await fakeUpstream(t);
  const hubAttaches = federation.createHubAttachStore({ graceMs: 500, maxAttaches: 8, ringBytes: 4096 });

  const id = ATTACH_ID;
  const a = await openBrowser(t, { nodesPath, port, req: upgradeReq({ token: 'TOK' }), hubAttaches });
  await waitFor(() => bodyOf(a.seen).includes('101'));
  a.client.destroy();
  // Attesa su CONDIZIONE, non su sleep: la chiusura del socket non e'
  // istantanea e sotto carico un tempo fisso produce un rosso casuale.
  assert.ok(await waitFor(() => hubAttaches.get(ATTACH_ID) && hubAttaches.get(ATTACH_ID).socket === null, 5000),
    'il record deve entrare in grazia');

  await openBrowser(t, { nodesPath, port, req: upgradeReq({ token: 'ALTRO' }), hubAttaches });
  await waitFor(() => state.connections === 2);
  assert.equal(state.connections, 2, 'identità diversa: attach nuova');
  assert.equal(state.sockets[0].destroyed, false, 'e la bufferizzata resta al suo timer');
});

test('hub: una sessione diversa con lo stesso attachId NON aggancia', async (t) => {
  const { nodesPath } = bootStore(t);
  const { port, state } = await fakeUpstream(t);
  const hubAttaches = federation.createHubAttachStore({ graceMs: 500, maxAttaches: 8, ringBytes: 4096 });

  const id = ATTACH_ID;
  const a = await openBrowser(t, { nodesPath, port, req: upgradeReq({ session: 'work-build' }), hubAttaches });
  await waitFor(() => bodyOf(a.seen).includes('101'));
  a.client.destroy();
  // Attesa su CONDIZIONE, non su sleep: la chiusura del socket non e'
  // istantanea e sotto carico un tempo fisso produce un rosso casuale.
  assert.ok(await waitFor(() => hubAttaches.get(ATTACH_ID) && hubAttaches.get(ATTACH_ID).socket === null, 5000),
    'il record deve entrare in grazia');

  await openBrowser(t, { nodesPath, port, req: upgradeReq({ session: 'altra-sessione' }), hubAttaches });
  await waitFor(() => state.connections === 2);
  assert.equal(state.connections, 2, 'sessione diversa: attach nuova');
});

test('hub: attachId ignoto fa una attach nuova', async (t) => {
  const { nodesPath } = bootStore(t);
  const { port, state } = await fakeUpstream(t);
  const hubAttaches = federation.createHubAttachStore({ graceMs: 500, maxAttaches: 8, ringBytes: 4096 });

  await openBrowser(t, { nodesPath, port, req: upgradeReq({ attachId: 'f'.repeat(32) }), hubAttaches });
  await waitFor(() => state.connections === 1);
  assert.equal(state.connections, 1, 'prima attach');
  await openBrowser(t, { nodesPath, port, req: upgradeReq({ attachId: 'e'.repeat(32) }), hubAttaches });
  await waitFor(() => state.connections === 2);
  assert.equal(state.connections, 2, 'id mai visto: attach nuova, non aggancio');
});

test('hub: oltre la grazia l\'upstream viene distrutta', async (t) => {
  const { nodesPath } = bootStore(t);
  const { port, state } = await fakeUpstream(t);
  const hubAttaches = federation.createHubAttachStore({ graceMs: 120, maxAttaches: 8, ringBytes: 4096 });

  const a = await openBrowser(t, { nodesPath, port, req: upgradeReq(), hubAttaches });
  await waitFor(() => bodyOf(a.seen).includes('101'));
  a.client.destroy();
  await waitFor(() => state.sockets[0].destroyed === true, 1200);
  assert.equal(state.sockets[0].destroyed, true, 'scaduta la grazia, upstream chiusa');

  await openBrowser(t, { nodesPath, port, req: upgradeReq(), hubAttaches });
  await waitFor(() => state.connections === 2);
  assert.equal(state.connections, 2, 'e il ritorno è una attach nuova');
});

test('hub: oltre il cap di 8 attach in grazia si chiude la più vecchia', async (t) => {
  // Proprietà dello STORE: il cap chiude la più vecchia invece di rifiutare la
  // nuova. Verificata direttamente (l'harness a 8 coppie reali misurava il
  // rumore delle porte, non la regola).
  const hubAttaches = federation.createHubAttachStore({ graceMs: 60000, maxAttaches: 8, ringBytes: 4096 });
  const ups = [];
  const hold = (i) => {
    const up = { destroyed: false, destroy() { this.destroyed = true; } };
    ups.push(up);
    return hubAttaches.hold({
      attachId: String(i % 10).repeat(32).slice(0, 32),
      tokenHash: 'h'.repeat(64), route: '', session: `sess-${i}`, up,
    });
  };
  for (let i = 0; i < 8; i += 1) hold(i);
  assert.equal(hubAttaches.size(), 8, 'otto attach in grazia');
  assert.equal(ups[0].destroyed, false, 'la più vecchia è ancora viva');

  const ninth = hold(8);
  assert.equal(hubAttaches.size(), 8, 'il cap tiene');
  assert.equal(ups[0].destroyed, true, 'la PIÙ VECCHIA è stata chiusa dal cap');
  assert.equal(hubAttaches.get(ninth.attachId) !== null, true, 'la nuova è entrata');

  // E l'aggancio della più vecchia non è più possibile: non c'è più.
  assert.equal(hubAttaches.take({ attachId: String(0).repeat(32).slice(0, 32), tokenHash: 'h'.repeat(64), route: '', session: 'sess-0' }), null);
});
