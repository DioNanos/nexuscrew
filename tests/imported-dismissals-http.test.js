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
async function boot(t, { readonly = false, malformed = false, symlink = false, queued = false, feedOnly = false, ownerPort = 42001, routed = false, extraAlias = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-owner-access-'));
  const configDir = path.join(home, '.nexuscrew'); fs.mkdirSync(configDir);
  const nodesPath = path.join(configDir, 'nodes.json'); nodes.initStore(nodesPath);
  const store = createAsksStore({ dir: configDir });
  const alias = feedOnly ? null : store.create({ question: 'Review?', options: ['Yes'], session: tmuxSessionForCell('reviewer'), ownerId: OWNER, ownerAskId: ID, originNode: OWNER, ownerAskTs: 100 }).ask;
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
test('local dismissal acknowledges durable imported state without waiting for the owner', async t => {
  const runtime = await boot(t); const calls = [];
  const actual = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push(String(url)); return actual(url, options); });
  const result = await dismiss(runtime); assert.equal(result.code, 200); assert.deepEqual(result.body, { dismissed: true, scope: 'local', ownerSync: 'pending' });
  const store = createAsksStore({ dir: runtime.configDir }); const record = store.getImportedDismissal(OWNER, ID);
  assert.equal(record.dismissedReason, 'owner-unreachable'); assert.equal(store.get(runtime.alias.id).dismissed, true);
  assert.equal(calls.some(url => url.includes('/event-feed/asks/')), false);
});
for (const [name, options, extra, code] of [
  ['READONLY', { readonly: true }, {}, 403],
  ['malformed dismissal store', { malformed: true }, {}, 503],
  ['symlink dismissal store', { symlink: true }, {}, 503],
  ['spoofed fingerprint', {}, { fingerprint: 'forged' }, 400],
  ['unknown canonical pair', {}, { askId: '87654321' }, 404],
  ['local alias id passed as owner ask id', {}, { askId: 'alias' }, 400],
]) test(`local dismissal refuses ${name} without persisting intent`, async t => {
  const runtime = await boot(t, options); const result = await dismiss(runtime, extra); assert.equal(result.code, code);
  if (!options.malformed && !options.symlink) assert.equal(createAsksStore({ dir: runtime.configDir }).getImportedDismissal(OWNER, ID), null);
});
test('parallel local dismiss clicks preserve one durable timestamp and revision', async t => {
  const runtime = await boot(t); const results = await Promise.all([dismiss(runtime), dismiss(runtime)]); assert.deepEqual(results.map(r => r.code), [200, 200]);
  const store = createAsksStore({ dir: runtime.configDir }); assert.equal(store.listImportedDismissals().length, 1); assert.equal(store.get(runtime.alias.id).revision, 1);
});
function connect(local, remote, name) {
  let st = nodes.addNode(nodes.loadStoreStrict(local.nodesPath), { name, nodeId: remote.id, direction: 'outbound', eventsReceive: false, token: 'fanout-fixture', acceptToken: 'fanout-fixture', shared: true, visibility: 'network', ssh: 'demo@example.invalid', localPort: remote.port, remotePort: 42003 });
  st = nodes.setPeerAccessPreset(st, name, 'admin'); nodes.atomicWriteStore(local.nodesPath, st);
}
test('new fanout imports preserve owner timestamp distinct from receipt timestamp', async t => {
  const owner = await boot(t), receiver = await boot(t); connect(owner, receiver, 'receiver'); connect(receiver, owner, 'source');
  const response = await fetch(`http://127.0.0.1:${owner.port}/api/asks`, { method: 'POST', headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ question: 'A new routed question?', session: tmuxSessionForCell('reviewer'), target: receiver.id }) });
  const created = await response.json(); assert.equal(response.status, 201); assert.ok(created.fanout.some(result => result.status === 'delivered'));
  const alias = createAsksStore({ dir: receiver.configDir }).findImported(owner.id, created.id);
  const source = createAsksStore({ dir: owner.configDir }).get(created.id);
  assert.ok(alias); assert.equal(alias.ownerAskTs, source.ts); assert.ok(alias.ts >= alias.ownerAskTs);
  assert.notEqual(alias.id, created.id);
});
test('server bootstrap resumes durable imported dismissal work without a feed subscription', async t => {
  const runtime = await boot(t, { queued: true }); let record;
  for (let i = 0; i < 50; i++) {
    record = createAsksStore({ dir: runtime.configDir }).getImportedDismissal(OWNER, ID);
    if (record.attempts > 0) break; await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(record.attempts > 0, 'a restarted server must resume durable work');
  assert.equal(record.syncState, 'pending'); assert.equal(record.lastReason, 'reverse-slot-unverified');
});
test('feed-only local dismissal is durable and idempotent without creating an alias', async t => {
  const http = require('node:http');
  const source = { id: ID, ts: 100, question: 'Feed only?', session: tmuxSessionForCell('reviewer') };
  const owner = http.createServer((req, res) => {
    const json = body => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url.includes('/health')) return json({ ok: true, instanceId: OWNER, eventFeedV1: true });
    if (req.url.includes('/event-feed/snapshot')) return json({ ownerId: OWNER, cursor: '1:0', viewEpoch: 1, asks: [source], notifications: [] });
    if (req.url.includes('/event-feed')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n'); return; }
    json({ nodes: [] });
  });
  await new Promise(resolve => owner.listen(0, '127.0.0.1', resolve));
  t.after(() => { owner.closeAllConnections(); owner.close(); });
  const runtime = await boot(t, { feedOnly: true, ownerPort: owner.address().port });
  const headers = { authorization: `Bearer ${runtime.token}` }; let view;
  for (let i = 0; i < 100; i++) {
    view = await fetch(`http://127.0.0.1:${runtime.port}/api/feed-state`, { headers }).then(r => r.json());
    if (view.views.some(item => item.asks.some(ask => ask.id === ID))) break; await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(view.views.some(item => item.asks.some(ask => ask.id === ID)), 'the authorized feed establishes the known pair');
  owner.closeAllConnections(); await new Promise(resolve => owner.close(resolve));
  await fetch(`http://127.0.0.1:${runtime.port}/api/asks-relay/capability?ownerId=${OWNER}&askId=${ID}&dismissals=1`, { headers });
  const first = await dismiss(runtime); assert.equal(first.code, 200);
  const second = await dismiss(runtime); assert.equal(second.code, 200);
  const store = createAsksStore({ dir: runtime.configDir }); assert.equal(store.list().length, 0); assert.equal(store.listImportedDismissals().length, 1);
  const after = await fetch(`http://127.0.0.1:${runtime.port}/api/feed-state`, { headers }).then(r => r.json());
  assert.ok(after.views.every(item => item.asks.every(ask => ask.id !== ID)));
});
test('local imported dismissal does not publish a closure to a third peer or durable feed history', async t => {
  const receiver = await boot(t), observer = await boot(t); connect(observer, receiver, 'receiver'); connect(receiver, observer, 'observer');
  nodes.atomicWriteStore(receiver.nodesPath, nodes.updateNode(nodes.loadStoreStrict(receiver.nodesPath), 'observer', { direction: 'inbound', transport: 'inbound', shared: false }));
  const snapshot = () => fetch(`http://127.0.0.1:${observer.port}/api/route/receiver/_/event-feed/snapshot`, { headers: { authorization: `Bearer ${observer.token}` } }).then(r => r.json());
  const before = await snapshot(); assert.equal(before.ownerId, receiver.id, JSON.stringify(before)); assert.equal(typeof before.cursor, 'string');
  const historyPath = path.join(receiver.configDir, 'event-feed-history.json'); const history = fs.existsSync(historyPath) ? fs.readFileSync(historyPath, 'utf8') : null;
  assert.equal((await dismiss(receiver)).code, 200);
  const after = await snapshot(); assert.equal(after.cursor, before.cursor, 'the receiving publisher did not append a federated closure');
  assert.deepEqual(after.notifications, before.notifications);
  assert.equal(fs.existsSync(historyPath) ? fs.readFileSync(historyPath, 'utf8') : null, history);
});
for (const transport of ['reverse', 'hub']) test(`durable dismissal recovery over ${transport} preserves generation headers and survives a lost DELETE reply`, async t => {
  const { createAskRelay } = require('../lib/notify/ask-relay.js');
  const { createImportedDismissalDrainer } = require('../lib/notify/imported-dismissals.js');
  const client = await boot(t), owner = await boot(t); let hub;
  if (transport === 'hub') {
    hub = await boot(t); connect(client, hub, 'hub'); connect(hub, client, 'client'); connect(hub, owner, 'source'); connect(owner, hub, 'hub');
  } else { connect(client, owner, 'source'); connect(owner, client, 'client'); }
  const response = await fetch(`http://127.0.0.1:${owner.port}/api/asks`, { method: 'POST', headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ question: 'Recover this dismissal?', session: tmuxSessionForCell('reviewer') }) });
  const created = await response.json(); assert.equal(response.status, 201);
  const source = createAsksStore({ dir: owner.configDir }).get(created.id); let probes = 0, deletes = 0, loseReply = false;
  const st = nodes.loadStoreStrict(client.nodesPath);
  if (transport === 'reverse') {
    const node = st.nodes.find(node => node.nodeId === owner.id); node.direction = 'inbound'; node.transport = 'inbound'; node.shared = true;
    node.reversePool = { activeSlot: 0, activeGeneration: 1, slots: [{ port: owner.port, state: 'active', generation: 1 }] };
  }
  const relay = createAskRelay({ loadStore: () => st, localPort: () => client.port, localToken: () => client.token,
    ...(hub ? { peers: async () => [{ nodeId: owner.id, route: ['hub', 'source'] }] } : {}),
    probeReverseSlotImpl: async ({ expected }) => { probes++; assert.equal(expected.instanceId, owner.id); assert.equal(expected.remotePort, owner.port); return { owned: true }; },
    fetchImpl: async (url, options) => { const result = await fetch(url, options); if (options.method === 'DELETE') { deletes++; if (loseReply) { loseReply = false; await result.text(); throw new Error('applied response lost'); } } return result; },
  });
  const refused = await relay.relayDismiss({ ownerId: owner.id, askId: source.id, expectedTs: source.ts - 1 });
  assert.equal(refused.code, 409); assert.equal(refused.reason, 'generation-mismatch'); assert.equal(createAsksStore({ dir: owner.configDir }).get(source.id).dismissed, false);
  const dir = path.join(client.configDir, 'dismissal-recovery-fixture'); const store = createAsksStore({ dir });
  store.dismissImported({ ownerId: owner.id, ownerAskId: source.id, ask: source }); let clock = 1000; loseReply = true;
  const make = saved => createImportedDismissalDrainer({ store: saved, relay, now: () => clock, random: () => 0 });
  const first = make(store); t.after(() => first.stop()); await first.drain(); first.stop();
  assert.equal(store.getImportedDismissal(owner.id, source.id).syncState, 'pending');
  assert.equal(createAsksStore({ dir: owner.configDir }).get(source.id).dismissed, true);
  clock += 60001; const restarted = make(createAsksStore({ dir })); t.after(() => restarted.stop()); await restarted.drain();
  assert.equal(createAsksStore({ dir }).getImportedDismissal(owner.id, source.id).syncState, 'confirmed-dismissed');
  assert.equal(deletes, 2, 'one rejected precondition and one applied DELETE, with no blind resend');
  if (transport === 'reverse') assert.ok(probes > 0, 'the selected reverse binding must be proved');
});

