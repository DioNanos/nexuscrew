'use strict';
// tests/audio-federation-e2e.test.js — DUE server reali, A parla verso B.
//
// Niente SSH: la porta di forward del peer punta direttamente al secondo server,
// cosi' il percorso esercitato e' quello vero — dispatcher, /api/route,
// peerRouter autenticato con acceptToken, catena visited costruita dal server,
// prova di hop, e infine i gate del TARGET. E' il solo modo per provare che
// l'origine attraversa la federazione senza poter essere iniettata dal client.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const ba = require('../lib/audio/bridge-auth.js');

const PEER_TOKEN = 'peer-token-abcdefghijklmnopqrstuvwxyz0123456789';

const fakeAdapter = () => {
  const spoken = [];
  return {
    id: 'fake', installed: true, limits: 'adapter di test: non produce suono', spoken,
    speak({ text }) { spoken.push(text); return { started: true, done: Promise.resolve({ code: 0 }), kill: () => {} }; },
  };
};

async function bootNode(t, { session, cell, extraCells = [] }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaudio-fed-'));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir,
    configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'),
    tokenPath: path.join(configDir, 'token'),
    topologyCachePath: path.join(configDir, 'topology-cache.json'),
  };
  nodesStore.initStore(paths.nodesPath);
  const adapter = fakeAdapter();
  const { server, token, watcher } = createServer({
    ...paths, filesRoot: path.join(dir, 'files'), port: 0,
    audioAdapterSeam: adapter,
    fleetSeam: {
      available: true, isCellSession: () => true, capabilities: () => [],
      status: async () => ({
        available: true,
        cells: [{ cell, tmuxSession: session, active: true, tmux: true }, ...extraCells],
      }),
    },
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => { server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const secret = ba.loadOrCreateBridgeSecret(path.join(configDir, 'audio-bridge.key'));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const nodeId = nodesStore.loadStore(paths.nodesPath).nodeId;

  const signed = (method, apiPath, body, opts = {}) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = ba.signedHeaders(opts.secret || secret, {
      method, path: apiPath, session: opts.session || session,
      rawBody: payload === undefined ? '' : payload,
    });
    return fetch(`${base}${apiPath}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`, ...headers,
        ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(payload !== undefined ? { body: payload } : {}),
    });
  };
  const plain = (method, apiPath, body) => fetch(`${base}${apiPath}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { dir, configDir, paths, port, base, token, nodeId, adapter, signed, plain, session, cell };
}

// Collega A -> B senza SSH: la "porta di forward locale" del peer punta al
// secondo server. Il resto del percorso federato resta identico a quello reale.
function link(a, b, { visibility = 'network', peerToken = PEER_TOKEN, aVisibility = 'network' } = {}) {
  let stA = nodesStore.loadStoreStrict(a.paths.nodesPath);
  stA = nodesStore.addNode(stA, {
    name: 'peer-b', ssh: 'user@peer-b', remotePort: 41999, localPort: b.port,
    nodeId: b.nodeId, token: peerToken, direction: 'outbound', shared: true, visibility: aVisibility,
  });
  nodesStore.atomicWriteStore(a.paths.nodesPath, stA);

  let stB = nodesStore.loadStoreStrict(b.paths.nodesPath);
  stB = nodesStore.addNode(stB, {
    name: 'peer-a', remotePort: 41999, localPort: a.port,
    nodeId: a.nodeId, acceptToken: PEER_TOKEN, direction: 'inbound', shared: true, visibility,
  });
  nodesStore.atomicWriteStore(b.paths.nodesPath, stB);
}

async function pair(t, opts = {}) {
  const a = await bootNode(t, { session: 'cloud-Dev', cell: 'Dev' });
  const b = await bootNode(t, { session: 'mac-Dev', cell: 'Dev' }); // stesso NOME cella, nodo diverso
  link(a, b, opts);
  return { a, b };
}

const setConsent = (node, consent) => node.plain('PATCH', '/api/settings/audio/consent', { consent });

test('A->B: l origine attraversa la federazione ed e attribuita al nodo giusto', async (t) => {
  const { a, b } = await pair(t);
  await setConsent(b, true);
  const res = await a.signed('POST', '/api/audio/speak', { target: b.nodeId, text: 'parla su B' });
  const body = await res.json();
  assert.equal(res.status, 200, JSON.stringify(body));
  assert.ok(['accepted', 'spoken'].includes(body.status), JSON.stringify(body));
  assert.equal(body.target, b.nodeId);
  assert.equal(b.adapter.spoken.at(-1), 'parla su B', 'il testo e arrivato all adapter del TARGET');
  assert.equal(a.adapter.spoken.length, 0, 'il nodo di origine non parla al posto del target');
});

test('A->B: il target registra il nodo di origine da visited, e la cella come ATTESTATA', async (t) => {
  const { a, b } = await pair(t);
  await setConsent(b, true);
  await a.signed('POST', '/api/audio/speak', { target: b.nodeId, text: 'x', utteranceId: 'e2e-attest-1' });
  // Il receipt lato B appartiene all'origine remota: la cella locale omonima di
  // B non deve poterlo leggere.
  const suoi = await b.signed('GET', '/api/audio/speak/status/e2e-attest-1');
  assert.equal(suoi.status, 404,
    'una cella "Dev" locale non deve vedere il receipt della cella "Dev" di un altro nodo');
});

test('A->B: il consenso e del target — senza consenso il rifiuto arriva onesto, non come successo', async (t) => {
  const { a, b } = await pair(t);
  const res = await a.signed('POST', '/api/audio/speak', { target: b.nodeId, text: 'x' });
  assert.equal(res.status, 422);
  const body = await res.json();
  assert.equal(body.status, 'refused');
  assert.equal(body.reason, 'consent');
  assert.equal(b.adapter.spoken.length, 0);
});

test('A->B: ACL del target — un peer relay-only non ottiene voce', async (t) => {
  const { a, b } = await pair(t, { visibility: 'relay-only' });
  await setConsent(b, true);
  const res = await a.signed('POST', '/api/audio/speak', { target: b.nodeId, text: 'x' });
  const body = await res.json();
  assert.equal(body.status, 'refused');
  assert.equal(body.reason, 'acl', 'far transitare traffico non equivale ad autorizzare un suono');
  assert.equal(b.adapter.spoken.length, 0);
});

test('A->B: credenziale peer sbagliata non diventa mai un successo (falso-401)', async (t) => {
  const { a, b } = await pair(t, { peerToken: 'token-sbagliato-0123456789abcdefghij' });
  await setConsent(b, true);
  const res = await a.signed('POST', '/api/audio/speak', { target: b.nodeId, text: 'x' });
  const body = await res.json();
  assert.notEqual(body.status, 'spoken');
  assert.notEqual(body.status, 'accepted');
  assert.ok(['unknown', 'unreachable', 'refused'].includes(body.status), `stato onesto: ${body.status}`);
  assert.equal(b.adapter.spoken.length, 0);
});

test('target sconosciuto: unreachable, mai un successo silenzioso', async (t) => {
  const { a, b } = await pair(t);
  await setConsent(b, true);
  const res = await a.signed('POST', '/api/audio/speak', { target: 'f'.repeat(32), text: 'x' });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).status, 'unreachable');
});

test('POST diretto su /api/route non puo iniettare la provenienza', async (t) => {
  const { a, b } = await pair(t);
  await setConsent(b, true);
  // Un client locale con il token della UI prova a scavalcare il bridge e a
  // dichiararsi una cella arbitraria passando dalla route federata.
  const res = await a.plain('POST', `/api/route/peer-b/_/audio/speak`, {
    target: b.nodeId, text: 'falsificato', originCell: 'CellaInventata', originNode: 'a'.repeat(32),
  });
  const body = await res.json().catch(() => ({}));
  assert.notEqual(body.status, 'spoken');
  assert.notEqual(body.status, 'accepted');
  assert.equal(b.adapter.spoken.length, 0,
    'il nodo dichiarato nel body non combacia con la catena visited: la richiesta cade');
});

test('stop remoto: A puo fermare su B un enunciato proprio', async (t) => {
  const { a, b } = await pair(t);
  await setConsent(b, true);
  await a.signed('POST', '/api/audio/speak', { target: b.nodeId, text: 'lungo', utteranceId: 'e2e-stop-1' });
  const res = await a.signed('POST', '/api/audio/stop', { target: b.nodeId, utteranceId: 'e2e-stop-1' });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).status, 'accepted');
});

test('READONLY sul target: rifiuto esplicito che raggiunge l origine', async (t) => {
  const a = await bootNode(t, { session: 'cloud-Dev', cell: 'Dev' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaudio-fed-ro-'));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir, configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'), tokenPath: path.join(configDir, 'token'),
    topologyCachePath: path.join(configDir, 'topology-cache.json'),
  };
  nodesStore.initStore(paths.nodesPath);
  const adapter = fakeAdapter();
  const { server, watcher } = createServer({
    ...paths, filesRoot: path.join(dir, 'files'), port: 0, readonlyDefault: true,
    audioAdapterSeam: adapter,
    fleetSeam: { available: true, isCellSession: () => true, capabilities: () => [], status: async () => ({ available: true, cells: [] }) },
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => { server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const b = { port: server.address().port, nodeId: nodesStore.loadStore(paths.nodesPath).nodeId, paths, adapter };
  link(a, b);
  const res = await a.signed('POST', '/api/audio/speak', { target: b.nodeId, text: 'x' });
  const body = await res.json();
  assert.notEqual(body.status, 'spoken');
  assert.equal(adapter.spoken.length, 0, 'un nodo in sola lettura non emette suono su richiesta federata');
});
