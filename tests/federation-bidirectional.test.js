'use strict';
// tests/federation-bidirectional.test.js — E2E federazione bidirezionale tra due
// istanze NexusCrew isolate (A <-> B), cross-linkate come peer reciproci. Entrambe
// le direzioni devono: vedere l'inventario corretto dell'altra via /api/route/<peer>/_
// (sessions tmux), le letture colpire la route giusta (B legge la config di A, non
// la propria), una credenziale sbagliata dare 401, e il main token non essere mai
// forwardato (redaction invariant).
//
// Le due istanze sono "outbound" reciproche con localPort che punta alla porta
// dell'altra (simula un tunnel forward attivo in entrambe le direzioni); le
// credenziali token/acceptToken sono incrociate come nel pairing reale.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const store = require('../lib/nodes/store.js');
const { createServer } = require('../lib/server.js');

const FAKE_TMUX = path.join(__dirname, 'fixtures', 'fake-tmux.sh');
const NODE_ID_A = 'a'.repeat(32);
const NODE_ID_B = 'b'.repeat(32);
const CRED_A = 'AAA-credential-aaa';
const CRED_B = 'BBB-credential-bbb';

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'nc-bidir-')); }

async function boot(t, tag, peerName, peerPort, peerId, creds) {
  const dir = tmp();
  const nodesPath = path.join(dir, 'nodes.json');
  let st = { schemaVersion: 2, nodeId: tag === 'A' ? NODE_ID_A : NODE_ID_B, nodes: [] };
  st = store.addNode(st, {
    name: peerName, ssh: 'peer@127.0.0.1', remotePort: 41820, localPort: peerPort || 41820,
    direction: 'outbound', transport: 'auto', autostart: false, visibility: 'network',
    nodeId: peerId, token: creds.token, acceptToken: creds.acceptToken,
  });
  store.atomicWriteStore(nodesPath, st);
  const { server, token, watcher } = createServer({
    home: dir, tokenPath: path.join(dir, 'token'), filesRoot: path.join(dir, 'files'),
    nodesPath, tmuxBin: FAKE_TMUX, fleetEnabled: false,
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    t.after(() => { server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    res({ port, token, nodesPath, dir, server });
  }));
}

function req(inst, method, pth, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port: inst.port, method, path: pth,
      headers: { authorization: `Bearer ${inst.token}`, 'content-type': 'application/json', ...headers },
    }, (x) => { let b = ''; x.on('data', (d) => { b += d; }); x.on('end', () => resolve({ status: x.statusCode, body: b })); });
    r.on('error', reject); if (method !== 'GET' && method !== 'HEAD') r.end();
    else r.end();
  });
}
const JH = (tok) => ({ authorization: `Bearer ${tok}` });
const route = (peer) => `/api/route/${encodeURIComponent(peer)}/_`;

async function crosslink(A, B) {
  // A punta a B (localPort = B.port); B punta ad A (già impostato in boot).
  let stA = store.loadStore(A.nodesPath);
  stA = store.updateNode(stA, 'b', { localPort: B.port });
  store.atomicWriteStore(A.nodesPath, stA);
}

test('bidirezionale: A<->B vedono entrambe le sessions dell\'altra via route', async (t) => {
  const A = await boot(t, 'A', 'b', 0, NODE_ID_B, { token: CRED_B, acceptToken: CRED_A });
  const B = await boot(t, 'B', 'a', A.port, NODE_ID_A, { token: CRED_A, acceptToken: CRED_B });
  await crosslink(A, B);

  const aSeesB = await req(A, 'GET', `${route('b')}/sessions`);
  assert.equal(aSeesB.status, 200, 'A -> B sessions 200');
  assert.ok(Array.isArray(JSON.parse(aSeesB.body).sessions), 'A riceve sessions di B');

  const bSeesA = await req(B, 'GET', `${route('a')}/sessions`);
  assert.equal(bSeesA.status, 200, 'B -> A sessions 200 (direzione opposta)');
  assert.ok(Array.isArray(JSON.parse(bSeesA.body).sessions), 'B riceve sessions di A');
});

