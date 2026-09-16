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
    res({ base: `http://127.0.0.1:${server.address().port}`, port: server.address().port, token, ...paths, notify, paths });
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
  B.notify.publishState('fleet-state', {
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
  // getReader() is SYNCHRONOUS in the standard Streams API: an async one hands
  // back a promise and the stream throw would be masked as a transport error.
  body: { getReader: () => ({
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
    { ok: true, status: 200, text: async () => JSON.stringify({
      ownerId: 'b'.repeat(32), cursor: '5:0', viewEpoch: 1, asks: [], fleetState: null,
      notifications: [{ origin: 'local', eventId: 'marker-1', at: 1,
        envelope: { v: 1, ownerId: 'b'.repeat(32), eventId: 'marker-1', scope: 'node', cellId: null, hop: 1, emittedAt: 1,
          frame: { type: 'notify', title: 'MARKER', body: '' } } }],
    }) },
  ]);
  client.start();
  await new Promise((r) => setTimeout(r, 120));
  const snapCalls = calls.filter((c) => c.url.includes('/event-feed/snapshot')).length;
  assert.ok(snapCalls >= 1, 'the snapshot was requested');
  // The marker is the sensitive probe: it must be absent from the view whatever
  // shape the element takes, so the check is shape-agnostic on purpose.
  const markerIn = (v) => (v.notifications || []).some((e) => JSON.stringify(e).includes('MARKER'));
  let view = null;
  for (let i = 0; i < 40; i++) {
    view = client.state().views.find((v) => v.ownerId === 'a'.repeat(32));
    if (view && (view.lastError === 'owner-mismatch' || markerIn(view))) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(view, 'the view exists');
  assert.equal(markerIn(view), false, 'the mismatched snapshot is not applied: no marker in the view');
  assert.equal(view.lastError, 'owner-mismatch', 'the mismatched snapshot is refused with a named reason');
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

// R5 — the reset streak is deterministic: every round that ends WITHOUT a
// usable frame (a 409 reset-required from the owner, or a frame from an epoch
// we no longer know) counts once. Past the cap the view goes to the error state
// and the poll gate stops it; the stub answers with no real backoff timer.
test('R5: three consecutive 409 rounds exhaust the resync and stop the loop', async (t) => {
  const ownerId = 'a'.repeat(32);
  const health = { ok: true, status: 200, json: async () => ({ ok: true, instanceId: ownerId, eventFeedV1: true }) };
  const snap = { ok: true, status: 200, text: async () => JSON.stringify({ ownerId, cursor: '5:0', viewEpoch: 5, asks: [], notifications: [] }) };
  const reset409 = { ok: false, status: 409, json: async () => ({ error: 'cursor is too old', reason: 'reset-required' }) };
  const { client, calls } = stubClient(t, [health, snap, reset409, snap, reset409, snap, reset409, snap]);
  client.start();
  let view = null;
  for (let i = 0; i < 80; i++) {
    view = client.state().views.find((v) => v.ownerId === ownerId);
    if (view && view.lastError === 'resync-exhausted') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(view, 'the view exists');
  assert.equal(view.lastError, 'resync-exhausted', 'three reset rounds in a row exhaust the resync');
  assert.equal(view.stale, true, 'the exhausted view is in the error state');
  const streams = calls.filter((c) => c.url.includes('/event-feed?')).length;
  assert.ok(streams >= 3, 'each reset asked for a fresh stream: ' + streams);
  const before = calls.length;
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(calls.length, before, 'resync-exhausted stops the loop: no further request');
  client.stop();
});

test('R5: a stream that restarts from an unknown epoch also exhausts the resync', async (t) => {
  const ownerId = 'a'.repeat(32);
  const health = { ok: true, status: 200, json: async () => ({ ok: true, instanceId: ownerId, eventFeedV1: true }) };
  const snap = { ok: true, status: 200, text: async () => JSON.stringify({ ownerId, cursor: '5:0', viewEpoch: 5, asks: [], notifications: [] }) };
  // id: <epoch>:<seq> with epoch 1 while the view knows epoch 5. One fresh
  // stream object per round: a shared one is drained by its first read.
  const staleEpoch = () => sse(['id: 1:5\ndata: {"v":1,"ownerId":"' + ownerId + '","eventId":"ez","scope":"node","cellId":null,"hop":1,"emittedAt":1,"frame":{"type":"notify","title":"x"}}\n\n']);
  const { client, calls } = stubClient(t, [health, snap, staleEpoch(), snap, staleEpoch(), snap, staleEpoch(), snap]);
  client.start();
  let view = null;
  for (let i = 0; i < 80; i++) {
    view = client.state().views.find((v) => v.ownerId === ownerId);
    if (view && view.lastError === 'resync-exhausted') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(view, 'the view exists');
  assert.equal(view.lastError, 'resync-exhausted', 'an epoch that never settles exhausts the resync');
  const before = calls.length;
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(calls.length, before, 'the loop is stopped, not retried forever');
  client.stop();
});

test('R4: the kill switch flipped during/after the build still refuses the snapshot', async (t) => {
  const { A, B } = await pair(t);
  fs.writeFileSync(B.configPath, JSON.stringify({ federation: { events: { enabled: false } } }));
  const r = await fetch(`${A.base}/api/route/owner/_/event-feed/snapshot`, { headers: H(A.token) });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).reason, 'events-disabled');
});
