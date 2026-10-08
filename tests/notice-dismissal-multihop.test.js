'use strict';
// tests/notice-dismissal-multihop.test.js — a dismissal that travels TWO hops.
//
// A owns the notices, B is the relay, C is the node whose operator clears them
// and has no direct pairing with A: the request goes out on the authorized
// inventory route (C → B → A) and must be authorized on EVERY ring, while the
// entry it points at is judged by the origin's view (exactly what the snapshot
// rule says). `dismiss-all` is ONE request: N requests through two hops would die
// in the owner's per-request budget.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');

const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
const SECRET_AB = 'secret-a-b';
const SECRET_BC = 'secret-b-c';
const BULK = 6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function boot(t, dir) {
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir, configDir,
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

const selfId = (node) => nodesStore.loadStoreStrict(node.paths.nodesPath).nodeId;

let nextLocalPort = 44777;
function addInbound(node, { name, remoteNodeId, secret, preset }) {
  // One local port per inbound record: the store refuses a duplicate, and in a
  // test the reverse listeners are not real anyway.
  let st = nodesStore.addNode(nodesStore.loadStoreStrict(node.paths.nodesPath), {
    name, remotePort: 41999, localPort: nextLocalPort++, nodeId: remoteNodeId,
    acceptToken: secret, direction: 'inbound', shared: false, visibility: 'network',
  });
  st = nodesStore.setPeerAccessPreset(st, name, preset);
  nodesStore.atomicWriteStore(node.paths.nodesPath, st);
}

function addOutbound(node, { name, remoteNodeId, remotePort, secret, eventsReceive = false }) {
  let st = nodesStore.addNode(nodesStore.loadStoreStrict(node.paths.nodesPath), {
    name, remotePort: 41999, localPort: remotePort, nodeId: remoteNodeId,
    token: secret, direction: 'outbound', shared: true, visibility: 'network', ssh: `u@${name}`,
  });
  if (eventsReceive) st = nodesStore.updateNode(st, name, { eventsReceive: true });
  nodesStore.atomicWriteStore(node.paths.nodesPath, st);
}

// The owner's history, written BEFORE it reads it (the store reads the file once).
function seedHistory(node, ownerId, count) {
  const now = Date.now();
  const entries = Array.from({ length: count }, (_, i) => {
    const eventId = `${String(i).padStart(8, '0')}-bbbb-4bbb-8bbb-${'b'.repeat(12)}`;
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

async function clearThroughRelay(C, idA, eventId) {
  const res = await fetch(`${C.base}/api/notices-relay`, {
    method: 'POST', headers: H(C.token),
    body: JSON.stringify({ action: 'dismiss', ownerId: idA, eventId }),
  });
  return { code: res.status, body: await res.json() };
}

test('a two-hop dismissal is authorized on every ring and judged by the origin', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncmulti-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const A = await boot(t, path.join(dir, 'a'));
  const idA = selfId(A);
  const ids = seedHistory(A, idA, BULK);
  const B = await boot(t, path.join(dir, 'b'));
  const C = await boot(t, path.join(dir, 'c'));
  const idB = selfId(B);
  const idC = selfId(C);

  // A knows B (the relay) and C (the actor): the grants must hold on EVERY ring.
  addInbound(A, { name: 'node-b', remoteNodeId: idB, secret: SECRET_AB, preset: 'admin' });
  addInbound(A, { name: 'node-c', remoteNodeId: idC, secret: SECRET_BC, preset: 'admin' });
  // B forwards to A and accepts C.
  addOutbound(B, { name: 'a-owner', remoteNodeId: idA, remotePort: A.port, secret: SECRET_AB });
  addInbound(B, { name: 'node-c', remoteNodeId: idC, secret: SECRET_BC, preset: 'admin' });
  // C is paired with B only: its route to A comes from the authorized inventory.
  addOutbound(C, { name: 'b-owner', remoteNodeId: idB, remotePort: B.port, secret: SECRET_BC, eventsReceive: true });

  // The route needs the topology to be collected (the inventory is built from it).
  await sleep(900);

  const cleared = await clearThroughRelay(C, idA, ids[0]);
  assert.equal(cleared.code, 200, JSON.stringify(cleared.body));
  assert.deepStrictEqual(cleared.body, { dismissed: true });

  // The owner stopped serving it. Read back from B: the SNAPSHOT is direct-only
  // by design (a relayed chain is refused, event-feed-routes.js:58) — the
  // dismissal is what travels two hops, not the feed.
  const snap = await (await fetch(`${B.base}/api/route/a-owner/_/event-feed/snapshot`, { headers: H(B.token) })).json();
  assert.equal(snap.ownerId, idA);
  assert.equal((snap.notifications || []).some((n) => n.eventId === ids[0]), false, 'the owner recorded the dismissal');
});

test('a missing grant on ONE ring refuses the action', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncring-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const A = await boot(t, path.join(dir, 'a'));
  const idA = selfId(A);
  const ids = seedHistory(A, idA, 2);
  const B = await boot(t, path.join(dir, 'b'));
  const C = await boot(t, path.join(dir, 'c'));
  const idB = selfId(B);
  const idC = selfId(C);

  addInbound(A, { name: 'node-b', remoteNodeId: idB, secret: SECRET_AB, preset: 'admin' });
  // The ACTOR's ring on the owner is a plain user: it reads, it does not act.
  addInbound(A, { name: 'node-c', remoteNodeId: idC, secret: SECRET_BC, preset: 'user' });
  addOutbound(B, { name: 'a-owner', remoteNodeId: idA, remotePort: A.port, secret: SECRET_AB });
  addInbound(B, { name: 'node-c', remoteNodeId: idC, secret: SECRET_BC, preset: 'admin' });
  addOutbound(C, { name: 'b-owner', remoteNodeId: idB, remotePort: B.port, secret: SECRET_BC, eventsReceive: true });
  await sleep(900);

  const refused = await clearThroughRelay(C, idA, ids[0]);
  assert.equal(refused.code, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.reason, 'grant-required:ask-action');

  // Nothing was recorded on the owner.
  const snap = await (await fetch(`${B.base}/api/route/a-owner/_/event-feed/snapshot`, { headers: H(B.token) })).json();
  assert.equal((snap.notifications || []).some((n) => n.eventId === ids[0]), true, 'the notice is still there');
});

test('dismiss-all crosses the two hops as ONE request inside the owner budget', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncall-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const A = await boot(t, path.join(dir, 'a'));
  const idA = selfId(A);
  const ids = seedHistory(A, idA, BULK);
  const B = await boot(t, path.join(dir, 'b'));
  const C = await boot(t, path.join(dir, 'c'));
  const idB = selfId(B);
  const idC = selfId(C);

  addInbound(A, { name: 'node-b', remoteNodeId: idB, secret: SECRET_AB, preset: 'admin' });
  addInbound(A, { name: 'node-c', remoteNodeId: idC, secret: SECRET_BC, preset: 'admin' });
  addOutbound(B, { name: 'a-owner', remoteNodeId: idA, remotePort: A.port, secret: SECRET_AB });
  addInbound(B, { name: 'node-c', remoteNodeId: idC, secret: SECRET_BC, preset: 'admin' });
  addOutbound(C, { name: 'b-owner', remoteNodeId: idB, remotePort: B.port, secret: SECRET_BC, eventsReceive: true });
  await sleep(900);

  const res = await fetch(`${C.base}/api/notices-relay`, {
    method: 'POST', headers: H(C.token),
    body: JSON.stringify({ action: 'dismiss-all', owners: [idA] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepStrictEqual(body.results[idA], { ok: true, dismissed: BULK },
    'one request clears the whole window: the per-request budget of the owner is 6/min');

  const snap = await (await fetch(`${B.base}/api/route/a-owner/_/event-feed/snapshot`, { headers: H(B.token) })).json();
  const served = (snap.notifications || []).map((n) => n.eventId);
  assert.equal(served.some((id) => ids.includes(id)), false, 'none of them is served any more');
});
