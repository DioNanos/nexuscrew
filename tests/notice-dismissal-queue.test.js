'use strict';
// tests/notice-dismissal-queue.test.js — the durable queue of notice dismissals
// this node could not hand to the owner, and the drainer that retries them.
//
// The local intent is already honoured when a record lands here; the queue is
// about the OWNER's copy, so the other devices stop seeing the notice too. The
// retry policy is the interesting part: a transient failure stays pending with
// backoff, a decision (the owner refuses, or has no such surface) is declared
// blocked and NOT retried in a loop, and an expired notice (404 from the owner)
// counts as done.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createNoticeDismissalQueue, createNoticeDismissalDrainer,
} = require('../lib/notify/notice-dismissal-queue.js');

const OWNER = 'a'.repeat(32);
const OTHER = 'b'.repeat(32);
const E1 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const E2 = '11111111-2222-4333-8444-555555555555';
const T0 = 1_700_000_000_000;

function harness(t, { limits = {}, random = () => 0.5 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncqueue-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'notice-dismissal-queue.json');
  let clock = T0;
  const timers = [];
  const queue = createNoticeDismissalQueue({ filePath, now: () => clock, limits });
  const calls = [];
  const relay = {
    async relayNoticeDismiss(arg) { calls.push(arg); return this.next ? this.next(arg) : { ok: true, code: 200, ownerId: arg.ownerId }; },
  };
  const drainer = createNoticeDismissalDrainer({
    queue, relay, now: () => clock, random,
    setTimer: (fn) => { const handle = { fn, unref() {} }; timers.push(handle); return handle; },
    clearTimer: () => {},
    bindingForOwner: () => 'binding-1',
  });
  return {
    dir, filePath, queue, relay, drainer, calls, timers,
    rewind: (ms) => { clock += ms; },
    second: () => createNoticeDismissalQueue({ filePath, now: () => clock, limits }),
  };
}

test('a queued dismissal is retried until the owner confirms it, then it leaves', async (t) => {
  const h = harness(t);
  assert.deepStrictEqual(h.queue.enqueue({ ownerId: OWNER, eventId: E1 }).existed, false);
  assert.strictEqual(h.queue.get(OWNER, E1).syncState, 'pending');

  let flaky = 0;
  h.relay.next = () => { flaky += 1; return flaky < 3 ? { ok: false, code: 502, reason: 'owner-unreachable', transient: true } : { ok: true, code: 200 }; };
  // Three minutes per round: past the backoff (seconds) and inside the 15-minute
  // life of the record, so the retry policy is what is being measured here.
  for (let i = 0; i < 3; i += 1) { await h.drainer.drain(); h.rewind(3 * 60 * 1000); }
  assert.equal(h.calls.length, 3, 'three attempts');
  assert.equal(h.queue.get(OWNER, E1), null, 'the record leaves the queue once the owner confirms');
  assert.equal(h.queue.status().pending, 0);
});

test('a transient failure stays pending with a backoff, never blocked', async (t) => {
  const h = harness(t);
  h.queue.enqueue({ ownerId: OWNER, eventId: E1 });
  h.relay.next = () => ({ ok: false, code: 504, reason: 'relay-deadline', transient: true });
  await h.drainer.drain();
  const record = h.queue.get(OWNER, E1);
  assert.equal(record.syncState, 'pending');
  assert.equal(record.attempts, 1);
  assert.ok(record.nextRetryAt > T0, 'a retry is scheduled');
  // The backoff is honoured: an immediate drain does not call the owner again.
  await h.drainer.drain();
  assert.equal(h.calls.length, 1);
});

test('an owner without the surface is declared blocked and is not retried in a loop', async (t) => {
  const h = harness(t);
  h.queue.enqueue({ ownerId: OWNER, eventId: E1 });
  h.relay.next = () => ({ ok: false, code: 404, reason: 'unsupported' });
  await h.drainer.drain();
  const record = h.queue.get(OWNER, E1);
  assert.equal(record.syncState, 'blocked');
  assert.equal(record.lastReason, 'unsupported');
  for (let i = 0; i < 5; i += 1) { h.rewind(600000); await h.drainer.drain(); }
  assert.equal(h.calls.length, 1, 'a refused owner is not hammered');
});

test('a fresh pairing makes a blocked record admissible again', async (t) => {
  const h = harness(t);
  h.queue.enqueue({ ownerId: OWNER, eventId: E1 });
  h.relay.next = () => ({ ok: false, code: 404, reason: 'unsupported' });
  await h.drainer.drain();
  assert.equal(h.queue.get(OWNER, E1).syncState, 'blocked');

  // A re-pair changes the binding: the record goes back to pending and is tried.
  const drainer2 = createNoticeDismissalDrainer({
    queue: h.queue, relay: h.relay, now: () => T0, random: () => 0.5,
    setTimer: () => ({ unref() {} }), clearTimer: () => {},
    bindingForOwner: () => 'binding-2',
  });
  h.relay.next = () => ({ ok: true, code: 200 });
  h.rewind(600000);
  await drainer2.drain();
  assert.equal(h.queue.get(OWNER, E1), null, 'delivered after the re-pair');
  assert.equal(h.calls.length, 2);
});

test('the per-owner budget caps the attempts inside the window', async (t) => {
  const h = harness(t);
  for (const eventId of [E1, E2]) h.queue.enqueue({ ownerId: OWNER, eventId });
  h.queue.enqueue({ ownerId: OTHER, eventId: E1 });
  h.relay.next = () => ({ ok: false, code: 504, reason: 'relay-deadline', transient: true });
  await h.drainer.drain();
  const perOwner = h.calls.filter((c) => c.ownerId === OWNER).length;
  assert.equal(perOwner, 1, 'one attempt per owner inside the window');
  assert.equal(h.calls.length, 2, 'and one for the other owner');
});

test('READONLY stops the drainer before any attempt', async (t) => {
  const h = harness(t);
  h.queue.enqueue({ ownerId: OWNER, eventId: E1 });
  const drainer = createNoticeDismissalDrainer({
    queue: h.queue, relay: h.relay, now: () => T0, readonly: () => true,
    setTimer: () => ({ unref() {} }), clearTimer: () => {},
  });
  drainer.start();
  await drainer.drain();
  assert.equal(h.calls.length, 0);
  drainer.stop();
});

test('the queue is bounded, atomic and survives a reload', async (t) => {
  const h = harness(t, { limits: { maxEntries: 3 } });
  for (const eventId of [E1, E2, '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333']) {
    h.queue.enqueue({ ownerId: OWNER, eventId });
  }
  assert.equal(h.queue.status().count, 3, 'the cap holds');
  assert.equal(fs.statSync(h.filePath).mode & 0o777, 0o600);
  assert.deepStrictEqual(fs.readdirSync(h.dir).filter((n) => n.endsWith('.tmp')), []);
  const reloaded = h.second();
  assert.equal(reloaded.status().count, 3);
  assert.equal(reloaded.get(OWNER, E1), null, 'the oldest was pruned');
});

test('an entry whose notice has expired leaves the queue', async (t) => {
  const h = harness(t);
  h.queue.enqueue({ ownerId: OWNER, eventId: E1 });
  h.rewind(16 * 60 * 1000);
  assert.equal(h.queue.get(OWNER, E1), null);
  assert.equal(h.queue.status().count, 0);
});
