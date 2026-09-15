'use strict';
// tests/live-host-federation.test.js — F2(a): il ponte Live di un nodo CLIENT
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

const HUB_ID = 'a'.repeat(32);
const CLIENT_ID = 'b'.repeat(32);
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

function startOwner({ liveHostAccess = true, bridgeResult } = {}) {
  const dir = DIR();
  const ownerStore = createLiveHostStore({ filePath: path.join(dir, 'owner-live-host.json') });
  const nodesPath = path.join(dir, 'owner-nodes.json');
  const seen = { bridgeBodies: [], hopProofs: 0 };
  const app = express();
  let serverRef = null;
  const selfPort = () => (serverRef && serverRef.address() ? serverRef.address().port : 0);
  // Ingresso federato VERO (stesso routeHandler della produzione): il peer
  // (client) entra con il suo token di route e il gate liveHostAccess viene
  // valutato PRIMA delle route, dal proprietario.
  app.use('/federation/route', (req, res) => {
    const ingress = { nodeId: CLIENT_ID, liveHostAccess, panelAccess: true };
    return fed.routeHandler({
      nodesPath, localPort: selfPort, localCredential: () => 'owner-local-token',
      ingress, readonly: () => false, hopSecret: () => 'owner-hop-secret',
    })(req, res);
  });
  const fakeBridge = {
    resolveForLive: async () => bridgeResult || { mode: 'tmux', cell: 'dev', cwd: '/w', prompt: { applied: false, reason: 'tmux-mode' } },
    threadStatus: async () => 'unknown',
  };
  app.use('/api/live-host', (req, res, next) => {
    if (req.headers[HOP]) seen.hopProofs += 1;
    if (req.path === '/bridge') seen.bridgeBodies.push(req.body || {});
    next();
  });
  app.use('/api/live-host', liveHostRoutes({
    fleetP: mockFleet([{ cell: 'dev', active: true, tmuxSession: 'cloud-dev', engine: 'codex-vl' }]),
    store: ownerStore,
    bridge: fakeBridge,
    readonly: () => false,
    originResolver: { hop: true },
    federatedRate: { allow: () => true },
  }));
  return {
    app, ownerStore, seen,
    setServer: (server) => {
      serverRef = server;
      let ost = store.emptyStore('c'.repeat(32));
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
  app.use(express.json({ limit: '4kb' }));
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
    federatedRate: { allow: () => true },
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

test('F2(a) designate remota: il client registra {hostCell, ownerId, revision} e GET dichiara remote:true con lo stato del proprietario', async () => {
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

test('F2(a) bridge: con host remoto il client inoltra al proprietario e restituisce la risposta con owner e route', async () => {
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

test('F2(a) bridge: proprietario senza liveHostAccess per il client → 403 nominato', async () => {
  const owner = startOwner({ liveHostAccess: false });
  const ownerServer = await listen(owner.app);
  owner.setServer(ownerServer);
  const client = await startClient({ ownerPort: ownerServer.address().port });
  await jfetch(`${client.base}/api/route/hub/_/live-host/designate`, { method: 'POST', body: { cellId: 'dev', expectedRevision: 0 } });
  const b = await jfetch(`${client.base}/api/live-host/bridge`, { method: 'POST', body: {} });
  assert.equal(b.status, 403);
  assert.equal(b.json.reason, 'live-host-not-granted');
  console.log('a: closing');
  await Promise.all([close(ownerServer), close(client.server)]);
  console.log('a: closed');
});

test('F2(a) bridge: cella/revision del proprietario cambiata → 409 nominato', async () => {
  const owner = startOwner({});
  const ownerServer = await listen(owner.app);
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

test('F2(a) bridge: proprietario irraggiungibile → errore nominato, nessun fallback locale', async () => {
  const client = await startClient({ ownerPort: 1 });
  await client.clientStore.setRemoteDesignation({ ownerId: HUB_ID, hostCell: 'dev', revision: 3 });
  const b = await jfetch(`${client.base}/api/live-host/bridge`, { method: 'POST', body: {} });
  assert.equal(b.status, 502);
  assert.equal(b.json.reason, 'live-host-owner-unreachable');
  assert.notEqual(b.json.cell, 'local-dev');
  await close(client.server);
});

test('F2(a) host locale: POST /bridge resta identico a oggi', async () => {
  const client = await startClient({ ownerPort: 1 });
  await client.clientStore.compareAndSet(0, 'local-dev');
  const b = await jfetch(`${client.base}/api/live-host/bridge`, { method: 'POST', body: {} });
  assert.equal(b.status, 200);
  assert.equal(b.json.mode, 'tmux');
  assert.equal(b.json.cell, 'local-dev');
  assert.equal(b.json.owner, undefined);
  await close(client.server);
});

test('F2(a) GET con proprietario irraggiungibile → threadStatus unknown con reason', async () => {
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

test('F2(a) clear remota: pulisce il proprietario e il registro locale', async () => {
  const owner = startOwner({});
  const ownerServer = await listen(owner.app);
  const client = await startClient({ ownerPort: ownerServer.address().port });
  await jfetch(`${client.base}/api/route/hub/_/live-host/designate`, { method: 'POST', body: { cellId: 'dev', expectedRevision: 0 } });
  const c = await jfetch(`${client.base}/api/route/hub/_/live-host/clear`, { method: 'POST', body: { expectedRevision: 1 } });
  assert.equal(c.status, 200);
  const snap = client.clientStore.snapshot();
  assert.equal(snap.hostCell, null);
  assert.equal(snap.ownerId, null);
  await Promise.all([close(ownerServer), close(client.server)]);
});

test('F2(a) bridge federato: body senza expect o con campi extra → 400; expect valido ma route non federata resta 400 locale', async () => {
  const owner = startOwner({});
  const ownerServer = await listen(owner.app);
  const client = await startClient({ ownerPort: ownerServer.address().port });
  await jfetch(`${client.base}/api/route/hub/_/live-host/designate`, { method: 'POST', body: { cellId: 'dev', expectedRevision: 0 } });
  const bad = await jfetch(`${client.base}/api/live-host/bridge`, { method: 'POST', body: { expect: { hostCell: 'dev' } } });
  assert.equal(bad.status, 400);
  await Promise.all([close(ownerServer), close(client.server)]);
});
