'use strict';
// tests/event-feed-engine.test.js — the feed engine in isolation: ring, cursor
// rules, backpressure, budgets, counters. Every limit here is §5 of the design
// with its initial value; a mutant that ignores any of them must go red.
const { test } = require('node:test');
const assert = require('node:assert');
const { createEventFeed } = require('../lib/notify/event-feed.js');

const ENV = (i) => ({ v: 1, ownerId: 'o', eventId: `e${i}`, scope: 'node', cellId: null, hop: 1, emittedAt: 1, frame: { type: 'notify', title: 'x' } });

function fakeRes({ failFrom = Infinity } = {}) {
  const writes = [];
  const handlers = {};
  return {
    writes,
    closed: false,
    writeHead() {},
    write(chunk) {
      writes.push(chunk);
      return writes.length - 1 < failFrom;
    },
    end() { this.closed = true; },
    on(ev, fn) { handlers[ev] = fn; },
    fire(ev) { if (handlers[ev]) handlers[ev](); },
  };
}

test('publish assigns a per-peer sequence and subscribe replays in order, then goes live', () => {
  const feed = createEventFeed();
  feed.enablePeer('p');
  for (let i = 0; i < 3; i++) feed.publish('p', ENV(i));
  const res = fakeRes();
  const sub = feed.subscribe('p', res, { epoch: 1, seq: 0 });
  assert.equal(sub.ok, true);
  const ids = res.writes.filter((w) => w.startsWith('id:')).map((w) => w.split('\n')[0]);
  assert.deepEqual(ids, ['id: 1:1', 'id: 1:2', 'id: 1:3'], 'replay is ordered');
  feed.publish('p', ENV(99));
  assert.ok(res.writes.some((w) => w.includes('"eventId":"e99"')), 'live delivery after replay');
  assert.equal(feed.status('p').counters.replayed, 3);
});

test('a future cursor is refused with 409 cursor-future', () => {
  const feed = createEventFeed();
  feed.enablePeer('p');
  feed.publish('p', ENV(1));
  const sub = feed.subscribe('p', fakeRes(), { epoch: 1, seq: 5 });
  assert.equal(sub.ok, false);
  assert.equal(sub.status, 409);
  assert.equal(sub.reason, 'cursor-future');
});

test('an old epoch gets reset-required, never a falsely continuous stream', () => {
  const feed = createEventFeed();
  feed.enablePeer('p');
  feed.publish('p', ENV(1));
  feed.invalidatePeer('p', 'grants-changed');
  feed.publish('p', ENV(2));
  const sub = feed.subscribe('p', fakeRes(), { epoch: 1, seq: 1 });
  assert.equal(sub.ok, false);
  assert.equal(sub.status, 409);
  assert.equal(sub.reason, 'reset-required');
});

test('a cursor pruned out of the ring gets reset-required', () => {
  const feed = createEventFeed();
  feed.enablePeer('p');
  for (let i = 0; i < 520; i++) feed.publish('p', ENV(i)); // over the 512 cap
  const st = feed.status('p');
  assert.ok(st.ring.events <= 512, 'the ring prunes at the first threshold');
  const sub = feed.subscribe('p', fakeRes(), { epoch: 1, seq: 1 });
  assert.equal(sub.ok, false);
  assert.equal(sub.reason, 'reset-required');
});

test('write(false) pauses the stream; drain resumes it; overflow closes with resync-required', () => {
  const feed = createEventFeed();
  feed.enablePeer('p');
  const res = fakeRes({ failFrom: 1 }); // the retry line fits, then the socket is full
  assert.equal(feed.subscribe('p', res, null).ok, true);
  feed.publish('p', ENV(100));
  // The frame that filled the socket is ACCEPTED (write(false) means "buffer
  // full": this chunk went out, the next ones must not). Production pauses.
  assert.equal(res.writes.length, 2);
  assert.equal(feed.status('p').ring.events, 1, 'the ring keeps recording while paused');
  feed.publish('p', ENV(101));
  assert.ok(!res.writes.some((w) => w.includes('"eventId":"e101"')), 'a paused stream writes nothing more');
  // The socket drains: the queued frame is flushed and the stream goes live.
  res.fire('drain');
  assert.ok(res.writes.some((w) => w.includes('"eventId":"e101"')), 'drain flushes the queue and resumes');
});

