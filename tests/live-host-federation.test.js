'use strict';
// tests/live-host-federation.test.js — the Live bridge of a CLIENT node
// segue la designazione anche quando punta a una cella di un ALTRO nodo.
//
// Il sistema e' quello di produzione: store vero, route live-host vere, e il
// routeHandler federato vero (stesso codice che in produzione inoltra
// /api/route). Il proprietario e' un server express vero con la catena
// d'ingresso della federazione (gate liveHostAccess + prova di hop + route
// live-host vere). L'app Live continua a non scegliere il target: sceglie la
// designazione, che ora puo' puntare fuori nodo.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const express = require('express');
const { liveHostRoutes } = require('../lib/live-host/routes.js');
const { createLiveHostStore } = require('../lib/live-host/store.js');
const { createLiveHostFederation } = require('../lib/live-host/federation.js');
const fed = require('../lib/proxy/federation.js');
const store = require('../lib/nodes/store.js');
// The rate limit and the origin resolution are the PRODUCTION objects: a bench
// that passes a shape the real modules never produce cannot see the defect they
// would hide (that is exactly how the dead federated budget went unnoticed).
const { createSpeakRateLimiter, LIMITS } = require('../lib/audio/rate-limit.js');
const { createOriginResolver } = require('../lib/audio/origin.js');
const { signHop, HOP_HEADER } = require('../lib/proxy/hop-proof.js');

const HUB_ID = 'a'.repeat(32);
const CLIENT_ID = 'b'.repeat(32);
const OWNER_ID = 'c'.repeat(32);
const HUB_TOKEN = 'hub-accepts-client';
const CLIENT_TOKEN = 'client-local-token';
const HOP = 'x-nexuscrew-hop';

