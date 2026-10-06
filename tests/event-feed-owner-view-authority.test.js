'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createProbe, ownerId, ask } = require('./helpers/owner-view-probe.cjs');
for (const [reason, response] of [
  ['asks-unreadable', () => ({ ok: false, status: 503 })],
  ['transport', () => { throw new Error('socket unavailable'); }],
]) test(`a failed owner snapshot revokes authority and preserves data: ${reason}`, async () => {
  const p = createProbe();
  const initial = p.snapshot(); initial.asks = [ask];
  p.setResponse(() => ({ ok: true, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(initial) }));
  assert.equal((await p.client.ownerSnapshotAsks(ownerId)).status, 'ok');
  const before = p.client.state().views[0]; assert.equal(before.stale, false);
  p.setResponse(response);
  const result = await p.client.ownerSnapshotAsks(ownerId);
  const after = p.client.state().views[0];
  assert.equal(after.stale, true);
  assert.equal(after.lastError, reason);
  assert.equal(result.reason, reason);
  assert.deepEqual(after.asks, before.asks);
  assert.equal(p.changes.length, 2);
});
test('the exported owner view follows live ASK, generation replacement and owner closure', async () => {
  const p = createProbe();
  try {
    await p.start();
    await p.emit({ type: 'ask', askId: ask.id, question: ask.question, options: [], session: ask.session, ts: 999, askTs: 100 });
    assert.equal(p.client.state().views[0].asks.length, 1);
    assert.equal(p.client.state().views[0].asks[0].ownerAskTs, 100);
    await p.emit({ type: 'ask', askId: ask.id, question: 'New generation', options: [], session: ask.session, ts: 999, askTs: 200 });
    assert.equal(p.client.state().views[0].asks.length, 1);
    assert.equal(p.client.state().views[0].asks[0].ownerAskTs, 200);
    await p.emit({ type: 'ask-closed', askId: ask.id, outcome: 'answered', askTs: 100 });
    assert.equal(p.client.state().views[0].asks.length, 1);
    await p.emit({ type: 'ask-closed', askId: ask.id, outcome: 'answered', askTs: 200 });
    assert.equal(p.client.state().views[0].asks.length, 0);
  } finally { p.client.stop(); }
});
test('a fresh owner snapshot after a live ASK can certify its absence', async () => {
  const p = createProbe();
  try {
    await p.start(); await p.emit({ type: 'ask', askId: ask.id, question: ask.question, session: ask.session, ts: 100, askTs: 100 });
    assert.equal(p.client.state().views[0].asks.length, 1);
    assert.equal((await p.client.ownerSnapshotAsks(ownerId)).status, 'ok');
    assert.equal(p.client.state().views[0].asks.length, 0);
    assert.equal(p.client.state().views[0].stale, false);
  } finally { p.client.stop(); }
});
test('a snapshot started before a live ASK cannot certify its absence', async () => {
  const p = createProbe(); let complete, started;
  try {
    await p.start();
    const waiting = new Promise(resolve => { started = resolve; });
    const old = p.snapshot();
    p.setResponse(() => { started(); return new Promise(resolve => { complete = () => resolve({ ok: true, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(old) }); }); });
    const pending = p.client.ownerSnapshotAsks(ownerId); await waiting;
    await p.emit({ type: 'ask', askId: ask.id, question: ask.question, session: ask.session, ts: 100, askTs: 100 });
    complete(); const result = await pending;
    assert.equal(p.client.state().views[0].asks.length, 1);
    assert.notEqual(result.status, 'ok', 'an old owner read must not authorize imported alias removal either');
  } finally { p.client.stop(); }
});
test('a replayed closed generation cannot return to the exported owner view', async () => {
  const p = createProbe();
  try {
    await p.start();
    const frame = { type: 'ask', askId: ask.id, question: ask.question, session: ask.session, ts: 100, askTs: 100 };
    await p.emit(frame);
    await p.emit({ type: 'ask-closed', askId: ask.id, outcome: 'dismissed', askTs: 100 });
    await p.emit(frame);
    assert.equal(p.client.state().views[0].asks.length, 0);
  } finally { p.client.stop(); }
});
