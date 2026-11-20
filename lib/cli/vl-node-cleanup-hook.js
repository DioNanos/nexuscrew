'use strict';
// Private cleanup hook of the CLI serve authority for the incarnation
// cleanup of the qualified Node runtime (lib/fleet/vl-node-runtime.js).
// This is the ONLY module that requires both that runtime and the process
// census: the production graph stays runtime factory -> roots -> qualified
// Node runtime for every producer, and the adapter here is the single
// meeting point of the registry and the census for a cleanup proof.
//
// Nothing here is a network or configuration surface. The process owner is
// minted only for the CLI serve dispatch branch, the owned-hook binding is
// a private in-process WeakMap keyed by the server's shutdownController
// identity, and no option or environment variable installs any of it.
// A programmatic server (createServer / serve(opts) with an injected
// coordinator) never receives an owner: its afterDrainHook keeps the
// legacy behavior untouched.
//
// One adapter and one terminal outcome exist per owner and process — not
// one per createCleanupHook() call and not one per server. The first
// outcome of the adapter, refusal included, is terminal for this owned
// shutdown: a later invocation replays it without rebuilding the proof and
// without calling the cleanup again.

const vlNodeRuntime = require('../fleet/vl-node-runtime.js');
const vlNodeCensus = require('../fleet/vl-node-census.js');

const ATTEST_FIELDS = [
  'localAdmissionClosed', 'localDisarmErrors', 'fleetRaw', 'updaterQuiescent',
  'updaterHandoff', 'nowMono', 'serverFinalized',
];
const OUTCOME_FIELDS = ['schema', 'outcome', 'reason', 'counts', 'replayed'];
const SUMMARY_FIELDS = ['outcome', 'reason', 'counts'];
const COUNT_FIELDS = [
  'candidates', 'removed', 'alreadyAbsent', 'skipped', 'residues', 'durabilityUnattested',
];
const REFUSED_REASONS = ['proof-invalid', 'nonce-mismatch', 'not-quiescent'];
const INCOMPLETE_REASONS = ['proof-invalid', 'deadline-exhausted', 'io-error', 'residues'];
const FLEET_RAW_FIELDS = [
  'disarmed', 'disarmedBeforeWait', 'quiescent', 'timedOut', 'budgetExhausted',
  'activeOpsRemaining', 'canCleanupOwnedResources', 'codes',
];
const FLEET_CLAIM_FIELDS = ['idle', 'timedOut', 'activeCount', 'attestedActive', 'unattestedCount', 'drainExpired'];

// --- process owner ----------------------------------------------------------

const mintedOwners = new WeakSet();

// Reserved for the CLI serve dispatch branch: the only caller that may
// create the process owner and close admissions for the whole process.
function createProcessOwner() {
  const owner = vlNodeCensus.createAdmissionOwner();
  mintedOwners.add(owner);
  return owner;
}

function isMintedOwner(owner) {
  return owner !== null && typeof owner === 'object' && mintedOwners.has(owner);
}

// --- owned-hook binding (WeakMap by shutdownController identity) -----------

const OWNED_BINDINGS = new WeakMap(); // shutdownController -> { owner, hook }
const OWNER_CORES = new WeakMap(); // owner -> { hook, terminal, sealed, coordinatorFinalized }

function ownerCore(owner) {
  let core = OWNER_CORES.get(owner);
  if (!core) {
    core = { hook: null, terminal: null, sealed: false, coordinatorFinalized: false };
    core.hook = buildOwnedAdapter(owner, core);
    OWNER_CORES.set(owner, core);
  }
  return core;
}

function bindOwnedHook(shutdownController, owner) {
  if (!shutdownController || typeof shutdownController !== 'object'
    || typeof shutdownController.closeOrdered !== 'function') {
    return { ok: false, reason: 'controller-invalid' };
  }
  if (!isMintedOwner(owner)) return { ok: false, reason: 'owner-invalid' };
  const existing = OWNED_BINDINGS.get(shutdownController);
  if (existing) {
    if (existing.owner === owner) return { ok: true, already: true };
    return { ok: false, reason: 'already-bound' };
  }
  OWNED_BINDINGS.set(shutdownController, { owner, hook: ownerCore(owner).hook });
  return { ok: true, already: false };
}