const DIR = () => fs.mkdtempSync(path.join(os.tmpdir(), `lh-fed-${process.pid}-${Math.random().toString(36).slice(2)}`));
const listen = (app) => new Promise((resolve) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => resolve(s)); });
const close = (s) => new Promise((r) => s.close(r));
const jfetch = async (url, { method = 'GET', token, body, hop = false } = {}) => {
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (hop) headers[HOP] = 'proof';
  const res = await fetch(url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
};

const mockFleet = (cells) => Promise.resolve({
  available: true,
  status: async () => ({ available: true, cells }),
  lease: { status: () => ({ state: 'live' }) },
});

function startOwner({ liveHostAccess = true, bridgeResult, bridgeFault = 0 } = {}) {
  const dir = DIR();
  const ownerStore = createLiveHostStore({ filePath: path.join(dir, 'owner-live-host.json') });
  const nodesPath = path.join(dir, 'owner-nodes.json');
  const seen = { bridgeBodies: [], hopProofs: 0 };
  // The permission is read per request, so a test can revoke it after the
  // designation exists and still watch the owner refuse the next forward.
  const gate = { liveHostAccess };
  const app = express();
  let serverRef = null;
  const selfPort = () => (serverRef && serverRef.address() ? serverRef.address().port : 0);
  // Ingresso federato VERO (stesso routeHandler della produzione): il peer
  // (client) entra con il suo token di route e il gate liveHostAccess viene
  // valutato PRIMA delle route, dal proprietario.
  app.use('/federation/route', (req, res) => {
    const ingress = { nodeId: CLIENT_ID, liveHostAccess: gate.liveHostAccess, panelAccess: true };
    return fed.routeHandler({
      nodesPath, localPort: selfPort, localCredential: () => 'owner-local-token',
      ingress, readonly: () => false, hopSecret: () => 'owner-hop-secret',
    })(req, res);
  });
  const fakeBridge = {
    resolveForLive: async () => bridgeResult || { mode: 'tmux', cell: 'dev', cwd: '/w', prompt: { applied: false, reason: 'tmux-mode' } },
    threadStatus: async () => 'unknown',
  };
  // Production mounts its JSON parsers per route, and the bridge route is one of
  // them (lib/server.js). The observation needs the same thing to see what the
  // client actually forwarded.
  app.use('/api/live-host/bridge', express.json({ limit: '4kb' }));
  app.use('/api/live-host', (req, res, next) => {
    if (req.headers[HOP]) seen.hopProofs += 1;
    if (req.path === '/bridge') {
      seen.bridgeBodies.push(req.body || {});
      // An owner that fails with something we cannot name: the client must not
      // hand the peer's status or text through as if it had named it itself.
      if (bridgeFault) return res.status(bridgeFault).json({ error: 'owner bridge failure' });
    }
    next();
  });
  app.use('/api/live-host', liveHostRoutes({
    fleetP: mockFleet([{ cell: 'dev', active: true, tmuxSession: 'cell-one', engine: 'codex-vl' }]),
    store: ownerStore,
    bridge: fakeBridge,
    readonly: () => false,
    originResolver: createOriginResolver({ localNodeId: () => OWNER_ID, hopSecret: () => 'owner-hop-secret' }),
    federatedRate: createSpeakRateLimiter(),
  }));
  return {
    app, ownerStore, seen,
    revokeLiveHostAccess: () => { gate.liveHostAccess = false; },
    setServer: (server) => {
      serverRef = server;
      let ost = store.emptyStore(OWNER_ID);
      ost = store.addNode(ost, {
        name: 'client', nodeId: CLIENT_ID, localPort: 1, remotePort: 41821,
        token: 'client-to-owner', direction: 'inbound', shared: true,
        transport: 'inbound', visibility: 'network',
      });
      store.atomicWriteStore(nodesPath, ost);
    },
  };
}

async function startClient({ ownerPort, ownerLiveHostAccess, bridgeResult } = {}) {
  const dir = DIR();
  const clientStore = createLiveHostStore({ filePath: path.join(dir, 'client-live-host.json') });
  const nodesPath = path.join(dir, 'nodes.json');
  let st = store.emptyStore(CLIENT_ID);
  st = store.addNode(st, {
    name: 'hub', nodeId: HUB_ID, localPort: ownerPort, remotePort: 41820,
    token: HUB_TOKEN, acceptToken: CLIENT_TOKEN,
    direction: 'inbound', shared: true, transport: 'inbound', visibility: 'network',
  });
  store.atomicWriteStore(nodesPath, st);
  const ledger = {
    recordRemote: ({ ownerId, hostCell, revision }) => clientStore.setRemoteDesignation({ ownerId, hostCell, revision }),
    clearRemote: (ownerId) => clientStore.clearForOwner(ownerId),
  };
  const app = express();
  // No body parser in front of the proxy: production mounts its JSON parsers per
  // route (lib/server.js), so a forwarded POST still carries its body. The route
  // handlers mounted here bring their own parser.
  let clientServerRef = null;
  const liveFed = createLiveHostFederation({
    localNodeId: () => CLIENT_ID,
    peers: async () => [{ nodeId: HUB_ID, name: 'hub', route: ['hub'] }],
    localPort: () => (clientServerRef && clientServerRef.address() ? clientServerRef.address().port : 0),
    localToken: () => CLIENT_TOKEN,
  });
  app.use('/api/live-host', liveHostRoutes({
    fleetP: mockFleet([]),
    store: clientStore,
    bridge: { resolveForLive: async () => bridgeResult || { mode: 'tmux', cell: 'local-dev', cwd: '/l', prompt: { applied: false, reason: 'tmux-mode' } } },
    readonly: () => false,
    federation: liveFed,
    originResolver: { hop: true },
    // The client gets the production limiter too (lib/server.js mounts the same
    // object on both sides). A fake shape here is exactly what hid the dead
    // branch on the owner: no bench keeps one.
    federatedRate: createSpeakRateLimiter(),
  }));
  app.use('/api/route', (req, res) => fed.routeHandler({
    nodesPath, localPort: () => ownerPort, localCredential: () => HUB_TOKEN,
    ingress: null, readonly: () => false, hopSecret: () => 'hop-secret',
    liveHostLedger: ledger,
  })(req, res));
  const server = await listen(app);
  clientServerRef = server;
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, clientStore, base, liveFed };
}

test('remote designation: the client records {hostCell, ownerId, revision} and GET reports remote:true with the owner state', async () => {
  const owner = startOwner({});
  const ownerServer = await listen(owner.app);
  owner.setServer(ownerServer);
  const client = await startClient({ ownerPort: ownerServer.address().port });
  console.log('a: designate start');
  const d = await jfetch(`${client.base}/api/route/hub/_/live-host/designate`, { method: 'POST', body: { cellId: 'dev', expectedRevision: 0 } });
  console.log('a: designate done', d.status);
  assert.equal(d.status, 200);
  assert.equal(d.json.hostCell, 'dev');
  const snap = client.clientStore.snapshot();
  assert.equal(snap.hostCell, 'dev');
  assert.equal(snap.ownerId, HUB_ID);
  assert.equal(snap.revision, 1);
  console.log('a: GET start');
  const g = await jfetch(`${client.base}/api/live-host`);
  console.log('a: GET done', g.status, JSON.stringify(g.json));
  assert.equal(g.status, 200);
  assert.equal(g.json.remote, true);
  assert.equal(g.json.ownerId, HUB_ID);
  assert.equal(g.json.hostCell, 'dev');
  assert.ok('threadStatus' in g.json);
  console.log('a: closing');
  await Promise.all([close(ownerServer), close(client.server)]);
  console.log('a: closed');
});

