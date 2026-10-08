'use strict';
// tests/notice-dismissal-operator.test.js — the operator surface, end to end on
// two real nodes: the owner is DOWN when the operator clears the notice.
//
// What must hold: the card leaves THIS node at once (the intent is honoured
// locally), the intent lands in the durable queue, and when the owner comes back
// the drainer delivers it and the entry leaves the queue. A notice the owner no
// longer has (expired: 404) counts as delivered, not as a failure to retry.
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

function serverFor(dir, extra = {}) {
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir, configDir,
    configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'),
    tokenPath: path.join(configDir, 'token'),
  };
  if (!fs.existsSync(paths.nodesPath)) nodesStore.initStore(paths.nodesPath);
  const made = createServer({
    ...paths,
    filesRoot: path.join(dir, 'files'),
    port: 41999,
    fleetEnabled: false,
    eventFeedClientPollMs: 250,
    noticeDismissalDrainMs: 250,
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
  return { made, paths };
}

async function boot(t, dir, extra = {}) {
  const { made, paths } = serverFor(dir, extra);
  const { server, token, watcher } = made;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const stop = () => new Promise((resolve) => { try { watcher.close(); } catch (_) {} server.closeAllConnections(); server.close(() => resolve()); });
  t.after(stop);
  return { base: `http://127.0.0.1:${server.address().port}`, port: server.address().port, token, paths, stop };
}

function link(A, B) {
  const idA = nodesStore.loadStoreStrict(A.paths.nodesPath).nodeId;
  const idB = nodesStore.loadStoreStrict(B.paths.nodesPath).nodeId;
  let stA = nodesStore.addNode(nodesStore.loadStoreStrict(A.paths.nodesPath), {
    name: 'node-b', remotePort: 41999, localPort: 44777, nodeId: idB,
    acceptToken: SECRET_AB, direction: 'inbound', shared: false, visibility: 'network',
  });
  stA = nodesStore.setPeerAccessPreset(stA, 'node-b', 'admin');
  nodesStore.atomicWriteStore(A.paths.nodesPath, stA);
  let stB = nodesStore.addNode(nodesStore.loadStoreStrict(B.paths.nodesPath), {
    name: 'a-owner', remotePort: 41999, localPort: A.port, nodeId: idA,
    token: SECRET_AB, direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@a',
  });
  stB = nodesStore.updateNode(stB, 'a-owner', { eventsReceive: true });
  nodesStore.atomicWriteStore(B.paths.nodesPath, stB);
  return { idA, idB };
}

async function viewOfB(B, idA) {
  const state = await (await fetch(`${B.base}/api/feed-state`, { headers: H(B.token) })).json();
  return (state.views || []).find((v) => v.ownerId === idA) || null;
}

function queueFile(B) { return path.join(B.paths.configDir, 'notice-dismissal-queue.json'); }
function queuedRecords(B) {
  try { return (JSON.parse(fs.readFileSync(queueFile(B), 'utf8')).entries || []); } catch (_) { return []; }
}

test('an operator clears a notice while the owner is DOWN: local now, owner when it returns', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncrelay-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const A = await boot(t, path.join(dir, 'a'));
  const B = await boot(t, path.join(dir, 'b'));
  const { idA } = link(A, B);

  await fetch(`${A.base}/api/notify`, {
    method: 'POST', headers: H(A.token),
    body: JSON.stringify({ title: 'clear me later', session: tmuxSessionForCell('dev') }),
  });
  let view = null;
  for (let i = 0; i < 40; i += 1) {
    view = await viewOfB(B, idA);
    if (view && view.stale === false && (view.notifications || []).length === 1) break;
    await sleep(150);
  }
  const target = view.notifications[0];
  assert.ok(target, 'B imported the notice');

  // The owner goes away. The operator clears the notice anyway.
  await A.stop();
  await sleep(200);
  const cleared = await fetch(`${B.base}/api/notices-relay`, {
    method: 'POST', headers: H(B.token),
    body: JSON.stringify({ action: 'dismiss', ownerId: idA, eventId: target.eventId }),
  });
  assert.equal(cleared.status, 200);
  assert.deepStrictEqual(await cleared.json(), { dismissed: true, scope: 'local', ownerSync: 'pending' });

  // Hidden HERE at once, and the intent is durable.
  view = await viewOfB(B, idA);
  assert.equal((view.notifications || []).length, 0, 'the card is gone from this node');
  const queued = queuedRecords(B);
  assert.equal(queued.length, 1);
  assert.equal(queued[0].syncState, 'pending');
  assert.equal(queued[0].eventId, target.eventId);

  // The owner comes back on the same store: the drainer delivers and the entry leaves.
  const A2 = await boot(t, path.join(dir, 'a'));
  assert.equal(nodesStore.loadStoreStrict(A2.paths.nodesPath).nodeId, idA, 'same owner identity');
  // The owner came back on a different port: re-point the pairing at it, the way
  // an operator would after the owner moved.
  let st = nodesStore.loadStoreStrict(B.paths.nodesPath);
  st = nodesStore.updateNode(st, 'a-owner', { localPort: A2.port });
  nodesStore.atomicWriteStore(B.paths.nodesPath, st);
  let delivered = false;
  for (let i = 0; i < 60; i += 1) {
    if (queuedRecords(B).length === 0) { delivered = true; break; }
    await sleep(250);
  }
  assert.ok(delivered, 'the queue drains once the owner is back');
  const snap = await (await fetch(`${B.base}/api/route/a-owner/_/event-feed/snapshot`, { headers: H(B.token) })).json();
  assert.equal((snap.notifications || []).some((n) => n.eventId === target.eventId), false,
    'the owner no longer serves it: the other devices stop seeing it too');
});