function unbindOwnedHook(shutdownController) {
  return OWNED_BINDINGS.delete(shutdownController);
}

function readOwnedHook(shutdownController) {
  const binding = OWNED_BINDINGS.get(shutdownController);
  if (!binding) return null;
  return { owner: binding.owner, hook: binding.hook };
}

// --- admission fence of the owner's coordinator ----------------------------

function sealAdmissionFor(owner) {
  if (!isMintedOwner(owner)) return { ok: false, reason: 'owner-invalid' };
  const res = vlNodeCensus.sealAdmission(owner);
  if (res.ok) ownerCore(owner).sealed = true;
  return res;
}

// The owning coordinator closes its own finalization state here, BEFORE
// delivering its final outcome or invoking exit. The closure is private to
// the owner, one-way and idempotent: a delayed entry of the adapter that
// actually runs past it refuses without reopening anything and without a
// second epoch of any kind.
function markCoordinatorFinalized(owner) {
  if (!isMintedOwner(owner)) return false;
  ownerCore(owner).coordinatorFinalized = true;
  return true;
}

// --- adapter: attest -> proof -> cleanupInstance ---------------------------

function refusedRecord(reason) {
  return Object.freeze({
    schema: 1,
    outcome: 'refused',
    reason,
    counts: Object.freeze({
      candidates: 0, removed: 0, alreadyAbsent: 0, skipped: 0, residues: 0, durabilityUnattested: 0,
    }),
    replayed: false,
  });
}

function deadlineExhaustedRecord() {
  return Object.freeze({
    schema: 1,
    outcome: 'incomplete',
    reason: 'deadline-exhausted',
    counts: Object.freeze({
      candidates: 0, removed: 0, alreadyAbsent: 0, skipped: 0, residues: 0, durabilityUnattested: 0,
    }),
    replayed: false,
  });
}

// A plain record of own data only: exactly the expected string keys, a
// plain prototype (Object.prototype or null) and no accessor property.
// Accessors and foreign prototypes are refused BEFORE any value is read:
// the check inspects property descriptors, so a getter is never executed
// and a class instance carrying green-looking fields is never interpreted
// as data of its own.
function isPlainDataRecord(record, fields) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  let keys;
  let proto;
  try {
    keys = Reflect.ownKeys(record);
    proto = Object.getPrototypeOf(record);
  } catch (_) {
    return false;
  }
  if (proto !== Object.prototype && proto !== null) return false;
  if (keys.length !== fields.length) return false;
  for (const k of keys) {
    if (typeof k !== 'string' || !fields.includes(k)) return false;
    let d;
    try { d = Object.getOwnPropertyDescriptor(record, k); } catch (_) { return false; }
    if (!d || d.get !== undefined || d.set !== undefined) return false;
  }
  return true;
}

// The attest is a closed record of the server's original typed values. A
// missing, extra, symbol, wrongly typed or non-fresh attest refuses with
// proof-invalid before anything else runs.
function readAttest(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;
  const attest = ctx.attest;
  if (!attest || typeof attest !== 'object' || Array.isArray(attest)) return null;
  if (!isPlainDataRecord(attest, ATTEST_FIELDS)) return null;
  if (typeof attest.localAdmissionClosed !== 'boolean') return null;
  if (!Number.isSafeInteger(attest.localDisarmErrors) || attest.localDisarmErrors < 0) return null;
  if (typeof attest.updaterQuiescent !== 'boolean') return null;
  if (typeof attest.updaterHandoff !== 'boolean') return null;
  if (typeof attest.nowMono !== 'function') return null;
  // The finalization of the server travels as a LIVE verification function,
  // not as a boolean photographed when the attest was built: the adapter
  // reads it at its actual entry, so a callback delayed past the server's
  // own final result can never ride a stale false.
  if (typeof attest.serverFinalized !== 'function') return null;
  if (!attest.fleetRaw || typeof attest.fleetRaw !== 'object' || Array.isArray(attest.fleetRaw)) return null;
  return attest;
}