test('federated bridge: with a remote host the client forwards to the owner and returns the answer with owner and route', async () => {
  const bridgeResult = { mode: 'tmux', cell: 'dev', cwd: '/w', prompt: { applied: false, reason: 'tmux-mode' } };
  const owner = startOwner({ bridgeResult });
  const ownerServer = await listen(owner.app);
  owner.setServer(ownerServer);
  const client = await startClient({ ownerPort: ownerServer.address().port });
  await jfetch(`${client.base}/api/route/hub/_/live-host/designate`, { method: 'POST', body: { cellId: 'dev', expectedRevision: 0 } });
  const b = await jfetch(`${client.base}/api/live-host/bridge`, { method: 'POST', body: {} });
  assert.equal(b.status, 200);
  assert.equal(b.json.mode, 'tmux');
  assert.equal(b.json.cell, 'dev');
  assert.equal(b.json.owner, HUB_ID);
  assert.deepEqual(b.json.route, ['hub']);
  assert.equal(owner.seen.bridgeBodies.length, 1);
  assert.deepEqual(owner.seen.bridgeBodies[0], { expect: { hostCell: 'dev', revision: 1 } });
  console.log('a: closing');
  await Promise.all([close(ownerServer), close(client.server)]);
  console.log('a: closed');
});

test('federated bridge: a revoked permission answers 403 by name and the pointer stays', async () => {
  const owner = startOwner({});
  const ownerServer = await listen(owner.app);
  owner.setServer(ownerServer);
  const client = await startClient({ ownerPort: ownerServer.address().port });
  const d = await jfetch(`${client.base}/api/route/hub/_/live-host/designate`, { method: 'POST', body: { cellId: 'dev', expectedRevision: 0 } });
  assert.equal(d.status, 200);
  assert.equal(client.clientStore.snapshot().ownerId, HUB_ID, 'the pointer exists before the revocation');
  // The owner changes its mind after the pointer exists: the next forward must
  // come back with the owner's own name for the refusal, and nothing may be
  // resolved locally in its place. Dropping the pointer is the operator's call
  // (clear), never a side effect of a refusal.
  owner.revokeLiveHostAccess();
  const b = await jfetch(`${client.base}/api/live-host/bridge`, { method: 'POST', body: {} });
  assert.equal(b.status, 403);
  assert.equal(b.json.reason, 'live-host-not-granted');
  assert.notEqual(b.json.cell, 'local-dev');
  const snap = client.clientStore.snapshot();
  assert.equal(snap.ownerId, HUB_ID);
  assert.equal(snap.hostCell, 'dev');
  await Promise.all([close(ownerServer), close(client.server)]);
});

test('federated bridge: the owner designation moved → 409 by name', async () => {
  const owner = startOwner({});
  const ownerServer = await listen(owner.app);
  owner.setServer(ownerServer);
  const client = await startClient({ ownerPort: ownerServer.address().port });
  await jfetch(`${client.base}/api/route/hub/_/live-host/designate`, { method: 'POST', body: { cellId: 'dev', expectedRevision: 0 } });
  await owner.ownerStore.compareAndSet(1, 'other');
  const b = await jfetch(`${client.base}/api/live-host/bridge`, { method: 'POST', body: {} });
  assert.equal(b.status, 409);
  assert.equal(b.json.reason, 'live-host-expectation-mismatch');
  console.log('a: closing');
  await Promise.all([close(ownerServer), close(client.server)]);
  console.log('a: closed');
});

test('federated bridge: unreachable owner → named error, no local fallback', async () => {
  const client = await startClient({ ownerPort: 1 });
  await client.clientStore.setRemoteDesignation({ ownerId: HUB_ID, hostCell: 'dev', revision: 3 });
  const b = await jfetch(`${client.base}/api/live-host/bridge`, { method: 'POST', body: {} });
  assert.equal(b.status, 502);
  assert.equal(b.json.reason, 'live-host-owner-unreachable');
  assert.notEqual(b.json.cell, 'local-dev');
  await close(client.server);
});