test('local dismissal accepts a known owner behind an authorized unavailable first hop', async t => {
  const runtime = await boot(t, { routed: true });
  const result = await dismiss(runtime); assert.equal(result.code, 200);
  assert.equal(createAsksStore({ dir: runtime.configDir }).getImportedDismissal(OWNER, ID).syncState, 'pending');
});
test('local capability distinguishes remote reply from durable local dismissal', async t => {
  const runtime = await boot(t);
  const response = await fetch(`http://127.0.0.1:${runtime.port}/api/asks-relay/capability?ownerId=${OWNER}&askId=${ID}&dismissals=1`, { headers: { authorization: `Bearer ${runtime.token}` } });
  const body = await response.json(); assert.equal(body.canReply, false);
  assert.equal(body.canDismissRemote, false); assert.equal(body.canDismissLocal, true);
});
test('READONLY capability refuses both local and remote dismissals', async t => {
  const runtime = await boot(t, { readonly: true });
  const body = await fetch(`http://127.0.0.1:${runtime.port}/api/asks-relay/capability?ownerId=${OWNER}&askId=${ID}&dismissals=1`, { headers: { authorization: `Bearer ${runtime.token}` } }).then(r => r.json());
  assert.equal(body.canDismissLocal, false); assert.equal(body.canDismissRemote, false);
});
test('an offline user peer retains local intent as blocked without remote permission', async t => {
  const runtime = await boot(t);
  nodes.atomicWriteStore(runtime.nodesPath, nodes.setPeerAccessPreset(nodes.loadStoreStrict(runtime.nodesPath), 'owner', 'user'));
  const out = await dismiss(runtime); assert.equal(out.code, 200); assert.equal(out.body.ownerSync, 'blocked');
  const record = createAsksStore({ dir: runtime.configDir }).getImportedDismissal(OWNER, ID);
  assert.equal(record.lastReason, 'permission-denied'); assert.match(record.retryBinding, /^[a-f0-9]{64}$/);
});
test('revoked event access prevents local dismissal through a cached hub route', async t => {
  const runtime = await boot(t, { routed: true });
  nodes.atomicWriteStore(runtime.nodesPath, nodes.setPeerAccessPreset(nodes.loadStoreStrict(runtime.nodesPath), 'owner', 'nexushost'));
  assert.equal((await dismiss(runtime)).code, 404);
  assert.equal(createAsksStore({ dir: runtime.configDir }).listImportedDismissals().length, 0);
});
test('a known pair with a reachable channel still dismisses locally', async t => {
  const runtime = await boot(t);
  const st = nodes.loadStoreStrict(runtime.nodesPath); st.nodes[0].direction = 'outbound'; st.nodes[0].transport = 'auto'; nodes.atomicWriteStore(runtime.nodesPath, st);
  const out = await dismiss(runtime); assert.equal(out.code, 200); assert.equal(out.body.scope, 'local');
});
test('a failed local write after cache load returns no acknowledgement and rolls back the alias', async t => {
  const runtime = await boot(t);
  const headers = { authorization: `Bearer ${runtime.token}` };
  await fetch(`http://127.0.0.1:${runtime.port}/api/asks`, { headers }).then(r => r.json());
  const file = path.join(runtime.configDir, 'asks.json');
  fs.renameSync(file, file + '.target'); fs.symlinkSync(file + '.target', file);
  const out = await dismiss(runtime); assert.equal(out.code, 503); assert.equal(out.body.dismissed, undefined);
  const body = await fetch(`http://127.0.0.1:${runtime.port}/api/asks`, { headers }).then(r => r.json());
  assert.equal(body.asks.find(ask => ask.id === runtime.alias.id).dismissed, false);
  assert.equal(JSON.parse(fs.readFileSync(file)).importedDismissals[`${OWNER}|${ID}`], undefined);
});

