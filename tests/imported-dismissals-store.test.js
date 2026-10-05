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
  return store.dismissImported({ ownerId, ownerAskId: ask.ownerAskId || ask.id, ask, syncState: 'pending' });
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
  const first = { ...store.get(ask.id) };
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
test('direct imports of a locally dismissed generation are explicitly suppressed', t => {
  const { store } = fixture(t);
  const imported = store.create({ ...source(), ownerId: OWNER, ownerAskId: ID, originNode: OWNER, ownerAskTs: 1000 }).ask;
  assert.equal(store.dismissImported({ ownerId: OWNER, ownerAskId: ID, ask: imported }).ok, true);
  const replay = store.create({ ...source(), ownerId: OWNER, ownerAskId: ID, originNode: OWNER, ownerAskTs: 1000 });
  assert.equal(replay.suppressed, true); assert.equal(store.list().length, 1);
});
test('a new direct import generation creates a fresh alias and resolves the latest canonical pair', t => {
  const { store } = fixture(t);
  const old = store.create({ ...source(), ownerId: OWNER, ownerAskId: ID, originNode: OWNER, ownerAskTs: 1000 }).ask;
  store.dismissImported({ ownerId: OWNER, ownerAskId: ID, ask: old });
  const next = store.create({ ...source(), question: 'New question?', ownerId: OWNER, ownerAskId: ID, originNode: OWNER, ownerAskTs: 1001 }).ask;
  assert.notEqual(next.id, old.id); assert.equal(next.dismissed, false);
  assert.equal(store.findImported(OWNER, ID).id, next.id); assert.equal(store.isImportedDismissed(OWNER, next), false);
});
test('a failed authoritative closure write rolls back both alias and synchronization cache', t => {
  const { store, dir } = fixture(t);
  const alias = store.create({ ...source(), ownerId: OWNER, ownerAskId: ID, originNode: OWNER }).ask;
  dismiss(store, alias); const before = store.getImportedDismissal(OWNER, ID);
  const file = store.filePath; fs.renameSync(file, path.join(dir, 'saved.json')); fs.symlinkSync(path.join(dir, 'saved.json'), file);
  const result = store.closeImported({ ownerId: OWNER, ownerAskId: ID, outcome: 'answered' });
  assert.equal(result.ok, false); assert.deepEqual(store.getImportedDismissal(OWNER, ID), before);
  assert.equal(store.get(alias.id).answered, false);
});
for (const [field, value] of [['attempts', -1], ['nextRetryAt', 'tomorrow'], ['dismissed', false]]) test(`malformed durable ${field} blocks mutations without resetting intent`, t => {
  const f = fixture(t); assert.equal(dismiss(f.store).ok, true);
  const raw = JSON.parse(fs.readFileSync(f.store.filePath)); raw.importedDismissals[`${OWNER}|${ID}`][field] = value;
  fs.writeFileSync(f.store.filePath, JSON.stringify(raw));
  const restarted = f.restart(); assert.equal(restarted.health().readable, false);
  assert.equal(dismiss(restarted).ok, false); assert.deepEqual(JSON.parse(fs.readFileSync(f.store.filePath)), raw);
});

test('a dismissal record under a noncanonical key makes the store unreadable', t => {
  const { store, restart } = fixture(t);
  assert.equal(dismiss(store).ok, true);
  const state = JSON.parse(fs.readFileSync(store.filePath, 'utf8'));
  const record = state.importedDismissals[`${OWNER}|${ID}`];
  state.importedDismissals = { wrongKey: record };
  fs.writeFileSync(store.filePath, JSON.stringify(state));
  const before = fs.readFileSync(store.filePath, 'utf8');
  assert.equal(restart().health().readable, false);
  assert.equal(restart().dismissImported({ ownerId: OWNER, ownerAskId: ID, ask: source() }).ok, false);
  assert.equal(fs.readFileSync(store.filePath, 'utf8'), before, 'malformed history is never overwritten');
});
