'use strict';

// Coverage per i pin helper (frontend/src/lib/pins.js). togglePinIn/removePinIn
// ritornano { next, error }: next e' l'array risultante (contratto stabile), error
// e' null se la persistenza e' OK o un Error se fallisce (mai ingoiato: il chiamante
// puo' segnalarlo/ritentarlo). node:test gira senza DOM, quindi forniamo uno stub
// localStorage per esercitare entrambi gli esiti.

const { test } = require('node:test');
const assert = require('node:assert');

const pins = () => import('../frontend/src/lib/pins.js');

function stubLs(store = {}) {
  return {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  };
}

test('togglePinIn ritorna { next, error:null }: append/remove senza duplicati', async () => {
  globalThis.localStorage = stubLs();
  const { togglePinIn } = await pins();
  assert.deepEqual(togglePinIn(['a'], 'b').next, ['a', 'b'], 'appends a new pin');
  assert.deepEqual(togglePinIn(['a', 'b'], 'a').next, ['b'], 'removes an existing pin');
  assert.deepEqual(togglePinIn(['a', 'b'], 'b').next, ['a'], 'toggle off does not duplicate on re-add');
  assert.deepEqual(togglePinIn([], 'x').next, ['x']);
  assert.equal(togglePinIn(['a'], 'b').error, null, 'persistenza OK => error null');
});

test('togglePinIn emerge l\'errore di persistenza (NON lo ingoia)', async () => {
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => { throw new Error('quota'); },
    removeItem: () => {}, clear: () => {},
  };
  const { togglePinIn } = await pins();
  const r = togglePinIn(['a'], 'b');
  assert.deepEqual(r.next, ['a', 'b'], 'il next e\' calcolato comunque');
  assert.ok(r.error instanceof Error, 'l\'errore e\' riportato al chiamante');
});

test('removePinIn e\' idempotente: non aggiunge un pin assente (clear su stato server-owned)', async () => {
  // Era il difetto: clear su una designazione SENZA pin locale (stato ammesso dal
  // contratto) chiamava togglePin e AGGIUNGEVA il pin. removePinIn non aggiunge mai.
  globalThis.localStorage = stubLs();
  const { removePinIn } = await pins();
  assert.deepEqual(removePinIn(['a', 'b'], 'a').next, ['b'], 'rimuove un pin presente');
  assert.deepEqual(removePinIn([], 'a').next, [], 'NO-OP se assente (NON aggiunge come un toggle)');
  assert.deepEqual(removePinIn(['b'], 'a').next, ['b'], 'un altro pin sopravvive');
  assert.equal(removePinIn(['a'], 'a').error, null);
});

test('movePinIn reorders within the pinned block in both directions and guards edges', async () => {
  const { movePinIn } = await pins();
  const base = ['a', 'b', 'c'];
  assert.deepEqual(movePinIn(base, 'a', 'b'), ['b', 'a', 'c'], 'move down past the next pin');
  assert.deepEqual(movePinIn(base, 'c', 'b'), ['a', 'c', 'b'], 'move up before the previous pin');
  // No-op guards leave the order untouched.
  assert.deepEqual(movePinIn(base, 'a', 'a'), base, 'same source and target');
  assert.deepEqual(movePinIn(base, 'a', 'zzz'), base, 'target not pinned');
  assert.deepEqual(movePinIn(base, 'zzz', 'b'), base, 'source not pinned');
});

test('pinRank ranks pinned-first by pin order then by recent activity, compared via cmpRank', async () => {
  const { pinRank, cmpRank } = await pins();
  const base = ['p1', 'p2'];
  assert.deepEqual(pinRank(base, 'p1', 5), [0, -5], 'pinned keeps its index, activity negated');
  assert.deepEqual(pinRank(base, 'p2', 0), [1, 0]);
  assert.deepEqual(pinRank(base, 'other', 99), [1e9, -99], 'unpinned sorts after every pin');
  // Pinned always precedes unpinned, regardless of activity.
  assert.ok(cmpRank(pinRank(base, 'p1', 0), pinRank(base, 'other', 999)) < 0);
  // Among unpinned, more recent activity comes first.
  assert.ok(cmpRank(pinRank(base, 'a', 10), pinRank(base, 'b', 5)) < 0, 'higher activity ranks first');
  assert.equal(cmpRank([0, -5], [0, -5]), 0, 'equal ranks tie');
});
