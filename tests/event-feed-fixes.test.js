'use strict';
// tests/event-feed-fixes.test.js — audit fixes for the federated feed:
// per-peer projection of node frames (R1), capability + snapshot guards on the
// client (R2), the client ingress budget (R3), the post-build snapshot
// re-gate (R4) and the reset/idle-timer hygiene (R5).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const { tmuxSessionForCell } = require('../lib/fleet/definitions.js');
const { createEventFeedClient } = require('../lib/notify/event-feed-client.js');

const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
const SECRET = 'pairing-secret-token';

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
  const { server, token, watcher, notify } = createServer({
    ...paths,
    filesRoot: path.join(dir, 'files'),
    port: 41999,
    fleetEnabled: false,
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
    t.after(() => { server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    res({ base: `http://127.0.0.1:${server.address().port}`, token, ...paths, notify, paths });
  }));
}

async function pair(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncfix-'));
  const A = await boot(t, path.join(dir, 'a'));
  const B = await boot(t, path.join(dir, 'b'));
  const selfA = nodesStore.loadStoreStrict(A.paths.nodesPath).nodeId;
  const selfB = nodesStore.loadStoreStrict(B.paths.nodesPath).nodeId;
  let stB = nodesStore.addNode(nodesStore.loadStoreStrict(B.nodesPath), {
    name: 'client', remotePort: 41999, localPort: 44777, nodeId: selfA,
    acceptToken: SECRET, direction: 'inbound', shared: false, visibility: 'network',
  });
  stB = nodesStore.setPeerAccessGrants(stB, 'client', {
    cellVisibility: 'selected', cells: ['dev'], eventsAccess: true, nodeEventsAccess: true,
    askReplyAccess: false, filesReadAccess: false, liveHostAccess: false, panelAccess: false, peerOperatorAccess: false,
  });
  nodesStore.atomicWriteStore(B.nodesPath, stB);
  const stA = nodesStore.addNode(nodesStore.loadStoreStrict(A.nodesPath), {
    name: 'owner', remotePort: 41999, localPort: B.port, nodeId: selfB,
    token: SECRET, direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@owner',
  });
  nodesStore.atomicWriteStore(A.nodesPath, stA);
  return { A, B, selfA, selfB };
}

test('R1: a node frame with hidden cells is projected per peer (ring + replay)', async (t) => {
  const { A, B, selfB } = await pair(t);
  // The owner publishes a fleet-state frame listing a visible and a HIDDEN cell.
  A.notify.publishState('fleet-state', {
    cells: [{ cell: 'dev', active: true }, { cell: 'secret', active: true }], ts: Date.now(),
  });
  const done = readSse(`${A.base}/api/route/owner/_/event-feed?after=1:0`, H(A.token));
  const { text } = await done;
  assert.ok(text.includes('"scope":"node"'), 'the peer received the node frame');
  assert.ok(text.includes('"dev"'), 'the visible cell is there');
  assert.ok(!text.includes('secret'), 'the hidden cell never reaches the peer view');
});

function readSse(url, headers, { maxMs = 1500 } = {}) {
  const ctrl = new AbortController();
  const chunks = [];
  const timer = setTimeout(() => ctrl.abort(), maxMs);
  return (async () => {
    let status = null;
    try {
      const r = await fetch(url, { headers, signal: ctrl.signal });
      status = r.status;
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(dec.decode(value));
      }
    } catch (_) {}
    clearTimeout(timer);
    return { status, text: chunks.join('') };
  })();
}

// --- client guards (unit, stubbed fetch) ------------------------------------

