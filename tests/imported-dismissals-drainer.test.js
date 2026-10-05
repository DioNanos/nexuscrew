'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAsksStore } = require('../lib/notify/asks.js');
const modulePath = '../lib/notify/imported-dismissals.js';
const { createImportedDismissalDrainer } = fs.existsSync(path.join(__dirname, modulePath)) ? require(modulePath) : {};
const OWNER = 'b'.repeat(32), ID = '11223344';
const ASK = { id: ID, question: 'Review?', options: ['Yes', 'No'], session: 'reviewer', ts: 1000 };
function fixture(t, { unknown = false, inspect, dismiss, extra = {} } = {}) {
  assert.equal(typeof createImportedDismissalDrainer, 'function', 'a dedicated durable drainer is required');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismissal-drainer-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createAsksStore({ dir });
  let ask = ASK;
  if (unknown) ask = store.create({ ...ASK, ownerId: OWNER, ownerAskId: ID, originNode: OWNER }).ask;
  assert.equal(store.dismissImported({ ownerId: OWNER, ownerAskId: ID, ask }).ok, true);
  const calls = [];
  const relay = {
    inspectDismissal: async args => { calls.push(['inspect', args]); return inspect ? inspect(args) : { ok: true, status: 'open', ask: ASK, generationPrecondition: true }; },
    relayDismiss: async args => { calls.push(['delete', args]); return dismiss ? dismiss(args, store, dir) : { ok: true, outcome: 'dismissed' }; },
  };
  const drainer = createImportedDismissalDrainer({ store, relay, setTimer: () => ({ unref() {} }), clearTimer() {}, ...extra });
  t.after(() => drainer.stop());
  return { store, dir, calls, drainer };
}

test('unknown generation is adopted durably before DELETE and survives restart', async t => {
  const f = fixture(t, { unknown: true, dismiss: async (args, store, dir) => {
    const restarted = createAsksStore({ dir });
    assert.equal(restarted.getImportedDismissal(OWNER, ID).ownerAskTs, 1000);
    assert.equal(args.expectedTs, 1000);
    return { ok: true, outcome: 'dismissed' };
  } });
  await f.drainer.drain();
  assert.equal(f.calls.filter(c => c[0] === 'delete').length, 1);
  assert.equal(f.store.getImportedDismissal(OWNER, ID).syncState, 'confirmed-dismissed');
});

test('a different fingerprint remains visible and prevents the old DELETE', async t => {
  const fresh = { ...ASK, question: 'A new question?', ts: 2000 };
  const f = fixture(t, { unknown: true, inspect: async () => ({ ok: true, status: 'open', ask: fresh, generationPrecondition: true }) });
  await f.drainer.drain();
  assert.equal(f.calls.filter(c => c[0] === 'delete').length, 0);
  assert.equal(f.store.isImportedDismissed(OWNER, fresh), false);
  assert.equal(f.store.getImportedDismissal(OWNER, ID).syncState, 'blocked');
});

test('an owner lacking generation preconditions is blocked without DELETE', async t => {
  const f = fixture(t, { inspect: async () => ({ ok: true, status: 'open', ask: ASK }) });
  await f.drainer.drain();
  assert.equal(f.calls.filter(c => c[0] === 'delete').length, 0);
  assert.equal(f.store.getImportedDismissal(OWNER, ID).syncState, 'blocked');
  assert.equal(f.store.getImportedDismissal(OWNER, ID).lastReason, 'unsupported');
});

test('a generation change between adoption and DELETE stays unconfirmed', async t => {
  const f = fixture(t, { unknown: true, dismiss: async () => ({ ok: false, code: 409, reason: 'generation-mismatch' }) });
  await f.drainer.drain();
  assert.equal(f.store.getImportedDismissal(OWNER, ID).syncState, 'blocked');
  assert.notEqual(f.store.getImportedDismissal(OWNER, ID).ownerOutcome, 'dismissed');
});

test('authoritative answered state wins before DELETE', async t => {
  const f = fixture(t, { inspect: async () => ({ ok: true, status: 'answered', ask: ASK, generationPrecondition: true }) });
  await f.drainer.drain();
  assert.equal(f.calls.filter(c => c[0] === 'delete').length, 0);
  assert.equal(f.store.getImportedDismissal(OWNER, ID).syncState, 'confirmed-answered');
});

test('a reply won during DELETE and its structured outcome is preserved', async t => {
  const f = fixture(t, { dismiss: async () => ({ ok: true, outcome: 'answered' }) });
  await f.drainer.drain();
  assert.equal(f.store.getImportedDismissal(OWNER, ID).syncState, 'confirmed-answered');
});

