'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEventFeedClient } = require('../lib/notify/event-feed-client.js');
const OWNER = 'b'.repeat(32);
const OTHER = 'c'.repeat(32);
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const health = (owner = OWNER) => ({ ok: true, json: async () => ({ instanceId: owner, eventFeedV1: true }) });
const snapshot = (owner = OWNER) => ({ ok: true, text: async () => JSON.stringify({
  ownerId: owner, cursor: '5:0', viewEpoch: 5, asks: [], notifications: [], askReplyAccess: true,
}) });
function blocked(signal) {
  return new Promise((_resolve, reject) => {
    if (!signal) return;
    if (signal.aborted) reject(new Error('aborted'));
    else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}
function setup(t, fetchImpl, extra = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100000 });
  t.mock.method(Math, 'random', () => 0);
  const peers = [{ nodeId: OWNER, direction: 'outbound', eventsReceive: true,
    localPort: 41001, token: 'fixture-token' }];
  const calls = [];
  const client = createEventFeedClient({ loadStore: () => ({ nodeId: 'a'.repeat(32), nodes: peers.map((p) => ({ ...p })) }),
    minSnapshotIntervalMs: 0, pollMs: 100,
    fetchImpl: (url, opts) => { calls.push({ url, opts, at: Date.now() }); return fetchImpl(url, opts); },
    eventsHub: { broadcast() {} },
    ...extra,
  });
  t.after(() => client.stop());
  return { client, peers, calls };
}

for (const phase of ['health headers', 'health body', 'snapshot headers', 'snapshot body']) {
  test(`${phase} has an abort deadline including the response body and releases its slot`, async (t) => {
    let first = true;
    let pendingSignal;
    const { client, calls } = setup(t, async (url, opts) => {
      const isHealth = url.endsWith('/health');
      const target = phase.startsWith('health') === isHealth;
      if (first && target) {
        first = false; pendingSignal = opts.signal;
        if (phase.endsWith('headers')) return blocked(opts.signal);
        return { ok: true, json: () => blocked(opts.signal), text: () => blocked(opts.signal) };
      }
      if (isHealth) return health();
      if (url.includes('/snapshot')) return snapshot();
      return { ok: true, body: { getReader: () => ({ read: () => blocked(opts.signal) }) } };
    });
    void client.poll(); await flush();
    t.mock.timers.tick((phase.startsWith('health') ? 5000 : 8000) - 1); await flush();
    assert.ok(!pendingSignal?.aborted, 'the deadline does not fire early');
    t.mock.timers.tick(1); await flush();
    assert.ok(pendingSignal?.aborted, 'the pending fetch or body is actually cancelled');
    const count = calls.length;
    t.mock.timers.tick(2500); await flush();
    assert.ok(calls.length > count, 'a timed-out acquisition frees the owner for retry');
  });
}

test('fresh store objects retain owner backoff and polling cannot anticipate the retry timer', async (t) => {
  const { client, calls } = setup(t, async () => { throw new Error('network unavailable'); });
  await client.poll();
  for (let i = 0; i < 5; i++) await client.poll();
  assert.equal(calls.length, 1, 'ordinary polls respect the first retry deadline');
  t.mock.timers.tick(2499); await flush(); await client.poll();
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1); await flush();
  assert.equal(calls.length, 2, 'one timer opens exactly one retry');
  t.mock.timers.tick(4999); await flush(); await client.poll();
  assert.equal(calls.length, 2, 'the second failure doubles backoff despite fresh peer objects');
  t.mock.timers.tick(1); await flush();
  assert.equal(calls.length, 3);
  client.stop();
  t.mock.timers.tick(60000); await flush();
  assert.equal(calls.length, 3, 'stop cancels every retry timer');
});

