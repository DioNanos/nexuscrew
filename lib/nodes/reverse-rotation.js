'use strict';

// Pure state transitions for the three-slot reverse pool.  SSH side effects
// live outside this module: callers reserve, prove the candidate, commit on
// the hub, then let the peer drain the old sidecar.  Keeping the transitions
// pure makes crash/replay cases explicit and testable.
const crypto = require('node:crypto');

const LEASE_MS = 60_000;
const GRACE_MS = 30_000;

function clone(pool) { return JSON.parse(JSON.stringify(pool)); }
function validSlot(pool, slot) { return Number.isInteger(slot) && pool && Array.isArray(pool.slots) && slot >= 0 && slot < pool.slots.length; }

function nextReadySlot(pool) {
  if (!pool || !Array.isArray(pool.slots)) return null;
  return pool.slots.findIndex((slot, index) => index !== pool.activeSlot && slot && slot.state === 'ready');
}

function prepareRotation(pool, { slot = nextReadySlot(pool), now = Date.now(), leaseId = crypto.randomBytes(16).toString('hex'), leaseMs = LEASE_MS } = {}) {
  if (!pool || pool.verification !== 'verified' || !Array.isArray(pool.verifiedSlots)
    || pool.verifiedSlots.length !== pool.slots.length || pool.rotation?.phase !== 'active' || !validSlot(pool, slot)
    || pool.slots[slot].state !== 'ready' || !Number.isSafeInteger(now) || !Number.isSafeInteger(leaseMs) || leaseMs < 1
    || typeof leaseId !== 'string' || !/^[a-f0-9]{32,64}$/.test(leaseId)) return null;
  const next = clone(pool);
  const generation = next.activeGeneration + 1;
  next.slots[slot] = { ...next.slots[slot], state: 'reserved', generation };
  next.rotation = { phase: 'prepared', generation, slot, leaseId, expiresAt: now + leaseMs };
  return next;
}

function abortPrepared(pool, { now = Date.now() } = {}) {
  if (!pool || pool.rotation?.phase !== 'prepared' || !Number.isSafeInteger(now)) return null;
  const next = clone(pool);
  const slot = next.rotation.slot;
  next.slots[slot] = { ...next.slots[slot], state: 'ready' };
  next.rotation = { phase: 'active', generation: next.activeGeneration, slot: next.activeSlot };
  return next;
}

function commitRotation(pool, { leaseId, now = Date.now(), graceMs = GRACE_MS } = {}) {
  if (!pool || pool.rotation?.phase !== 'prepared' || typeof leaseId !== 'string' || leaseId !== pool.rotation.leaseId
    || !Number.isSafeInteger(now) || now > pool.rotation.expiresAt || !Number.isSafeInteger(graceMs) || graceMs < 0) return null;
  const next = clone(pool);
  const oldSlot = next.activeSlot;
  const oldGeneration = next.activeGeneration;
  const slot = next.rotation.slot;
  next.slots[oldSlot] = { ...next.slots[oldSlot], state: 'draining' };
  next.slots[slot] = { ...next.slots[slot], state: 'active', generation: next.rotation.generation };
  next.activeSlot = slot;
  next.activeGeneration = next.rotation.generation;
  next.rotation = {
    phase: 'switched', generation: next.activeGeneration, slot,
    oldSlot, oldGeneration, graceUntil: now + graceMs,
  };
  return next;
}

function settleGrace(pool, { now = Date.now() } = {}) {
  if (!pool || pool.rotation?.phase !== 'switched' || !Number.isSafeInteger(now) || now < pool.rotation.graceUntil) return null;
  const next = clone(pool);
  const oldSlot = next.rotation.oldSlot;
  if (next.slots[oldSlot]?.state === 'draining') next.slots[oldSlot] = { ...next.slots[oldSlot], state: 'ready' };
  next.rotation = { phase: 'active', generation: next.activeGeneration, slot: next.activeSlot };
  return next;
}

function quarantineSlot(pool, { slot, now = Date.now() } = {}) {
  if (!pool || !validSlot(pool, slot) || slot === pool.activeSlot || !Number.isSafeInteger(now)) return null;
  const next = clone(pool);
  next.slots[slot] = { ...next.slots[slot], state: 'quarantined' };
  if (next.rotation?.phase === 'prepared' && next.rotation.slot === slot) {
    next.rotation = { phase: 'abandoned', generation: next.activeGeneration, slot: next.activeSlot };
  }
  return next;
}

module.exports = { LEASE_MS, GRACE_MS, nextReadySlot, prepareRotation, abortPrepared, commitRotation, settleGrace, quarantineSlot };