// The Fleet class of the attest: present=true demands the raw close outcome
// with every field exact; present=false is admitted ONLY from the known
// disabled/off provenance; null and anything else stay UNKNOWN and never
// become an attested absence. Returns {fleetDisarmed, canCleanupOwnedResources,
// positive} or {formMissing:true}.
function classifyFleetRaw(fleetRaw) {
  const present = fleetRaw.present;
  if (present === false) {
    if (fleetRaw.provenance !== 'disabled') return { negative: true };
    // Vacuous attestation of the disabled Fleet: no missing Fleet datum is
    // ever filled with true here; the global zero proof still applies.
    return { fleetDisarmed: true, canCleanupOwnedResources: true, positive: true };
  }
  if (present !== true) return { negative: true };
  const raw = fleetRaw.raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { formMissing: true };
  for (const f of FLEET_RAW_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(raw, f)) return { formMissing: true };
  }
  if (typeof raw.disarmed !== 'boolean' || typeof raw.disarmedBeforeWait !== 'boolean'
    || typeof raw.quiescent !== 'boolean' || typeof raw.timedOut !== 'boolean'
    || typeof raw.budgetExhausted !== 'boolean'
    || typeof raw.canCleanupOwnedResources !== 'boolean') {
    return { formMissing: true };
  }
  if (!Number.isSafeInteger(raw.activeOpsRemaining) || raw.activeOpsRemaining < 0) return { formMissing: true };
  if (!Array.isArray(raw.codes)) return { formMissing: true };
  const claims = raw.claims;
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) return { formMissing: true };
  for (const f of FLEET_CLAIM_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(claims, f)) return { formMissing: true };
  }
  if (typeof claims.idle !== 'boolean' || typeof claims.timedOut !== 'boolean'
    || typeof claims.drainExpired !== 'boolean') {
    return { formMissing: true };
  }
  for (const f of ['activeCount', 'attestedActive', 'unattestedCount']) {
    if (!Number.isSafeInteger(claims[f]) || claims[f] < 0) return { formMissing: true };
  }
  // A complete raw with negative requirements is a refusal of quiescence,
  // not a form failure.
  const allTrue = raw.disarmed === true && raw.disarmedBeforeWait === true
    && raw.quiescent === true && raw.canCleanupOwnedResources === true;
  const allQuiet = raw.timedOut === false && raw.budgetExhausted === false
    && raw.activeOpsRemaining === 0 && raw.codes.length === 0
    && claims.idle === true && claims.timedOut === false && claims.drainExpired === false
    && claims.activeCount === 0 && claims.attestedActive === 0 && claims.unattestedCount === 0;
  if (!allTrue || !allQuiet) return { negative: true };
  return { fleetDisarmed: true, canCleanupOwnedResources: true, positive: true };
}

function ctxCountsAllZero(counts) {
  if (!counts || typeof counts !== 'object' || Array.isArray(counts)) return false;
  for (const f of ['activeOps', 'activeClaims', 'forcedConnections', 'residues']) {
    if (!Object.prototype.hasOwnProperty.call(counts, f)) return false;
    const v = counts[f];
    if (!Number.isSafeInteger(v) || v !== 0) return false;
  }
  return true;
}

