'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const store = require('../lib/nodes/store.js');
const rotation = require('../lib/nodes/reverse-rotation.js');

function pool() { return store.reversePoolDefault(44003, { verification: 'verified', generation: 4 }); }

test('reverse rotation: reserve, commit, grace e replay della generation vecchia', () => {
  const base = pool();
  const prepared = rotation.prepareRotation(base, { slot: 1, now: 100, leaseId: 'a'.repeat(32), leaseMs: 60 });
  assert.equal(prepared.slots[1].state, 'reserved');
  assert.equal(prepared.slots[1].generation, 5);
  assert.equal(rotation.commitRotation(prepared, { leaseId: 'wrong', now: 110 }), null);
  const switched = rotation.commitRotation(prepared, { leaseId: 'a'.repeat(32), now: 110, graceMs: 30 });
  assert.equal(switched.activeSlot, 1);
  assert.equal(switched.slots[0].state, 'draining');
  assert.equal(switched.rotation.oldGeneration, 4);
  assert.equal(rotation.settleGrace(switched, { now: 139 }), null);
  const settled = rotation.settleGrace(switched, { now: 140 });
  assert.equal(settled.slots[0].state, 'ready');
  assert.equal(settled.activeGeneration, 5);
});

test('reverse rotation: pool non verificato, lease scaduto e candidate quarantinata non avanzano', () => {
  const unverified = store.reversePoolDefault(44003);
  assert.equal(rotation.prepareRotation(unverified, { slot: 1, now: 1, leaseId: 'b'.repeat(32) }), null);
  const prepared = rotation.prepareRotation(pool(), { slot: 1, now: 1, leaseId: 'b'.repeat(32), leaseMs: 10 });
  assert.equal(rotation.commitRotation(prepared, { leaseId: 'b'.repeat(32), now: 12 }), null);
  const quarantined = rotation.quarantineSlot(prepared, { slot: 1, now: 2 });
  assert.equal(quarantined.slots[1].state, 'quarantined');
  assert.equal(quarantined.rotation.phase, 'abandoned');
});
