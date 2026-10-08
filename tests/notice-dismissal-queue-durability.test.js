'use strict';
// tests/notice-dismissal-queue-durability.test.js — a lost durable write must
// be VISIBLE in the operator's answer, and the loss must be measurable.
//
// The dismissal queue honours the intent in memory when the disk refuses it
// (that policy stands), but the answer must not look like the normal,
// durable pending success: a record that will not survive a restart is a
// different outcome, and the only honest way to say so is in the response.
//
// The scene: two real nodes, the owner DOWN, two notices cleared. The first
// clear happens with a healthy queue (normal pending, record on disk). Then
// the queue file is replaced by a DIRECTORY (writes fail for real), the
// second clear answers, the node RESTARTS, and the durable file shows what
// really happened: the first record is there, the second is gone.
//
// Everything runs in-process on ephemeral ports and a temporary HOME: no
// service is touched.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const { createNoticeDismissalQueue, SCHEMA } = require('../lib/notify/notice-dismissal-queue.js');
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
  nodesStore.atomicWriteStore(stB && B.paths.nodesPath, stB);
  return { idA, idB };
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

function queuedRecords(node) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(node.paths.configDir, 'notice-dismissal-queue.json'), 'utf8'));
    return parsed.entries || [];
  } catch (_) { return []; }
}

function dismiss(node, ownerId, eventId) {
  return fetch(`${node.base}/api/notices-relay`, {
    method: 'POST', headers: H(node.token),
    body: JSON.stringify({ action: 'dismiss', ownerId, eventId }),
  }).then(async (r) => ({ code: r.status, body: await r.json() }));
}

test('a refused queue write is declared in the answer, and the restart proves the loss', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncqueuedur-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const A = await boot(t, path.join(dir, 'a'));
  let B = await boot(t, path.join(dir, 'b'));
  const { idA } = link(A, B);

  await Promise.all([
    fetch(`${A.base}/api/notify`, { method: 'POST', headers: H(A.token), body: JSON.stringify({ title: 'first', session: tmuxSessionForCell('dev') }) }),
    fetch(`${A.base}/api/notify`, { method: 'POST', headers: H(A.token), body: JSON.stringify({ title: 'second', session: tmuxSessionForCell('dev') }) }),
  ]);
  const seen = await waitForNotices(B, idA, 2);
  assert.equal((seen.notifications || []).length, 2, 'B imported both notices');
  const [first, second] = seen.notifications;

  // The owner goes down; the first clear is the NORMAL case: a healthy queue
  // keeps the record and the answer says nothing about durability.
  A.server.close();
  await sleep(400);
  const healthy = await dismiss(B, idA, first.eventId);
  assert.equal(healthy.code, 200);
  assert.deepStrictEqual(healthy.body, { dismissed: true, scope: 'local', ownerSync: 'pending' },
    'a durable pending success keeps its exact shape');
  assert.equal(queuedRecords(B).length, 1, 'the healthy record is on disk');

  // The queue is made UNWRITABLE for real: the config directory loses its
  // write bit, so the queue's atomic write (tmp file + rename) fails with
  // EACCES while the healthy file — and its record — stay untouched.
  const queueDir = B.paths.configDir;
  fs.chmodSync(queueDir, 0o555);
  const broken = await dismiss(B, idA, second.eventId);
  assert.equal(broken.code, 200);
  assert.equal(broken.body.dismissed, true, 'the intent is honoured: the card leaves');
  assert.equal(broken.body.ownerSync, 'pending');
  assert.equal(broken.body.durable, false, 'the lost durability is DECLARED');
  assert.equal(broken.body.degraded, 'queue-write-failed', 'the cause is named');
  fs.chmodSync(queueDir, 0o755);

  // RESTART: the queue file shows what survived. The first record is there
  // (written while healthy); the second never reached the disk.
  B.server.close();
  await sleep(300);
  B = await boot(t, path.join(dir, 'b'));
  const records = queuedRecords(B);
  assert.equal(records.length, 1, 'exactly the healthy record survived');
  assert.equal(records[0].eventId, first.eventId, 'the healthy record is the first one');
  assert.equal(records.some((e) => e.eventId === second.eventId), false,
    'the lost record is really lost: it cannot survive a restart');
});