test('a notice the owner no longer has (404) counts as delivered, not retried', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncrelay404-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const A = await boot(t, path.join(dir, 'a'));
  const B = await boot(t, path.join(dir, 'b'));
  const { idA } = link(A, B);

  await fetch(`${A.base}/api/notify`, {
    method: 'POST', headers: H(A.token),
    body: JSON.stringify({ title: 'expiring', session: tmuxSessionForCell('dev') }),
  });
  let view = null;
  for (let i = 0; i < 40; i += 1) {
    view = await viewOfB(B, idA);
    if (view && view.stale === false && (view.notifications || []).length === 1) break;
    await sleep(150);
  }
  const target = view.notifications[0];

  await A.stop();
  const cleared = await fetch(`${B.base}/api/notices-relay`, {
    method: 'POST', headers: H(B.token),
    body: JSON.stringify({ action: 'dismiss', ownerId: idA, eventId: target.eventId }),
  });
  assert.equal(cleared.status, 200);
  assert.equal(queuedRecords(B).length, 1);

  // The owner returns WITHOUT that notice in its history (expired): the entry is
  // unknown to it, and an unknown id is an opaque 404 — the goal is reached.
  fs.rmSync(path.join(A.paths.configDir, 'event-feed-history.json'), { force: true });
  const A2 = await boot(t, path.join(dir, 'a'));
  let st2 = nodesStore.loadStoreStrict(B.paths.nodesPath);
  st2 = nodesStore.updateNode(st2, 'a-owner', { localPort: A2.port });
  nodesStore.atomicWriteStore(B.paths.nodesPath, st2);
  let drained = false;
  for (let i = 0; i < 60; i += 1) {
    if (queuedRecords(B).length === 0) { drained = true; break; }
    await sleep(250);
  }
  assert.ok(drained, 'a 404 from the owner closes the record');
});

test('the surface refuses a foreign hop, and the capability answers locally', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncrelaycap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const A = await boot(t, path.join(dir, 'a'));
  const B = await boot(t, path.join(dir, 'b'));
  const { idA } = link(A, B);

  const hopped = await fetch(`${B.base}/api/notices-relay`, {
    method: 'POST',
    headers: { ...H(B.token), 'x-nexuscrew-hop': 'deadbeef' },
    body: JSON.stringify({ action: 'dismiss', ownerId: idA, eventId: '0f8fad5b-d9cb-469f-a165-70867728950e' }),
  });
  assert.equal(hopped.status, 403, 'the local surface is not a federated entry point');

  const bad = await fetch(`${B.base}/api/notices-relay`, {
    method: 'POST', headers: H(B.token),
    body: JSON.stringify({ action: 'dismiss', ownerId: idA, eventId: 'not-an-id' }),
  });
  assert.equal(bad.status, 400);

  const cap = await (await fetch(`${B.base}/api/notices-relay/capability?ownerId=${idA}`, { headers: H(B.token) })).json();
  assert.deepStrictEqual(cap, { ownerId: idA, canDismiss: true });
  const unknown = await (await fetch(`${B.base}/api/notices-relay/capability?ownerId=${'c'.repeat(32)}`, { headers: H(B.token) })).json();
  assert.equal(unknown.canDismiss, false);
});