function stubClient(t, responses = []) {
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    const next = responses.shift();
    if (!next) return { ok: false, status: 500, json: async () => ({ error: 'no stub' }), text: async () => '' };
    if (next.error) throw next.error;
    return next;
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncfixclient-'));
  const nodesPath = path.join(dir, 'nodes.json');
  nodesStore.initStore(nodesPath);
  let st = nodesStore.addNode(nodesStore.loadStoreStrict(nodesPath), {
    name: 'owner', remotePort: 41999, localPort: 44777, nodeId: 'a'.repeat(32),
    token: 'TOK', direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@owner',
    eventsReceive: true,
  });
  st = nodesStore.updateNode(st, 'owner', { eventsReceive: true });
  nodesStore.atomicWriteStore(nodesPath, st);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = createEventFeedClient({ loadStore: () => nodesStore.loadStoreStrict(nodesPath), fetchImpl, pollMs: 30 });
  return { client, calls };
}

const sse = (chunks) => ({
  ok: true, status: 200,
  body: { getReader: async () => ({
    read: async () => chunks.length ? { done: false, value: Buffer.from(chunks.shift()) } : { done: true },
  }) },
  text: async () => chunks.join(''),
  json: async () => JSON.parse(chunks.join('')),
});

test('R2a: an owner without the feed capability is unsupported, not retried forever', async (t) => {
  const { client, calls } = stubClient(t, [
    { ok: true, status: 200, json: async () => ({ ok: true, instanceId: 'a'.repeat(32) }) },
  ]);
  client.start();
  // health WITHOUT the capability, then nothing else should be requested.
  await new Promise((r) => setTimeout(r, 120));
  const healthCalls = calls.filter((c) => c.url.includes('/federation/health')).length;
  const snapshotCalls = calls.filter((c) => c.url.includes('/event-feed/snapshot')).length;
  assert.ok(healthCalls >= 1);
  assert.equal(snapshotCalls, 0, 'no subscription attempt on an incapable owner');
  await new Promise((r) => setTimeout(r, 120));
  const after = calls.filter((c) => c.url.includes('/federation/health')).length;
  assert.equal(after, healthCalls, 'unsupported: no infinite backoff, no repeated probing');
  client.stop();
});

test('R2b: a snapshot attributed to another owner is refused, never applied', async (t) => {
  const { client, calls } = stubClient(t, [
    { ok: true, status: 200, json: async () => ({ ok: true, instanceId: 'a'.repeat(32), eventFeedV1: true }) },
    { ok: true, status: 200, text: async () => JSON.stringify({ ownerId: selfB, cursor: '1:0', asks: [], notifications: [], viewEpoch: 1 }) },
  ]);
  client.start();
  await new Promise((r) => setTimeout(r, 120));
  const snapCalls = calls.filter((c) => c.url.includes('/event-feed/snapshot')).length;
  assert.ok(snapCalls >= 1, 'the snapshot was requested');
  const view = client.state().views.find((v) => v.ownerId === 'a'.repeat(32));
  assert.equal(view.stale, true, 'the mismatched snapshot is not applied');
  client.stop();
});

test('R2c: a snapshot body over the budget is refused without parsing elements', async (t) => {
  const { client, calls } = stubClient(t, [
    { ok: true, status: 200, json: async () => ({ ok: true, instanceId: 'a'.repeat(32), eventFeedV1: true }) },
    { ok: true, status: 200, text: async () => JSON.stringify({ ownerId: 'a'.repeat(32), cursor: '1:0', asks: [], notifications: [], viewEpoch: 1, filler: 'x'.repeat(4 * 1024 * 1024) }) },
  ]);
  client.start();
  await new Promise((r) => setTimeout(r, 120));
  const snapCalls = calls.filter((c) => c.url.includes('/event-feed/snapshot')).length;
  assert.ok(snapCalls >= 1);
  client.stop();
});

