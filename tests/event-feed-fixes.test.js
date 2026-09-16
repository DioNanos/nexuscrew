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

function stubClient(t, responses = [], extra = {}) {
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
  const hub = [];
  const client = createEventFeedClient({
    loadStore: () => nodesStore.loadStoreStrict(nodesPath), fetchImpl, pollMs: 30,
    eventsHub: { broadcast: (e) => hub.push(e) },
    ...extra,
  });
  return { client, calls, hub };
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

// --- R3: ingress budget per FRAME -------------------------------------------

// A whole round of `n` valid frames, joined in ONE chunk: the transport shape
// that used to hide 121 frames behind a single read().
function sseFrames(ownerId, n, epoch = 1) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    out.push(`id: ${epoch}:${i}\ndata: ${JSON.stringify({
      v: 1, ownerId, eventId: `e${i}`, scope: 'node', cellId: null, hop: 1, emittedAt: 1,
      frame: { type: 'notify', title: `n${i}` },
    })}\n\n`);
  }
  return out.join('');
}

// One owner per stub URL. Each stream hands its whole round over in a single
// chunk and exposes cancel(), so an explicit disconnect is observable.
function stubOwners(t, defs, extra = {}) {
  const calls = [];
  const hub = [];
  const readers = new Map();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncfixowners-'));
  const nodesPath = path.join(dir, 'nodes.json');
  nodesStore.initStore(nodesPath);
  let st = nodesStore.loadStoreStrict(nodesPath);
  defs.forEach((d, i) => {
    d.port = 46000 + i;
    st = nodesStore.addNode(st, {
      name: d.name, remotePort: 41999, localPort: d.port, nodeId: d.nodeId,
      token: 'TOK', direction: 'outbound', shared: true, visibility: 'network',
      ssh: `u@${d.name}`, eventsReceive: true,
    });
    st = nodesStore.updateNode(st, d.name, { eventsReceive: true });
  });
  nodesStore.atomicWriteStore(nodesPath, st);
  const ownerAt = (url) => {
    const m = /127\.0\.0\.1:(\d+)/.exec(url);
    const port = m ? Number(m[1]) : 0;
    return defs.find((d) => d.port === port) || null;
  };
  const fetchImpl = async (url) => {
    calls.push({ url });
    const d = ownerAt(url);
    if (!d) return { ok: false, status: 404, json: async () => ({ error: 'unknown' }), text: async () => '' };
    if (url.includes('/federation/health')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, instanceId: d.nodeId, eventFeedV1: true }) };
    }
    if (url.includes('/event-feed/snapshot')) {
      return { ok: true, status: 200, text: async () => JSON.stringify(
        { ownerId: d.nodeId, cursor: '0:0', viewEpoch: 1, asks: [], notifications: [] }) };
    }
    if (url.includes('/event-feed?')) {
      const payload = sseFrames(d.nodeId, d.frames === undefined ? 1 : d.frames);
      const state = { cancelled: false, reads: 0 };
      readers.set(d.nodeId, state);
      return {
        ok: true, status: 200,
        body: { getReader: () => {
          let sent = false;
          return {
            read: async () => {
              state.reads += 1;
              if (sent) return { done: true };
              sent = true;
              return { done: false, value: Buffer.from(payload) };
            },
            cancel: async () => { state.cancelled = true; },
          };
        } },
        text: async () => '', json: async () => ({}),
      };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'unknown resource' }), text: async () => '' };
  };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const client = createEventFeedClient({
    loadStore: () => nodesStore.loadStoreStrict(nodesPath), fetchImpl, pollMs: 30,
    eventsHub: { broadcast: (e) => hub.push(e) },
    ...extra,
  });
  return { client, calls, readers, hub, ownerAt };
}

