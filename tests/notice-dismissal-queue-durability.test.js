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
