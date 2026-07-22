'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const WebSocket = require('ws');
const { createServer } = require('../lib/server.js');
const store = require('../lib/nodes/store.js');
const fed = require('../lib/proxy/federation.js');

const listen = (app) => new Promise((resolve) => { const s = http.createServer(app); s.listen(0, '127.0.0.1', () => resolve(s)); });
const close = (s) => new Promise((resolve) => s.close(resolve));
const rawRequest = (url, headers = {}) => new Promise((resolve, reject) => {
  const req = http.get(url, { headers }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: () => JSON.parse(Buffer.concat(chunks).toString()) }));
  });
  req.on('error', reject);
});

test('hub Share OFF gates topology immediately while the old reverse port still answers', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-fed-share-off-'));
  const reverse = await listen((_req, res) => res.end('still-alive'));
  const nodesPath = path.join(dir, 'hub-nodes.json');
  let st = store.emptyStore('a'.repeat(32));
  st = store.addNode(st, {
    name: 'pixel', remotePort: 41820, localPort: reverse.address().port,
    direction: 'inbound', transport: 'inbound', autostart: true,
    shared: true, visibility: 'network', nodeId: 'b'.repeat(32),
    token: 'hub-to-pixel', acceptToken: 'pixel-to-hub',
  });
  store.atomicWriteStore(nodesPath, st);
  const app = express();
  app.use('/federation', fed.peerRouter({
    nodesPath, localPort: 1, localCredential: () => 'hub-main',
  }));
  const hub = await listen(app);
  t.after(async () => { await close(hub); await close(reverse); fs.rmSync(dir, { recursive: true, force: true }); });

  assert.deepEqual((await fed.collectTopology({ nodesPath, ttl: 1 })).nodes.map((node) => node.name), ['pixel']);
  assert.equal((await rawRequest(`http://127.0.0.1:${reverse.address().port}/`)).status, 200);
  const response = await fetch(`http://127.0.0.1:${hub.address().port}/federation/share`, {
    method: 'POST',
    headers: { authorization: 'Bearer pixel-to-hub', 'content-type': 'application/json' },
    body: JSON.stringify({ shared: false }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { shared: false });
  assert.equal(store.getNode(store.loadStoreStrict(nodesPath), 'pixel').shared, false);
  assert.deepEqual((await fed.collectTopology({ nodesPath, ttl: 1 })).nodes, []);
  assert.equal((await rawRequest(`http://127.0.0.1:${reverse.address().port}/`)).status, 200,
    'authorization revocation, not port liveness, is the topology gate');
});

test('scoped federation HTTP reaches sessions, fleet, owner decks and only the hub invite settings mutation', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-fed-http-'));
  const destNodes = path.join(dir, 'dest.json');
  let ds = store.emptyStore('d'.repeat(32));
  ds = store.addNode(ds, { name: 'relay', remotePort: 41820, localPort: 44001, direction: 'inbound', transport: 'inbound', autostart: true, visibility: 'network', nodeId: 'a'.repeat(32), token: 'dest-to-relay', acceptToken: 'relay-to-dest' });
  store.atomicWriteStore(destNodes, ds);

  let sessionHits = 0; let fleetHits = 0; let deckHits = 0; let inviteHits = 0; let forbiddenHits = 0; let deleteHits = 0; let seen = null;
  let diagnosticHits = 0; let diagnosticQuery = '';
  let cellGetHits = 0; let cellSendHits = 0; let cellVisited = null;
  const local = express();
  local.use((req, res, next) => req.headers.authorization === 'Bearer dest-main' ? next() : res.sendStatus(401));
  local.get('/api/sessions', (req, res) => {
    sessionHits += 1;
    seen = { url: req.url, forwarded: req.headers.forwarded, xforwarded: req.headers['x-forwarded-for'], xhop: req.headers['x-hop'] };
    res.set('connection', 'x-response-hop'); res.set('x-response-hop', 'secret');
    res.json({ sessions: [{ name: 'remote-one' }] });
  });
  local.delete('/api/sessions/:name', (_req, res) => { deleteHits += 1; res.json({ killed: true }); });
  local.get('/api/fleet/status', (_req, res) => { fleetHits += 1; res.json({ available: true, provider: 'builtin' }); });
  local.get('/api/cells', (_req, res) => { cellGetHits += 1; res.json({ instanceId: 'd'.repeat(32), cells: [] }); });
  local.post('/api/cells/send', express.json(), (req, res) => {
    cellSendHits += 1;
    cellVisited = req.headers['x-nexuscrew-visited'];
    res.json({ id: req.body.id, status: 'submitted' });
  });
  local.get('/api/decks', (_req, res) => { deckHits += 1; res.json({ schemaVersion: 1, decks: [{ name: 'main', revision: 0, layout: { columns: [] } }] }); });
  local.post('/api/decks', express.json(), (req, res) => { deckHits += 1; res.status(201).json({ name: req.body.name, revision: 0, layout: { columns: [] } }); });
  local.put('/api/decks/:name', express.json(), (req, res) => { deckHits += 1; res.json({ name: req.params.name, revision: req.body.expectedRevision + 1, layout: req.body.layout }); });
  local.get('/api/topology', (_req, res) => res.json({ nodes: [] }));
  local.get('/api/diagnostics/status', (_req, res) => { diagnosticHits += 1; res.json({ verbose: false }); });
  local.get('/api/diagnostics/logs', (req, res) => { diagnosticHits += 1; diagnosticQuery = req.url; res.json({ records: [], cursor: Number(req.query.after || 0) }); });
  local.patch('/api/diagnostics/verbose', express.json(), (req, res) => { diagnosticHits += 1; res.json({ verbose: req.body.enabled === true }); });
  local.delete('/api/diagnostics/logs', (_req, res) => { diagnosticHits += 1; res.json({ cleared: 0 }); });
  local.post('/api/settings/peering/invite', express.json(), (req, res) => {
    inviteHits += 1;
    res.json({ pairingUrl: `http://127.0.0.1:41777/#pair=hub-${req.body.ssh}` });
  });
  local.post('/api/files/outbox', (_req, res) => { forbiddenHits += 1; res.sendStatus(500); });
  local.all('/api/settings*', (_req, res) => { forbiddenHits += 1; res.sendStatus(500); });
  const localServer = await listen(local);
  t.after(() => close(localServer));

  const dest = express();
  dest.use('/federation', fed.peerRouter({ nodesPath: destNodes, localPort: localServer.address().port, localCredential: () => 'dest-main' }));
  const destServer = await listen(dest);
  t.after(() => close(destServer));

  const relayNodes = path.join(dir, 'relay.json');
  let rs = store.emptyStore('a'.repeat(32));
  rs = store.addNode(rs, { name: 'mac', ssh: 'mac', remotePort: 41820, localPort: destServer.address().port, direction: 'outbound', transport: 'ssh', autostart: true, visibility: 'network', nodeId: 'd'.repeat(32), token: 'relay-to-dest', acceptToken: 'dest-to-relay' });
  store.atomicWriteStore(relayNodes, rs);
  const relay = express();
  relay.use('/api/route', fed.localRouter({ nodesPath: relayNodes, localPort: 1, localCredential: () => 'unused' }));
  const relayServer = await listen(relay);
  t.after(async () => { await close(relayServer); fs.rmSync(dir, { recursive: true, force: true }); });

  const base = `http://127.0.0.1:${relayServer.address().port}`;
  const ok = await rawRequest(`${base}/api/route/mac/_/sessions?token=MAIN-PWA-SECRET&x=1`,
    { forwarded: 'for=evil', 'x-forwarded-for': 'evil', connection: 'x-hop', 'x-hop': 'secret' });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json().sessions.map((x) => x.name), ['remote-one']);
  assert.equal(ok.headers['x-response-hop'], undefined);
  assert.equal(sessionHits, 1);
  assert.deepEqual(seen, { url: '/api/sessions?x=1', forwarded: undefined, xforwarded: undefined, xhop: undefined });
  assert.equal((await fetch(`${base}/api/route/mac/_/sessions/remote-one`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}/api/route/mac/_/sessions/files`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}/api/route/mac/_/sessions/_`, { method: 'DELETE' })).status, 200);
  assert.equal(deleteHits, 3, 'ordinary, capability-like, and underscore session names reach only the selected destination');
  assert.equal((await fetch(`${base}/api/route/mac/_/files/outbox`, { method: 'POST' })).status, 404);
  assert.equal((await fetch(`${base}/api/route/mac/_/settings`)).status, 404);
  const invite = await fetch(`${base}/api/route/mac/_/settings/peering/invite`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ssh: 'vps3' }),
  });
  assert.equal(invite.status, 200);
  assert.equal((await invite.json()).pairingUrl, 'http://127.0.0.1:41777/#pair=hub-vps3');
  assert.equal(await fetch(`${base}/api/route/mac/_/settings/peering/invite`).then((r) => r.status), 404);
  assert.equal((await fetch(`${base}/api/route/mac/_/fleet/status`)).status, 200);
  assert.equal((await fetch(`${base}/api/route/mac/_/cells`)).status, 200);
  const cellMessage = await fetch(`${base}/api/route/mac/_/cells/send`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-nexuscrew-visited': 'f'.repeat(32) },
    body: JSON.stringify({ id: 'message-id' }),
  });
  assert.equal(cellMessage.status, 200);
  assert.equal(cellVisited, `${'a'.repeat(32)},${'d'.repeat(32)}`,
    'client header is replaced by the server-controlled route identity');
  const forgedOrigin = await fetch(`http://127.0.0.1:${destServer.address().port}/federation/route/_/cells/send`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer relay-to-dest',
      'content-type': 'application/json',
      'x-nexuscrew-visited': 'f'.repeat(32),
    },
    body: JSON.stringify({ id: 'forged-origin' }),
  });
  assert.equal(forgedOrigin.status, 409, 'visited origin must be bound to the authenticated ingress peer');
  assert.equal(cellSendHits, 1, 'forged origin never reaches the destination cells API');
  assert.equal((await fetch(`${base}/api/route/mac/_/decks`)).status, 200);
  assert.equal((await fetch(`${base}/api/route/mac/_/decks`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'work' }),
  })).status, 201);
  assert.equal((await fetch(`${base}/api/route/mac/_/decks/work`, {
    method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedRevision: 0, layout: { columns: [] } }),
  })).status, 200);
  assert.equal((await fetch(`${base}/api/route/mac/_/topology`)).status, 200);
  assert.equal((await fetch(`${base}/api/route/mac/_/diagnostics/status`)).status, 200);
  assert.equal((await fetch(`${base}/api/route/mac/_/diagnostics/logs?after=7&limit=20`)).status, 200);
  assert.equal(diagnosticQuery, '/api/diagnostics/logs?after=7&limit=20');
  assert.equal((await fetch(`${base}/api/route/mac/_/diagnostics/verbose`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, durationSeconds: 900 }),
  })).status, 200);
  assert.equal((await fetch(`${base}/api/route/mac/_/diagnostics/logs`, { method: 'DELETE' })).status, 200);
  assert.equal((await fetch(`${base}/api/route/mac/_/diagnostics/status?raw=1`)).status, 404);
  assert.equal((await fetch(`${base}/api/route/mac/_/diagnostics/logs?after=1&after=2`)).status, 404);
  assert.equal(diagnosticHits, 4, 'only exact diagnostics methods and bounded query reach the peer');
  assert.equal(fleetHits, 1);
  assert.equal(cellGetHits, 1);
  assert.equal(cellSendHits, 1);
  assert.equal(deckHits, 3);
  assert.equal(inviteHits, 1);
  assert.equal(forbiddenHits, 0);
});