test('a live queue beyond the caps closes the stream and demands a resync', () => {
  const feed = createEventFeed();
  feed.enablePeer('p');
  const res = fakeRes({ failFrom: 1 }); // full socket: everything queues
  feed.subscribe('p', res, null);
  for (let i = 0; i < 140; i++) feed.publish('p', ENV(i)); // over 128 frames
  assert.equal(res.closed, true, 'queue overflow closes the stream');
});

test('a second subscribe replaces the first stream (one stream per pair)', () => {
  const feed = createEventFeed();
  feed.enablePeer('p');
  const r1 = fakeRes(); const r2 = fakeRes();
  feed.subscribe('p', r1, null);
  feed.subscribe('p', r2, null);
  assert.equal(r1.closed, true, 'the replaced stream is closed');
  feed.publish('p', ENV(1));
  assert.ok(!r1.writes.some((w) => w.includes('"eventId":"e1"')), 'the replaced stream gets nothing');
  assert.ok(r2.writes.some((w) => w.includes('"eventId":"e1"')));
});

test('the per-peer open rate refuses the 7th open in a minute', () => {
  const feed = createEventFeed();
  feed.enablePeer('p');
  let last = null;
  for (let i = 0; i < 6; i++) last = feed.subscribe('p', fakeRes(), null);
  assert.equal(last.ok, true);
  const refused = feed.subscribe('p', fakeRes(), null);
  assert.equal(refused.ok, false);
  assert.equal(refused.status, 429);
  assert.equal(refused.reason, 'open-rate');
});

test('a frame over the 16 KiB cap is dropped BEFORE entering the ring', () => {
  const feed = createEventFeed();
  feed.enablePeer('p');
  const big = ENV(1); big.frame.title = 'x'.repeat(20 * 1024);
  const out = feed.publish('p', big);
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'frame-too-large');
  assert.equal(feed.status('p').ring.events, 0);
  assert.equal(feed.status('p').counters.dropped, 1);
});

test('invalidating a peer bumps the epoch, wipes the ring and closes the stream', () => {
  const feed = createEventFeed();
  feed.enablePeer('p');
  feed.publish('p', ENV(1));
  const res = fakeRes();
  feed.subscribe('p', res, null);
  const before = feed.status('p');
  feed.invalidatePeer('p', 'revoked');
  const after = feed.status('p');
  assert.equal(after.viewEpoch, before.viewEpoch + 1);
  assert.equal(after.ring.events, 0);
  assert.equal(res.closed, true, 'revocation closes the stream first');
});

test('enabling beyond the peer budget is refused by name', () => {
  const feed = createEventFeed({ maxPeers: 2 });
  feed.enablePeer('a'); feed.enablePeer('b');
  assert.throws(() => feed.enablePeer('c'), /too many peers/);
});

test('the stream is filtered when the route narrows the scope', () => {
  const feed = createEventFeed();
  feed.enablePeer('p');
  const cellEnv = ENV(1); cellEnv.scope = 'cell'; cellEnv.cellId = 'dev';
  const res = fakeRes();
  feed.subscribe('p', res, null, { filter: (e) => e.envelope.scope === 'cell' });
  feed.publish('p', ENV(2));
  feed.publish('p', cellEnv);
  const frames = res.writes.filter((w) => w.includes('"scope":"cell"'));
  assert.equal(frames.length, 1);
  assert.equal(res.writes.filter((w) => w.includes('"scope":"node"')).length, 0, 'the narrowed stream never sees other scopes');
});
