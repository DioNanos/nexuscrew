'use strict';

// Focused coverage for the pin order helpers (frontend/src/lib/pins.js) that the
// shared useRosterPreferences controller now centralizes for both the desktop
// Sidebar and the mobile SessionList. These are pure array operations: the
// best-effort localStorage write is defensive (try/catch), so the returned-array
// contract is stable under node:test with no DOM.

const { test } = require('node:test');
const assert = require('node:assert');

const pins = () => import('../frontend/src/lib/pins.js');

test('togglePinIn appends new pins and removes existing ones without duplicates', async () => {
  const { togglePinIn } = await pins();
  assert.deepEqual(togglePinIn(['a'], 'b'), ['a', 'b'], 'appends a new pin');
  assert.deepEqual(togglePinIn(['a', 'b'], 'a'), ['b'], 'removes an existing pin');
  assert.deepEqual(togglePinIn(['a', 'b'], 'b'), ['a'], 'toggle off does not duplicate on re-add');
  assert.deepEqual(togglePinIn([], 'x'), ['x']);
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
