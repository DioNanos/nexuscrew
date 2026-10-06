'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProbe, ownerId, ask } = require('./helpers/owner-view-probe.cjs');

// Every authenticated owner closure — fan-out frame or feed envelope — must
// land on the SAME exported view the live ask entered, whether or not the
// store alias changed. The key is canonical (ownerId/ownerAskId), the
// generation decides: an old closure cannot close a newer generation, and the
// closed generation cannot come back by replay for EITHER outcome.
const liveFrame = (ts) => ({ type: 'ask', askId: ask.id, question: ask.question, options: [], session: ask.session, ts, askTs: ts });

for (const outcome of ['answered', 'dismissed']) {
  test(`a fan-out closure removes the ASK from the exported owner view: ${outcome}`, () => {
    const p = createProbe();
    try {
      assert.ok(p.client.rememberLiveAsk(ownerId, { ...ask }));
      assert.equal(p.client.state().views[0].asks.length, 1);
      p.client.applyOwnerClosure(ownerId, ask.id, { ownerAskTs: ask.ownerAskTs, outcome });
      assert.equal(p.client.state().views[0].asks.length, 0, 'a closed ASK must leave the exported owner view');
    } finally { p.client.stop(); }
  });

  test(`a replayed closed generation cannot return to the exported view: ${outcome} via feed`, async () => {
    const p = createProbe();
    try {
      await p.start();
      await p.emit(liveFrame(100));
      await p.emit({ type: 'ask-closed', askId: ask.id, outcome, askTs: 100 });
      await p.emit(liveFrame(100));
      assert.equal(p.client.state().views[0].asks.length, 0, `a replayed ${outcome} generation must not come back`);
    } finally { p.client.stop(); }
  });

  test(`a replayed closed generation cannot return to the exported view: ${outcome} via fan-out`, () => {
    const p = createProbe();
    try {
      p.client.rememberLiveAsk(ownerId, { ...ask });
      p.client.applyOwnerClosure(ownerId, ask.id, { ownerAskTs: 100, outcome });
      assert.equal(p.client.rememberLiveAsk(ownerId, { ...ask }), null, `a replayed ${outcome} generation must not be re-admitted`);
      assert.equal(p.client.state().views[0].asks.length, 0);
    } finally { p.client.stop(); }
  });
}

test('a closure without a live alias still blocks that generation', () => {
  const p = createProbe();
  try {
    p.client.applyOwnerClosure(ownerId, ask.id, { ownerAskTs: 100, outcome: 'answered' });
    assert.equal(p.client.rememberLiveAsk(ownerId, { ...ask }), null, 'the closed generation must stay out even with no alias');
  } finally { p.client.stop(); }
});

test('a duplicate closure is idempotent on the view', () => {
  const p = createProbe();
  try {
    p.client.rememberLiveAsk(ownerId, { ...ask });
    p.client.applyOwnerClosure(ownerId, ask.id, { ownerAskTs: 100, outcome: 'answered' });
    p.client.applyOwnerClosure(ownerId, ask.id, { ownerAskTs: 100, outcome: 'answered' });
    assert.equal(p.client.state().views[0].asks.length, 0);
  } finally { p.client.stop(); }
});

test('a closure of an older generation must not close a newer one', () => {
  const p = createProbe();
  try {
    p.client.rememberLiveAsk(ownerId, { ...ask, ownerAskTs: 200, ts: 200 });
    p.client.applyOwnerClosure(ownerId, ask.id, { ownerAskTs: 100, outcome: 'answered' });
    assert.equal(p.client.state().views[0].asks.length, 1, 'the newer generation stays');
    assert.equal(p.client.state().views[0].asks[0].ownerAskTs, 200);
  } finally { p.client.stop(); }
});

test('a genuinely new generation is admitted after a closure', () => {
  const p = createProbe();
  try {
    p.client.rememberLiveAsk(ownerId, { ...ask });
    p.client.applyOwnerClosure(ownerId, ask.id, { ownerAskTs: 100, outcome: 'answered' });
    assert.ok(p.client.rememberLiveAsk(ownerId, { ...ask, ownerAskTs: 200, ts: 200 }), 'a new generation must be admitted');
    assert.equal(p.client.state().views[0].asks.length, 1);
  } finally { p.client.stop(); }
});

test('a closure during an in-flight snapshot invalidates the anterior acquisition', async () => {
  const p = createProbe();
  try {
    await p.start();
    p.client.rememberLiveAsk(ownerId, { ...ask });
    const stale = p.snapshot(); stale.asks = [{ ...ask }];
    let started; const waiting = new Promise((resolve) => { started = resolve; });
    let release;
    p.setResponse(() => { started(); return new Promise((resolve) => { release = () => resolve({ ok: true, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(stale) }); }); });
    const pending = p.client.ownerSnapshotAsks(ownerId);
    await waiting;
    p.client.applyOwnerClosure(ownerId, ask.id, { ownerAskTs: 100, outcome: 'answered' });
    release();
    const result = await pending;
    assert.notEqual(result.status, 'ok', 'an acquisition anterior to the closure must not decide anything');
    assert.equal(p.client.state().views[0].asks.length, 0);
  } finally { p.client.stop(); }
});

test('a closure notifies that the view changed', () => {
  const p = createProbe();
  try {
    p.client.rememberLiveAsk(ownerId, { ...ask });
    const before = p.changes.length;
    p.client.applyOwnerClosure(ownerId, ask.id, { ownerAskTs: 100, outcome: 'answered' });
    assert.ok(p.changes.length > before, 'the UI refresh signal must fire on closure');
  } finally { p.client.stop(); }
});
