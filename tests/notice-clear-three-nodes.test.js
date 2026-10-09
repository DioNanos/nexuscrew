'use strict';
// tests/notice-clear-three-nodes.test.js — «Pulisci» on THREE REAL NODES in a
// star: A owns the notices, B and C are two independent receivers.
//
// The owner is down when C's operator clears. Three facts are the point of the
// test, and none of them is observable on two nodes:
//   1. the local intent is PER NODE: C stops serving the notices, B keeps
//      showing them until the owner himself takes the dismissal;
//   2. the intent survives a RESTART of C and is then handed to the owner by
//      the drainer, which makes the owner stop serving the notices;
//   3. the owner's closure propagates: once the owner records it, B's view
//      empties too, without any local intent of its own.
//
// The handover is paced by the drainer's own policy (one delivery per owner
// inside a 60 s budget window), so the test waits on the OBSERVABLE outcome —
// the queue emptying and the owner's snapshot changing — instead of sleeping a
// guessed number of seconds.
//
// Everything runs in-process on ephemeral ports and temporary HOMEs: no
// service is touched.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const { tmuxSessionForCell } = require('../lib/fleet/definitions.js');

const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
const SECRET_AB = 'secret-a-b';
const SECRET_AC = 'secret-a-c';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function boot(t, dir, extra = {}) {
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir,
    configDir,
    configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'),
    tokenPath: path.join(configDir, 'token'),
  };
  nodesStore.initStore(paths.nodesPath);
  const created = createServer({
    ...paths,
    filesRoot: path.join(dir, 'files'),
    port: 41999,
    fleetEnabled: false,
    eventFeedClientPollMs: 250,
    sessionExistsSeam: () => true,
    settingsSeams: {
      platform: 'linux', uid: 1000,
      execImpl: () => { throw new Error('exec disabled in test'); },
      serviceInstallPath: path.join(dir, 'systemd', 'nexuscrew.service'),
      keygen: (_kp, name) => `ssh-ed25519 AAAAC3FAKEKEY nexuscrew-tunnel-${name}`,
      spawnImpl: () => ({ pid: 4193999, unref() {} }),
      sshVersion: () => ({ major: 9, minor: 6 }),
    },
    ...extra,
  });
  return new Promise((res) => created.server.listen(0, '127.0.0.1', () => {
    const entry = {
      base: `http://127.0.0.1:${created.server.address().port}`,
      port: created.server.address().port,
      token: created.token, paths, nodeId: nodesStore.loadStoreStrict(paths.nodesPath).nodeId,
      server: created.server, watcher: created.watcher,
    };
    t.after(() => { try { entry.server.close(); } catch (_) {} if (entry.watcher) entry.watcher.close(); });
    res(entry);
  }));
}

// One local port per inbound record: the store refuses a duplicate, and in a
// test the reverse listeners are not real anyway.
let nextLocalPort = 44777;
function addInbound(node, { name, remoteNodeId, secret, preset = 'admin' }) {
  let st = nodesStore.addNode(nodesStore.loadStoreStrict(node.paths.nodesPath), {
    name, remotePort: 41999, localPort: nextLocalPort++, nodeId: remoteNodeId,
    acceptToken: secret, direction: 'inbound', shared: false, visibility: 'network',
  });
  st = nodesStore.setPeerAccessPreset(st, name, preset);
  nodesStore.atomicWriteStore(node.paths.nodesPath, st);
}

function addOutbound(node, { name, remoteNodeId, remotePort, secret }) {
  let st = nodesStore.addNode(nodesStore.loadStoreStrict(node.paths.nodesPath), {
    name, remotePort: 41999, localPort: remotePort, nodeId: remoteNodeId,
    token: secret, direction: 'outbound', shared: true, visibility: 'network', ssh: `u@${name}`,
  });
  st = nodesStore.updateNode(st, name, { eventsReceive: true });
  nodesStore.atomicWriteStore(node.paths.nodesPath, st);
}

function repoint(node, name, localPort) {
  let st = nodesStore.loadStoreStrict(node.paths.nodesPath);
  st = nodesStore.updateNode(st, name, { localPort });
  nodesStore.atomicWriteStore(node.paths.nodesPath, st);
}

async function viewOf(node, ownerId) {
  const res = await fetch(`${node.base}/api/feed-state`, { headers: H(node.token) });
  const state = await res.json();
  return (state.views || []).find((v) => v.ownerId === ownerId) || null;
}

async function waitForNotices(node, ownerId, count, tries = 40) {
  let view = null;
  for (let i = 0; i < tries; i += 1) {
    view = await viewOf(node, ownerId);
    if (view && (view.notifications || []).length === count) return view;
    await sleep(150);
  }
  return view;
}

async function ownerSnapshot(node, ownerId) {
  const res = await fetch(`${node.base}/api/route/a-owner/_/event-feed/snapshot`, { headers: H(node.token) });
  return res.json();
}

function emit(owner, titles) {
  return Promise.all(titles.map((title) => fetch(`${owner.base}/api/notify`, {
    method: 'POST', headers: H(owner.token),
    body: JSON.stringify({ title, session: tmuxSessionForCell('dev') }),
  })));
}