test('repeated EOF respects snapshot and retry windows, tombstone epochs and the global ingress cap', async (t) => {
  const snapshots = new Map();
  const streams = new Map();
  const emitted = [];
  let epoch = 5;
  let sendFrames = false;
  const ownerAt = (url) => {
    const port = Number(new URL(url).port);
    return String.fromCharCode('b'.charCodeAt(0) + port - 41001).repeat(32);
  };
  const { client, peers } = setup(t, async (url) => {
    const owner = ownerAt(url);
    if (url.endsWith('/health')) return health(owner);
    if (url.includes('/snapshot')) {
      snapshots.set(owner, (snapshots.get(owner) || 0) + 1);
      return { ok: true, text: async () => JSON.stringify({ ownerId: owner,
        cursor: `${epoch}:0`, viewEpoch: epoch, asks: [{ id: 'same-ask', question: 'Proceed?' }], notifications: [] }) };
    }
    const round = (streams.get(owner) || 0) + 1;
    streams.set(owner, round);
    let sent = false;
    return { ok: true, body: { getReader: () => ({ read: async () => {
      if (!sendFrames || sent) return { done: true };
      sent = true;
      return { done: false, value: Buffer.from(Array.from({ length: 100 }, (_unused, index) => {
        const envelope = { v: 1, ownerId: owner, eventId: `round-${round}-${index}`, scope: 'node',
          cellId: null, hop: 1, emittedAt: 1, frame: { type: 'notify', title: 'Demo' } };
        return `id: ${epoch}:${index + 1}\ndata: ${JSON.stringify(envelope)}\n\n`;
      }).join('')) };
    }, cancel: async () => {} }) } };
  }, { minSnapshotIntervalMs: 30000, eventsHub: { broadcast: (event) => emitted.push(event) } });
  await client.poll();
  assert.equal(client.state().views[0].cursor, null, 'EOF invalidates the cursor');
  client.dismissConfirmed(OWNER, 'same-ask');
  t.mock.timers.tick(2499); await flush(); await client.poll();
  assert.equal(snapshots.get(OWNER), 1, 'no snapshot before the retry deadline');
  t.mock.timers.tick(1); await flush(); await client.poll();
  assert.equal(snapshots.get(OWNER), 1, 'retry expiry cannot bypass the minimum snapshot window');
  t.mock.timers.tick(27499); await flush(); await client.poll();
  assert.equal(snapshots.get(OWNER), 1, 'no snapshot before the full 30 second window');
  t.mock.timers.tick(1); await flush(); void client.poll(); await flush();
  assert.equal(snapshots.get(OWNER), 2);
  assert.equal(client.state().views[0].asks.length, 0, 'a resnapshot cannot revive a dismissed ask');
  epoch = 6;
  t.mock.timers.tick(30000); await flush(); void client.poll(); await flush();
  assert.equal(snapshots.get(OWNER), 3);
  assert.equal(client.state().views[0].asks[0].id, 'same-ask', 'a new epoch does not inherit an old tombstone');
  sendFrames = true;
  for (let i = 1; i < 5; i++) peers.push({ ...peers[0],
    nodeId: String.fromCharCode('b'.charCodeAt(0) + i).repeat(32), localPort: 41001 + i });
  t.mock.timers.tick(30000); await flush(); void client.poll(); await flush();
  assert.equal(emitted.length, 480, 'EOF recovery cannot bypass the global frame cap');
  assert.ok(client.state().views.some((view) => view.ingressBlockReason === 'global-frames'));
  assert.equal(snapshots.get(OWNER), 4, 'one snapshot per permitted recovery, no storm');
});

test('disabling or changing a peer cancels acquisition and obsolete results cannot heal the new generation', async (t) => {
  let resolveOld;
  let oldSignal;
  const { client, peers, calls } = setup(t, async (url, opts) => {
    if (url.endsWith('/health') && !resolveOld) {
      oldSignal = opts.signal;
      return new Promise((resolve) => { resolveOld = resolve; });
    }
    if (url.endsWith('/health')) return health();
    if (url.includes('/snapshot')) return snapshot();
    return { ok: true, body: { getReader: () => ({ read: () => blocked(opts.signal) }) } };
  });
  void client.poll(); await flush();
  peers[0].eventsReceive = false;
  await client.poll();
  assert.ok(oldSignal?.aborted, 'off cancels acquisition before any stream exists');
  peers[0].eventsReceive = true; peers[0].localPort = 41002;
  void client.poll(); await flush();
  assert.ok(calls.some((c) => c.url.includes(':41002/') && c.url.includes('/snapshot')));
  const count = calls.length;
  resolveOld(health()); await flush();
  assert.equal(calls.length, count, 'the obsolete health result cannot start an old-port snapshot');
  void client.poll(); await flush();
  assert.equal(calls.length, count, 'the old finally cannot release the new running slot');
});

