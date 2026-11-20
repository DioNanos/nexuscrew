'use strict';
// tests/event-feed-reset-reasons.test.js — every reset path of the event-feed
// client logs ONE bounded line carrying a reason from the closed RESET_REASONS
// set, and nothing outside that set can ever reach the line. Purely diagnostic:
// the counters, the resync flow and the cooldown ladder stay unchanged (their
// behaviour is pinned by tests/event-feed-resync-exit.test.js).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const nodesStore = require('../lib/nodes/store.js');
const { createEventFeedClient, resetReasons, mapResetReason } = require('../lib/notify/event-feed-client.js');

const RE_LINE = /^event-feed-client: [0-9a-f]{8}… resync reset \(([^)]+)\)$/;
const OWNER = 'a'.repeat(32);

// Same stub hygiene as tests/event-feed-resync-exit.test.js, plus a collecting
// log so the diagnostics lines can be asserted.
function stubClient(t, responses = [], extra = {}) {
  const lines = [];
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, opts });
    const next = responses.shift();
    if (!next) return { ok: false, status: 500, json: async () => ({ error: 'no stub' }), text: async () => '' };
    if (next.error) throw next.error;
    return typeof next === 'function' ? next(opts) : next;
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncrestlog-'));
  const nodesPath = path.join(dir, 'nodes.json');
  nodesStore.initStore(nodesPath);
  let st = nodesStore.addNode(nodesStore.loadStoreStrict(nodesPath), {
    name: 'owner', remotePort: 41999, localPort: 44777, nodeId: OWNER,
    token: 'TOK', direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@owner',
    eventsReceive: true,
  });
  st = nodesStore.updateNode(st, 'owner', { eventsReceive: true });
  nodesStore.atomicWriteStore(nodesPath, st);
  const ref = { value: null };
  t.after(async () => {
    try { if (ref.value) ref.value.stop(); } catch (_) { /* an already stopped client must not break teardown */ }
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setImmediate(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const client = createEventFeedClient({
    loadStore: () => nodesStore.loadStoreStrict(nodesPath), fetchImpl, pollMs: 5, minSnapshotIntervalMs: 0,
    eventsHub: { broadcast: () => {} },
    log: (s) => lines.push(String(s)),
    ...extra,
  });
  ref.value = client;
  return { client, calls, lines };
}

const sse = (chunks) => ({ ok: true, status: 200,
  body: { getReader: () => ({
    read: async () => chunks.length ? { done: false, value: Buffer.from(chunks.shift()) } : { done: true },
  }) },
  text: async () => chunks.join(''), json: async () => JSON.parse(chunks.join('')) });

// A stream that stays open until the client aborts it, so stop() can unwind.
const hang = (opts = {}) => ({ ok: true, status: 200, body: { getReader: () => {
  let kill = () => {};
  const pending = new Promise((_resolve, reject) => { kill = reject; });
  try { opts.signal.addEventListener('abort', () => kill(new Error('client stopped')), { once: true }); } catch (_) {}
  return { read: () => pending };
} } });

const health = { ok: true, status: 200, json: async () => ({ ok: true, instanceId: OWNER, eventFeedV1: true }) };
const snapClean = () => ({ ok: true, status: 200, text: async () => JSON.stringify({
  ownerId: OWNER, cursor: '5:0', viewEpoch: 5, asks: [], notifications: [],
}) });
const reset409 = { ok: false, status: 409, json: async () => ({ error: 'cursor is too old', reason: 'reset-required' }) };
const frame = (epoch, seq, obj) => `id: ${epoch}:${seq}\ndata: ${JSON.stringify(obj)}\n\n`;
const eventOf = (ownerId = OWNER) => ({ ownerId, eventId: 'e1', type: 'notify' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReason(lines, reason, timeoutMs = 5000) {
  for (let i = 0; i < timeoutMs / 10; i++) {
    if (lines.some((l) => { const m = RE_LINE.exec(l); return m && m[1] === reason; })) return true;
    await sleep(10);
  }
  return false;
}

// One scenario per reason: health -> clean snapshot -> the offending stream
// response -> recovery room (clean snapshots + hanging streams).
function scenario(offending) {
  return [health, snapClean(), offending, ...Array.from({ length: 4 }, () => snapClean()), hang];
}

test('every reset path logs one line with its reason from the closed set', async (t) => {
  const cases = [
    ['http-409', scenario(reset409)],
    ['frame-oversized', scenario(sse(['id: 5:1\ndata: ' + 'x'.repeat(17 * 1024) + '\n\n']))],
    ['parse', scenario(sse(['id: 5:1\ndata: {not json\n\n']))],
    ['owner-mismatch', scenario(sse([frame(5, 1, eventOf('b'.repeat(32)))]))],
    ['epoch', scenario(sse([frame(9, 1, eventOf(OWNER))]))],
    ['seq-gap', scenario(sse([frame(5, 1, eventOf(OWNER)), frame(5, 3, eventOf(OWNER))]))],
  ];
  for (const [reason, responses] of cases) {
    const { client, lines } = stubClient(t, responses);
    client.start();
    const found = await waitReason(lines, reason);
    assert.ok(found, `reason ${reason} is logged exactly once: ` + JSON.stringify(lines));
    const resets = lines.filter((l) => RE_LINE.test(l));
    // Only lines from the closed set, and no stray content on them.
    for (const l of resets) {
      const m = RE_LINE.exec(l);
      assert.ok(resetReasons.includes(m[1]), `logged reason "${m[1]}" belongs to the closed set`);
    }
    // A healthy frame never logs (the seq-gap scenario delivers one sane frame first).
    assert.equal(resets.length, 1, `one reset line for ${reason}, healthy frames stay silent`);
    client.stop();
  }
});

test('mapResetReason is the identity on the closed set and collapses everything else to other', () => {
  assert.ok(Object.isFrozen(resetReasons), 'the reason set is frozen');
  for (const r of resetReasons) assert.equal(mapResetReason(r), r, `identity for ${r}`);
  const hostile = ['DROP TABLE users', '../../etc/passwd', '', 'x'.repeat(200), 'parse\x00inject', 'constructor', 'toString', 'resync reset (injected'];
  for (const h of hostile) assert.equal(mapResetReason(h), 'other', `hostile value collapses: ${JSON.stringify(h.slice(0, 20))}`);
});