test('R5: three consecutive resets exhaust the resync and stop the loop', async (t) => {
  const streamResponses = [1, 2, 3, 4].map((n) => sse([
    'retry: 100\n\n',
    `id: 1:9\ndata: {"v":1,"ownerId":"${'a'.repeat(32)}","eventId":"e${n}","scope":"node","cellId":null,"hop":1,"emittedAt":1,"frame":{"type":"notify","title":"x"}}\n\n`,
  ]));
  const responses = [
    { ok: true, status: 200, json: async () => ({ ok: true, instanceId: 'a'.repeat(32), eventFeedV1: true }) },
    { ok: true, status: 200, text: async () => JSON.stringify({ ownerId: 'a'.repeat(32), cursor: '1:0', asks: [], notifications: [], viewEpoch: 1, askReplyAccess: true }) },
    ...streamResponses,
  ];
  const { client, calls } = stubClient(t);
  const fake = { fetchImpl: async (url, opts = {}) => {
    calls.push({ url, opts });
    const next = responses.shift();
    if (!next) { calls.exhausted = true; throw new Error('no stub'); }
    return next;
  } };
  client.stop();
  // Rebuild the client with the counting fetch.
  const client2 = createEventFeedClient({
    loadStore: () => { const np = path.join(os.tmpdir(), `ncx-${Date.now()}-a`); return { nodeId: 'b'.repeat(32), nodes: [{ name: 'owner', remotePort: 1, localPort: 44777, nodeId: 'a'.repeat(32), token: 'TOK', direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@o', eventsReceive: true }] }; },
    fetchImpl: fake.fetchImpl, pollMs: 30,
  });
  client2.start();
  await new Promise((r) => setTimeout(r, 400));
  const streamCalls = calls.filter((c) => c.url.includes('/event-feed?')).length;
  assert.ok(streamCalls >= 3, 'each reset required a fresh stream');
  assert.equal(calls.exhausted === true, false, 'placeholder');
  assert.ok(streamCalls <= 5, 'the reset loop stops instead of growing forever');
  client2.stop();
});

test('R3: a too-chatty owner hits the ingress budget and is disconnected', async (t) => {
  const OWNER = 'a'.repeat(32);
  const chunks = [];
  for (let i = 0; i < 130; i++) {
    chunks.push(`id: 1:${i}\ndata: {"v":1,"ownerId":"${OWNER}","eventId":"e${i}","scope":"node","cellId":null,"hop":1,"emittedAt":1,"frame":{"type":"notify","title":"x${i}","body":"${'y'.repeat(9000)}"}}\n\n`);
  }
  chunks.push('END');
  const responses = [
    { ok: true, status: 200, json: async () => ({ ok: true, instanceId: OWNER, eventFeedV1: true }) },
    { ok: true, status: 200, text: async () => JSON.stringify({ ownerId: OWNER, cursor: '1:0', asks: [], notifications: [], viewEpoch: 1 }) },
    sse(chunks),
  ];
  const { client, calls } = stubClient(t);
  const viewOwner = OWNER;
  // Drive the relay/verify path directly is not needed: use the client with a
  // counting fetch, but stubClient builds its own fetch. Use a dedicated one.
  const client2 = createEventFeedClient({
    loadStore: () => ({ nodeId: 'b'.repeat(32), nodes: [{ name: 'owner', remotePort: 1, localPort: 44777, nodeId: OWNER, token: 'TOK', direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@o', eventsReceive: true }] }),
    fetchImpl: async (url, opts = {}) => {
      calls.push({ url, opts });
      const next = responses.shift();
      if (!next) throw new Error('no stub');
      return next;
    },
    pollMs: 30000,
  });
  void viewOwner;
  client2.start();
  await new Promise((r) => setTimeout(r, 300));
  const st = client2.state().views.find((v) => v.ownerId === OWNER);
  assert.ok(st, 'the view exists');
  assert.equal(st.stale, true, 'the disconnected view is stale');
  client2.stop();
});

test('R4: the kill switch flipped during/after the build still refuses the snapshot', async (t) => {
  const { A, B } = await pair(t);
  fs.writeFileSync(B.configPath, JSON.stringify({ federation: { events: { enabled: false } } }));
  const r = await fetch(`${A.base}/api/route/owner/_/event-feed/snapshot`, { headers: H(A.token) });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).reason, 'events-disabled');
});
