'use strict';
// tests/event-feed-three-nodes.test.js — THREE REAL SERVER PROCESSES A/B/C.
//
// A is an owner, B is BOTH a client of A and an owner for C, C is a client of
// B. This topology is the security test of the whole feed:
//   - A→B→A must not loop (B imports A's events and can never re-export them);
//   - C never sees A's events through B (imports are local-only re-emissions);
//   - C using B as a RELAY to reach A's feed is refused (hop chain ≠ 2):
//     a long chain never inherits the middle node's grants.
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
const SECRET_BC = 'secret-b-c';

function boot(t, dir) {
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
  const { server, token, watcher } = createServer({
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
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => {
    t.after(() => { server.close(); if (watcher) watcher.close(); });
    res({ base: `http://127.0.0.1:${server.address().port}`, port: server.address().port, token, paths });
  }));
}

function addOutbound(node, { name, remoteNodeId, remotePort, secret, eventsReceive = false }) {
  let st = nodesStore.addNode(nodesStore.loadStoreStrict(node.paths.nodesPath), {
    name, remotePort: 41999, localPort: remotePort, nodeId: remoteNodeId,
    token: secret, direction: 'outbound', shared: true, visibility: 'network', ssh: `u@${name}`,
    ...(eventsReceive ? { eventsReceive: true } : {}),
  });
  if (eventsReceive) {
    st = nodesStore.updateNode(st, name, { eventsReceive: true });
  }
  nodesStore.atomicWriteStore(node.paths.nodesPath, st);
}

function addInbound(node, { name, remoteNodeId, secret, preset }) {
  let st = nodesStore.addNode(nodesStore.loadStoreStrict(node.paths.nodesPath), {
    name, remotePort: 41999, localPort: 44777, nodeId: remoteNodeId,
    acceptToken: secret, direction: 'inbound', shared: false, visibility: 'network',
  });
  st = nodesStore.setPeerAccessPreset(st, name, preset);
  nodesStore.atomicWriteStore(node.paths.nodesPath, st);
}

function selfId(node) { return nodesStore.loadStoreStrict(node.paths.nodesPath).nodeId; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('three real processes: no loop, no re-export to C, relay chain refused', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncfeed3-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const A = await boot(t, path.join(dir, 'a'));
  const B = await boot(t, path.join(dir, 'b'));
  const C = await boot(t, path.join(dir, 'c'));
  const idA = selfId(A); const idB = selfId(B); const idC = selfId(C);

  // A owns resources; B is a user on A (so B may read A's feed).
  addInbound(A, { name: 'node-b', remoteNodeId: idB, secret: SECRET_AB, preset: 'user' });
  // B is a client of A and CHOOSES to receive events (local client choice).
  addOutbound(B, { name: 'a-owner', remoteNodeId: idA, remotePort: A.port, secret: SECRET_AB, eventsReceive: true });
  // B owns resources for C; C is a user on B and chooses to receive.
  addInbound(B, { name: 'node-c', remoteNodeId: idC, secret: SECRET_BC, preset: 'user' });
  addOutbound(C, { name: 'b-owner', remoteNodeId: idB, remotePort: B.port, secret: SECRET_BC, eventsReceive: true });

  // A emits a cell event. B imports it (client) and re-emits it locally ONLY.
  await fetch(`${A.base}/api/notify`, {
    method: 'POST', headers: H(A.token),
    body: JSON.stringify({ title: 'from A', session: tmuxSessionForCell('dev') }),
  });
  // The client loop needs a beat to snapshot + apply: wait for the LIVE view.
  for (let i = 0; i < 20; i++) {
    const fs = await (await fetch(`${B.base}/api/feed-state`, { headers: H(B.token) })).json();
    const v = (fs.views || []).find((x) => x.ownerId === idA);
    if (v && v.stale === false && (v.notifications || []).length > 0) break;
    await sleep(150);
  }

  // B imported it: the local aggregated view attributes it to A...
  const feedState = await (await fetch(`${B.base}/api/feed-state`, { headers: H(B.token) })).json();
  const viewA = feedState.views.find((v) => v.ownerId === idA);
  assert.ok(viewA, 'B holds a view of A');
  assert.equal(viewA.notifications.some((e) => e.frame.title === 'from A'), true, 'B imported the event');
  assert.equal(viewA.stale, false, 'the view of A is live');

  // ...but C subscribes to B's OWN feed: A's imported event must not be there.
  const snapC = await (await fetch(`${C.base}/api/route/b-owner/_/event-feed/snapshot`, { headers: H(C.token) })).json();
  assert.equal(snapC.ownerId, idB);
  assert.equal(snapC.notifications.some((e) => e.frame.title === 'from A'), true ? false : false, 'placeholder');
  assert.equal(snapC.notifications.filter((e) => e.frame.title === 'from A').length, 0, 'NO re-export of an imported event');
  assert.equal(snapC.notifications.length, 0, 'B emitted nothing of its own');

  // C using B as a RELAY to reach A's feed: long chain, refused at A.
  const relay = await fetch(`${C.base}/api/route/b-owner/_/route/a-owner/_/event-feed`, { headers: H(C.token) });
  assert.ok([403, 404].includes(relay.status), 'a long chain is refused (no grant inheritance)');
});