test('a healthy write after recovery answers like a healthy write again', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncqueuerec-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const A = await boot(t, path.join(dir, 'a'));
  const B = await boot(t, path.join(dir, 'b'));
  const { idA } = link(A, B);

  await fetch(`${A.base}/api/notify`, { method: 'POST', headers: H(A.token), body: JSON.stringify({ title: 'first', session: tmuxSessionForCell('dev') }) });
  let seen = null;
  for (let i = 0; i < 40; i += 1) {
    seen = await viewOf(B, idA);
    if (seen && (seen.notifications || []).length === 1) break;
    await sleep(150);
  }
  const first = seen.notifications[0];

  A.server.close();
  await sleep(400);
  // Healthy: exact durable shape, one record on disk.
  const healthy = await dismiss(B, idA, first.eventId);
  assert.deepStrictEqual(healthy.body, { dismissed: true, scope: 'local', ownerSync: 'pending' });

  // The disk refuses the write: the answer declares it.
  fs.chmodSync(B.paths.configDir, 0o555);
  const broken = await dismiss(B, idA, '22222222-3333-4444-8555-666666666666');
  assert.equal(broken.body.durable, false);
  assert.equal(broken.body.degraded, 'queue-write-failed');
  fs.chmodSync(B.paths.configDir, 0o755);

  // The disk is healthy again: the NEXT queued write persists everything it
  // holds, so its answer must go back to the exact healthy shape — not keep
  // reporting an old failure forever.
  const third = '11111111-2222-4333-8444-555555555555';
  const recovered = await dismiss(B, idA, third);
  assert.deepStrictEqual(recovered.body, { dismissed: true, scope: 'local', ownerSync: 'pending' },
    'a healthy write after recovery keeps the normal healthy shape');
  const events = queuedRecords(B).map((e) => e.eventId);
  assert.ok(events.includes(first.eventId), 'the healthy record is still there');
  assert.ok(events.includes('22222222-3333-4444-8555-666666666666'), 'the recovery rewrote the temporarily lost record too');
  assert.ok(events.includes(third), 'the new record is on disk');
});

// --- The three READ-failure causes: a failed load must never cost records ---

// A read denial is TRANSIENT: before any write the queue retries the read and
// merges, so nothing the file held is lost and a complete merged write ends
// the degradation.
test('a transient read denial retries and merges before writing: no record is lost', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncqueuerd-'));
  const file = path.join(dir, 'notice-dismissal-queue.json');
  const ownerId = 'a'.repeat(32);
  const seed = createNoticeDismissalQueue({ filePath: file });
  assert.equal(seed.enqueue({ ownerId, eventId: 'previous' }).ok, true);

  const q = createNoticeDismissalQueue({ filePath: file });
  const original = fs.readFileSync;
  fs.readFileSync = function (p, ...args) {
    if (p === file) { const e = new Error('temporary read denial'); e.code = 'EACCES'; throw e; }
    return original.call(this, p, ...args);
  };
  try { assert.equal(q.status().degraded, 'queue-read-failed', 'the read denial is declared'); } finally { fs.readFileSync = original; }

  assert.equal(q.enqueue({ ownerId, eventId: 'fresh' }).ok, true);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')).entries.map((e) => e.eventId).sort();
  assert.deepStrictEqual(onDisk, ['fresh', 'previous'], 'the seeded record survives the write');
  assert.equal(q.status().degraded, null, 'a complete merged write ends the degradation');
  fs.rmSync(dir, { recursive: true, force: true });
});

// A file with a foreign schema can hold records this process cannot read:
// writing a partial list over it would destroy them, so the write is refused
// and the file stays byte-identical while the degradation is declared.
test('a foreign-schema queue file is never overwritten by a partial cache', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncqueuesch-'));
  const file = path.join(dir, 'notice-dismissal-queue.json');
  const ownerId = 'a'.repeat(32);
  fs.writeFileSync(file, JSON.stringify({ schema: 'something-else-v9', entries: [{ ownerId, eventId: 'unreadable' }] }), { mode: 0o600 });
  const before = fs.readFileSync(file);

  const q = createNoticeDismissalQueue({ filePath: file });
  assert.equal(q.status().degraded, 'queue-schema');
  assert.equal(q.enqueue({ ownerId, eventId: 'fresh' }).ok, true, 'the intent is honoured in memory');
  assert.equal(q.status().degraded, 'queue-schema', 'the read degradation stands');
  assert.ok(fs.readFileSync(file).equals(before), 'the unreadable file is untouched');
  fs.rmSync(dir, { recursive: true, force: true });
});

