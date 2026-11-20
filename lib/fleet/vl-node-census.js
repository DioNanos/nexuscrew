'use strict';
// Process-level census of the builtin fleet runtimes that can reach the
// qualified Node runtime (vl-node-runtime.js) through the production graph
// runtime.js -> vl-roots.js -> vl-node-runtime.js. The caller that retires
// or seals is part of that graph; a caller outside it imports
// vl-node-runtime.js directly, is NOT censused here and never receives the
// process owner or an automatic wiring.
//
// The census covers EVERY runtime created by the createBuiltinRuntime
// factory, including programmatic servers and runtimes that never produced
// a pin: registration is synchronous in the factory, right after the claim
// tracker is created and BEFORE the runtime object is exposed or can reach
// vl-roots/vl-node-runtime. There is no lazy registration at the first
// qualification, and the census never resets for a new server, home or
// Fleet: it is module state for the whole process.
//
// This is an internal module. register/retire/seal/snapshot are not network
// or configuration APIs; producer tokens are opaque object identities and
// no numeric or string value supplied by a caller can retire another
// producer. There are no separate read wrappers: snapshot() is the only
// reading that may feed a cleanup proof, and a proof is never assembled
// from different snapshots.
//
// Admission fence: sealAdmission is synchronous, permanent and idempotent
// for the same owner. It runs at the start of the owning coordinator's
// shutdown, before its waits. After the fence a new factory/runtime refuses
// before it can produce or use the qualified Node runtime; no new record,
// retry or new epoch bypasses it. Producers already admitted stay censused
// until their attested close retires them, so an in-progress factory
// suspended before its registration can never appear later as an
// authorized producer ignoring the fence.
//
// claims and consumers overlap by design: the tracker snapshot does not
// separate admitted/pre-spawn uses from live children, so both numbers are
// the same conservative sum. They prove ZERO together and are never summed
// as disjoint classes of events.

const CENSUS = {
  admissionClosed: false,
  sealedBy: null,
  producers: new Map(), // token (opaque object identity) -> { readState, retireRefused }
  serial: 0,
};

const genuineOwners = new WeakSet();

// The process owner is minted here and nowhere else; construction is
// reserved for the CLI serve dispatch branch, which is the only authority
// that may close admissions for the whole process.
function createAdmissionOwner() {
  const owner = Object.freeze(Object.create(null));
  genuineOwners.add(owner);
  return owner;
}

function isGenuineOwner(owner) {
  return owner !== null && typeof owner === 'object' && genuineOwners.has(owner);
}

// Synchronous registration from the runtime factory. Returns the opaque
// token, or null when the admission fence is closed (the factory must then
// refuse before the runtime is exposed) or the readState is not callable.
function registerProducer(readState) {
  if (CENSUS.admissionClosed) return null;
  if (typeof readState !== 'function') return null;
  CENSUS.serial += 1;
  const token = Object.freeze(Object.create(null));
  CENSUS.producers.set(token, { readState, retireRefused: false });
  return token;
}

function isCount(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
}

// Live reading of one producer's own state at this instant. Returns the
// coherent claim counts, or null when the reading throws, is missing, has
// wrong fields or the three tracker counts do not satisfy
// activeCount = attestedActive + unattestedCount.
function readProducerCounts(entry) {
  let s;
  try {
    s = entry.readState();
  } catch (_) {
    return null;
  }
  if (!s || typeof s !== 'object') return null;
  if (!isCount(s.activeCount) || !isCount(s.attestedActive) || !isCount(s.unattestedCount)) return null;
  if (s.activeCount !== s.attestedActive + s.unattestedCount) return null;
  return { activeCount: s.activeCount, attestedActive: s.attestedActive, unattestedCount: s.unattestedCount };
}

// Fresh frozen reading of the whole census. producers is the number of
// non-retired tokens; claims is the conservative sum of the live
// activeCount of every producer; consumers is the same sum used as the
// conservative bound of still-admitted uses. A thrown, missing, wrong or
// incoherent reading, or an overflowing sum, makes attestable false and
// the non-attestable counts null — never zero.
function snapshot() {
  let attestable = true;
  let claims = 0;
  for (const entry of CENSUS.producers.values()) {
    const counts = readProducerCounts(entry);
    if (counts === null) {
      attestable = false;
      break;
    }
    claims += counts.activeCount;
  }
  if (attestable && !Number.isSafeInteger(claims)) attestable = false;
  return Object.freeze({
    admissionClosed: CENSUS.admissionClosed,
    attestable,
    producers: CENSUS.producers.size,
    claims: attestable ? claims : null,
    consumers: attestable ? claims : null,
  });
}

// Retirement is possible only from the close block of the builtin Fleet
// that owns the token, before it delivers its own outcome. It requires a
// green raw close outcome AND a live reading of this producer's runtime
// and tracker at this instant. A first failed attempt is final: an
// error/incomplete/expired raw never requalifies later as green. Retired
// tokens leave no tombstone: their resources are attested and the runtime
// stays disarmed.
function retireProducer(token, rawCloseOutcome) {
  const entry = CENSUS.producers.get(token);
  if (!entry || entry.retireRefused) return false;
  const raw = rawCloseOutcome;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    entry.retireRefused = true;
    return false;
  }
  if (raw.disarmed !== true || raw.disarmedBeforeWait !== true
    || raw.quiescent !== true || raw.canCleanupOwnedResources !== true
    || raw.timedOut !== false || raw.budgetExhausted !== false
    || raw.activeOpsRemaining !== 0) {
    entry.retireRefused = true;
    return false;
  }
  if (!Array.isArray(raw.codes) || raw.codes.length !== 0) {
    entry.retireRefused = true;
    return false;
  }
  let s;
  try {
    s = entry.readState();
  } catch (_) {
    entry.retireRefused = true;
    return false;
  }
  if (!s || typeof s !== 'object') {
    entry.retireRefused = true;
    return false;
  }
  if (s.disarmed !== true || s.inFlightOps !== 0 || s.canCleanupOwnedResources !== true
    || s.drainExpired !== false
    || !isCount(s.activeCount) || !isCount(s.attestedActive) || !isCount(s.unattestedCount)
    || s.activeCount !== 0 || s.attestedActive !== 0 || s.unattestedCount !== 0
    || s.activeCount !== s.attestedActive + s.unattestedCount) {
    entry.retireRefused = true;
    return false;
  }
  CENSUS.producers.delete(token);
  return true;
}

// Permanent, synchronous admission fence. Idempotent for the same owner;
// a different owner never replaces the one already in charge.
function sealAdmission(owner) {
  if (!isGenuineOwner(owner)) return { ok: false, reason: 'owner-invalid' };
  if (CENSUS.admissionClosed) {
    if (CENSUS.sealedBy === owner) return { ok: true, already: true };
    return { ok: false, reason: 'already-sealed' };
  }
  CENSUS.admissionClosed = true;
  CENSUS.sealedBy = owner;
  return { ok: true, already: false };
}

module.exports = {
  registerProducer,
  retireProducer,
  sealAdmission,
  snapshot,
  createAdmissionOwner,
};
