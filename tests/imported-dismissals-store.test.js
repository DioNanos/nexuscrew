'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAsksStore } = require('../lib/notify/asks.js');
const OWNER = 'b'.repeat(32);
const ID = '11223344';
const source = (extra = {}) => ({ id: ID, question: 'Review this change?', options: ['Proceed', 'Wait'], session: 'reviewer', ts: 1000, ...extra });
function fixture(t, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imported-dismissals-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createAsksStore({ dir, now: () => 5000, ...extra });
  const restart = () => createAsksStore({ dir, now: () => 9999999, ...extra });
  return { store, dir, restart };
}
function dismiss(store, ask = source(), ownerId = OWNER) {
  return store.dismissImported({ ownerId, ownerAskId: ask.id, ask, syncState: 'pending' });
}

test('new imports retain the owner timestamp separately from local receipt time', t => {
  const { store } = fixture(t);
  const { ask } = store.create({ ...source(), ownerId: OWNER, ownerAskId: ID, originNode: OWNER, ownerAskTs: 1000 });
  assert.equal(ask.ownerAskTs, 1000);
  assert.equal(ask.ts, 5000);
});

test('a feed-only dismissal is durable and does not fabricate an alias', t => {
  const { store, restart } = fixture(t);
  assert.equal(dismiss(store).ok, true);
  assert.deepEqual(store.list(), []);
  const record = restart().getImportedDismissal(OWNER, ID);
  assert.equal(record.dismissedReason, 'owner-unreachable');
  assert.equal(record.syncState, 'pending');
  assert.equal(record.ownerAskTs, 1000);
  assert.equal(record.generation, 'known');
  assert.equal(restart().isImportedDismissed(OWNER, source()), true);
});

test('historical aliases use unknown generation and suppress by canonical fingerprint', t => {
  const { store, restart } = fixture(t);
  const { ask } = store.create({ ...source(), ownerId: OWNER, ownerAskId: ID, originNode: OWNER });
  assert.equal(dismiss(store, ask).ok, true);
  const record = restart().getImportedDismissal(OWNER, ID);
  assert.equal(record.generation, 'unknown');
  assert.equal(record.ownerAskTs, null);
  assert.equal(restart().isImportedDismissed(OWNER, source({ ts: 123456 })), true);
  assert.equal(restart().isImportedDismissed(OWNER, source({ question: 'Another change?' })), false);
});

test('double dismissal and restart preserve one record, timestamp and alias revision', t => {
  const { store, restart } = fixture(t);
  const { ask } = store.create({ ...source(), ownerId: OWNER, ownerAskId: ID, originNode: OWNER, ownerAskTs: 1000 });
  assert.equal(dismiss(store, ask).ok, true);
  const first = store.get(ask.id);
  const record = store.getImportedDismissal(OWNER, ID);
  assert.equal(dismiss(store, first).ok, true);
  assert.equal(store.get(ask.id).revision, first.revision);
  assert.deepEqual(restart().getImportedDismissal(OWNER, ID), record);
  assert.equal(restart().listImportedDismissals().length, 1);
});

test('owner-qualified keys separate identical ask ids and alias ids', t => {
  const { store } = fixture(t);
  const alias = store.create({ ...source(), ownerId: OWNER, ownerAskId: ID, originNode: OWNER, ownerAskTs: 1000 }).ask;
  dismiss(store, alias);
  assert.equal(store.isImportedDismissed(OWNER, source()), true);
  assert.equal(store.isImportedDismissed('c'.repeat(32), source()), false);
  assert.equal(store.isImportedDismissed(OWNER, { ...alias, ownerAskTs: 1000 }), true);
});

test('known generation changes are visible without deleting the pending intent', t => {
  const { store } = fixture(t);
  dismiss(store);
  assert.equal(store.isImportedDismissed(OWNER, source({ ts: 1001 })), false);
  assert.equal(store.isImportedDismissed(OWNER, source()), true);
  assert.equal(store.listImportedDismissals().length, 1);
});

