'use strict';
// tests/notice-clear-two-nodes.test.js — «Pulisci» end to end on TWO REAL NODES
// with the owner DOWN the whole way through.
//
// A owns the notices, B is the node whose operator clears them. The owner is
// unreachable at the moment of the clear (the case the operator cannot see
// coming), so the local intent is all there is: it must be durable, survive a
// RESTART of B, and be handed to the owner once he is back — at which point the
// owner stops serving the notices himself and publishes one `notify-closed`
// closure per cleared notice, exactly like a clear that landed live.
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

function link(A, B, preset = 'admin') {
  const idA = A.nodeId;
  const idB = B.nodeId;
  let stA = nodesStore.addNode(nodesStore.loadStoreStrict(A.paths.nodesPath), {
    name: 'node-b', remotePort: 41999, localPort: 44777, nodeId: idB,
    acceptToken: SECRET_AB, direction: 'inbound', shared: false, visibility: 'network',
  });
  stA = nodesStore.setPeerAccessPreset(stA, 'node-b', preset);
  nodesStore.atomicWriteStore(A.paths.nodesPath, stA);
  let stB = nodesStore.addNode(nodesStore.loadStoreStrict(B.paths.nodesPath), {
    name: 'a-owner', remotePort: 41999, localPort: A.port, nodeId: idA,
    token: SECRET_AB, direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@a',
  });
  stB = nodesStore.updateNode(stB, 'a-owner', { eventsReceive: true });
  nodesStore.atomicWriteStore(B.paths.nodesPath, stB);
  return { idA, idB };
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

test('clear while the owner is down: the intent survives a restart and is handed over when he is back', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncclear2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const A = await boot(t, path.join(dir, 'a'));
  const B = await boot(t, path.join(dir, 'b'));
  const { idA } = link(A, B);

  await emit(A, ['gone one', 'gone two']);
  const seen = await waitForNotices(B, idA, 2);
  assert.equal((seen.notifications || []).length, 2, 'B imported both notices');
  const clearedIds = new Set((seen.notifications || []).map((n) => n.eventId));

  // The owner goes away right before the operator clears: the dismissal cannot
  // travel, and this is the exact case that used to answer {failed} and leave
  // the cards standing.
  A.server.close();
  await sleep(400);
  const cleared = await fetch(`${B.base}/api/notices-relay`, {
    method: 'POST', headers: H(B.token),
    body: JSON.stringify({ action: 'dismiss-all', owners: [idA] }),
  });
  assert.equal(cleared.status, 200);
  assert.deepStrictEqual(await cleared.json(), { results: { [idA]: { pending: 2 } } },
    'queued as pending, not failed');

  const after = await viewOf(B, idA);
  assert.deepStrictEqual((after.notifications || []).map((n) => n.eventId), [], 'the view is cleared at once');
  const queued = queuedOnDisk(B);
  assert.equal(queued.length, 2, 'one durable record per cleared notice');
  assert.deepStrictEqual([...new Set(queued.map((e) => e.syncState))], ['pending']);
  assert.deepStrictEqual(new Set(queued.map((e) => e.eventId)), clearedIds, 'the records name the cleared notices');

  // The owner still holds both notices on disk: without local intent they would
  // come back from any snapshot.
  const history = JSON.parse(fs.readFileSync(path.join(A.paths.configDir, 'event-feed-history.json'), 'utf8'));
  const stillAtOwner = new Set((history.entries || []).map((e) => e.envelope && e.envelope.eventId));
  for (const eventId of clearedIds) assert.ok(stillAtOwner.has(eventId), 'the owner could hand them back');

  // The owner is back (same HOME, so the same identity, history and grants) and
  // the receiving node is RESTARTED while repointed at him: the restarted node
  // rebuilds its view from a snapshot that still carries the notices.
  const A2 = await boot(t, path.join(dir, 'a'));
  repoint(B, 'a-owner', A2.port);
  const B2 = await boot(t, path.join(dir, 'b'));

  // The restarted node completes snapshot rounds; the drainer hands the intent
  // over within its own budget window (one delivery per owner per 60 s), and
  // once the queue is empty the owner has taken everything.
  let early = null;
  for (let i = 0; i < 40; i += 1) {
    early = await viewOf(B2, idA);
    if (early && early.stale === false) break;
    await sleep(150);
  }
  assert.equal(early.stale, false, 'the restarted node completed a snapshot round');

  let drained = false;
  for (let i = 0; i < 140 && !drained; i += 1) {
    drained = queuedOnDisk(B2).length === 0;
    if (!drained) await sleep(700);
  }
  assert.ok(drained, 'the drainer delivered the pending intent to the owner');

  const snap = await ownerSnapshot(B2, idA);
  assert.equal(snap.ownerId, idA);
  const served = (snap.notifications || []).filter((n) => n.frame && n.frame.type === 'notify');
  assert.equal(served.some((n) => clearedIds.has(n.eventId)), false, 'the owner stopped serving the cleared notices');
  const closures = (snap.notifications || []).filter((n) => n.frame && n.frame.type === 'notify-closed');
  assert.equal(closures.length, 2, 'one closure per cleared notice, like a live clear');
  assert.equal(new Set(closures.map((n) => n.frame.eventId)).size, 2, 'each closure names its notice');

  await stableEmptyView(B2, idA);
});