test('server-controlled visited IDs reject an HTTP federation cycle', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-fed-cycle-'));
  const reserve = async () => { const s = await listen((_q, r) => r.end()); const p = s.address().port; await close(s); return p; };
  const aPort = await reserve(); const bPort = await reserve(); const cPort = await reserve();
  const aPath = path.join(dir, 'a.json'); const bPath = path.join(dir, 'b.json'); const cPath = path.join(dir, 'c.json');
  const node = (name, port, nodeId, token, acceptToken) => ({ name, ssh: name, remotePort: port, localPort: port, direction: 'outbound', transport: 'ssh', autostart: false, shared: true, visibility: 'network', nodeId, token, acceptToken });
  let a = store.emptyStore('a'.repeat(32));
  a = store.addNode(a, node('b', bPort, 'b'.repeat(32), 'a-to-b', 'b-to-a'));
  a = store.addNode(a, node('c', cPort, 'c'.repeat(32), 'a-to-c', 'c-to-a'));
  let b = store.emptyStore('b'.repeat(32));
  b = store.addNode(b, node('a', aPort, 'a'.repeat(32), 'b-to-a', 'a-to-b'));
  b = store.addNode(b, node('c', cPort, 'c'.repeat(32), 'b-to-c', 'c-to-b'));
  let c = store.emptyStore('c'.repeat(32));
  c = store.addNode(c, node('b', bPort, 'b'.repeat(32), 'c-to-b', 'b-to-c'));
  c = store.addNode(c, node('a', aPort, 'a'.repeat(32), 'c-to-a', 'a-to-c'));
  store.atomicWriteStore(aPath, a); store.atomicWriteStore(bPath, b); store.atomicWriteStore(cPath, c);
  const aa = express();
  aa.use('/api/route', fed.localRouter({ nodesPath: aPath, localPort: aPort, localCredential: () => 'a-main' }));
  aa.use('/federation', fed.peerRouter({ nodesPath: aPath, localPort: aPort, localCredential: () => 'a-main' }));
  const bb = express(); bb.use('/federation', fed.peerRouter({ nodesPath: bPath, localPort: bPort, localCredential: () => 'b-main' }));
  const cc = express(); cc.use('/federation', fed.peerRouter({ nodesPath: cPath, localPort: cPort, localCredential: () => 'c-main' }));
  const as = http.createServer(aa); const bs = http.createServer(bb); const cs = http.createServer(cc);
  await new Promise((resolve) => as.listen(aPort, '127.0.0.1', resolve));
  await new Promise((resolve) => bs.listen(bPort, '127.0.0.1', resolve));
  await new Promise((resolve) => cs.listen(cPort, '127.0.0.1', resolve));
  t.after(async () => { await close(as); await close(bs); await close(cs); fs.rmSync(dir, { recursive: true, force: true }); });
  const r = await fetch(`http://127.0.0.1:${aPort}/api/route/b/c/a/_/sessions`);
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /cycle/);
});