test('adoption is durable before a resumed process can use the owner timestamp', t => {
  const { store, restart } = fixture(t);
  const alias = store.create({ ...source(), ownerId: OWNER, ownerAskId: ID, originNode: OWNER }).ask;
  dismiss(store, alias);
  assert.equal(store.adoptImportedDismissal(OWNER, ID, source()).ok, true);
  const adopted = restart().getImportedDismissal(OWNER, ID);
  assert.equal(adopted.ownerAskTs, 1000);
  assert.equal(adopted.generation, 'known');
});

test('a different fingerprint cannot adopt an old dismissal', t => {
  const { store } = fixture(t);
  const alias = store.create({ ...source(), ownerId: OWNER, ownerAskId: ID, originNode: OWNER }).ask;
  dismiss(store, alias);
  const result = store.adoptImportedDismissal(OWNER, ID, source({ question: 'New request?' }));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'generation-mismatch');
  assert.equal(store.getImportedDismissal(OWNER, ID).generation, 'unknown');
});

test('authoritative closure updates a locally dismissed alias and its owner outcome', t => {
  const { store, restart } = fixture(t);
  const alias = store.create({ ...source(), ownerId: OWNER, ownerAskId: ID, originNode: OWNER, ownerAskTs: 1000 }).ask;
  dismiss(store, alias);
  const closed = store.closeImported({ ownerId: OWNER, ownerAskId: ID, outcome: 'answered' });
  assert.equal(closed.ok, true);
  const record = restart().getImportedDismissal(OWNER, ID);
  assert.equal(record.syncState, 'confirmed-answered');
  assert.equal(record.ownerOutcome, 'answered');
  assert.equal(restart().get(alias.id).dismissed, true);
  assert.equal(restart().get(alias.id).answer, undefined);
});

test('a malformed dismissal section refuses mutations instead of resetting state', t => {
  const { store, dir } = fixture(t);
  fs.writeFileSync(path.join(dir, 'asks.json'), JSON.stringify({ asks: [], importedDismissals: 'broken' }), { mode: 0o600 });
  assert.equal(store.health().readable, false);
  assert.equal(store.create({ question: 'Keep history', session: 'reviewer' }).ok, false);
  assert.equal(dismiss(store).ok, false);
  assert.equal(JSON.parse(fs.readFileSync(store.filePath)).importedDismissals, 'broken');
});

test('a failed atomic write rolls back both alias and dismissal cache', t => {
  const { store } = fixture(t);
  const alias = store.create({ ...source(), ownerId: OWNER, ownerAskId: ID, originNode: OWNER, ownerAskTs: 1000 }).ask;
  const before = fs.readFileSync(store.filePath);
  const original = store.filePath + '.original';
  fs.renameSync(store.filePath, original);
  fs.symlinkSync(original, store.filePath);
  assert.equal(dismiss(store, alias).ok, false);
  assert.equal(store.get(alias.id).dismissed, false);
  assert.equal(store.getImportedDismissal(OWNER, ID), null);
  assert.deepEqual(fs.readFileSync(original), before);
});

test('pending intent survives alias pruning and a full cap refuses rather than evicts', t => {
  const { store, restart } = fixture(t, { maxImportedDismissals: 1 });
  dismiss(store);
  for (let i = 0; i < 110; i++) {
    const created = store.create({ question: `Request ${i}`, session: 'reviewer' });
    assert.equal(created.ok, true);
    store.markAnswered(created.ask.id, 'Done');
  }
  assert.equal(dismiss(store, source({ id: '55667788' })).reason, 'dismissal-cap');
  assert.equal(restart().listImportedDismissals().length, 1);
  assert.equal(restart().getImportedDismissal(OWNER, ID).syncState, 'pending');
});

test('answering and answered aliases cannot acquire a local dismissal record', t => {
  const { store } = fixture(t);
  const alias = store.create({ ...source(), ownerId: OWNER, ownerAskId: ID, originNode: OWNER, ownerAskTs: 1000 }).ask;
  store.claim(alias.id);
  assert.equal(dismiss(store, alias).reason, 'answering');
  store.commit(alias.id, 'A reply already won');
  assert.equal(dismiss(store, store.get(alias.id)).reason, 'answered');
  assert.deepEqual(store.listImportedDismissals(), []);
});
