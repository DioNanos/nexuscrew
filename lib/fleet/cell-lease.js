'use strict';

// Pure state transitions for the supervisor lease of a Live host cell.
//
// Contratto rev12 + rev13 + rev22. Il canale lease e' la connessione UDS
// accettata col nonce one-shot del launch-broker che RESTA APERTA dopo il frame
// payload; after an EOF the supervisor reconnects to a stable endpoint.
// Here live ONLY the lease state transitions: the side
// effects (socket, timer, EOF handling) live in the LeaseManager and the callers.
// Modello speculare a lib/nodes/reverse-rotation.js (clone + arg validation),
// cosi' i casi crash/replay sono espliciti e testabili senza socket.
//
// Invarianti normativi ribaditi nel codice:
//  - EOF arms a SINGLE monotonic Live -> Grace transition; the deadline
//    is not extendable: a second armGrace on a Grace lease is a no-op.
//  - Nessuna operazione riporta in Live un lease gia' in Grace: refresh e armGrace
//    non cambiano lo stato di un lease in Grace. Solo reattach crea un lease NUOVO.
//  - reattach produces a lease with a NEW leaseId and the SAME identity
//    cellId+launchEpoch (the generation may advance). It is not the resurrection
//    of the previous lease: the old lease stays in its grace, the per-lease
//    monotonicity stays intact and the old deadline becomes irrelevant.
//  - Past the grace the reconnect is refused: reattach of an expired
//    lease returns null.

const crypto = require('node:crypto');

const GRACE_MS = 60_000;             // grace: 60s from EOF, not extendable
const REFRESH_MS = 20_000;           // refresh cadence 20s (supervisor-side heartbeat)
const RECONNECT_CADENCE_MS = 20_000; // >=2 attempts strictly inside the grace window

function isInt(v) { return Number.isSafeInteger(v); }
function validId(v, max = 128) { return typeof v === 'string' && v.length > 0 && v.length <= max; }
function validLeaseId(v) { return typeof v === 'string' && /^[a-f0-9]{16,64}$/.test(v); }

function newLeaseId() { return crypto.randomBytes(16).toString('hex'); }

// Apertura del lease: prima connessione (post-payload). Nasce Live, senza grace.
function openLease({ cellId, launchEpoch, generation, leaseId, now }) {
  if (!validId(cellId) || !validId(launchEpoch) || !isInt(generation) || generation < 0
    || !validLeaseId(leaseId) || !isInt(now)) return null;
  return {
    cellId, launchEpoch, generation, leaseId,
    state: 'live',
    openedAt: now,
    lastRefreshedAt: now,
    eofArmedAt: null,
    graceDeadline: null,
  };
}

// EOF arma UNA sola transizione monotona Live -> Grace. Su un lease gia' in Grace
// is a no-op (returns the same lease): the deadline is NOT extendable.
function armGrace(lease, { now } = {}) {
  if (!lease || !isInt(now)) return null;
  if (lease.state === 'grace') return lease;
  const next = { ...lease };
  next.state = 'grace';
  next.eofArmedAt = now;
  next.graceDeadline = now + GRACE_MS;
  return next;
}

// Refresh: heartbeat lato supervisore (cad 20s). Aggiorna lastRefreshedAt. NON
// never changes state and never brings a Grace lease back to Live. Hook for the
// HMAC proof rotation; today it is application liveness + ack only.
function refresh(lease, { now } = {}) {
  if (!lease || !isInt(now)) return null;
  return { ...lease, lastRefreshedAt: now };
}

// Successful reconnect: NEW lease (new leaseId), SAME identity
// cellId+launchEpoch (the generation may advance), state Live. Past the
// grace the reconnect is refused -> null. The old lease stays in its grace.
function reattach(lease, { leaseId, generation, now } = {}) {
  if (!lease || !validLeaseId(leaseId) || !isInt(generation) || generation < 0 || !isInt(now)) return null;
  if (lease.state === 'grace' && now >= lease.graceDeadline) return null;
  return {
    cellId: lease.cellId,
    launchEpoch: lease.launchEpoch,
    generation,
    leaseId,
    state: 'live',
    openedAt: now,
    lastRefreshedAt: now,
    eofArmedAt: null,
    graceDeadline: null,
  };
}

function isLive(lease) {
  return !!lease && lease.state === 'live';
}

function isGrace(lease, { now = Date.now() } = {}) {
  return !!lease && lease.state === 'grace' && isInt(now) && lease.graceDeadline != null && now < lease.graceDeadline;
}

function isExpired(lease, { now = Date.now() } = {}) {
  return !!lease && lease.state === 'grace' && isInt(now) && lease.graceDeadline != null && now >= lease.graceDeadline;
}

// Chiave composita di identita' per la map lato server (modello rotatableReverse).
function identityKey(cellId, launchEpoch, generation) {
  if (!validId(cellId) || !validId(launchEpoch) || !isInt(generation) || generation < 0) return null;
  return `${cellId}:${launchEpoch}:${generation}`;
}

module.exports = {
  GRACE_MS, REFRESH_MS, RECONNECT_CADENCE_MS,
  newLeaseId, openLease, armGrace, refresh, reattach,
  isLive, isGrace, isExpired, identityKey,
};