function queuedOnDisk(node) {
  const file = path.join(node.paths.configDir, 'notice-dismissal-queue.json');
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (parsed && parsed.entries) || [];
}

// Cards only: the view may legitimately carry the owner's `notify-closed`
// entries (the frontend drops them by type), so what must be gone is every
// entry of type `notify`.
function cardsOf(view) {
  return ((view && view.notifications) || []).filter((n) => n.frame && n.frame.type === 'notify');
}

// No cards, and none comes back across more snapshot rounds: one read could
// catch a mid-delivery instant, a stable pair of rounds is the fact.
async function stableEmptyView(node, ownerId, rounds = 2) {
  let view = null;
  for (let i = 0; i < 80; i += 1) {
    view = await viewOf(node, ownerId);
    if (view && cardsOf(view).length === 0) break;
    await sleep(250);
  }
  for (let i = 0; i < rounds; i += 1) {
    await sleep(400);
    view = await viewOf(node, ownerId);
    assert.deepStrictEqual(cardsOf(view).map((n) => n.eventId), [],
      'no cleared notice comes back across snapshot rounds');
  }
  return view;
}

test('clear on one receiver with the owner down: per-node intent, restart, handover, and the closure reaches the other receiver', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncclear3-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const A = await boot(t, path.join(dir, 'a'));
  const B = await boot(t, path.join(dir, 'b'));
  const C = await boot(t, path.join(dir, 'c'));
  const idA = A.nodeId;
  addInbound(A, { name: 'node-b', remoteNodeId: B.nodeId, secret: SECRET_AB });
  addInbound(A, { name: 'node-c', remoteNodeId: C.nodeId, secret: SECRET_AC });
  addOutbound(B, { name: 'a-owner', remoteNodeId: idA, remotePort: A.port, secret: SECRET_AB });
  addOutbound(C, { name: 'a-owner', remoteNodeId: idA, remotePort: A.port, secret: SECRET_AC });

  await emit(A, ['shared one', 'shared two']);
  const seenB = await waitForNotices(B, idA, 2);
  const seenC = await waitForNotices(C, idA, 2);
  assert.equal((seenB.notifications || []).length, 2, 'B imported both notices');
  assert.equal((seenC.notifications || []).length, 2, 'C imported both notices');
  const clearedIds = new Set((seenC.notifications || []).map((n) => n.eventId));

  // The owner goes down; C clears while B does nothing.
  A.server.close();
  await sleep(400);
  const cleared = await fetch(`${C.base}/api/notices-relay`, {
    method: 'POST', headers: H(C.token),
    body: JSON.stringify({ action: 'dismiss-all', owners: [idA] }),
  });
  assert.equal(cleared.status, 200);
  assert.deepStrictEqual(await cleared.json(), { results: { [idA]: { pending: 2 } } },
    'queued as pending on C, not failed');

  const afterC = await viewOf(C, idA);
  assert.deepStrictEqual((afterC.notifications || []).map((n) => n.eventId), [], 'C stops serving them at once');
  const afterB = await viewOf(B, idA);
  assert.equal((afterB.notifications || []).length, 2, 'B still serves them: the intent is per node');
  assert.equal(queuedOnDisk(C).length, 2, 'the intent is durable on C');

  // The owner is back (same HOME: same identity, history and grants) and both
  // receivers are repointed at him — B live, C through a RESTART.
  const A2 = await boot(t, path.join(dir, 'a'));
  repoint(B, 'a-owner', A2.port);
  repoint(C, 'a-owner', A2.port);
  const C2 = await boot(t, path.join(dir, 'c'));

  // C2 completes snapshot rounds; the drainer hands the intent over within its
  // own budget window (one delivery per owner per 60 s), and once the queue is
  // empty the owner has taken everything.
  let early = null;
  for (let i = 0; i < 40; i += 1) {
    early = await viewOf(C2, idA);
    if (early && early.stale === false) break;
    await sleep(150);
  }
  assert.equal(early.stale, false, 'the restarted C completed a snapshot round');

  let drained = false;
  for (let i = 0; i < 140 && !drained; i += 1) {
    drained = queuedOnDisk(C2).length === 0;
    if (!drained) await sleep(700);
  }
  assert.ok(drained, 'the drainer delivered the pending intent to the owner');

  const snap = await ownerSnapshot(C2, idA);
  assert.equal(snap.ownerId, idA);
  const served = (snap.notifications || []).filter((n) => n.frame && n.frame.type === 'notify');
  assert.equal(served.some((n) => clearedIds.has(n.eventId)), false, 'the owner stopped serving the cleared notices');
  const closures = (snap.notifications || []).filter((n) => n.frame && n.frame.type === 'notify-closed');
  assert.equal(closures.length, 2, 'one closure per cleared notice, like a live clear');
  assert.equal(new Set(closures.map((n) => n.frame.eventId)).size, 2, 'each closure names its notice');

  // The closure reaches the receiver that never cleared: B empties too, with no
  // local intent of its own. C stays clear on its own intent.
  await stableEmptyView(B, idA);
  await stableEmptyView(C2, idA);
});