function runAdapter(owner, core, ctx) {
  const attest = readAttest(ctx);
  if (!attest) return refusedRecord('proof-invalid');
  // Freshness of THIS shutdown, read LIVE at the actual entry: the server
  // must not have finalized its own result when the callback really runs.
  // A throw, a missing or a non-false reading is a refusal — never a
  // default to "not finalized".
  let serverFinalized;
  try {
    serverFinalized = attest.serverFinalized();
  } catch (_) {
    return refusedRecord('proof-invalid');
  }
  if (serverFinalized !== false) return refusedRecord('proof-invalid');
  const deadlineMono = ctx.deadlineMono;
  if (typeof deadlineMono !== 'number' || !Number.isFinite(deadlineMono)) return refusedRecord('proof-invalid');
  // The owning coordinator's own finalization state, closed privately in
  // the owner before its final outcome/exit: an entry that actually runs
  // past that closure refuses before any new round.
  if (core.coordinatorFinalized === true) return refusedRecord('proof-invalid');
  // The owner-side global state: the fence of this owner must be closed.
  if (core.sealed !== true) return refusedRecord('not-quiescent');
  // One fresh census reading, under the fence, at the actual callback
  // instant. Every census number of the proof comes from this snapshot.
  const snap = vlNodeCensus.snapshot();
  if (snap.admissionClosed !== true) return refusedRecord('not-quiescent');
  // The original clock of the server: finite, and still before the original
  // deadline. An expired clock concludes incomplete without new operations.
  let now;
  try { now = attest.nowMono(); } catch (_) { return refusedRecord('proof-invalid'); }
  if (!Number.isFinite(now)) return refusedRecord('proof-invalid');
  if (now >= deadlineMono) return deadlineExhaustedRecord();
  // Fleet class.
  const fleet = classifyFleetRaw(attest.fleetRaw);
  if (fleet.formMissing) return refusedRecord('proof-invalid');
  // processDisarmed: valid owner (this adapter only runs bound to a minted
  // owner), the census fence closed, the server locally disarmed with zero
  // disarm errors.
  const processDisarmed = attest.localAdmissionClosed === true && attest.localDisarmErrors === 0;
  // processQuiescent: everything above plus the server's own pre-hook
  // judgement, its counts and codes at zero, the census attestable and at
  // zero, the updater quiet without handoff, and a positive Fleet class.
  const processQuiescent = processDisarmed
    && ctx.quiescent === true && ctx.timedOut === false
    && ctxCountsAllZero(ctx.counts)
    && Array.isArray(ctx.codes) && ctx.codes.length === 0
    && snap.attestable === true && snap.producers === 0 && snap.claims === 0 && snap.consumers === 0
    && attest.updaterQuiescent === true && attest.updaterHandoff === false
    && fleet.positive === true;
  if (!processDisarmed || !processQuiescent) return refusedRecord('not-quiescent');
  // Exactly the ten frozen proof fields, nonce from the live registry,
  // counts from the same census snapshot, the original deadline and the
  // server's own clock function as the cleanup clock.
  const registry = vlNodeRuntime.getCreationRegistry();
  const nonce = registry && Object.prototype.hasOwnProperty.call(registry, 'nonce')
    ? registry.nonce : undefined;
  if (nonce !== null && typeof nonce !== 'string') return refusedRecord('proof-invalid');
  const proof = {
    nonce,
    processDisarmed: true,
    processQuiescent: true,
    fleetDisarmed: true,
    timedOut: false,
    producers: snap.producers,
    claims: snap.claims,
    consumers: snap.consumers,
    canCleanupOwnedResources: true,
    deadlineMono,
  };
  return vlNodeRuntime.cleanupInstance(proof, { monotonicNow: attest.nowMono });
}

function buildOwnedAdapter(owner, core) {
  return function ownedCleanupHook(ctx) {
    // The first outcome of this adapter is terminal for this owned
    // shutdown; a later invocation replays it without rebuilding anything.
    if (core.terminal !== null) {
      const t = core.terminal;
      return Object.freeze({
        schema: t.schema, outcome: t.outcome, reason: t.reason, counts: t.counts, replayed: true,
      });
    }
    let record;
    try {
      record = runAdapter(owner, core, ctx);
    } catch (_) {
      record = refusedRecord('proof-invalid');
    }
    if (!record || typeof record !== 'object') record = refusedRecord('proof-invalid');
    core.terminal = record;
    return record;
  };
}

// Per-server cleanup hook factory: every server bound to the same owner
// shares the one adapter and its single terminal outcome.
function createCleanupHook(owner) {
  if (!isMintedOwner(owner)) return null;
  return ownerCore(owner).hook;
}

// --- validation of the cleanup outcome the server received -----------------