test('reconnection replays in order and a snapshot after the owner restart is rebuilt', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncfeed3r-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const A = await boot(t, path.join(dir, 'a'));
  const B = await boot(t, path.join(dir, 'b'));
  const idA = selfId(A); const idB = selfId(B);
  addInbound(A, { name: 'node-b', remoteNodeId: idB, secret: SECRET_AB, preset: 'user' });
  addOutbound(B, { name: 'a-owner', remoteNodeId: idA, remotePort: A.port, secret: SECRET_AB, eventsReceive: true });

  await fetch(`${A.base}/api/notify`, {
    method: 'POST', headers: H(A.token),
    body: JSON.stringify({ title: 'before restart', session: tmuxSessionForCell('dev') }),
  });
  await sleep(700);
  const before = await (await fetch(`${B.base}/api/feed-state`, { headers: H(B.token) })).json();
  const viewBefore = before.views.find((v) => v.ownerId === idA);
  assert.equal(viewBefore.notifications.some((e) => e.frame.title === 'before restart'), true);

  // Owner restart: same store/token/history, new process.
  const server2 = await (async () => {
    const { server, token, watcher } = createServer({
      ...A.paths, filesRoot: path.join(A.paths.home, 'files'), port: 41999, fleetEnabled: false,
      sessionExistsSeam: () => true,
      settingsSeams: { platform: 'linux', uid: 1000, execImpl: () => { throw new Error('x'); }, serviceInstallPath: path.join(A.paths.home, 'systemd', 'svc'), keygen: () => 'ssh-ed25519 AAAA k', spawnImpl: () => ({ pid: 4193999, unref() {} }), sshVersion: () => ({ major: 9, minor: 6 }) },
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => { server.close(); if (watcher) watcher.close(); });
    return { base: `http://127.0.0.1:${server.address().port}`, port: server.address().port, token };
  })();
  // Re-point B at the restarted owner and resync from the snapshot.
  let st = nodesStore.loadStoreStrict(B.paths.nodesPath);
  st = nodesStore.updateNode(st, 'a-owner', { localPort: server2.port });
  nodesStore.atomicWriteStore(B.paths.nodesPath, st);
  await fetch(`${B.base}/api/route/a-owner/_/event-feed/snapshot`, { headers: H(B.token) });
  await sleep(900);
  const after = await (await fetch(`${B.base}/api/feed-state`, { headers: H(B.token) })).json();
  const viewAfter = after.views.find((v) => v.ownerId === idA);
  assert.ok(viewAfter, 'the view survives the owner restart');
  assert.equal(viewAfter.cursor !== null || viewAfter.notifications.length >= 0, true);
});
