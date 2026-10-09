'use strict';
// tests/event-feed-notice-closed.test.js — the receiver side of a cleared notice.
//
// The owner publishes `notify-closed` / `notify-closed-node` when it clears a
// notice. The receiver must (a) take the card out of the exported view, (b) tell
// the UI, and (c) remember the closure long enough that a snapshot taken just
// before the dismissal cannot hand the card back. A frame type this version does
// not know must be inert, never an exception.
const { test } = require('node:test');
const assert = require('node:assert');
const { ReadableStream } = require('node:stream/web');
const { createEventFeedClient } = require('../lib/notify/event-feed-client.js');

const OWNER = 'a'.repeat(32);
const PEER = 'b'.repeat(32);
const E1 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const E2 = '11111111-2222-4333-8444-555555555555';

const notice = (eventId, cellId = 'dev') => ({
  v: 1, ownerId: OWNER, eventId, scope: 'cell', cellId, hop: 1, emittedAt: 1_700_000_000_000,
  frame: { type: 'notify', title: 'cell event' },
});

function harness({ notifications = [] } = {}) {
  let controller = null;
  let seq = 0;
  let peerGen = 0;
  let snap = { ownerId: OWNER, cursor: '1:0', viewEpoch: 1, asks: [], notifications, fleetState: null };
  const broadcasts = [];
  const changes = [];
  const client = createEventFeedClient({
    // The peer record is re-generated on demand: changing its token is the
    // client's own trigger for a re-acquisition (drop the slot, lose the
    // cursor, take a fresh snapshot), which is exactly the race under test.
    loadStore: () => ({ nodeId: PEER, nodes: [{ nodeId: OWNER, direction: 'outbound', token: `fixture-${peerGen}`, localPort: 1, eventsReceive: true }] }),
    minSnapshotIntervalMs: 0,
    eventsHub: { broadcast: (frame) => broadcasts.push(frame) },
    onViewChanged: (id) => changes.push(id),
    fetchImpl: async (url, { signal } = {}) => {
      if (url.endsWith('/federation/health')) return { ok: true, json: async () => ({ instanceId: OWNER, eventFeedV1: true }) };
      if (url.endsWith('/event-feed/snapshot')) {
        return { ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(snap) };
      }
      assert.ok(url.includes('/event-feed?after='), `unexpected fetch: ${url}`);
      return {
        ok: true, status: 200,
        body: new ReadableStream({ start(c) { controller = c; signal.addEventListener('abort', () => { try { c.close(); } catch (_) {} }, { once: true }); } }),
      };
    },
  });
  async function waitFor(predicate, what) {
    const deadline = Date.now() + 3000;
    while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    assert.ok(predicate(), what || 'condition never became true');
  }
  return {
    client, broadcasts, changes, waitFor,
    setSnapshot: (next) => { snap = next; },
    // Fire-and-forget on purpose: a poll that re-acquires ends up holding the
    // live stream, so it never resolves while the harness stream stays open.
    reacquire: () => { peerGen += 1; client.poll().catch(() => {}); },
    start: async () => { client.start(); await waitFor(() => controller, 'the client must subscribe'); },
    view: () => client.state().views[0],
    // Same cursor shape the client derives from a real envelope: `<epoch>:<seq>`.
    emit: async (frame, { scope = 'cell', cellId = 'dev' } = {}) => {
      const id = `1:${++seq}`;
      controller.enqueue(Buffer.from(`id: ${id}\ndata: ${JSON.stringify({ ownerId: OWNER, eventId: id, hop: 1, scope, ...(cellId ? { cellId } : {}), frame })}\n\n`));
      await waitFor(() => client.state().views[0].cursor === id, `frame ${frame.type} must be consumed`);
    },
  };
}

