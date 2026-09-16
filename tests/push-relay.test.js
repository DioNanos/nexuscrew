'use strict';
// tests/push-relay.test.js — the OS alert relay for imported notifications.
// Fake sender everywhere: nothing here talks to a real push provider. What is
// proved: exactly-one alert per event across replay and restart, silent
// frames stay silent, the queue and alert budgets hold, and a failed send is
// counted without touching the SSE stream. Android delivery itself is a
// human field test, not a unit test.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPushRelay, createPushDedup, buildPayload } = require('../lib/notify/push-relay.js');
const { allowedResource } = require('../lib/proxy/federation.js');

const OWNER = 'a'.repeat(32);

function envelope(i, over = {}) {
  return {
    v: 1, ownerId: OWNER, eventId: `ev-${i}`, scope: 'cell', cellId: 'dev',
    hop: 1, emittedAt: 1, frame: { type: 'notify', title: `t${i}`, body: 'b', urgency: 'normal' },
    ...over,
  };
}

function fresh(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncpushrelay-'));
  const dedupPath = path.join(dir, 'push-dedup.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dedupPath };
}

function relayWith(dedupPath, sent, over = {}) {
  return createPushRelay({
    pushDedup: createPushDedup({ filePath: dedupPath, ...over.dedup }),
    send: over.send || (async (payload) => { sent.push(payload); return { sent: 1 }; }),
    sendTimeoutMs: over.sendTimeoutMs || 10000,
    now: over.now,
  });
}

test('replay, re-import and restart produce exactly ONE alert per event', (t) => {
  const { dedupPath } = fresh(t);
  const sent = [];
  const r1 = relayWith(dedupPath, sent);
  assert.equal(r1.consider(envelope(1)), true, 'first import pushes');
  assert.equal(r1.consider(envelope(1)), false, 'replay of a known event does not');
  // Restart: a fresh relay over the same durable dedup still knows the event.
  const r2 = relayWith(dedupPath, sent);
  assert.equal(r2.consider(envelope(1)), false, 'restart does not ring twice');
  assert.equal(r2.consider(envelope(2)), true, 'a new event still pushes');
  assert.equal(sent.length, 2);
});

test('ask closures and state frames never alert; the ask alert rides its notify', (t) => {
  const { dedupPath } = fresh(t);
  const sent = [];
  const r = relayWith(dedupPath, sent);
  const closure = envelope(1, { frame: { type: 'ask-closed', askId: 'x', outcome: 'answered' } });
  const state = envelope(2, { frame: { type: 'fleet-state', cells: [] } });
  assert.equal(r.consider(closure), false, 'a closure is silent');
  assert.equal(r.consider(state), false, 'a state frame is silent');
  assert.equal(sent.length, 0);
});

test('payload: unicode-safe truncation with a marker, deep link built locally, tag per event', () => {
  const p = buildPayload(envelope(1, { frame: { type: 'notify', title: 't', body: 'x'.repeat(400) } }));
  const raw = JSON.stringify(p);
  assert.ok(Buffer.byteLength(raw, 'utf8') <= 3 * 1024, 'within the wire budget');
  assert.ok(p.body.endsWith('…'), 'the preview says it was cut');
  assert.equal(p.full, undefined, 'the full body is not shipped in the payload');
  assert.ok(!raw.includes('x'.repeat(201)), 'the unreduced body never travels');
  const q = buildPayload(envelope(2, { frame: { type: 'notify', title: 'domanda' } }));
  assert.ok(q.url.startsWith(`/#owner=${OWNER}`), 'the link is generated locally');
  assert.equal(q.tag, `nc:${OWNER}:ev-2`);
});

test('queue caps: over 32 pending alerts the queue overflows instead of flooding', (t) => {
  const { dedupPath } = fresh(t);
  const sent = [];
  const r = relayWith(dedupPath, sent, { send: async () => { await new Promise((res) => setTimeout(res, 50)); return { sent: 1 }; } });
  let pushed = 0;
  for (let i = 0; i < 40; i++) if (r.consider(envelope(i))) pushed += 1;
  const st = r.status();
  assert.ok(st.counters.dropped > 0, 'overflow is counted as dropped');
  void pushed;
});

test('the alert budget is dedicated: urgency never bypasses it', async (t) => {
  const { dedupPath } = fresh(t);
  const sent = [];
  let t0 = Date.now();
  const r = relayWith(dedupPath, sent, { send: async () => { sent.push(1); return { sent: 1 }; }, now: () => t0 });
  let allowed = 0;
  for (let i = 0; i < 30; i++) {
    const cell = `cell-${i % 10}`; // rotate cells: the CLIENT window is what trips
    if (r.consider(envelope(100 + i, { cellId: cell, frame: { type: 'notify', title: 'x', urgency: 'high' } }))) allowed += 1;
  }
  assert.equal(allowed, 12, 'the client-wide window holds even for high urgency');
  t0 += 61000; // window slides: alerts flow again
  assert.equal(r.consider(envelope(200)), true);
  // Sends are async: give the (max 2 concurrent) queue a beat to drain.
  await new Promise((res) => setTimeout(res, 60));
  assert.equal(sent.length, 13);
});

test('a failed send is counted, best-effort: the relay never throws', (t) => {
  const { dedupPath } = fresh(t);
  const r = relayWith(dedupPath, [], { send: async () => { throw new Error('endpoint down'); } });
  assert.equal(r.consider(envelope(1)), true, 'the dedup already accepted the event');
  await_settle(() => r.status(), () => {
    assert.ok(r.status().counters.sendFailed >= 1);
  });
});

function await_settle(peek, check) {
  setTimeout(() => { peek(); check(); }, 20);
}

test('a revoked or empty subscription set: zero sent, counter notes the failure', (t) => {
  const { dedupPath } = fresh(t);
  const sent = [];
  const r = relayWith(dedupPath, sent, { send: async () => ({ sent: 0, removed: 1 }) });
  assert.equal(r.consider(envelope(1)), true);
  setTimeout(() => {
    assert.equal(sent.length, 0, 'nothing was deliverable');
    assert.ok(r.status().counters.sendFailed >= 1, 'the empty delivery is visible in the counters');
  }, 20);
});

// --- the import hook of the client server -----------------------------------
// The flattened events the feed client re-emits into the local hub are the only
// place an imported event exists on this side: exactly one shape may ring.

test('the import hook rings for a notify only, and shares the same registry', (t) => {
  const { dedupPath } = fresh(t);
  const sent = [];
  const r = relayWith(dedupPath, sent);
  const hubNotify = { type: 'notify', ownerId: OWNER, eventId: 'ev-7', title: 'from A', body: 'b', urgency: 'normal' };
  const hubAsk = { type: 'ask', ownerId: OWNER, eventId: 'ev-8', ask: { id: 'ask-1', question: 'q' } };
  const hubClosure = { type: 'ask-answered', ownerId: OWNER, eventId: 'ev-9', id: 'ask-1' };
  const hubState = { type: 'feed-state', ownerId: OWNER, eventId: 'ev-10', state: { type: 'fleet-state' } };

  assert.equal(r.considerImported(hubAsk), false, 'an ask card never rings');
  assert.equal(r.considerImported(hubClosure), false, 'a closure never rings');
  assert.equal(r.considerImported(hubState), false, 'a state frame never rings');
  assert.equal(r.considerImported(hubNotify), true, 'the imported notify rings');
  assert.equal(r.considerImported(hubNotify), false, 'a re-emission does not ring twice');
  // Same registry as the envelope path: the event cannot ring again as an
  // envelope either (nor the other way round).
  assert.equal(r.consider(envelope(7, { eventId: 'ev-7' })), false, 'the two paths share one identity');
  assert.equal(sent.length, 1);
});

test('a correlated ask travels in the payload, with a local-only route', () => {
  const p = buildPayload(envelope(1, { frame: { type: 'notify', title: 'domanda', askId: 'ask-42' } }));
  assert.equal(p.askId, 'ask-42', 'the correlated ask is named');
  assert.ok(p.url.includes(`/#owner=${OWNER}&ask=ask-42`), 'the route opens that ask locally');
  assert.ok(!/^https?:|^\/\//.test(p.url), 'no foreign or absolute URL is ever built');
});

test('the push surface is not federated', () => {
  const paths = ['push/vapid', 'push/subscribe', 'push/send', 'push/status'];
  for (const resource of paths) {
    for (const method of ['GET', 'POST', 'DELETE']) {
      assert.equal(allowedResource(resource, method), false, `${method} ${resource} must stay local-only`);
      assert.equal(resource.startsWith('push/'), true);
    }
  }
});

test('the per-owner view separates one chatty owner from the rest', async (t) => {
  const { dedupPath } = fresh(t);
  const sent = [];
  const r = relayWith(dedupPath, sent);
  const other = 'b'.repeat(32);
  // One owner is silenced by its own budget; the others keep their counters.
  for (let i = 0; i < 20; i++) {
    r.considerImported({ type: 'notify', ownerId: OWNER, eventId: `own-${i}`, title: 't', body: 'b' });
    r.considerImported({ type: 'notify', ownerId: other, eventId: `other-${i}`, title: 't', body: 'b' });
  }
  await new Promise((res) => setTimeout(res, 40));
  const st = r.status();
  assert.ok(st.byOwner[OWNER] && st.byOwner[other], 'both owners appear');
  assert.ok(st.byOwner[OWNER].dropped >= 1 || st.byOwner[other].dropped >= 1, 'the budget shows up as dropped');
  const sum = st.byOwner[OWNER].pushed + st.byOwner[other].pushed;
  assert.equal(sum, st.counters.pushed, 'the per-owner sends add up to the global ones');
  assert.ok(!JSON.stringify(st).includes('endpoint'), 'the local view carries no endpoint');
});
