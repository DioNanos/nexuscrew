'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const { createAsksStore } = require('../lib/notify/asks.js');
const nodes = require('../lib/nodes/store.js');
const { tmuxSessionForCell } = require('../lib/fleet/definitions.js');
const OWNER = 'b'.repeat(32), ID = '12345678';
async function boot(t, { readonly = false, malformed = false, symlink = false, queued = false, feedOnly = false, ownerPort = 42001, routed = false, extraAlias = false, initialAlias = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-owner-access-'));
  const configDir = path.join(home, '.nexuscrew'); fs.mkdirSync(configDir);
  const nodesPath = path.join(configDir, 'nodes.json'); nodes.initStore(nodesPath);
  const store = createAsksStore({ dir: configDir });
  const alias = feedOnly && !initialAlias ? null : store.create({ question: 'Review?', options: ['Yes'], session: tmuxSessionForCell('reviewer'), ownerId: OWNER, ownerAskId: ID, originNode: OWNER, ownerAskTs: 100 }).ask;
  if (extraAlias) store.create({ question: 'Review?', session: tmuxSessionForCell('reviewer'), ownerId: OWNER, ownerAskId: '87654321', originNode: OWNER, ownerAskTs: 100 });
  let st = nodes.addNode(nodes.loadStoreStrict(nodesPath), { name: 'owner', nodeId: routed ? 'c'.repeat(32) : OWNER, direction: feedOnly ? 'outbound' : 'inbound', eventsReceive: feedOnly, token: 'fixture', shared: true, visibility: 'network', ssh: 'demo@example.invalid', localPort: ownerPort, remotePort: 42002 });
  st = nodes.setPeerAccessPreset(st, 'owner', 'admin'); nodes.atomicWriteStore(nodesPath, st);
  if (routed) require('../lib/nodes/topology-cache.js').atomicWriteCache(path.join(configDir, 'topology-cache.json'), { schemaVersion: 1, nodes: [{ instanceId: OWNER, name: 'source', route: ['owner', 'source'], lastSeen: Date.now() }] });
  if (queued) store.dismissImported({ ownerId: OWNER, ownerAskId: ID, ask: alias });
  if (malformed) { const value = JSON.parse(fs.readFileSync(store.filePath)); value.importedDismissals = []; fs.writeFileSync(store.filePath, JSON.stringify(value)); }
  if (symlink) { fs.renameSync(store.filePath, store.filePath + '.target'); fs.symlinkSync(store.filePath + '.target', store.filePath); }
  const runtime = createServer({ home, configDir, nodesPath, configPath: path.join(configDir, 'config.json'), tokenPath: path.join(configDir, 'token'),
    readonlyDefault: readonly, eventFeedClientPollMs: 20, filesRoot: path.join(home, 'files'), port: 0, fleetEnabled: false, sessionExistsSeam: () => true, pasteSeam: () => true,
    askSubmit: async () => ({ outcome: 'submitted', submitted: true }),
    settingsSeams: { platform: 'linux', uid: 1000, execImpl: () => { throw new Error('disabled'); }, serviceInstallPath: path.join(home, 'service'),
      keygen: () => 'ssh-ed25519 AAAAFIXTURE demo', spawnImpl: () => ({ pid: 4100000, unref() {} }), sshVersion: () => ({ major: 9, minor: 6 }) },
  });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { runtime.server.closeAllConnections(); await new Promise(resolve => runtime.server.close(resolve)); runtime.watcher.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { ...runtime, configDir, alias, nodesPath, port: runtime.server.address().port, id: nodes.loadStoreStrict(nodesPath).nodeId };
}

async function dismiss(runtime, extra = {}) {
  const response = await fetch(`http://127.0.0.1:${runtime.port}/api/asks-relay`, { method: 'POST', headers: { authorization: `Bearer ${runtime.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'dismiss-local', ownerId: OWNER, askId: ID, ...extra }) });
  return { code: response.status, body: await response.json() };
}
function connect(local, remote, name) {
  let st = nodes.addNode(nodes.loadStoreStrict(local.nodesPath), { name, nodeId: remote.id, direction: 'outbound', eventsReceive: false, token: 'fanout-fixture', acceptToken: 'fanout-fixture', shared: true, visibility: 'network', ssh: 'demo@example.invalid', localPort: remote.port, remotePort: 42003 });
  st = nodes.setPeerAccessPreset(st, name, 'admin'); nodes.atomicWriteStore(local.nodesPath, st);
}
test('a real fanout feed event reappears after durable dismissal of the same ask', async t => {
  const owner = await boot(t), receiver = await boot(t); connect(owner, receiver, 'receiver'); connect(receiver, owner, 'source');
  const actualFetch = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).includes(`${receiver.port}/`) && options?.method === 'POST') await new Promise(resolve => setTimeout(resolve, 75));
    return actualFetch(url, options);
  });
  const response = await fetch(`http://127.0.0.1:${owner.port}/api/asks`, { method: 'POST', headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ question: 'Canonical timestamp?', session: tmuxSessionForCell('reviewer'), target: receiver.id }) });
  const created = await response.json(); assert.equal(response.status, 201);
  const source = createAsksStore({ dir: owner.configDir }).get(created.id);
  const store = createAsksStore({ dir: receiver.configDir }); const alias = store.findImported(owner.id, created.id);
  assert.ok(alias); assert.equal(store.dismissImported({ ownerId: owner.id, ownerAskId: source.id, ask: alias }).ok, true);
  const historyPath = path.join(owner.configDir, 'event-feed-history.json');
  let envelope;
  for (let i = 0; i < 30; i++) { if (fs.existsSync(historyPath)) envelope = JSON.parse(fs.readFileSync(historyPath)).entries.map(e => e.envelope).find(e => e.frame.type === 'ask' && e.frame.askId === source.id); if (envelope) break; await new Promise(r => setTimeout(r, 10)); }
  assert.ok(envelope); assert.ok(envelope.frame.ts > source.ts, 'fanout actually delays event emission');
  console.log('OBSERVED_REAL_TIMESTAMP', JSON.stringify({ ownerTs: source.ts, aliasTs: alias.ownerAskTs, feedTs: envelope.frame.ts }));
  const { createEventFeedClient } = require('../lib/notify/event-feed-client.js'); const frames = [];
  const client = createEventFeedClient({ isAskDismissed: (ownerId, ask) => store.isImportedDismissed(ownerId, ask), eventsHub: { broadcast: f => frames.push(f) }, loadStore: () => ({ nodes: [] }) }); t.after(() => client.stop());
  client.reemit(envelope); console.log('OBSERVED_RESURRECTION', frames.length);
  assert.equal(frames.length, 0, 'the same authoritative ask must remain suppressed on a delayed live frame');
});
test('dismissal ACK for a replacement feed ask persists the obsolete alias instead', async t => {
  const http = require('node:http');
  const source = { id: ID, ts: 200, question: 'Replacement question', session: tmuxSessionForCell('reviewer') };
  const owner = http.createServer((req, res) => {
    const json = body => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url.includes('/federation/health')) return json({ ok: true, instanceId: OWNER, eventFeedV1: true });
    if (req.url.includes('/event-feed/snapshot')) return json({ ownerId: OWNER, cursor: '1:0', viewEpoch: 1, asks: [source], notifications: [] });
    if (req.url.includes('/event-feed')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n'); return; }
    json({ nodes: [] });
  });
  await new Promise(r => owner.listen(0, '127.0.0.1', r)); t.after(() => { owner.closeAllConnections(); owner.close(); });
  const runtime = await boot(t, { feedOnly: true, initialAlias: true, queued: true, ownerPort: owner.address().port });
  const headers = { authorization: `Bearer ${runtime.token}` }; let view;
  for (let i = 0; i < 100; i++) { view = await fetch(`http://127.0.0.1:${runtime.port}/api/feed-state`, { headers }).then(r => r.json()); if (view.views.some(v => v.asks.some(a => a.question === source.question))) break; await new Promise(r => setTimeout(r, 10)); }
  assert.ok(view.views.some(v => v.asks.some(a => a.question === source.question)));
  owner.closeAllConnections(); await new Promise(r => owner.close(r));
  await fetch(`http://127.0.0.1:${runtime.port}/api/asks-relay/capability?ownerId=${OWNER}&askId=${ID}&dismissals=1`, { headers });
  const out = await dismiss(runtime); assert.equal(out.code, 200);
  const store = createAsksStore({ dir: runtime.configDir });
  console.log('OBSERVED_REPLACEMENT_ACK', JSON.stringify({ ack: out.body, recordedTs: store.getImportedDismissal(OWNER, ID).ownerAskTs, replacementSuppressed: store.isImportedDismissed(OWNER, source) }));
  assert.equal(store.isImportedDismissed(OWNER, source), true, 'the acknowledged replacement must be durably suppressed');
});

test('live and legacy feed cards never use event time as owner generation', t => {
  const { createEventFeedClient } = require('../lib/notify/event-feed-client.js');
  const frames = [], store = createAsksStore({ dir: fs.mkdtempSync(path.join(os.tmpdir(), 'feed-generation-')) });
  t.after(() => fs.rmSync(path.dirname(store.filePath), { recursive: true, force: true }));
  const client = createEventFeedClient({ eventsHub: { broadcast: f => frames.push(f) }, loadStore: () => ({ nodes: [] }) });
  t.after(() => client.stop());
  for (const [eventId, askTs] of [['known', 100], ['legacy', undefined]]) {
    const id = eventId === 'known' ? ID : '87654321';
    client.reemit({ ownerId: OWNER, eventId, hop: 1, frame: { type: 'ask', askId: id, question: 'Same question', session: 'reviewer', ts: 999, ...(askTs ? { askTs } : {}) } });
    const card = frames.at(-1).ask;
    assert.equal(card.ts, 999, 'event timestamp is preserved');
    assert.equal(card.ownerAskTs, askTs || null);
    const out = store.dismissImported({ ownerId: OWNER, ownerAskId: id, ask: card });
    assert.equal(out.record.ownerAskTs, askTs || null);
    assert.equal(out.record.generation, askTs ? 'known' : 'unknown');
  }
});
test('feed-only original generation drains against the real owner without mismatch', async t => {
  const owner = await boot(t);
  const response = await fetch(`http://127.0.0.1:${owner.port}/api/asks`, { method: 'POST', headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ question: 'Feed card', session: tmuxSessionForCell('reviewer') }) });
  const created = await response.json(); assert.equal(response.status, 201);
  const source = createAsksStore({ dir: owner.configDir }).get(created.id);
  let envelope;
  for (let i = 0; i < 30; i++) { const p = path.join(owner.configDir, 'event-feed-history.json'); if (fs.existsSync(p)) envelope = JSON.parse(fs.readFileSync(p)).entries.map(e => e.envelope).find(e => e.frame.askId === source.id); if (envelope) break; await new Promise(r => setTimeout(r, 10)); }
  const clientNode = await boot(t); connect(clientNode, owner, 'source'); connect(owner, clientNode, 'client');
  const frames = []; const client = require('../lib/notify/event-feed-client.js').createEventFeedClient({ eventsHub: { broadcast: f => frames.push(f) }, loadStore: () => ({ nodes: [] }) }); t.after(() => client.stop());
  client.reemit(envelope); const store = createAsksStore({ dir: path.join(clientNode.configDir, 'feed-only') });
  store.dismissImported({ ownerId: owner.id, ownerAskId: source.id, ask: frames[0].ask });
  const relay = require('../lib/notify/ask-relay.js').createAskRelay({ loadStore: () => nodes.loadStoreStrict(clientNode.nodesPath), localPort: () => clientNode.port, localToken: () => clientNode.token });
  const drainer = require('../lib/notify/imported-dismissals.js').createImportedDismissalDrainer({ store, relay }); t.after(() => drainer.stop()); await drainer.drain();
  const record = store.getImportedDismissal(owner.id, source.id);
  assert.equal(record.syncState, 'confirmed-dismissed'); assert.equal(record.ownerAskTs, source.ts);
});
