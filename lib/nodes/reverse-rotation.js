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


// Esito di uno spegnimento che puo' riguardare PIU' entry insieme: durante la
// grace di una rotazione lo slot vecchio e quello nuovo coesistono. Una
// chiusura riuscita su una sola non e' una chiusura: dichiararla tale
// lascerebbe l'altra viva mentre chi chiama registra il canale come privato.
// `no pidfile` e `stale (pid dead)` contano come spente: li' non e' rimasto
// nulla di vivo da attribuire.
const STOP_ALREADY_GONE = ['no pidfile', 'stale (pid dead)'];

function stopWasDemonstrated(result) {
  if (!result) return false;
  return result.stopped === true || STOP_ALREADY_GONE.includes(result.reason);
}

function summarizeStops(results) {
  const list = Array.isArray(results) ? results : [];
  const stoppedAny = list.some(stopWasDemonstrated);
  const quarantinedAny = list.some((result) => !stopWasDemonstrated(result));
  return { stoppedAny, quarantinedAny, allClosed: stoppedAny && !quarantinedAny };
}

// Esito di un giro di verifica del pool. `verified` richiede TUTTI gli slot:
// e' una scelta deliberata, perche' rotateRotatableReverse si rifiuta di
// commutare dentro un pool non interamente provato. La conseguenza pero' va
// detta, non dedotta: finche' il pool non e' verificato la rotazione
// automatica resta SPENTA e il watcher non viene nemmeno armato. Un pool
// "unverifiable" non e' un'etichetta descrittiva, e' autoriparazione assente.
function summarizePoolVerification(results, slotCount) {
  const list = Array.isArray(results) ? results : [];
  const total = Number.isSafeInteger(slotCount) && slotCount > 0 ? slotCount : 0;
  const verifiedSlots = [...new Set(list.filter((r) => r && r.proven === true)
    .map((r) => r.slot).filter(Number.isSafeInteger))].sort((a, b) => a - b);
  const failures = list.filter((r) => r && r.proven !== true)
    .map((r) => ({ slot: r.slot, code: typeof r.code === 'string' && /^[a-z0-9-]{1,64}$/.test(r.code) ? r.code : 'reverse-slot-verify-failed' }));
  // Zero slot dichiarati non e' "tutto verificato": senza un pool da provare
  // non c'e' nulla da cui ruotare.
  const verified = total > 0 && verifiedSlots.length === total;
  return {
    verifiedSlots,
    failures,
    verification: verified ? 'verified' : 'unverifiable',
    rotationActive: verified,
  };
}

module.exports = { LEASE_MS, GRACE_MS, nextReadySlot, prepareRotation, abortPrepared, commitRotation, settleGrace, quarantineSlot, stopWasDemonstrated, summarizeStops, summarizePoolVerification };