test('legacy local capability retains its exact response shape without the dismissal opt-in', async t => {
  const runtime = await boot(t);
  const body = await fetch(`http://127.0.0.1:${runtime.port}/api/asks-relay/capability?ownerId=${OWNER}&askId=${ID}`, { headers: { authorization: `Bearer ${runtime.token}` } }).then(r => r.json());
  assert.deepEqual(Object.keys(body).sort(), ['askId', 'canReply', 'ownerId', 'reason', 'status']);
});

for (const credential of ['token', 'acceptToken']) test(`a pairing ${credential} change changes the durable blocked retry binding without storing credentials`, async t => {
  const runtime = await boot(t, { extraAlias: true });
  nodes.atomicWriteStore(runtime.nodesPath, nodes.setPeerAccessPreset(nodes.loadStoreStrict(runtime.nodesPath), 'owner', 'user'));
  assert.equal((await dismiss(runtime)).code, 200);
  const first = createAsksStore({ dir: runtime.configDir }).getImportedDismissal(OWNER, ID);
  const st = nodes.loadStoreStrict(runtime.nodesPath); st.nodes[0][credential] = 'repaired-pairing-token'; nodes.atomicWriteStore(runtime.nodesPath, st);
  assert.equal((await dismiss(runtime, { askId: '87654321' })).code, 200);
  const second = createAsksStore({ dir: runtime.configDir }).getImportedDismissal(OWNER, '87654321');
  assert.notEqual(first.retryBinding, second.retryBinding);
  assert.equal(JSON.stringify(second).includes('repaired-pairing-token'), false);
});
test('local dismissal SSE carries canonical generation context without exporting a closure', async t => {
  const runtime = await boot(t);
  const controller = new AbortController();
  const stream = await fetch(`http://127.0.0.1:${runtime.port}/api/events`, { headers: { authorization: `Bearer ${runtime.token}` }, signal: controller.signal });
  const reader = stream.body.getReader(); await reader.read();
  try {
    assert.equal((await dismiss(runtime)).code, 200);
    let data = '';
    while (!data.includes('ask-dismissed')) data += Buffer.from((await reader.read()).value).toString();
    const frame = JSON.parse(data.split('\n').find(line => line.startsWith('data: ')).slice(6));
    assert.equal(frame.scope, 'local'); assert.equal(frame.ownerId, OWNER); assert.equal(frame.ownerAskId, ID);
    assert.equal(frame.ownerAskTs, 100); assert.equal(frame.ownerSync, 'pending');
    assert.deepEqual(frame.askGeneration, { question: runtime.alias.question, options: runtime.alias.options, session: runtime.alias.session });
  } finally { controller.abort(); await reader.cancel().catch(() => {}); }
});

for (const variant of ['hop', 'extra body key']) test(`local dismissal rejects ${variant} without persisting a record`, async t => {
  const runtime = await boot(t);
  const store = createAsksStore({ dir: runtime.configDir });
  const before = fs.readFileSync(store.filePath, 'utf8');
  const response = await fetch(`http://127.0.0.1:${runtime.port}/api/asks-relay`, {
    method: 'POST', headers: { authorization: `Bearer ${runtime.token}`, 'content-type': 'application/json',
      ...(variant === 'hop' ? { 'x-nexuscrew-hop': 'untrusted-hop' } : {}) },
    body: JSON.stringify({ action: 'dismiss-local', ownerId: OWNER, askId: ID,
      ...(variant === 'extra body key' ? { note: 'not allowed' } : {}) }),
  });
  assert.equal(response.status, variant === 'hop' ? 403 : 400);
  assert.equal(fs.readFileSync(store.filePath, 'utf8'), before);
  assert.equal(store.getImportedDismissal(OWNER, ID), null);
});