// A closed record of plain data only: own keys exactly the five expected
// string names on a plain prototype with no accessor, numeric schema 1,
// contract outcome/reason values, six own safe-integer counts in 0..256
// and a boolean replayed flag, with the semantic coherence of each
// admitted outcome — the counts record is a plain data record of its own.
// Accessors and foreign prototypes are malformed WITHOUT being read. Any
// exception or contradiction is a malformed result; the raw value is
// never serialized.
function validateOutcomeContract(outcome, reason, countsRec) {
  if (outcome !== 'done' && outcome !== 'incomplete' && outcome !== 'refused') return { valid: false };
  if (reason !== null && typeof reason !== 'string') return { valid: false };
  if (!isPlainDataRecord(countsRec, COUNT_FIELDS)) return { valid: false };
  const counts = {};
  for (const f of COUNT_FIELDS) {
    const v = countsRec[f];
    if (!Number.isSafeInteger(v) || v < 0 || v > 256) return { valid: false };
    counts[f] = v;
  }
  if (outcome === 'done') {
    if (reason !== null) return { valid: false };
    if (counts.residues !== 0 || counts.skipped !== 0 || counts.durabilityUnattested !== 0) return { valid: false };
    if (counts.candidates !== counts.removed + counts.alreadyAbsent) return { valid: false };
  } else if (outcome === 'refused') {
    if (!REFUSED_REASONS.includes(reason)) return { valid: false };
    for (const f of COUNT_FIELDS) {
      if (counts[f] !== 0) return { valid: false };
    }
  } else if (!INCOMPLETE_REASONS.includes(reason)) {
    return { valid: false };
  }
  // Coherence of every admitted outcome.
  if (counts.removed + counts.alreadyAbsent > counts.candidates) return { valid: false };
  if (counts.skipped !== counts.residues) return { valid: false };
  if (counts.removed + counts.alreadyAbsent + counts.residues > 256) return { valid: false };
  if (counts.durabilityUnattested > counts.removed) return { valid: false };
  return {
    valid: true,
    cleanup: Object.freeze({ outcome, reason, counts: Object.freeze(counts) }),
  };
}

function validateCleanupOutcome(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { valid: false };
    if (!isPlainDataRecord(value, OUTCOME_FIELDS)) return { valid: false };
    if (value.schema !== 1) return { valid: false };
    if (typeof value.replayed !== 'boolean') return { valid: false };
    return validateOutcomeContract(value.outcome, value.reason, value.counts);
  } catch (_) {
    return { valid: false };
  }
}

// Validate the normalized public cleanup summary ({ outcome, reason, counts })
// separately from the raw hook record: no schema/replayed field is invented or
// backfilled, and accessors or foreign prototypes are refused BEFORE reading.
function validateCleanupSummary(summary) {
  try {
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) return { valid: false };
    if (!isPlainDataRecord(summary, SUMMARY_FIELDS)) return { valid: false };
    return validateOutcomeContract(summary.outcome, summary.reason, summary.counts);
  } catch (_) {
    return { valid: false };
  }
}

// Pure read-only verification for the owning coordinator: confirms that the
// delivered normalized summary is a coherent 'done' summary AND matches the
// private terminal record actually produced by this owner's sealed hook.
// Never invokes the hook, never creates an owner core and never mutates state.
function verifyAttestedOwnedDone(owner, summary) {
  if (summary === null || summary === undefined) {
    return { attested: false, code: 'CLEANUP_REFUSED' };
  }
  const summaryVerdict = validateCleanupSummary(summary);
  if (!summaryVerdict.valid) {
    return { attested: false, code: 'CLEANUP_MALFORMED' };
  }
  if (summaryVerdict.cleanup.outcome !== 'done') {
    return { attested: false, code: 'CLEANUP_REFUSED' };
  }
  if (!isMintedOwner(owner)) {
    return { attested: false, code: 'CLEANUP_REFUSED' };
  }
  const core = OWNER_CORES.get(owner);
  if (!core || core.sealed !== true || core.terminal === null) {
    return { attested: false, code: 'CLEANUP_REFUSED' };
  }
  const terminalVerdict = validateCleanupOutcome(core.terminal);
  if (!terminalVerdict.valid || terminalVerdict.cleanup.outcome !== 'done' || terminalVerdict.cleanup.reason !== null) {
    return { attested: false, code: 'CLEANUP_REFUSED' };
  }
  for (const f of COUNT_FIELDS) {
    if (summaryVerdict.cleanup.counts[f] !== terminalVerdict.cleanup.counts[f]) {
      return { attested: false, code: 'CLEANUP_REFUSED' };
    }
  }
  return { attested: true, code: null };
}

module.exports = {
  createProcessOwner,
  bindOwnedHook,
  unbindOwnedHook,
  readOwnedHook,
  sealAdmissionFor,
  markCoordinatorFinalized,
  createCleanupHook,
  validateCleanupOutcome,
  verifyAttestedOwnedDone,
};