// Same for a file too big to load at all.
test('an oversize-at-load queue file is never overwritten by a partial cache', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncqueuebig-'));
  const file = path.join(dir, 'notice-dismissal-queue.json');
  const ownerId = 'a'.repeat(32);
  const huge = { schema: SCHEMA, savedAt: Date.now(), entries: [{ ownerId, eventId: 'x'.repeat(300000), at: Date.now(), expiresAt: Date.now() + 1000, syncState: 'pending' }] };
  fs.writeFileSync(file, JSON.stringify(huge), { mode: 0o600 });
  const before = fs.readFileSync(file);

  const q = createNoticeDismissalQueue({ filePath: file });
  assert.equal(q.status().degraded, 'queue-oversize');
  assert.equal(q.enqueue({ ownerId, eventId: 'fresh' }).ok, true, 'the intent is honoured in memory');
  assert.equal(q.status().degraded, 'queue-oversize', 'the read degradation stands');
  assert.ok(fs.readFileSync(file).equals(before), 'the oversize file is untouched');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- A refused write after a recovered read must keep the merged list ---

test('a refused write after a successful reload keeps the merged list for the next attempt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncqueuemrg-'));
  const file = path.join(dir, 'notice-dismissal-queue.json');
  const ownerId = 'a'.repeat(32);
  const seed = createNoticeDismissalQueue({ filePath: file });
  assert.equal(seed.enqueue({ ownerId, eventId: 'old' }).ok, true);

  const q = createNoticeDismissalQueue({ filePath: file });
  const originalRead = fs.readFileSync;
  fs.readFileSync = function (p, ...args) {
    if (p === file) { const e = new Error('read denied'); e.code = 'EACCES'; throw e; }
    return originalRead.call(this, p, ...args);
  };
  try { q.status(); } finally { fs.readFileSync = originalRead; }

  // The reload succeeds and the merge is built, but THIS write is refused.
  const originalRename = fs.renameSync;
  fs.renameSync = function (a, b, ...args) {
    if (b === file) { const e = new Error('rename denied once'); e.code = 'EACCES'; throw e; }
    return originalRename.call(this, a, b, ...args);
  };
  try { assert.equal(q.enqueue({ ownerId, eventId: 'new' }).ok, true); } finally { fs.renameSync = originalRename; }

  // The next attempt must still know the recovered record: the merged list,
  // not the partial cache, is what the queue writes.
  assert.equal(q.enqueue({ ownerId, eventId: 'third' }).ok, true);
  const ids = JSON.parse(fs.readFileSync(file, 'utf8')).entries.map((e) => e.eventId).sort();
  assert.deepStrictEqual(ids, ['new', 'old', 'third'], 'nothing the merge recovered is lost');
  assert.equal(q.status().degraded, null, 'the eventually successful write attests everything');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('on duplicate keys the cache intent outranks the disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncqueuedup-'));
  const file = path.join(dir, 'notice-dismissal-queue.json');
  const ownerId = 'a'.repeat(32);
  const seed = createNoticeDismissalQueue({ filePath: file });
  assert.equal(seed.enqueue({ ownerId, eventId: 'same' }).ok, true); // pending, attempts 0

  const q = createNoticeDismissalQueue({ filePath: file });
  const originalRead = fs.readFileSync;
  fs.readFileSync = function (p, ...args) {
    if (p === file) { const e = new Error('read denied'); e.code = 'EACCES'; throw e; }
    return originalRead.call(this, p, ...args);
  };
  // While the read is denied this node builds its own intent for 'same'.
  try {
    q.status();
    assert.equal(q.enqueue({ ownerId, eventId: 'same' }).ok, true);
    assert.equal(q.update(ownerId, 'same', { syncState: 'blocked', attempts: 7, lastReason: 'probe' }).ok, true);
  } finally { fs.readFileSync = originalRead; }

  // The read comes back: the disk still holds 'same' as pending/0. The merge
  // must keep THE CACHE's intent (state and attempts), not the disk's copy.
  assert.equal(q.enqueue({ ownerId, eventId: 'trigger' }).ok, true);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')).entries.find((e) => e.eventId === 'same');
  assert.equal(onDisk.syncState, 'blocked', 'the cache state wins on duplicates');
  assert.equal(onDisk.attempts, 7, 'the cache attempts win on duplicates');
  fs.rmSync(dir, { recursive: true, force: true });
});