test('relay READONLY blocks federated mutations before forwarding', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-fed-ro-'));
  const p = path.join(dir, 'nodes.json');
  let st = store.emptyStore();
  st = store.addNode(st, { name: 'vps', ssh: 'vps', remotePort: 1, localPort: 1, direction: 'outbound', transport: 'ssh', autostart: true, visibility: 'network' });
  store.atomicWriteStore(p, st);
  const app = express(); app.use('/api/route', fed.localRouter({ nodesPath: p, localPort: 1, localCredential: () => 'x', readonly: () => true }));
  const s = await listen(app); t.after(async () => { await close(s); fs.rmSync(dir, { recursive: true, force: true }); });
  const r = await fetch(`http://127.0.0.1:${s.address().port}/api/route/vps/_/sessions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
  const deck = await fetch(`http://127.0.0.1:${s.address().port}/api/route/vps/_/decks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":"work"}' });
  assert.equal(deck.status, 403);
});

test('federated WebSocket uses scoped hop auth and reaches destination PTY gate', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-fed-ws-'));
  const portFor = async () => { const x = await listen((_req, res) => res.end()); const p = x.address().port; await close(x); return p; };
  const destPort = await portFor(); const rootPort = await portFor();
  const destNodes = path.join(dir, 'dest-nodes.json');
  let ds = store.emptyStore('d'.repeat(32));
  ds = store.addNode(ds, { name: 'root', remotePort: rootPort, localPort: 44001, direction: 'inbound', transport: 'inbound', autostart: true, visibility: 'network', nodeId: 'a'.repeat(32), token: 'dest-to-root', acceptToken: 'root-to-dest' });
  store.atomicWriteStore(destNodes, ds);
  const dest = createServer({ home: dir, nodesPath: destNodes, tokenPath: path.join(dir, 'dest.token'), filesRoot: path.join(dir, 'dest-files'), fleetEnabled: false, port: destPort });
  await new Promise((resolve) => dest.server.listen(destPort, '127.0.0.1', resolve));

  const rootNodes = path.join(dir, 'root-nodes.json');
  let rs = store.emptyStore('a'.repeat(32));
  rs = store.addNode(rs, { name: 'mac', ssh: 'mac', remotePort: destPort, localPort: destPort, direction: 'outbound', transport: 'ssh', autostart: false, visibility: 'network', nodeId: 'd'.repeat(32), token: 'root-to-dest', acceptToken: 'dest-to-root' });
  store.atomicWriteStore(rootNodes, rs);
  const root = createServer({ home: dir, nodesPath: rootNodes, tokenPath: path.join(dir, 'root.token'), filesRoot: path.join(dir, 'root-files'), fleetEnabled: false, port: rootPort });
  await new Promise((resolve) => root.server.listen(rootPort, '127.0.0.1', resolve));
  t.after(async () => { await close(root.server); await close(dest.server); fs.rmSync(dir, { recursive: true, force: true }); });

  const code = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${rootPort}/api/route/mac/_/ws?token=${encodeURIComponent(root.token)}`);
    const timer = setTimeout(() => reject(new Error('federation ws timeout')), 4000);
    ws.on('open', () => ws.send(JSON.stringify({ type: 'attach', session: 'does-not-exist', token: root.token, cols: 80, rows: 24 })));
    ws.on('close', (c) => { clearTimeout(timer); resolve(c); });
    ws.on('error', reject);
  });
  assert.equal(code, 4404, 'scoped federation preauth reached destination; unknown session, not auth failure');
});

test('main-token rotation closes an active federated raw WebSocket', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-fed-rotate-'));
  const upstreamHttp = http.createServer();
  const upstreamWs = new WebSocket.Server({ server: upstreamHttp });
  await new Promise((resolve) => upstreamHttp.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstreamHttp.address().port;
  const nodesPath = path.join(dir, 'nodes.json');
  let st = store.emptyStore('a'.repeat(32));
  st = store.addNode(st, { name: 'peer', ssh: 'peer', remotePort: upstreamPort, localPort: upstreamPort, direction: 'outbound', transport: 'ssh', autostart: false, visibility: 'network', nodeId: 'b'.repeat(32), token: 'peer-scope', acceptToken: 'back-scope' });
  store.atomicWriteStore(nodesPath, st);
  const root = createServer({ home: dir, nodesPath, tokenPath: path.join(dir, 'token'), filesRoot: path.join(dir, 'files'), fleetEnabled: false, port: 0 });
  await new Promise((resolve) => root.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { upstreamWs.close(); await close(root.server); await close(upstreamHttp); fs.rmSync(dir, { recursive: true, force: true }); });
  const port = root.server.address().port;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/route/peer/_/ws?token=${encodeURIComponent(root.token)}`);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const closed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('federated WS stayed open after rotation')), 2000);
    ws.once('close', (code) => { clearTimeout(timer); resolve(code); });
  });
  const rotated = await fetch(`http://127.0.0.1:${port}/api/settings/token/rotate`, { method: 'POST', headers: { authorization: `Bearer ${root.token}` } });
  assert.equal(rotated.status, 200);
  assert.equal(await closed, 1006);
});
