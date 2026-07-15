'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

class MemoryStorage {
  constructor(limit = Infinity) { this.map = new Map(); this.limit = limit; }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) {
    if (String(value).length > this.limit) throw new Error('QuotaExceededError');
    this.map.set(key, String(value));
  }
  removeItem(key) { this.map.delete(key); }
}

test('composer model: ownerId + tmuxSession separano celle omonime e resistono al cambio route', async () => {
  const { composerCellKey } = await import('../frontend/src/lib/composer-model.js');
  const a = 'a'.repeat(32); const b = 'b'.repeat(32);
  assert.equal(
    composerCellKey({ ownerId: a, node: 'old-route', session: 'cloud-Dev' }),
    composerCellKey({ ownerId: a, node: 'new-route', session: 'cloud-Dev' }),
  );
  assert.notEqual(
    composerCellKey({ ownerId: a, session: 'cloud-Dev' }),
    composerCellKey({ ownerId: b, session: 'cloud-Dev' }),
  );
  assert.notEqual(
    composerCellKey({ node: 'relay', session: 'work' }),
    composerCellKey({ session: 'work' }),
  );
});

test('composer model: draft lungo, expand e history restano per cella senza troncare', async () => {
  const model = await import('../frontend/src/lib/composer-model.js');
  const storage = new MemoryStorage();
  const key = model.composerCellKey({ ownerId: 'a'.repeat(32), session: 'cloud-Dev' });
  const draft = `${'a'.repeat(3000)}\n${'è'.repeat(3000)}`;
  assert.equal(model.saveComposerDraft(key, draft, storage, 100), true);
  assert.equal(model.saveComposerExpanded(key, true, storage, 101), true);
  assert.equal(model.pushComposerHistory(key, draft, storage, 102), true);
  assert.equal(model.pushComposerHistory(key, draft, storage, 103), true, 'dedup aggiorna la voce senza duplicarla');
  const cell = model.loadComposerCell(key, storage, 104);
  assert.equal(cell.draft, draft);
  assert.equal(cell.expanded, true);
  assert.deepEqual(cell.history.map((item) => item.text), [draft]);
});

test('composer model: clear draft non elimina history e clear globale rimuove solo il namespace composer', async () => {
  const model = await import('../frontend/src/lib/composer-model.js');
  const storage = new MemoryStorage();
  storage.setItem('nc_decks', '["main"]');
  const key = model.composerCellKey({ session: 'local' });
  model.saveComposerDraft(key, 'bozza', storage, 10);
  model.pushComposerHistory(key, 'inviato', storage, 11);
  model.clearComposerDraft(key, storage, 12);
  assert.equal(model.loadComposerCell(key, storage, 13).draft, '');
  assert.deepEqual(model.loadComposerCell(key, storage, 13).history.map((item) => item.text), ['inviato']);
  assert.equal(model.clearAllComposerData(storage), true);
  assert.equal(storage.getItem(model.COMPOSER_STORAGE_KEY), null);
  assert.equal(storage.getItem('nc_decks'), '["main"]');
});

test('composer model: TTL e quota eliminano dati vecchi senza troncare il draft attivo', async () => {
  const model = await import('../frontend/src/lib/composer-model.js');
  const storage = new MemoryStorage(620);
  const old = model.composerCellKey({ ownerId: 'a'.repeat(32), session: 'old' });
  const active = model.composerCellKey({ ownerId: 'a'.repeat(32), session: 'active' });
  assert.equal(model.saveComposerDraft(old, 'x'.repeat(180), storage, 1), true);
  assert.equal(model.saveComposerDraft(active, 'y'.repeat(360), storage, 2), true, 'quota retry espelle la cella più vecchia');
  assert.equal(model.loadComposerCell(active, storage, 3).draft, 'y'.repeat(360));
  assert.equal(model.loadComposerCell(old, storage, 3).draft, '');

  const staleStorage = new MemoryStorage();
  model.saveComposerDraft(old, 'stale', staleStorage, 1);
  assert.equal(model.loadComposerCell(old, staleStorage, model.COMPOSER_TTL_MS + 2).draft, '');
});

test('composer model: storage corrotto e payload oltre limite falliscono chiusi', async () => {
  const model = await import('../frontend/src/lib/composer-model.js');
  const storage = new MemoryStorage();
  const key = model.composerCellKey({ ownerId: 'a'.repeat(32), session: 'safe' });
  storage.setItem(model.COMPOSER_STORAGE_KEY, '{broken');
  assert.deepEqual(model.loadComposerCell(key, storage), {
    draft: '', history: [], expanded: false, updatedAt: 0,
  });
  assert.equal(model.saveComposerDraft(key, 'x'.repeat(model.COMPOSER_MAX_DRAFT_CHARS + 1), storage), false);
  assert.equal(model.pushComposerHistory(key, 'x'.repeat(model.COMPOSER_MAX_ENTRY_CHARS + 1), storage), false);
  assert.equal(model.composerCellKey({ ownerId: '../bad', node: 'relay', session: 'safe' }), 'route%3Arelay:safe');
  storage.setItem(model.COMPOSER_STORAGE_KEY, '{"version":1,"cells":{"safe":{"draft":"x","history":[{"text":"x","at":1e999}],"updatedAt":1e999},"__proto__":{"draft":"bad","updatedAt":1}}}');
  assert.deepEqual(model.loadComposerCell('safe', storage).history, [{ text: 'x', at: 0 }]);
  assert.equal(Object.prototype.draft, undefined);
});
