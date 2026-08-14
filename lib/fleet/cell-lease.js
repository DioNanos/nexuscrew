'use strict';

// Pure state transitions for the supervisor lease of a Live host cell.
//
// Contratto rev12 R3 + rev13 S3 + rev22. Il canale lease e' la connessione UDS
// accettata col nonce one-shot del launch-broker che RESTA APERTA dopo il frame
// payload (R3.1.1); dopo un EOF il supervisore si riconnette a un endpoint
// stabile (R3.3.2). Qui vivono SOLO le transizioni di stato del lease: i side
// effect (socket, timer, EOF handling) stanno nel LeaseManager e nei caller.
// Modello speculare a lib/nodes/reverse-rotation.js (clone + arg validation),
// cosi' i casi crash/replay sono espliciti e testabili senza socket.
//
// Invarianti normativi ribaditi nel codice:
//  - EOF arma UNA sola transizione monotona Live -> Grace (R3.1.3); la deadline
//    e' non estendibile: un secondo armGrace su un lease in Grace e' no-op.
//  - Nessuna operazione riporta in Live un lease gia' in Grace: refresh e armGrace
//    non cambiano lo stato di un lease in Grace. Solo reattach crea un lease NUOVO.
//  - reattach (R3.3.4) produce un lease con leaseId NUOVO e STESSA identita'
//    cellId+launchEpoch (la generation puo' avanzare). Non e' la resurrezione del
//    lease precedente: il vecchio lease resta nella sua grace, la monotonia
//    per-lease resta intatta e la vecchia deadline diventa irrilevante.
//  - Oltre la grace il reconnect e' rifiutato (R3.3.5): reattach di un lease
//    scaduto restituisce null.

const crypto = require('node:crypto');

const GRACE_MS = 60_000;             // R3.2: grace 60s dall'EOF, non estendibile
const REFRESH_MS = 20_000;           // R3.2: cadenza refresh 20s (heartbeat lato supervisore)
const RECONNECT_CADENCE_MS = 20_000; // rev13 S3.3: >=2 tentativi strettamente dentro la grace

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
// e' no-op (ritorna lo stesso lease): la deadline NON si estende (R3.1.3).
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
// cambia state e NON riporta in Live un lease in Grace (R3.1.3). Hook per la
// rotazione del proof HMAC (fetta 2b); in 2a e' solo liveness applicativa + ack.
function refresh(lease, { now } = {}) {
  if (!lease || !isInt(now)) return null;
  return { ...lease, lastRefreshedAt: now };
}

// Reconnect riuscito (R3.3.4): lease NUOVO (leaseId nuovo), STESSA identita'
// cellId+launchEpoch (la generation puo' avanzare), state Live. R3.3.5: oltre la
// grace il reconnect e' rifiutato -> null. Il vecchio lease resta nella sua grace.
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