test('one hung owner does not block another and stop cancels acquisitions', async (t) => {
  let signal;
  const { client, peers } = setup(t, async (url, opts) => {
    if (url.includes(':41001/')) { signal = opts.signal; return blocked(opts.signal); }
    if (url.endsWith('/health')) return health(OTHER);
    if (url.includes('/snapshot')) return snapshot(OTHER);
    return { ok: true, body: { getReader: () => ({ read: () => blocked(opts.signal) }) } };
  });
  peers.push({ ...peers[0], nodeId: OTHER, localPort: 41002 });
  void client.poll(); await flush();
  assert.equal(client.state().views.find((v) => v.ownerId === OTHER).stale, false);
  client.stop(); await flush();
  assert.ok(signal?.aborted, 'stop cancels the pending owner health request');
});

test('idle interruption requires a new validated snapshot and preserves useful asks while backing off', async (t) => {
  let snapshots = 0;
  const { client } = setup(t, async (url, opts) => {
    if (url.endsWith('/health')) return health();
    if (url.includes('/snapshot')) {
      snapshots += 1;
      return { ok: true, text: async () => JSON.stringify({ ownerId: OWNER, cursor: '5:0', viewEpoch: 5,
        asks: [{ id: 'useful-ask', question: 'Proceed?' }], notifications: [], askReplyAccess: snapshots === 1 }) };
    }
    return { ok: true, body: { getReader: () => ({ read: () => blocked(opts.signal) }) } };
  });
  void client.poll(); await flush();
  t.mock.timers.tick(60000); await flush();
  assert.equal(client.state().views[0].cursor, null);
  assert.equal(client.state().views[0].stale, true);
  assert.equal(client.state().views[0].asks[0].id, 'useful-ask');
  t.mock.timers.tick(2500); await flush();
  assert.equal(snapshots, 2);
  assert.equal(client.state().views[0].stale, false);
  assert.equal(client.state().views[0].lastError, null);
  assert.equal(client.state().views[0].askReplyAccess, false);
});

test('unsupported is distinct from transport failure and configuration changes allow one new capability check', async (t) => {
  let supported = false;
  const { client, peers, calls } = setup(t, async (url, opts) => {
    if (url.endsWith('/health')) return { ok: true, json: async () => ({ instanceId: OWNER, eventFeedV1: supported }) };
    if (url.includes('/snapshot')) return snapshot();
    return { ok: true, body: { getReader: () => ({ read: () => blocked(opts.signal) }) } };
  });
  await client.poll();
  assert.equal(client.state().views[0].lastError, 'event-feed-unsupported');
  for (let i = 0; i < 5; i++) await client.poll();
  assert.equal(calls.length, 1, 'unsupported does not poll or invent a grant');
  assert.equal(client.state().views[0].askReplyAccess, false);
  supported = true; peers[0].token = 'replacement-fixture-token';
  void client.poll(); await flush();
  assert.equal(calls.filter((call) => call.url.endsWith('/health')).length, 2);
  assert.equal(client.state().views[0].stale, false);
  assert.equal(client.state().views[0].askReplyAccess, true);
});

test('an owner upgrade is rechecked at a bounded interval without inventing a capability', async (t) => {
  let supported = false;
  const { client, calls } = setup(t, async (url, opts) => {
    if (url.endsWith('/health')) return { ok: true, json: async () => ({ instanceId: OWNER, eventFeedV1: supported }) };
    if (url.includes('/snapshot')) return snapshot();
    return { ok: true, body: { getReader: () => ({ read: () => blocked(opts.signal) }) } };
  });
  await client.poll();
  supported = true;
  t.mock.timers.tick(59999); await flush(); await client.poll();
  assert.equal(calls.length, 1, 'an unsupported owner does not cause a probe storm');
  t.mock.timers.tick(1); void client.poll(); await flush();
  assert.equal(calls.filter((call) => call.url.endsWith('/health')).length, 2);
  assert.equal(client.state().views[0].askReplyAccess, true);
});

for (const change of ['token revocation', 'port change']) {
  test(`${change} aborts acquisition before the stream exists`, async (t) => {
    let pendingSignal;
    const { client, peers } = setup(t, async (url, opts) => {
      if (url.includes(':41001/')) { pendingSignal = opts.signal; return blocked(opts.signal); }
      if (url.endsWith('/health')) return health();
      if (url.includes('/snapshot')) return snapshot();
      return { ok: true, body: { getReader: () => ({ read: () => blocked(opts.signal) }) } };
    });
    void client.poll(); await flush();
    if (change === 'token revocation') peers[0].token = null;
    else peers[0].localPort = 41002;
    void client.poll(); await flush();
    assert.ok(pendingSignal?.aborted);
    if (change === 'port change') assert.equal(client.state().views[0].stale, false);
  });
}