test('a notify-closed frame drops the notice, tombstones it and tells the UI', async (t) => {
  const h = harness({ notifications: [notice(E1)] });
  t.after(() => h.client.stop());
  await h.start();
  await h.waitFor(() => (h.view().notifications || []).length === 1, 'the snapshot must land');

  await h.emit({ type: 'notify-closed', eventId: E1, ts: 1_700_000_000_100 });
  assert.equal(h.view().notifications.length, 0, 'the closed notice leaves the exported view');
  const told = h.broadcasts.filter((f) => f.type === 'notify-dismissed');
  assert.deepStrictEqual(told, [{ type: 'notify-dismissed', ownerId: OWNER, eventId: E1, originCell: 'dev' }]);
  assert.ok(h.changes.includes(OWNER), 'the UI is told the view changed');
});

test('a notify-closed-node frame clears a node-scoped notice too', async (t) => {
  const h = harness({ notifications: [{ ...notice(E2), scope: 'node', cellId: null }] });
  t.after(() => h.client.stop());
  await h.start();
  await h.waitFor(() => (h.view().notifications || []).length === 1);

  await h.emit({ type: 'notify-closed-node', eventId: E2, ts: 1_700_000_000_100 }, { scope: 'node', cellId: null });
  assert.equal(h.view().notifications.length, 0);
  assert.equal(h.broadcasts.filter((f) => f.type === 'notify-dismissed').length, 1);
});

test('a snapshot taken BEFORE the dismissal cannot bring the notice back', async (t) => {
  const h = harness({ notifications: [notice(E1)] });
  t.after(() => h.client.stop());
  await h.start();
  await h.waitFor(() => (h.view().notifications || []).length === 1);

  await h.emit({ type: 'notify-closed', eventId: E1, ts: 1_700_000_000_100 });
  // The owner answered a read that started before it processed the dismissal:
  // the same entry comes back in the snapshot.
  h.setSnapshot({ ownerId: OWNER, cursor: '1:9', viewEpoch: 1, asks: [], notifications: [notice(E1), notice(E2)], fleetState: null });
  // Re-acquisition: a fresh snapshot is taken and applied over the live view.
  h.reacquire();
  // The poll is asynchronous: wait for the new snapshot to be applied.
  await h.waitFor(() => (h.view().notifications || []).length === 1, 'the second snapshot must land');
  const left = (h.view().notifications || []).map((n) => n.eventId);
  assert.deepStrictEqual(left, [E2], 'the tombstone filters the closed entry and nothing else');
});

test('a closure of a DIFFERENT view generation does not suppress the new one', async (t) => {
  const h = harness({ notifications: [notice(E1)] });
  t.after(() => h.client.stop());
  await h.start();
  await h.waitFor(() => (h.view().notifications || []).length === 1);

  // The owner restarted: a new epoch, and the same id is a different notice.
  await h.emit({ type: 'notify-closed', eventId: E1, ts: 1_700_000_000_100 });
  h.setSnapshot({ ownerId: OWNER, cursor: '1:9', viewEpoch: 2, asks: [], notifications: [notice(E1)], fleetState: null });
  h.reacquire();
  await h.waitFor(() => (h.view().notifications || []).length === 1, 'the new-generation snapshot must land');
  assert.deepStrictEqual((h.view().notifications || []).map((n) => n.eventId), [E1],
    'an id reused after a reset is not suppressed forever');
});

test('a frame type this version does not know is inert, never an exception', async (t) => {
  const h = harness({ notifications: [notice(E1)] });
  t.after(() => h.client.stop());
  await h.start();
  await h.waitFor(() => (h.view().notifications || []).length === 1);

  await h.emit({ type: 'notice-something-new', eventId: E1, ts: 1 });
  assert.equal(h.view().notifications.length, 1, 'an unknown frame changes nothing');
  assert.equal(h.broadcasts.filter((f) => f.type === 'notify-dismissed').length, 0);
});

test('a closure without an event id is ignored, and the view is untouched', async (t) => {
  const h = harness({ notifications: [notice(E1)] });
  t.after(() => h.client.stop());
  await h.start();
  await h.waitFor(() => (h.view().notifications || []).length === 1);

  await h.emit({ type: 'notify-closed', ts: 1 });
  assert.equal(h.view().notifications.length, 1);
  assert.equal(h.broadcasts.filter((f) => f.type === 'notify-dismissed').length, 0);
});