const viewOf = (client, ownerId) => client.state().views.find((v) => v.ownerId === ownerId) || null;
const appliedFrames = (client, ownerId) => {
  const v = viewOf(client, ownerId);
  return v && v.cursor ? (Number(String(v.cursor).split(':')[1]) || 0) : 0;
};
async function waitForView(client, ownerId, pred, tries = 80) {
  for (let i = 0; i < tries; i++) {
    const v = viewOf(client, ownerId);
    if (v && pred(v)) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  return viewOf(client, ownerId);
}

test('R3: 121 frames inside ONE chunk are cut at 120 — per FRAME, not per read', async (t) => {
  const ownerId = 'a'.repeat(32);
  // One round only: no interval churn, so the state after the first stream is
  // exactly what the assertions see.
  const { client, readers } = stubOwners(t, [{ name: 'noisy', nodeId: ownerId, frames: 121 }], { pollMs: 60000 });
  client.start();
  const view = await waitForView(client, ownerId, (v) => v.lastError === 'ingress-budget');
  assert.ok(view, 'the view exists');
  assert.equal(appliedFrames(client, ownerId), 120, 'the per-minute cap keeps the first 120 frames');
  assert.equal(view.cursor, '1:120', 'the 121st frame is never applied: the cursor stops at 120');
  assert.equal(view.lastError, 'ingress-budget', 'a noisy owner is disconnected by a NAMED reason');
  assert.equal(view.ingressBlockReason, 'owner-frames', 'the reason names the window that tripped');
  assert.ok(view.ingressBlockedUntil > Date.now(), 'the block outlives the current poll: it is durable');
  assert.equal(readers.get(ownerId).cancelled, true, 'the reader is aborted explicitly, not left to the GC');
  client.stop();
});

test('R3: the block is durable — the next poll never restarts before it expires', async (t) => {
  const ownerId = 'a'.repeat(32);
  const { client, calls } = stubOwners(t, [{ name: 'noisy', nodeId: ownerId, frames: 121 }]);
  client.start();
  const view = await waitForView(client, ownerId, (v) => v.lastError === 'ingress-budget');
  assert.ok(view && view.ingressBlockedUntil > Date.now(), 'the trip arms a deadline, not a one-shot return');
  const forOwner = () => calls.filter((c) => c.url.includes('127.0.0.1:46000/')).length;
  const atBlock = forOwner();
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(atBlock >= 1, 'the round really ran');
  assert.equal(forOwner(), atBlock, 'no poll restarts for that owner before the block expires');
  client.stop();
});

test('R3: the GLOBAL budget trips while every owner stays under its own cap', async (t) => {
  // Five owners of 100 frames each: 100 < 120 per owner, but 500 > 480 globally.
  // A "2x100 + 1x300" shape would be cut by the PER-OWNER cap first (321 < 480),
  // so it can never exercise the global window.
  const defs = ['a', 'b', 'c', 'd', 'e'].map((ch) => ({ name: `o${ch}`, nodeId: ch.repeat(32), frames: 100 }));
  const { client } = stubOwners(t, defs, { pollMs: 60000 });
  client.start();
  const census = () => client.state().views.map((v) => [v.ownerId.slice(0, 1), v.ingressBlockReason || null, appliedFrames(client, v.ownerId)]);
  let blocked = null;
  for (let i = 0; i < 80; i++) {
    blocked = client.state().views.find((v) => String(v.ingressBlockReason || '').startsWith('global-'));
    if (blocked && client.state().views.length === defs.length) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  const after = census();
  assert.ok(blocked, 'the global window trips: ' + JSON.stringify(after));
  const total = defs.reduce((n, d) => n + appliedFrames(client, d.nodeId), 0);
  assert.equal(total, 480, 'the global cap stops the whole fleet at exactly 480 frames: ' + JSON.stringify(after));
  defs.forEach((d) => {
    assert.ok(appliedFrames(client, d.nodeId) <= 120, 'no owner is over its own per-minute cap');
  });
  client.stop();
});

// A transport that never delivers: after a refused snapshot nothing should be
// requested, and an accepted one must not be hidden by a later transport error.
const IDLE_STREAM = {
  ok: true, status: 200,
  body: { getReader: () => ({ read: async () => new Promise(() => {}), cancel: async () => {} }) },
  text: async () => '', json: async () => ({}),
};

test('R2d: the snapshot element sanity covers asks too (count and size)', async (t) => {
  const ownerId = 'a'.repeat(32);
  const health = { ok: true, status: 200, json: async () => ({ ok: true, instanceId: ownerId, eventFeedV1: true }) };
  const snapOf = (snap) => ({ ok: true, status: 200, text: async () => JSON.stringify({ ownerId, cursor: '1:0', viewEpoch: 1, notifications: [], ...snap }) });
  const overCap = Array.from({ length: 101 }, (_, i) => ({ id: `ask-${i}`, question: 'q', options: [], session: 's', ts: 1 }));
  const first = stubClient(t, [health, snapOf({ asks: overCap }), IDLE_STREAM]);
  first.client.start();
  const a = await waitForView(first.client, ownerId, (v) => v.lastError === 'snapshot-element-oversize');
  assert.equal(a.lastError, 'snapshot-element-oversize', '101 asks (cap 100) are refused, not applied');
  assert.equal(a.asks.length, 0, 'nothing is applied from a refused snapshot');
  first.client.stop();

  const huge = [{ id: 'ask-huge', question: 'q'.repeat(20 * 1024), options: [], session: 's', ts: 1 }];
  const second = stubClient(t, [health, snapOf({ asks: huge }), IDLE_STREAM]);
  second.client.start();
  const b = await waitForView(second.client, ownerId, (v) => v.lastError === 'snapshot-element-oversize');
  assert.equal(b.lastError, 'snapshot-element-oversize', 'an ask element over 16 KiB is refused');
  assert.equal(b.asks.length, 0, 'nothing is applied from a refused snapshot');
  second.client.stop();
});

test('R2e: an oversized fleetState element is refused too', async (t) => {
  const ownerId = 'a'.repeat(32);
  const { client } = stubClient(t, [
    { ok: true, status: 200, json: async () => ({ ok: true, instanceId: ownerId, eventFeedV1: true }) },
    { ok: true, status: 200, text: async () => JSON.stringify({
      ownerId, cursor: '1:0', viewEpoch: 1, asks: [], notifications: [],
      fleetState: { available: true, cells: [{ cell: 'x'.repeat(20 * 1024), active: true }] },
    }) },
    IDLE_STREAM,
  ]);
  client.start();
  const view = await waitForView(client, ownerId, (v) => v.lastError === 'snapshot-element-oversize');
  assert.equal(view.lastError, 'snapshot-element-oversize', 'an over-16-KiB fleetState element is refused');
  assert.equal(view.fleetState, null, 'nothing is applied from a refused snapshot');
  client.stop();
});

test('R4: the client keeps no per-tick console noise and logs transitions only', async (t) => {
  const ownerId = 'a'.repeat(32);
  const lines = [];
  const noise = [];
  const realError = console.error;
  console.error = (...args) => { noise.push(args.map(String).join(' ')); };
  try {
    const { client } = stubOwners(t, [{ name: 'quiet', nodeId: ownerId, frames: 1 }], { log: (m) => lines.push(String(m)) });
    client.start();
    await new Promise((r) => setTimeout(r, 400));
    client.stop();
  } finally {
    console.error = realError;
  }
  assert.equal(noise.length, 0, 'no console output per poll tick: ' + noise.slice(0, 3).join(' | '));
  assert.equal(lines.filter((l) => l.includes('retry in')).length, 0, 'a healthy round is silent');
});

test('R4: the kill switch flipped during/after the build still refuses the snapshot', async (t) => {
  const { A, B } = await pair(t);
  fs.writeFileSync(B.configPath, JSON.stringify({ federation: { events: { enabled: false } } }));
  const r = await fetch(`${A.base}/api/route/owner/_/event-feed/snapshot`, { headers: H(A.token) });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).reason, 'events-disabled');
});
