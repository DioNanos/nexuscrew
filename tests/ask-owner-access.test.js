'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodes = require('../lib/nodes/store.js');
const { tmuxSessionForCell } = require('../lib/fleet/definitions.js');
const headers = token => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
async function boot(t, extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-owner-access-'));
  const configDir = path.join(home, '.nexuscrew'); fs.mkdirSync(configDir);
  const nodesPath = path.join(configDir, 'nodes.json'); nodes.initStore(nodesPath);
  const runtime = createServer({ home, configDir, nodesPath, configPath: path.join(configDir, 'config.json'), tokenPath: path.join(configDir, 'token'),
    ...extra, filesRoot: path.join(home, 'files'), port: 0, fleetEnabled: false, sessionExistsSeam: () => true, pasteSeam: () => true,
    askSubmit: async () => ({ outcome: 'submitted', submitted: true }),
    settingsSeams: { platform: 'linux', uid: 1000, execImpl: () => { throw new Error('disabled'); }, serviceInstallPath: path.join(home, 'service'),
      keygen: () => 'ssh-ed25519 AAAAFIXTURE demo', spawnImpl: () => ({ pid: 4100000, unref() {} }), sshVersion: () => ({ major: 9, minor: 6 }) },
  });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { runtime.server.closeAllConnections(); await new Promise(resolve => runtime.server.close(resolve)); runtime.watcher.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { ...runtime, nodesPath, port: runtime.server.address().port, id: nodes.loadStoreStrict(nodesPath).nodeId };
}
function peer(local, remote, direction) {
  let st = nodes.addNode(nodes.loadStoreStrict(local.nodesPath), { name: 'peer', nodeId: remote.id, direction, token: 'paired-owner-fixture', acceptToken: 'paired-owner-fixture',
    localPort: remote.port, remotePort: 41999, shared: true, visibility: 'network', ssh: 'demo@example.invalid' });
  st = nodes.setPeerAccessPreset(st, 'peer', 'admin'); nodes.atomicWriteStore(local.nodesPath, st);
}
for (const direction of ['outbound', 'inbound']) test(`a direct owner accepts dismiss when its admin hub peer is ${direction}`, async t => {
  const ownerReasons = [];
  const actualFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const response = await actualFetch(url, opts);
    if (response.status === 403 && String(url).includes('/event-feed/asks/')) {
      const refusal = await response.clone().json(); ownerReasons.push(refusal.reason);
    }
    return response;
  });
  const hub = await boot(t); const owner = await boot(t);
  peer(hub, owner, 'outbound'); peer(owner, hub, direction);
  const created = await fetch(`http://127.0.0.1:${owner.port}/api/asks`, { method: 'POST', headers: headers(owner.token),
    body: JSON.stringify({ question: 'Proceed with review?', session: tmuxSessionForCell('reviewer'), target: hub.id }) });
  const ask = await created.json(); assert.equal(created.status, 201);
  const response = await fetch(`http://127.0.0.1:${hub.port}/api/asks-relay`, { method: 'POST', headers: headers(hub.token),
    body: JSON.stringify({ action: 'dismiss', ownerId: owner.id, askId: ask.id }) });
  const body = await response.json(); assert.equal(response.status, 200, JSON.stringify({ body, ownerReasons })); assert.equal(body.dismissed, true);
  const list = await fetch(`http://127.0.0.1:${owner.port}/api/asks?open=1`, { headers: headers(owner.token) }).then(r => r.json());
  assert.equal(list.asks.some(item => item.id === ask.id), false);
});

test('a refused dismiss preserves its owner reason on local REST and cannot confirm a tombstone', async t => {
  const http = require('node:http');
  const ownerId = 'b'.repeat(32);
  const snapshot = { ownerId, cursor: '1:0', viewEpoch: 1, asks: [{ id: '11223344', question: 'Review?', session: tmuxSessionForCell('reviewer') }], notifications: [], fleetState: null };
  const owner = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    const json = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url === '/federation/health') return json(200, { ok: true, instanceId: ownerId, eventFeedV1: true });
    if (url.endsWith('/event-feed/snapshot')) return json(200, snapshot);
    if (url.endsWith('/event-feed')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n'); return; }
    if (url.includes('/event-feed/asks/')) return json(403, { error: 'forbidden', reason: 'peer-unknown' });
    return json(200, { nodes: [] });
  });
  await new Promise(resolve => owner.listen(0, '127.0.0.1', resolve));
  t.after(async () => { owner.closeAllConnections(); await new Promise(resolve => owner.close(resolve)); });
  const hub = await boot(t, { eventFeedClientPollMs: 20 });
  peer(hub, { id: ownerId, port: owner.address().port }, 'outbound');
  nodes.atomicWriteStore(hub.nodesPath, nodes.updateNode(nodes.loadStoreStrict(hub.nodesPath), 'peer', { eventsReceive: true }));
  const view = async () => (await fetch(`http://127.0.0.1:${hub.port}/api/feed-state`, { headers: headers(hub.token) }).then(r => r.json())).views.find(v => v.ownerId === ownerId);
  let ready;
  for (let i = 0; i < 100; i++) { ready = await view(); if (ready?.asks.some(a => a.id === '11223344')) break; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.ok(ready?.asks.some(a => a.id === '11223344'), 'the owner ask is visible before refusal');
  const response = await fetch(`http://127.0.0.1:${hub.port}/api/asks-relay`, { method: 'POST', headers: headers(hub.token), body: JSON.stringify({ action: 'dismiss', ownerId, askId: '11223344' }) });
  const result = await response.json(); assert.equal(response.status, 403); assert.equal(result.reason, 'peer-unknown');
  assert.ok((await view()).asks.some(a => a.id === '11223344'), 'a refused owner action cannot dismiss the visible ask');
});
