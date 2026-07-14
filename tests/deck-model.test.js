'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const mod = () => import('../frontend/src/lib/deck-model.js');

test('isValidDeckName: contratto ^[a-z0-9-]{1,32}$', async () => {
  const m = await mod();
  for (const ok of ['main', 'a', 'work-1', 'x'.repeat(32), 'left-monitor', '0']) {
    assert.equal(m.isValidDeckName(ok), true, `valido: ${ok}`);
  }
  for (const bad of ['Main', 'a_b', 'a.b', 'x'.repeat(33), '', 'a/b', 'sess@1', ' a', 'a ', null, 42]) {
    assert.equal(m.isValidDeckName(bad), false, `invalido: ${JSON.stringify(bad)}`);
  }
});

test('normalizeDeckName: i nomi umani diventano id URL-safe', async () => {
  const m = await mod();
  assert.equal(m.normalizeDeckName('Test Deck'), 'test-deck');
  assert.equal(m.normalizeDeckName('  Lavoro  Sera  '), 'lavoro-sera');
  assert.equal(m.normalizeDeckName('Caffè & Codice'), 'caffe-codice');
  assert.equal(m.normalizeDeckName('---'), '');
  assert.equal(m.normalizeDeckName('A'.repeat(40)), 'a'.repeat(32));
});

test('deckFromPath: /deck/<name> valido, altrimenti main', async () => {
  const m = await mod();
  assert.equal(m.deckFromPath('/'), 'main');
  assert.equal(m.deckFromPath(''), 'main');
  assert.equal(m.deckFromPath('/deck/work-1'), 'work-1');
  assert.equal(m.deckFromPath('/deck/work-1/'), 'work-1');
  assert.equal(m.deckFromPath('/deck/Work'), 'main', 'nome invalido → main');
  assert.equal(m.deckFromPath('/deck/a/b'), 'main', 'segmento extra → main');
  assert.equal(m.deckFromPath('/deck/'), 'main');
});

test('layoutKey: main = chiave storica, altri namespaced', async () => {
  const m = await mod();
  assert.equal(m.layoutKey('main'), 'nc_grid_v1');
  assert.equal(m.layoutKey('work-1'), 'nc_grid_v1__work-1');
});

test('deckUrl: path + fragment token opzionale', async () => {
  const m = await mod();
  const owner = 'a'.repeat(32);
  assert.equal(m.deckUrl('main'), '/');
  assert.equal(m.deckUrl('work-1'), '/deck/work-1');
  assert.equal(m.deckUrl('work-1', 'abc/def'), '/deck/work-1#token=abc%2Fdef');
  assert.equal(m.deckUrl('main', 'tk'), '/#token=tk');
  assert.equal(m.deckUrl(`${owner}:main`), `/deck/${owner}/main`);
  assert.equal(m.deckUrl({ ownerId: owner, name: 'work-1' }, 'tk'), `/deck/${owner}/work-1#token=tk`);
  assert.deepEqual(m.deckLocationFromPath(`/deck/${owner}/work-1`), { id: `${owner}:work-1`, ownerId: owner, name: 'work-1' });
  assert.deepEqual(m.deckLocationFromPath('/deck/not-an-owner/work-1'), { id: 'local:main', ownerId: null, name: 'main' });
});

test('normalizeDecks: main primo, validi, dedup, cap', async () => {
  const m = await mod();
  assert.deepEqual(m.normalizeDecks(null), ['main']);
  assert.deepEqual(m.normalizeDecks(['a', 'a', 'main', 'B', 'b']), ['main', 'a', 'b']);
  const big = Array.from({ length: 40 }, (_, i) => `d${i}`);
  assert.equal(m.normalizeDecks(big).length, 24, 'cap a 24');
});

test('addDeck/removeDeck/renameDeck: main indistruttibile', async () => {
  const m = await mod();
  let d = m.normalizeDecks(null);
  d = m.addDeck(d, 'work');
  assert.deepEqual(d, ['main', 'work']);
  assert.deepEqual(m.addDeck(d, 'Bad'), ['main', 'work'], 'nome invalido ignorato');
  assert.deepEqual(m.addDeck(d, 'work'), ['main', 'work'], 'dedup');
  assert.deepEqual(m.removeDeck(d, 'main'), ['main', 'work'], 'main non si elimina');
  assert.deepEqual(m.removeDeck(d, 'work'), ['main']);
  assert.deepEqual(m.renameDeck(d, 'work', 'work2'), ['main', 'work2']);
  assert.deepEqual(m.renameDeck(d, 'main', 'x'), ['main', 'work'], 'main non si rinomina');
  assert.deepEqual(m.renameDeck(d, 'work', 'main'), ['main', 'work'], 'collisione con main');
  assert.deepEqual(m.renameDeck(d, 'work', 'BAD'), ['main', 'work'], 'target invalido');
});

test('deck order: owner-qualified move, persistence and stale IDs are bounded', async () => {
  const m = await mod();
  const owner = 'a'.repeat(32);
  const initial = {
    local: ['local:main', 'local:work', 'local:notes'],
    [owner]: [`${owner}:main`, `${owner}:remote`],
  };
  const moved = m.moveDeckInOrder(initial, 'local', 'local:notes', 'local:work', initial.local);
  assert.deepEqual(moved.local, ['local:main', 'local:notes', 'local:work']);
  assert.deepEqual(moved[owner], initial[owner], 'un drag locale non cambia i deck remoti');
  assert.deepEqual(m.moveDeckInOrder(moved, 'local', 'local:notes', `${owner}:main`, initial.local), moved,
    'cross-owner fail-closed');

  const bag = new Map();
  const storage = { getItem: (key) => bag.get(key) || null, setItem: (key, value) => bag.set(key, value) };
  m.saveDeckOrders(moved, storage);
  assert.deepEqual(m.loadDeckOrders(storage), moved);

  const records = [
    { id: 'local:main', local: true }, { id: 'local:work', local: true }, { id: 'local:notes', local: true },
    { id: `${owner}:main`, ownerId: owner }, { id: `${owner}:remote`, ownerId: owner },
  ];
  assert.deepEqual(m.orderDeckRecords(records, moved).map((record) => record.id), [
    'local:main', 'local:notes', 'local:work', `${owner}:main`, `${owner}:remote`,
  ]);
});

test('deck order follows rename/delete without losing the surrounding position', async () => {
  const m = await mod();
  let orders = { local: ['local:main', 'local:work', 'local:notes'] };
  orders = m.replaceDeckOrderId(orders, 'local', 'local:work', 'local:projects');
  assert.deepEqual(orders.local, ['local:main', 'local:projects', 'local:notes']);
  orders = m.removeDeckOrderId(orders, 'local', 'local:projects');
  assert.deepEqual(orders.local, ['local:main', 'local:notes']);
});