test('route-correct: B legge la config di A via route (instanceId di A, non il proprio)', async (t) => {
  const A = await boot(t, 'A', 'b', 0, NODE_ID_B, { token: CRED_B, acceptToken: CRED_A });
  const B = await boot(t, 'B', 'a', A.port, NODE_ID_A, { token: CRED_A, acceptToken: CRED_B });
  await crosslink(A, B);

  // B legge la config di A via route: instanceId riportato e' quello di A
  const viaRoute = await req(B, 'GET', `${route('a')}/config`);
  assert.equal(viaRoute.status, 200);
  const rc = JSON.parse(viaRoute.body);
  assert.equal(rc.instanceId, NODE_ID_A, 'via route B legge la config di A (instanceId di A)');
  assert.notEqual(rc.instanceId, NODE_ID_B, 'NON e\' l\'instanceId di B (route corretta)');

  // control: la config LOCALE di B riporta l'instanceId di B
  const bLocal = await req(B, 'GET', '/api/config');
  assert.equal(JSON.parse(bLocal.body).instanceId, NODE_ID_B);
});

test('sicurezza: credenziale peer sbagliata -> 401; main token mai forwardato', async (t) => {
  const A = await boot(t, 'A', 'b', 0, NODE_ID_B, { token: CRED_B, acceptToken: CRED_A });
  const B = await boot(t, 'B', 'a', A.port, NODE_ID_A, { token: CRED_A, acceptToken: CRED_B });
  // rovina la credenziale che A usa verso B
  let stA = store.loadStore(A.nodesPath);
  stA = store.updateNode(stA, 'b', { localPort: B.port, token: 'WRONG-CREDENTIAL' });
  store.atomicWriteStore(A.nodesPath, stA);

  const r = await req(A, 'GET', `${route('b')}/sessions`);
  assert.equal(r.status, 401, 'credenziale sbagliata -> 401 dal peer');
  assert.ok(!r.body.includes(A.token), 'main token di A mai forwardato');
  assert.ok(!r.body.includes(B.token), 'main token di B mai esposto');
});

test('hub con peer inbound: usa la reversePort, vede il client e non ne possiede il power', async (t) => {
  const A = await boot(t, 'A', 'b', 0, NODE_ID_B, { token: CRED_B, acceptToken: CRED_A });
  const B = await boot(t, 'B', 'a', A.port, NODE_ID_A, { token: CRED_A, acceptToken: CRED_B });
  await crosslink(A, B);

  // Sul nodo hub B, A e' il peer inbound creato dal confirm: localPort e' la
  // reversePort SSH, token e' la credenziale che A accetta. Nessun sidecar locale.
  let stB = store.loadStore(B.nodesPath);
  stB = store.removeNode(stB, 'a');
  stB = store.addNode(stB, {
    name: 'a', remotePort: 41820, localPort: A.port,
    direction: 'inbound', transport: 'inbound', autostart: true, visibility: 'network',
    nodeId: NODE_ID_A, token: CRED_A, acceptToken: CRED_B,
  });
  store.atomicWriteStore(B.nodesPath, stB);
  require('../lib/nodes/health.js').clearHealthCache();

  const health = await req(B, 'GET', '/api/nodes');
  assert.equal(health.status, 200);
  const peer = JSON.parse(health.body).nodes.find((n) => n.name === 'a');
  assert.equal(peer.health.status, 'healthy');
  assert.equal(peer.health.managed, false, 'hub vede il peer ma non controlla il suo tunnel');

  const sessions = await req(B, 'GET', `${route('a')}/sessions`);
  assert.equal(sessions.status, 200, 'il peer inbound resta navigabile via federation route');
});
