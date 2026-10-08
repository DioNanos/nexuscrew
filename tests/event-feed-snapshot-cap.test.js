'use strict';
// tests/event-feed-snapshot-cap.test.js — the snapshot cap: a page at
// the EXACT cap is a whole page, not a floor.
//
// The producer builds the snapshot by slicing each collection to its cap and
// then marking `resyncRequired` when the POST-SLICE counter reaches the cap
// (event-feed-routes.js:298-300). Because the slice can never produce more
// than the cap, the marker fires precisely and only when it is FALSE — on a
// complete page — and never on the truncation it exists to report:
//
//   - 50 notifications  -> the marker must be ABSENT (the owner's history
//     cannot hold more than 50, so this page is by construction everything);
//   - 51 notifications  -> the marker must stay (real truncation, reachable
//     with an injected bigger history);
//   - 100 open asks     -> the marker must be ABSENT (100 exact asks are the
//     whole open set);
//   - 101 open asks     -> the marker must stay (real truncation);
//   - end to end: a peer of an owner at exactly 50 must import all 50 and
//     open the live stream — today it imports nothing and never opens it.
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
const { createAsksStore } = require('../lib/notify/asks.js');
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

// The owner's history, written BEFORE it reads it: the store loads the file
// once, and `load()` does not trim by count (only by the 15 min cutoff), so a
// seeded list bigger than MAX_ENTRIES is a legal way to reach a real overflow.
function seedHistory(node, ownerId, count) {
  const now = Date.now();
  const entries = Array.from({ length: count }, (_, i) => {
    const eventId = `${String(i).padStart(8, '0')}-cccc-4ccc-8ccc-${'c'.repeat(12)}`;
    return {
      origin: 'local', eventId, at: now - (count - i) * 100,
      envelope: {
        v: 1, ownerId, eventId, scope: 'cell', cellId: 'dev', hop: 1,
        emittedAt: now - (count - i) * 100, frame: { type: 'notify', title: `notice ${i}`, urgency: 'normal' },
      },
    };
  });
  fs.writeFileSync(path.join(node.paths.configDir, 'event-feed-history.json'),
    JSON.stringify({ schema: 'nexuscrew-event-feed-history-v1', savedAt: now, entries }), { mode: 0o600 });
  return entries.map((e) => e.eventId);
}

// Exactly `count` LOCAL open asks, through the store itself. `store.create()`
// has a hard cap of MAX_OPEN (100) open local asks, so for 101 the extra one
// is appended to the file the same way save() would write it: the server
// loads lazily, at its first access, so the file is what it reads.
function seedAsks(nodeDir, count) {
  const configDir = path.join(nodeDir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const store = createAsksStore({ dir: configDir });
  for (let i = 0; i < Math.min(count, 100); i += 1) {
    const out = store.create({ question: `question ${i}?`, options: ['Yes'], session: tmuxSessionForCell('dev') });
    assert.equal(out.ok, true, `ask ${i} seeded`);
  }
  if (count > 100) {
    const file = path.join(configDir, 'asks.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    parsed.asks.push({
      id: 'overflow01', question: 'question overflow?', options: ['Yes'],
      session: tmuxSessionForCell('dev'), ts: Date.now(), revision: 0, answered: false, dismissed: false,
    });
    fs.writeFileSync(file, JSON.stringify(parsed), { mode: 0o600 });
  }
}

async function snapshotThrough(peer, ownerId) {
  const res = await fetch(`${peer.base}/api/route/a-owner/_/event-feed/snapshot`, { headers: H(peer.token) });
  assert.equal(res.status, 200);
  return res.json();
}

async function viewOf(node, ownerId) {
  const res = await fetch(`${node.base}/api/feed-state`, { headers: H(node.token) });
  const state = await res.json();
  return (state.views || []).find((v) => v.ownerId === ownerId) || null;
}

function emit(owner, title) {
  return fetch(`${owner.base}/api/notify`, {
    method: 'POST', headers: H(owner.token),
    body: JSON.stringify({ title, session: tmuxSessionForCell('dev') }),
  });
}