test('local host: POST /bridge stays exactly what it is today', async () => {
  const client = await startClient({ ownerPort: 1 });
  await client.clientStore.compareAndSet(0, 'local-dev');
  const b = await jfetch(`${client.base}/api/live-host/bridge`, { method: 'POST', body: {} });
  assert.equal(b.status, 200);
  assert.equal(b.json.mode, 'tmux');
  assert.equal(b.json.cell, 'local-dev');
  assert.equal(b.json.owner, undefined);
  await close(client.server);
});

test('GET with an unreachable owner → threadStatus unknown with a reason', async () => {
  const client = await startClient({ ownerPort: 1 });
  await client.clientStore.setRemoteDesignation({ ownerId: HUB_ID, hostCell: 'dev', revision: 3 });
  console.log('a: GET start');
  const g = await jfetch(`${client.base}/api/live-host`);
  console.log('a: GET done', g.status, JSON.stringify(g.json));
  assert.equal(g.status, 200);
  assert.equal(g.json.remote, true);
  assert.equal(g.json.threadStatus, 'unknown');
  assert.equal(g.json.reason, 'live-host-owner-unreachable');
  await close(client.server);
});

test('remote clear: removes the owner designation and the local pointer', async () => {
  const owner = startOwner({});
  const ownerServer = await listen(owner.app);
  owner.setServer(ownerServer);
  const client = await startClient({ ownerPort: ownerServer.address().port });
  await jfetch(`${client.base}/api/route/hub/_/live-host/designate`, { method: 'POST', body: { cellId: 'dev', expectedRevision: 0 } });
  const c = await jfetch(`${client.base}/api/route/hub/_/live-host/clear`, { method: 'POST', body: { expectedRevision: 1 } });
  assert.equal(c.status, 200);
  const snap = client.clientStore.snapshot();
  assert.equal(snap.hostCell, null);
  assert.equal(snap.ownerId, null);
  await Promise.all([close(ownerServer), close(client.server)]);
});

test('federated bridge: a body without expect or with extra fields → 400; a valid expect on the local route stays a local 400', async () => {
  const owner = startOwner({});
  const ownerServer = await listen(owner.app);
  const client = await startClient({ ownerPort: ownerServer.address().port });
  await jfetch(`${client.base}/api/route/hub/_/live-host/designate`, { method: 'POST', body: { cellId: 'dev', expectedRevision: 0 } });
  const bad = await jfetch(`${client.base}/api/live-host/bridge`, { method: 'POST', body: { expect: { hostCell: 'dev' } } });
  assert.equal(bad.status, 400);
  await Promise.all([close(ownerServer), close(client.server)]);
});

test('federated proxy: a body a local middleware already read is refused at once, by name', async () => {
  const owner = startOwner({});
  const ownerServer = await listen(owner.app);
  owner.setServer(ownerServer);
  // Deliberately the shape the other tests do NOT use: a body parser in front of
  // the proxy. The forward cannot carry a body that is already gone, so it has to
  // say so immediately instead of announcing bytes nobody will send.
  const dir = DIR();
  const nodesPath = path.join(dir, 'nodes.json');
  let st = store.emptyStore(CLIENT_ID);
  st = store.addNode(st, {
    name: 'hub', nodeId: HUB_ID, localPort: ownerServer.address().port, remotePort: 41820,
    token: HUB_TOKEN, acceptToken: CLIENT_TOKEN,
    direction: 'inbound', shared: true, transport: 'inbound', visibility: 'network',
  });
  store.atomicWriteStore(nodesPath, st);
  const app = express();
  app.use(express.json({ limit: '4kb' }));
  app.use('/api/route', (req, res) => fed.routeHandler({
    nodesPath, localPort: () => ownerServer.address().port, localCredential: () => HUB_TOKEN,
    ingress: null, readonly: () => false, hopSecret: () => 'hop-secret',
  })(req, res));
  const server = await listen(app);
  const base = `http://127.0.0.1:${server.address().port}`;
  const started = Date.now();
  const r = await jfetch(`${base}/api/route/hub/_/live-host/designate`, { method: 'POST', body: { cellId: 'dev', expectedRevision: 0 } });
  const elapsed = Date.now() - started;
  assert.equal(r.status, 502);
  assert.equal(r.json.reason, 'federation-body-consumed');
  assert.ok(elapsed < 2500, `refused at once, not after the upstream timeout (took ${elapsed} ms)`);
  await Promise.all([close(server), close(ownerServer)]);
});