for (const [code, reason, state] of [[409, 'answering', 'pending'], [409, 'delivery-unknown-block', 'pending'], [429, 'answer-rate', 'pending'], [404, 'reverse-slot-unverified', 'pending'], [502, 'owner-unreachable', 'pending'], [403, 'grant-required:ask-action', 'blocked'], [404, 'unknown', 'blocked']]) {
  test(`owner refusal ${reason} retains durable intent with bounded retries`, async t => {
    const f = fixture(t, { inspect: async () => ({ ok: false, code, reason }), extra: { now: () => 5000, random: () => 0.5 } });
    await f.drainer.drain();
    await f.drainer.drain();
    assert.equal(f.calls.filter(c => c[0] === 'inspect').length, 1);
    const record = f.store.getImportedDismissal(OWNER, ID);
    assert.equal(record.syncState, state);
    assert.equal(record.lastReason, reason);
    assert.ok(record.nextRetryAt > 5000);
    assert.equal(f.calls.filter(c => c[0] === 'delete').length, 0);
  });
}

test('concurrent drains are single-flight for each owner-qualified pair', async t => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { inspect: async () => { await wait; return { ok: true, status: 'open', ask: ASK, generationPrecondition: true }; } });
  const first = f.drainer.drain();
  const second = f.drainer.drain();
  assert.equal(first, second, 'concurrent callers must share the active drain');
  release(); await Promise.all([first, second]);
  assert.equal(f.calls.filter(c => c[0] === 'delete').length, 1);
});

test('an applied DELETE with a lost response is recovered from durable owner truth', async t => {
  const f = fixture(t, { dismiss: async () => ({ ok: false, code: 502, reason: 'owner-unreachable' }) });
  await f.drainer.drain();
  assert.equal(f.store.getImportedDismissal(OWNER, ID).syncState, 'pending');
  f.drainer.stop();
  const restarted = createAsksStore({ dir: f.dir });
  let deletes = 0;
  const drainer = createImportedDismissalDrainer({ store: restarted, now: () => 1e15,
    relay: { inspectDismissal: async () => ({ ok: true, status: 'dismissed', ask: ASK, generationPrecondition: true }), relayDismiss: async () => { deletes++; } },
    setTimer: () => ({ unref() {} }), clearTimer() {},
  });
  t.after(() => drainer.stop());
  await drainer.drain();
  assert.equal(restarted.getImportedDismissal(OWNER, ID).syncState, 'confirmed-dismissed');
  assert.equal(deletes, 0);
});
test('owner and global budgets persist across repeated nudges within a time window', async t => {
  let clock = 10000;
  const f = fixture(t, { extra: { now: () => clock, globalBudget: 2, ownerBudget: 1, budgetWindowMs: 60000 } });
  for (const [ownerId, id] of [[OWNER, '11223345'], ['c'.repeat(32), '11223346'], ['d'.repeat(32), '11223347']]) {
    f.store.dismissImported({ ownerId, ownerAskId: id, ask: { ...ASK, id } });
  }
  await f.drainer.drain(); await f.drainer.drain();
  assert.equal(f.calls.filter(c => c[0] === 'inspect').length, 2);
  clock += 60001; await f.drainer.drain(); assert.equal(f.calls.filter(c => c[0] === 'inspect').length, 4);
});
test('blocked records are reactivated only by a changed owner permission or channel binding', async t => {
  let binding = 'old', clock = 10000;
  const f = fixture(t, { inspect: async () => ({ ok: false, code: 403, reason: 'grant-required:ask-action' }), extra: { now: () => clock, bindingForOwner: () => binding } });
  await f.drainer.drain(); assert.equal(f.store.getImportedDismissal(OWNER, ID).syncState, 'blocked');
  await f.drainer.drain(); assert.equal(f.calls.length, 1);
  binding = 'new'; clock += 60001; await f.drainer.drain(); assert.equal(f.calls.length, 2);
});
test('READONLY prevents drain acquisition and a change during inspection prevents DELETE', async t => {
  let readonly = true;
  const f = fixture(t, { extra: { readonly: () => readonly }, inspect: async () => { readonly = true; return { ok: true, status: 'open', ask: ASK, generationPrecondition: true }; } });
  await f.drainer.drain(); assert.equal(f.calls.length, 0);
  readonly = false; await f.drainer.drain(); assert.equal(f.calls.filter(c => c[0] === 'inspect').length, 1);
  assert.equal(f.calls.filter(c => c[0] === 'delete').length, 0); assert.equal(f.store.getImportedDismissal(OWNER, ID).syncState, 'pending');
});
