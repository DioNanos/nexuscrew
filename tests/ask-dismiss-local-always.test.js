'use strict';
// tests/ask-dismiss-local-always.test.js — the federated-ask close button must
// work on the viewing node even when the owner is reachable and grants nothing:
// dismissing locally is not answering, so the owner permission set cannot gate
// it. The dismissal stays durable on the receiving node (asksStore) and is
// never re-published to the owner (no /event-feed/asks/:id traffic, syncState
// "blocked" without the reply grant).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const { createAsksStore } = require('../lib/notify/asks.js');
const nodes = require('../lib/nodes/store.js');
const ledger = require('../lib/nodes/reverse-pool.js');
const { tmuxSessionForCell } = require('../lib/fleet/definitions.js');

const OWNER = 'b'.repeat(32);
const ID = '12345678';

async function boot(t, { withReplyGrant = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-dismiss-always-'));
  const configDir = path.join(home, '.nexuscrew');
  fs.mkdirSync(configDir);
  const nodesPath = path.join(configDir, 'nodes.json');
  nodes.initStore(nodesPath);
  const store = createAsksStore({ dir: configDir });
  // The imported ask is already in the receiving store: the feed delivered it
  // before this test starts looking at capabilities.
  const alias = store.create({ question: 'Proceed?', options: ['Yes'], session: tmuxSessionForCell('reviewer'), ownerId: OWNER, ownerAskId: ID, originNode: OWNER, ownerAskTs: 100 }).ask;
  // A verified reverse-pool slot means the channel is NOT known unavailable:
  // exactly the case where the old gate turned the close button into a stub.
  let st = nodes.addNode(
    nodes.upgradeToReversePoolSchema(nodes.loadStoreStrict(nodesPath), ledger.ledgerHead(ledger.emptyLedger('d'.repeat(32)))),
    { name: 'owner', nodeId: OWNER, direction: 'inbound', shared: true, visibility: 'network', ssh: 'demo@example.invalid', localPort: 42001, remotePort: 42002, reversePool: nodes.reversePoolDefault(42003, { generation: 3, verification: 'verified' }) },
  );
  st = nodes.setPeerAccessGrants(st, 'owner', {
    cellVisibility: 'all', eventsAccess: true, nodeEventsAccess: true,
    askReplyAccess: withReplyGrant, filesReadAccess: false, liveHostAccess: false, panelAccess: false, peerOperatorAccess: false,
  });
  nodes.atomicWriteStore(nodesPath, st);
  const runtime = createServer({
    home, configDir, nodesPath, configPath: path.join(configDir, 'config.json'), tokenPath: path.join(configDir, 'token'),
    readonlyDefault: false, eventFeedClientPollMs: 20, filesRoot: path.join(home, 'files'), port: 0, fleetEnabled: false,
    sessionExistsSeam: () => true, pasteSeam: () => true,
    askSubmit: async () => ({ outcome: 'submitted', submitted: true }),
    settingsSeams: { platform: 'linux', uid: 1000, execImpl: () => { throw new Error('disabled'); }, serviceInstallPath: path.join(home, 'service'),
      keygen: () => 'ssh-ed25519 AAAAFIXTURE demo', spawnImpl: () => ({ pid: 4100000, unref() {} }), sshVersion: () => ({ major: 9, minor: 6 }) },
  });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { runtime.server.closeAllConnections(); await new Promise(resolve => runtime.server.close(resolve)); runtime.watcher.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { ...runtime, configDir, alias, port: runtime.server.address().port, store };
}

const getJSON = (runtime, url) => fetch(`http://127.0.0.1:${runtime.port}${url}`, { headers: { authorization: `Bearer ${runtime.token}` } }).then(async r => ({ code: r.status, body: await r.json() }));
const dismissLocal = (runtime) => fetch(`http://127.0.0.1:${runtime.port}/api/asks-relay`, {
  method: 'POST', headers: { authorization: `Bearer ${runtime.token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ action: 'dismiss-local', ownerId: OWNER, askId: ID }),
}).then(async r => ({ code: r.status, body: await r.json() }));
const freshStore = (runtime) => createAsksStore({ dir: runtime.configDir });

test('capability offers the local dismissal while the owner is reachable and grants nothing', async t => {
  const runtime = await boot(t);
  const out = await getJSON(runtime, `/api/asks-relay/capability?ownerId=${OWNER}&askId=${ID}&dismissals=1`);
  assert.equal(out.code, 200);
  assert.equal(out.body.canReply, false, 'the owner grants no reply');
  assert.equal(out.body.canDismissRemote, false, 'no remote dismissal without the reply grant');
  assert.equal(out.body.canDismissLocal, true, 'the local dismissal does not need the owner permission');
});

test('dismiss-local persists durably while the owner is reachable, without re-publishing', async t => {
  const runtime = await boot(t);
  const calls = [];
  const actual = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push(String(url)); return actual(url, options); });
  const result = await dismissLocal(runtime);
  assert.equal(result.code, 200, `the local dismissal succeeds: ${JSON.stringify(result.body)}`);
  assert.equal(result.body.dismissed, true);
  assert.equal(result.body.scope, 'local');
  assert.equal(result.body.ownerSync, 'blocked', 'without the reply grant nothing is queued for the owner');
  const record = freshStore(runtime).getImportedDismissal(OWNER, ID);
  assert.ok(record, 'the dismissal is durable on the viewing node');
  assert.equal(record.syncState, 'blocked', 'blocked sync state: removing is not answering');
  assert.equal(calls.some(url => url.includes('/event-feed/asks/')), false, 'no re-publication towards the owner');
});

test('a second dismiss-local is idempotent and still sends nothing to the owner', async t => {
  const runtime = await boot(t);
  const calls = [];
  const actual = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => { calls.push(String(url)); return actual(url, options); });
  const first = await dismissLocal(runtime);
  assert.equal(first.code, 200);
  const second = await dismissLocal(runtime);
  assert.equal(second.code, 200);
  assert.equal(second.body.dismissed, true);
  assert.equal(calls.some(url => url.includes('/event-feed/asks/')), false, 'still no re-publication');
});

test('an answered ask keeps refusing the local dismissal', async t => {
  const runtime = await boot(t);
  const answered = await fetch(`http://127.0.0.1:${runtime.port}/api/asks/${runtime.alias.id}/answer`, {
    method: 'POST', headers: { authorization: `Bearer ${runtime.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'done' }),
  });
  assert.equal(answered.status, 200, `the answer path marks the ask: ${JSON.stringify(await answered.json())}`);
  const result = await dismissLocal(runtime);
  assert.equal(result.code, 409);
  assert.equal(result.body.reason, 'answered');
});

test('asymmetric grants: a reachable owner with a local reply grant still records blocked', async t => {
  // The viewer grants the owner a reply grant in its own store, but the owner
  // denies the reply back (owner -> viewer askReplyAccess = false). The local
  // capability is true and the local dismissal must persist as "blocked":
  // "pending" would make the drainer retry a remote closure the owner never
  // authorized.
  const runtime = await boot(t, { withReplyGrant: true });
  const capability = await getJSON(runtime, `/api/asks-relay/capability?ownerId=${OWNER}&askId=${ID}&dismissals=1`);
  assert.equal(capability.body.canDismissLocal, true);
  assert.equal(capability.body.canDismissRemote, false, 'the owner denial wins for the remote dismissal');
  const result = await dismissLocal(runtime);
  assert.equal(result.code, 200);
  assert.equal(result.body.ownerSync, 'blocked', 'a reachable owner means no sync is queued at all');
  assert.equal(freshStore(runtime).getImportedDismissal(OWNER, ID).syncState, 'blocked');
});