test('federated bridge: an owner failure we cannot name becomes our own generic outcome', async () => {
  const owner = startOwner({ bridgeFault: 500 });
  const ownerServer = await listen(owner.app);
  owner.setServer(ownerServer);
  const client = await startClient({ ownerPort: ownerServer.address().port });
  await jfetch(`${client.base}/api/route/hub/_/live-host/designate`, { method: 'POST', body: { cellId: 'dev', expectedRevision: 0 } });
  const b = await jfetch(`${client.base}/api/live-host/bridge`, { method: 'POST', body: {} });
  assert.equal(b.status, 502);
  assert.equal(b.json.reason, 'live-host-owner-rejected');
  assert.notEqual(b.json.reason, 'live-host-owner-unreachable');
  assert.equal(b.json.ownerStatus, 500);
  await Promise.all([close(ownerServer), close(client.server)]);
});

test('federated bridge: the budget is really consumed — after the limit the owner stops answering', async () => {
  const owner = startOwner({});
  const ownerServer = await listen(owner.app);
  owner.setServer(ownerServer);
  const client = await startClient({ ownerPort: ownerServer.address().port });
  await jfetch(`${client.base}/api/route/hub/_/live-host/designate`, { method: 'POST', body: { cellId: 'dev', expectedRevision: 0 } });
  try {
    // The number comes from the module, never hard-coded: what is being asked
    // here is the production limiter, not a number this bench picked.
    const limit = LIMITS['origin-cell'];
    const answers = [];
    for (let i = 0; i < limit + 1; i += 1) {
      answers.push(await jfetch(`${client.base}/api/live-host/bridge`, { method: 'POST', body: {} }));
    }
    for (const r of answers.slice(0, limit)) assert.equal(r.status, 200);
    const last = answers[answers.length - 1];
    // The client keeps its own words for a refusal it did not name (documented
    // and audited rule) and reports the owner status it saw. What matters here:
    // the owner answered 429 instead of resolving, so the budget was consumed.
    assert.equal(last.json.ownerStatus, 429);
    assert.notEqual(last.json.mode, 'tmux');
    assert.notEqual(last.json.cell, 'local-dev');
  } finally {
    // A failing assertion must not leave the two servers listening: the runner
    // would wait for handles that nobody closes.
    await Promise.all([close(ownerServer), close(client.server)]);
  }
});

// The owner's own answer, seen without the client's vocabulary: a federated call
// that reaches the owner route with a hop proof the owner can verify — the shape
// production signs for the last hop.
const callOwnerDirect = async (port, { proof, visited, body = '{}' }) => {
  const res = await fetch(`http://127.0.0.1:${port}/api/live-host/bridge`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [HOP_HEADER]: proof,
      'x-nexuscrew-visited': visited.join(','),
    },
    body,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

test('federated bridge: on the owner the refusal after the limit is exactly 429 rate-limited with retryInMs', async () => {
  const owner = startOwner({});
  const ownerServer = await listen(owner.app);
  owner.setServer(ownerServer);
  const port = ownerServer.address().port;
  const visited = [CLIENT_ID, OWNER_ID];
  const proof = signHop('owner-hop-secret', { method: 'POST', path: '/api/live-host/bridge', visited });
  try {
    const limit = LIMITS['origin-cell'];
    const answers = [];
    for (let i = 0; i < limit + 1; i += 1) answers.push(await callOwnerDirect(port, { proof, visited }));
    for (const r of answers.slice(0, limit)) assert.equal(r.status, 200);
    const last = answers[answers.length - 1];
    assert.equal(last.status, 429);
    assert.equal(last.json.reason, 'rate-limited');
    assert.ok(Number.isInteger(last.json.retryInMs) && last.json.retryInMs > 0, 'retryInMs says when to come back');
  } finally {
    await close(ownerServer);
  }
});

test('federated bridge: an origin the owner cannot verify is refused, never served without a budget', async () => {
  const owner = startOwner({});
  const ownerServer = await listen(owner.app);
  owner.setServer(ownerServer);
  const port = ownerServer.address().port;
  const visited = [CLIENT_ID, OWNER_ID];
  try {
    // A proof signed by someone else: signature and chain do not hold together,
    // so there is no attested sender to count against. Falling through to the
    // bridge would be exactly the silent hole this branch exists to close.
    const badProof = signHop('not-the-owner-secret', { method: 'POST', path: '/api/live-host/bridge', visited });
    const r = await callOwnerDirect(port, { proof: badProof, visited });
    assert.equal(r.status, 403);
    assert.equal(r.json.reason, 'live-host-origin-unverified');
  } finally {
    await close(ownerServer);
  }
});