test('exactly 50 notifications is a whole page: no resync marker, all 50 served', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nccap1-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const A = await boot(t, path.join(dir, 'a'));
  const B = await boot(t, path.join(dir, 'b'));
  const { idA } = link(A, B);
  const seeded = seedHistory(A, A.nodeId, 50);

  const snap = await snapshotThrough(B, idA);
  assert.equal(snap.ownerId, idA);
  assert.equal(snap.notifications.length, 50, 'the page carries all 50 notifications');
  assert.equal(new Set(snap.notifications.map((n) => n.eventId)).size, 50, 'no duplicates');
  for (const eventId of seeded) {
    assert.ok(snap.notifications.some((n) => n.eventId === eventId), `${eventId} is served`);
  }
  assert.notEqual(snap.resyncRequired, true,
    'a complete page at the cap must NOT be declared a floor');
});

test('51 visible notifications still declare the floor: real truncation keeps the marker', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nccap2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const A = await boot(t, path.join(dir, 'a'));
  const B = await boot(t, path.join(dir, 'b'));
  const { idA } = link(A, B);
  const seeded = seedHistory(A, A.nodeId, 51);

  const snap = await snapshotThrough(B, idA);
  assert.equal(snap.ownerId, idA);
  assert.equal(snap.notifications.length, 50, 'the page is capped');
  const newest = new Set(seeded.slice(1));
  for (const eventId of newest) {
    assert.ok(snap.notifications.some((n) => n.eventId === eventId), `${eventId} (newest) is served`);
  }
  assert.equal(snap.resyncRequired, true,
    '51 sources into a 50-item page is a real truncation: the marker must fire');
});

test('exactly 100 open asks is a whole page: no resync marker, all 100 served', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nccap3-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // Seed BEFORE the owner boots: the store is lazy and caches what it reads
  // at its first access (the peer's first snapshot), so a seeded file must
  // already be on disk by then.
  seedAsks(path.join(dir, 'a'), 100);
  const A = await boot(t, path.join(dir, 'a'));
  const B = await boot(t, path.join(dir, 'b'));
  const { idA } = link(A, B);

  const snap = await snapshotThrough(B, idA);
  assert.equal(snap.ownerId, idA);
  assert.equal(snap.asks.length, 100, 'the page carries all 100 open asks');
  assert.notEqual(snap.resyncRequired, true,
    'a complete ask page at the cap must NOT be declared a floor');
});

test('101 open asks still declare the floor: real truncation keeps the marker', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nccap4-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  seedAsks(path.join(dir, 'a'), 101);
  const A = await boot(t, path.join(dir, 'a'));
  const B = await boot(t, path.join(dir, 'b'));
  const { idA } = link(A, B);

  const snap = await snapshotThrough(B, idA);
  assert.equal(snap.ownerId, idA);
  assert.equal(snap.asks.length, 100, 'the ask page is capped');
  assert.equal(snap.resyncRequired, true,
    '101 sources into a 100-item page is a real truncation: the marker must fire');
});

test('a peer of an owner at exactly 50 imports all 50 and opens the stream', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nccap5-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const A = await boot(t, path.join(dir, 'a'));
  const B = await boot(t, path.join(dir, 'b'));
  const { idA } = link(A, B);
  seedHistory(A, A.nodeId, 50);

  // The receiving node's own event-feed client must accept the full page:
  // stale false, no error, a cursor, and every one of the 50 imported.
  let view = null;
  for (let i = 0; i < 120; i += 1) {
    view = await viewOf(B, idA);
    if (view && view.stale === false && (view.notifications || []).length === 50) break;
    await sleep(250);
  }
  assert.ok(view, 'the peer holds a view of the owner');
  assert.equal(view.stale, false, 'the full page is applied, not refused');
  assert.equal(view.lastError || null, null, 'no snapshot-resync-required error');
  assert.equal(typeof view.cursor, 'string', 'the view carries a cursor');
  assert.equal((view.notifications || []).length, 50, 'all 50 imported');

  // With a cursor the client does not re-snapshot: the new notification can
  // only arrive through the live stream. The view's cursor advancing past the
  // snapshot's one is the receipt that the frame was read on the open stream
  // (the client re-emits it to the browser hub; the view list itself grows at
  // the next snapshot, and the owner's history is capped at 50, so counting
  // past 50 would test the wrong thing).
  const before = view.cursor;
  await emit(A, 'late arrival');
  let late = null;
  for (let i = 0; i < 80; i += 1) {
    late = await viewOf(B, idA);
    if (late && late.cursor && late.cursor !== before) break;
    await sleep(250);
  }
  assert.ok(late, 'the view survives the new event');
  assert.notEqual(late.cursor, before, 'the live frame was received on the open stream (cursor advanced)');
  assert.equal(late.stale, false, 'still live');
  assert.equal((late.notifications || []).length, 50,
    'the view list changes only at the next snapshot, by design');
});