// --- At the cap and across recoveries: the fresh intent and the confirmed
// --- removals are what the queue must never lose.

test('a cap-full disk never evicts the fresh accepted record during recovery', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncqueuecap-'));
  const file = path.join(dir, 'notice-dismissal-queue.json');
  const ownerId = 'a'.repeat(32);
  const seed = createNoticeDismissalQueue({ filePath: file });
  for (let i = 0; i < 200; i += 1) {
    assert.equal(seed.enqueue({ ownerId, eventId: `old-${i}` }).ok, true, `seed ${i}`);
  }

  // The first read is denied: the queue starts with an incomplete memory list.
  const q = createNoticeDismissalQueue({ filePath: file });
  const originalRead = fs.readFileSync;
  fs.readFileSync = function (p, ...args) {
    if (p === file) { const e = new Error('read denied'); e.code = 'EACCES'; throw e; }
    return originalRead.call(this, p, ...args);
  };
  try { q.status(); } finally { fs.readFileSync = originalRead; }

  assert.equal(q.enqueue({ ownerId, eventId: 'fresh' }).ok, true);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8')).entries.map((e) => e.eventId);
  assert.equal(onDisk.length, 200, 'the cap holds');
  assert.ok(onDisk.includes('fresh'), 'the fresh accepted record is NOT evicted by older disk records');
  assert.ok(!onDisk.includes('old-0'), 'the oldest record is the one the policy evicts');
  assert.equal(q.status().degraded, null, 'the recovery ends healthy');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a confirmed record during a degradation never comes back from the disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncqueueconf-'));
  const file = path.join(dir, 'notice-dismissal-queue.json');
  const ownerId = 'a'.repeat(32);
  const seed = createNoticeDismissalQueue({ filePath: file });
  assert.equal(seed.enqueue({ ownerId, eventId: 'old' }).ok, true);

  const q = createNoticeDismissalQueue({ filePath: file });
  const originalRead = fs.readFileSync;
  fs.readFileSync = function (p, ...args) {
    if (p === file) { const e = new Error('read denied'); e.code = 'EACCES'; throw e; }
    return originalRead.call(this, p, ...args);
  };
  try { q.status(); } finally { fs.readFileSync = originalRead; }

  // enqueue + recovery where the write is refused once, then confirm 'old'
  // while still degraded.
  const originalRename = fs.renameSync;
  fs.renameSync = function (a, b, ...args) {
    if (b === file) { const e = new Error('write denied once'); e.code = 'EACCES'; throw e; }
    return originalRename.call(this, a, b, ...args);
  };
  try { assert.equal(q.enqueue({ ownerId, eventId: 'fresh' }).ok, true); } finally { fs.renameSync = originalRename; }
  const confirmed = q.confirm(ownerId, 'old');
  assert.equal(confirmed.ok, true);

  // The confirmed record must never reappear on the disk, whatever the
  // following operations consolidate.
  assert.equal(q.enqueue({ ownerId, eventId: 'trigger' }).ok, true);
  let onDisk = JSON.parse(fs.readFileSync(file, 'utf8')).entries.map((e) => e.eventId);
  assert.equal(onDisk.includes('old'), false, 'the confirmed record stays removed');
  assert.ok(onDisk.includes('fresh'), 'the fresh intent is on the disk');
  assert.ok(onDisk.includes('trigger'), 'the trigger is on the disk');

  // And a full restart keeps it removed.
  fs.rmSync(path.join(dir, 'b'), { recursive: true, force: true });
  const B2 = createNoticeDismissalQueue({ filePath: file });
  assert.equal(B2.get(ownerId, 'old'), null, 'the confirmed record stays removed after a restart');
  fs.rmSync(dir, { recursive: true, force: true });
});
