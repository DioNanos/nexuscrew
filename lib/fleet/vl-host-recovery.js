'use strict';
// Host recovery attempt bookkeeping and the durable event writer.
//
// This module owns, at this increment:
//   - the closed vocabulary of recovery events and its schema;
//   - the durable store of those events under <stateDir>/recovery-events,
//     written one event at a time through an exclusively created temporary,
//     never over an existing name and never replayed;
//   - the RAM reservation that is taken BEFORE any effect and counted against
//     the store capacity together with the files already on disk;
//   - the read-only classification of an existing store;
//   - `recover`: entry, consent, trace, kernel snapshot, isolation judgement,
//     the durable intent, the synchronous TERM window, the wait for the
//     original process to leave, the host barrier and the outcomes.
//
// The guards are pure: they answer a strict boolean, never convert, never
// mutate and never touch the disk. The factory is opaque and does no I/O in
// construction; `readTrace` never creates, chmods or syncs anything. Creating
// and syncing a directory belongs to the writer that prepares the store.
//
// The only signal this module sends is SIGTERM, and only from the operational
// window of `recover`: the intent is durable before the syscall, a fresh
// snapshot and a synchronous fence precede it, and no await stands between the
// last snapshot and the syscall. The return value of the syscall is never
// evidence of death — only the kernel and the root can attest an exit — and a
// failure to persist the event that follows the syscall is a stop with no
// escalation and no new signal.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const hostStop = require('./vl-host-stop.js');
const { pubblicaEsclusiva } = require('./exclusive-publish.js');

// Closed event vocabulary. `peer-verified` exists for the later increment that
// performs a fresh positive proof of the original peer; it is already part of
// the schema and of the capacity reservation.
const EVENT_KINDS = Object.freeze([
  'cli-attempt',
  'peer-verified',
  'cli-ack',
  'cli-refusal',
  'cli-failed',
  'intent-term',
  'signaled-term',
  'intent-kill',
  'signaled-kill',
  'exited',
  'closed',
]);

const KIND_SET = new Set(EVENT_KINDS);
const COMMON_KEYS = Object.freeze(['version', 'launchId', 'attemptId', 'seq', 'kind', 'contextDigest']);

// Per-kind additional fields. Anything outside common keys plus these is a
// schema violation: a closed schema cannot carry a token, a hash of one, or a
// free-text reason.
const STOP_REASONS = hostStop.STOP_REASONS;
const PROTECTED_REFUSALS = new Set(['peer_mismatch', 'peer_unknown', 'expected_invalid']);
const CLI_FAILED_REASONS = new Set([
  ...STOP_REASONS.filter((r) => r !== 'shutdown_ack' && !PROTECTED_REFUSALS.has(r)),
  'spawn',
  'unattested',
  'truncated',
  'io',
]);
const CLI_REFUSAL_REASONS = new Set(['peer_mismatch', 'peer_unknown', 'expected_invalid']);
const SIGNAL_REASONS = new Set(['sent', 'esrch', 'eperm', 'error']);
// A term authorizes the escalation only when its syscall answered that the
// signal was delivered. A refusal of the kernel and any reason outside this
// closed list are not a delivery, and no later handle can turn them into one.
const ESCALATION_REASONS = new Set(['sent']);
const EXIT_REASONS = new Set(['absent', 'pid-reused', 'zombie']);
const METHODS = new Set(['term', 'kill']);

const MAX_FILES = 64;
const MAX_EVENT_BYTES = 2048;
const MAX_PAYLOAD_BYTES = 131072;

// One more slot than the events an attempt may append: the technical temporary
// needs a place of its own, and a temporary is not a free slot.
//
// The read-only branch — a silent entry without consent to recovery — writes
// nothing at all: no intent, no event, no signal. A reservation there would
// subtract places from a path that cannot use them, so it holds zero slots and
// takes no place in the process.
const RESERVED_SLOTS = Object.freeze({
  'expected/recovery': 10,
  'expected/no-recovery': 4,
  'silent/recovery': 8,
  'silent/no-recovery': 0,
});

const PHASE_IDS = Object.freeze(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9']);
const MIN_BUDGET = 200;
const MAX_BUDGET = 15000;
const PLAN_KEYS = Object.freeze(['budgetMs', 'deadlineAt', 'marginMs', 'phases']);
const PHASE_KEYS = Object.freeze(['id', 'capMs', 'allowanceMs']);

const RE_HEX16 = /^[a-f0-9]{16}$/;
const RE_HEX32 = /^[a-f0-9]{32}$/;
const RE_HEX64 = /^[a-f0-9]{64}$/;
const RE_EVENT_NAME = /^(\d{8})-([a-z-]+)\.json$/;
const RE_TEMP_NAME = /^\.tmp-[a-f0-9]{32}$/;

// ---------------------------------------------------------------------------
// Pure guards
// ---------------------------------------------------------------------------

// A pid is usable only as a safe integer strictly greater than one. Nothing is
// converted: a numeric string, a float, a boolean or an out-of-range integer is
// simply not a pid.
function guardPid(pid) {
  return Number.isSafeInteger(pid) && pid > 1;
}

// A record authorizes signals only when it is a complete v2 launch context with
// a live kernel identity. Pending, none and legacy shapes are readable formats
// without authority. The record is not mutated.
// The record an attempt works on is the one it admitted, not the object the
// caller still holds. A private copy, frozen together with its identity, is
// taken before the guard runs: from there the handle reads only values it owns,
// so a caller that rewrites the pid or an identity field after the admission
// cannot move the target of a signal. A record that cannot be copied is not
// admitted, and the refusal leaves no place behind.
function congelaRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return record;
  const copia = { ...record };
  const identita = record.hostIdentity;
  if (identita && typeof identita === 'object' && !Array.isArray(identita)) {
    copia.hostIdentity = Object.freeze({ ...identita });
  }
  return Object.freeze(copia);
}

function guardRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return false;
  if (record.version !== 2) return false;
  if (typeof record.launchId !== 'string' || !RE_HEX16.test(record.launchId)) return false;
  if (typeof record.vlBinSha256 !== 'string' || !RE_HEX64.test(record.vlBinSha256)) return false;
  if (typeof record.serverRoot !== 'string' || !record.serverRoot || record.serverRoot.includes('\0')) return false;
  const h = record.hostIdentity;
  if (!h || typeof h !== 'object' || Array.isArray(h)) return false;
  if (h.state !== 'live') return false;
  // The kernel format alone admits pid 1: as a signal target it is not a host.
  // Group and session ids follow the stop module's format instead, where a
  // positive integer including 1 is legitimate.
  if (!guardPid(h.pid)) return false;
  const idPositivo = (v) => Number.isSafeInteger(v) && v > 0;
  if (!idPositivo(h.pgid) || !idPositivo(h.sid)) return false;
  return hostStop.validaHostIdentity(h) === null;
}

// Strict field-by-field comparison of a registered and an observed identity.
// Both sides must be well-formed live tuples, otherwise the answer is false:
// an unreadable snapshot is not a match and not a mismatch, it is no evidence.
function confrontaTupla(registrata, osservata) {
  const viva = (t) => t && typeof t === 'object' && !Array.isArray(t)
    && t.state === 'live' && hostStop.validaHostIdentity(t) === null;
  if (!viva(registrata) || !viva(osservata)) return false;
  for (const k of ['source', 'instanceId', 'pid', 'uid', 'bootId', 'pidNamespaceInode', 'startTicks', 'pgid', 'sid']) {
    if (registrata[k] !== osservata[k]) return false;
  }
  return true;
}

// Closed schema for one event. Takes the object, answers a strict boolean, does
// no I/O and no coercion. The schema is about the object's OWN properties: a
// field inherited from a prototype would be read by the checks but never
// counted, and a property that exists without being enumerable would escape the
// closed-schema comparison, so an object that is not plain — another
// prototype, a symbol key, a non-enumerable own key — is refused before any
// field is looked at. Every common field must be present as an own key.
function validateEvent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototipo = Object.getPrototypeOf(value);
  if (prototipo !== Object.prototype && prototipo !== null) return false;
  if (Object.getOwnPropertySymbols(value).length !== 0) return false;
  const nomi = Object.getOwnPropertyNames(value);
  const chiavi = Object.keys(value);
  if (nomi.length !== chiavi.length) return false;
  for (const k of COMMON_KEYS) {
    if (!nomi.includes(k)) return false;
  }
  if (value.version !== 1) return false;
  if (typeof value.launchId !== 'string' || !RE_HEX16.test(value.launchId)) return false;
  if (typeof value.attemptId !== 'string' || !RE_HEX32.test(value.attemptId)) return false;
  if (!Number.isSafeInteger(value.seq) || value.seq < 1 || value.seq > MAX_FILES) return false;
  if (typeof value.kind !== 'string' || !KIND_SET.has(value.kind)) return false;
  if (typeof value.contextDigest !== 'string' || !RE_HEX64.test(value.contextDigest)) return false;

  const has = (k) => nomi.includes(k);
  const only = (allowed) => chiavi.every((k) => COMMON_KEYS.includes(k) || allowed.includes(k));
  switch (value.kind) {
    case 'cli-attempt':
    case 'peer-verified':
      return only([]) && !has('method') && !has('reason');
    case 'cli-ack':
      return only(['reason']) && value.reason === 'shutdown_ack';
    case 'cli-refusal':
      return only(['reason']) && CLI_REFUSAL_REASONS.has(value.reason);
    case 'cli-failed':
      return only(['reason']) && CLI_FAILED_REASONS.has(value.reason);
    case 'intent-term':
      return only(['method']) && value.method === 'term';
    case 'intent-kill':
      return only(['method']) && value.method === 'kill';
    case 'signaled-term':
    case 'signaled-kill': {
      const expected = value.kind === 'signaled-term' ? 'term' : 'kill';
      return only(['method', 'reason']) && value.method === expected && SIGNAL_REASONS.has(value.reason);
    }
    case 'exited': {
      if (!only(['method', 'reason'])) return false;
      if (!EXIT_REASONS.has(value.reason)) return false;
      return value.method === null || METHODS.has(value.method);
    }
    case 'closed': {
      if (!only(['method'])) return false;
      if (has('reason')) return false;
      return value.method === null || METHODS.has(value.method);
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Canonical form and identity helpers
// ---------------------------------------------------------------------------

// Canonical serialization: common fields in contract order, then method, then
// reason, plus the trailing newline. The reader rebuilds this line from the
// parsed event and compares it with the bytes it read: anything else is not
// canonical.
function canonicalLine(event) {
  const ordered = {
    version: event.version,
    launchId: event.launchId,
    attemptId: event.attemptId,
    seq: event.seq,
    kind: event.kind,
    contextDigest: event.contextDigest,
  };
  if (event.method !== undefined) ordered.method = event.method;
  if (event.reason !== undefined) ordered.reason = event.reason;
  return `${JSON.stringify(ordered)}\n`;
}

// Digest of the registered tuple together with the launch binding. It is a
// binding, never a credential: it does not replace the live fence checks and it
// introduces no field in host-context.json.
function contextDigest(record) {
  const h = record.hostIdentity;
  const tuple = [
    record.launchId,
    record.vlBinSha256,
    record.serverRoot,
    h.source,
    h.instanceId,
    h.pid,
    h.uid,
    h.bootId,
    h.pidNamespaceInode,
    h.startTicks,
    h.pgid,
    h.sid,
  ];
  return crypto.createHash('sha256').update(JSON.stringify(tuple), 'utf8').digest('hex');
}

function eventFilename(seq, kind) {
  return `${String(seq).padStart(8, '0')}-${kind}.json`;
}

function proprioUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function modoDi(st) {
  return typeof st.mode === 'number' ? (st.mode & 0o777) : null;
}

// The store directory itself must be a real directory, ours, and private. This
// is a property of the object, checked without adopting or repairing it.
function qualificaDirStore(st) {
  if (!st || typeof st !== 'object' || typeof st.isDirectory !== 'function') return false;
  if (!st.isDirectory()) return false;
  if (typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) return false;
  const uid = proprioUid();
  if (uid !== null && typeof st.uid === 'number' && st.uid !== uid) return false;
  return modoDi(st) === 0o700;
}

function qualificaFileEvento(st) {
  if (!st || typeof st !== 'object' || typeof st.isFile !== 'function') return false;
  if (!st.isFile()) return false;
  if (typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) return false;
  if (st.nlink !== 1) return false;
  const uid = proprioUid();
  if (uid !== null && typeof st.uid === 'number' && st.uid !== uid) return false;
  if (modoDi(st) !== 0o600) return false;
  if (!Number.isSafeInteger(st.size) || st.size < 1 || st.size > MAX_EVENT_BYTES) return false;
  return true;
}

// The chain that holds the store is qualified by the single decision of the stop
// module, the same one the preparer runs: a removable ancestor would let the
// whole store disappear between two reads, and a replaced one would point
// somewhere else. The reader only reads — no creation, no chmod, no sync — and
// every refusal is a classification of "uncertain", never a repair.
function catenaQualificata(fsRecovery, assoluta) {
  const esito = hostStop.qualificaCatenaDirectory(fsRecovery, assoluta);
  return Boolean(esito && esito.ok);
}

function decodeCanonico(buf) {
  let testo;
  try {
    testo = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  } catch (_) {
    return null;
  }
  // A byte-order mark is bytes, not a header to strip: a decoder that removes
  // it would make two different byte strings look identical.
  if (testo.charCodeAt(0) === 0xFEFF) return null;
  // Exactly one trailing newline and no other: a partial line is not an event.
  if (!testo.endsWith('\n')) return null;
  if (testo.indexOf('\n') !== testo.length - 1) return null;
  return testo;
}

// Two shapes of trace block a new silent or recovery entry, and nothing
// else does. A CLI refusal blocks until a fresh positive proof of the same
// context is recorded after it. A CLI attempt that never received its own
// outcome blocks too, and the outcome is the outcome OF THE CLI: an ack, a
// declared failure, or the barrier that closed that same attempt. The position
// of that block is the attempt itself, not the last thing that happened to be
// written for it: an intent, a signal or an exit is what recovery does after the
// CLI, it cannot stand in for the answer the CLI never gave, and it must not
// move the marker forward either — a proof already recorded after the attempt
// stays valid until a NEW protected marker appears. Intent, signaled, exited and
// closed are otherwise not blocking by themselves: they are the point where a
// resume starts, and only `closed` attests the host barrier. The proof unblocks
// only what came before it — a later refusal or a later open attempt blocks
// again — and it is never a reinterpretation of the old events.
function classificaTraccia(eventi, launchId, digest) {
  let ultimoBlocco = 0;
  let ultimaProva = 0;
  const tentativi = new Map();
  for (const ev of eventi) {
    if (ev.launchId !== launchId || ev.contextDigest !== digest) continue;
    if (ev.kind === 'peer-verified') {
      if (ev.seq > ultimaProva) ultimaProva = ev.seq;
      continue;
    }
    if (ev.kind === 'cli-refusal') {
      if (ev.seq > ultimoBlocco) ultimoBlocco = ev.seq;
      continue;
    }
    const voce = tentativi.get(ev.attemptId) || { cli: false, esito: false, marcatore: 0 };
    if (ev.kind === 'cli-attempt') {
      voce.cli = true;
      // The unresolved attempt marks the trace where the attempt is, and a
      // later recovery event of the same attempt does not move it: only a new
      // attempt or a refusal is a new marker.
      voce.marcatore = ev.seq;
    } else if (voce.cli && (ev.kind === 'cli-ack' || ev.kind === 'cli-failed' || ev.kind === 'closed')) {
      // Only an outcome that follows the attempt closes it.
      voce.esito = true;
    }
    tentativi.set(ev.attemptId, voce);
  }
  for (const voce of tentativi.values()) {
    if (voce.cli && !voce.esito && voce.marcatore > ultimoBlocco) {
      ultimoBlocco = voce.marcatore;
    }
  }
  if (ultimoBlocco === 0) return 'clear';
  return ultimaProva > ultimoBlocco ? 'clear' : 'blocked';
}

// One event, read through a single qualified descriptor: the name is opened
// without following links, the object is qualified through the descriptor
// itself (type, owner, mode, link count, size) and it must be the same object
// the no-follow lstat saw a moment before. At most one byte more than the cap
// is ever read, so an entry that grew after the check cannot turn into an
// unbounded read. A swap between the check and the open is refused, not
// followed.
function leggiEventoQualificato(fsRecovery, file, atteso) {
  const C = fsRecovery.constants || fs.constants;
  const flag = C.O_RDONLY | (C.O_NOFOLLOW || 0) | (C.O_NONBLOCK || 0);
  let fd = null;
  try {
    fd = fsRecovery.openSync(file, flag);
  } catch (_) {
    return null;
  }
  try {
    const st = fsRecovery.fstatSync(fd);
    if (!qualificaFileEvento(st)) return null;
    if (st.dev !== atteso.dev || st.ino !== atteso.ino) return null;
    const dimensione = st.size;
    const buf = Buffer.alloc(MAX_EVENT_BYTES + 1);
    let off = 0;
    while (off < buf.length) {
      const n = fsRecovery.readSync(fd, buf, off, buf.length - off, off);
      if (!(n > 0)) break;
      off += n;
    }
    // Ending before the qualified size means the object changed between the
    // qualification and the end of the read. An early end of file is a
    // detected change, not a short event: the bytes read may well be a
    // complete canonical line, and they would be one for an object that is no
    // longer the one we qualified.
    if (off !== dimensione) return null;
    // The object is qualified again after the read, with the same checks as the
    // first one, and the modification metadata must not have moved: a change
    // that is detectable from the descriptor is refused, not averaged out.
    const dopo = fsRecovery.fstatSync(fd);
    if (!qualificaFileEvento(dopo)) return null;
    if (dopo.dev !== st.dev || dopo.ino !== st.ino) return null;
    if (dopo.size !== st.size || dopo.mtimeMs !== st.mtimeMs || dopo.ctimeMs !== st.ctimeMs) return null;
    return buf.subarray(0, off);
  } catch (_) {
    return null;
  } finally {
    try { fsRecovery.closeSync(fd); } catch (_) { /* best effort */ }
  }
}

// ---------------------------------------------------------------------------
// Phase plan
// ---------------------------------------------------------------------------

function marginePer(budgetMs) {
  return Math.max(1, Math.floor((250 * Math.min(budgetMs, 8000)) / 8000));
}

// The nine caps are not a partition the caller may choose: they are the scaling
// of the literal table for the budget, and the remainder of the rounding goes
// only to the last phase. Every other arrangement that still sums to the budget
// is a different plan.
const CAPS_8000 = Object.freeze([500, 750, 1000, 250, 1000, 500, 750, 2000, 1000]);

function capsNormativi(budgetMs) {
  const caps = [];
  let somma = 0;
  for (let i = 0; i < CAPS_8000.length - 1; i += 1) {
    const c = Math.floor((CAPS_8000[i] * budgetMs) / 8000);
    caps.push(c);
    somma += c;
  }
  caps.push(budgetMs - marginePer(budgetMs) - somma);
  return caps;
}

// An explicit plan is admitted only when it is exactly the literal form the
// contract fixes: nine phases in order, no duplicates, own allowance within its
// own cap, margin and caps summing to the budget, and the caller's deadline.
// The plan is validated here and never rescaled at every await.
function planValido(plan, deadlineAt) {
  if (!plan || typeof plan !== 'object' || Array.isArray(plan)) return false;
  const keys = Object.keys(plan);
  if (keys.length !== PLAN_KEYS.length || keys.some((k) => !PLAN_KEYS.includes(k))) return false;
  if (!Number.isSafeInteger(plan.budgetMs) || plan.budgetMs < MIN_BUDGET || plan.budgetMs > MAX_BUDGET) return false;
  if (!Number.isFinite(plan.deadlineAt) || plan.deadlineAt !== deadlineAt) return false;
  if (!Number.isSafeInteger(plan.marginMs) || plan.marginMs !== marginePer(plan.budgetMs)) return false;
  if (!Array.isArray(plan.phases) || plan.phases.length !== PHASE_IDS.length) return false;
  const caps = capsNormativi(plan.budgetMs);
  let somma = 0;
  for (let i = 0; i < PHASE_IDS.length; i += 1) {
    const fase = plan.phases[i];
    if (!fase || typeof fase !== 'object' || Array.isArray(fase)) return false;
    const fk = Object.keys(fase);
    if (fk.length !== PHASE_KEYS.length || fk.some((k) => !PHASE_KEYS.includes(k))) return false;
    if (fase.id !== PHASE_IDS[i]) return false;
    if (fase.capMs !== caps[i]) return false;
    if (!Number.isSafeInteger(fase.allowanceMs) || fase.allowanceMs < 0 || fase.allowanceMs > fase.capMs) return false;
    somma += fase.capMs;
  }
  return somma + plan.marginMs === plan.budgetMs;
}

// ---------------------------------------------------------------------------
// Durable writing
// ---------------------------------------------------------------------------

// A directory is synced through a qualified descriptor: the name is resolved
// once, without following a link, and the descriptor must be the object the
// no-follow lstat qualified a moment before. Syncing an object nobody
// qualified would attest a directory that may have been replaced.
function fsyncDirQualificato(fsImpl, dir) {
  const C = fsImpl.constants || fs.constants;
  const atteso = fsImpl.lstatSync(dir);
  const fd = fsImpl.openSync(dir, C.O_RDONLY | (C.O_DIRECTORY || 0) | (C.O_NOFOLLOW || 0));
  try {
    const st = fsImpl.fstatSync(fd);
    if (!st || typeof st.isDirectory !== 'function' || !st.isDirectory()) {
      const e = new Error('not a directory'); e.code = 'ENOTDIR'; throw e;
    }
    if (st.dev !== atteso.dev || st.ino !== atteso.ino) {
      const e = new Error('directory replaced'); e.code = 'ESTALE'; throw e;
    }
    fsImpl.fsyncSync(fd);
  } finally {
    try { fsImpl.closeSync(fd); } catch (_) { /* best effort */ }
  }
}

// A short write is an error, not a shorter event: the bytes are written at an
// explicit offset until the whole line is on the descriptor.
function scriviTutto(fsImpl, fd, buf) {
  let off = 0;
  while (off < buf.length) {
    const n = fsImpl.writeSync(fd, buf, off, buf.length - off, off);
    if (!(n > 0)) {
      const e = new Error('short write'); e.code = 'EIO'; throw e;
    }
    off += n;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

function fallimento(code) {
  return { ok: false, code };
}

// A signal delivery answers synchronously: the syscall is made where the
// contract puts it, between the fence and the record of what happened, and an
// asynchronous seam would turn that boundary into a gap. An async function is
// therefore a contract violation, refused before any event is written and
// without any call.
function contrattoSegnale(fn) {
  return typeof fn === 'function'
    && !(fn.constructor && fn.constructor.name === 'AsyncFunction');
}

// One active attempt per store, in the PROCESS and not per factory. A factory
// is an object, not an authority: two of them on the same qualified store would
// each read the same files and their own empty map and both admit, which is
// exactly the double admission the reservation exists to prevent. The map is
// keyed by the resolved store path; release is bound to the exact handle that
// took the place. This is an in-process reservation and promises no
// cross-process atomicity.
const PRENOTAZIONI = new Map();
const TENTATIVI = new WeakMap();
// Everything an attempt needs after admission. It is a WeakMap and not fields
// on the handle: the handle stays opaque and a caller cannot read or replace
// the record, the digest or the deps it was admitted with.
const ATTEMPTS = new WeakMap();

function createHostRecovery(deps = {}) {
  const d = deps && typeof deps === 'object' ? deps : {};
  const fsRecovery = d.fsRecovery || fs;
  const monoNow = typeof d.monoNow === 'function'
    ? d.monoNow
    : () => Number(process.hrtime.bigint() / 1000000n);
  // The publisher is a seam for unit tests with a synthetic fs; production
  // passes nothing and gets the exclusive publication of the stop module.
  const publishExclusive = typeof d.publishExclusive === 'function' ? d.publishExclusive : pubblicaEsclusiva;
  // The observer is a DEPENDENCY and not an export: the production one lives in
  // the stop module (which also proves the exit after the ack), the tests pass
  // their own, and neither is a new surface of this module.
  const osservaKernel = typeof d.osservaKernel === 'function' ? d.osservaKernel : hostStop.osservatoreKernel(fsRecovery);
  const identitaNodo = typeof d.identitaNodo === 'function'
    ? d.identitaNodo
    : () => hostStop.identitaNodoKernel(fsRecovery);
  const identitaCoordinatore = typeof d.identitaCoordinatore === 'function'
    ? d.identitaCoordinatore
    : () => hostStop.identitaCoordinatoreKernel(fsRecovery);
  // The host barrier is a callback of the stop module: without it the barrier
  // cannot be attested, and an unattestable barrier is a refusal, never a clean
  // outcome.
  const probeRoot = typeof d.probeRoot === 'function' ? d.probeRoot : null;
  // Signal delivery is a dependency and not an export: the production one is
  // the kernel call on the recorded pid, the tests pass their own, and a
  // delivery is synchronous by contract. A promise-returning seam would let a
  // caller await between the fence and the syscall, so it is refused before any
  // event is written.
  const killProcess = typeof d.killProcess === 'function'
    ? d.killProcess
    : (pid, signal) => process.kill(pid, signal);
  // The wait is a dependency for the same reason: a polling loop that cannot be
  // driven by the caller cannot be bounded by a caller's clock.
  const attesaImpl = typeof d.attesaImpl === 'function'
    ? d.attesaImpl
    : (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // The reservation key is the resolved store path and nothing else. A key that
  // also carried the observed device/inode would change whenever that
  // observation failed, and a different key is a different attempt: the
  // exclusion would fail open exactly when the store stopped being readable.
  // The identity is checked by the qualification, not encoded here.
  function chiaveStore(assoluta) {
    return path.resolve(assoluta);
  }

  function dirStore(assoluta) {
    return path.join(assoluta, 'recovery-events');
  }

  // Counts EVERY entry of the namespace, whatever its name: an alien name, a
  // leftover temporary and a regular event all occupy the same budget.
  function contaVoci(dir) {
    let voci;
    try {
      voci = fsRecovery.readdirSync(dir);
    } catch (e) {
      if (e && e.code === 'ENOENT') return 0;
      return null;
    }
    if (!Array.isArray(voci)) return null;
    return voci.length;
  }

  // The reader behind every classification. `escludi` is the private marker of
  // the handle that is performing an effect: only that exact object, still
  // qualified by name, device, inode, type, owner and mode, is left out of the
  // enumeration. It is not a bypass of the temporaries: every other `.tmp-*`,
  // a different object under the same name, and the public reader always see
  // `uncertain`.
  function leggiTraccia(ctx, escludi) {
    const vuoto = (state) => ({ state, events: [] });
    if (!ctx || typeof ctx !== 'object') return vuoto('uncertain');
    const { stateDir, record } = ctx;
    if (typeof stateDir !== 'string' || !stateDir || stateDir.includes('\0')) return vuoto('uncertain');
    if (!guardRecord(record)) return vuoto('uncertain');

    const assoluta = path.resolve(stateDir);
    // The chain that holds the store is qualified before the store itself: an
    // ancestor that is a link, of another owner or writable by the group can
    // replace or remove the whole store, and a classification built on it would
    // be a statement about an object we do not control.
    if (!catenaQualificata(fsRecovery, assoluta)) return vuoto('uncertain');

    const dir = dirStore(assoluta);
    let stDir;
    try {
      stDir = fsRecovery.lstatSync(dir);
    } catch (e) {
      // The private capacity declares that it owns a marker, so for it a missing
      // store is never a clean store: the object it must find and qualify went
      // away with the directory. The public reader, which excludes nothing,
      // keeps its historical answer.
      if (e && e.code === 'ENOENT') return vuoto(escludi ? 'uncertain' : 'clear');
      return vuoto('uncertain');
    }
    if (!qualificaDirStore(stDir)) return vuoto('uncertain');

    // The store is opened as an object: the name is resolved once, without
    // following a link, and the descriptor must be the directory the no-follow
    // lstat just qualified, or the enumeration would be about something else.
    const C = fsRecovery.constants || fs.constants;
    let fd = null;
    try {
      fd = fsRecovery.openSync(dir, C.O_RDONLY | (C.O_DIRECTORY || 0) | (C.O_NOFOLLOW || 0));
    } catch (_) {
      return vuoto('uncertain');
    }
    try {
      const stF = fsRecovery.fstatSync(fd);
      if (!qualificaDirStore(stF)) return vuoto('uncertain');
      if (stF.dev !== stDir.dev || stF.ino !== stDir.ino) return vuoto('uncertain');

      let nomi;
      try {
        nomi = fsRecovery.readdirSync(dir);
      } catch (_) {
        return vuoto('uncertain');
      }
      if (!Array.isArray(nomi) || nomi.length > MAX_FILES) return vuoto('uncertain');
      nomi.sort();

      const eventi = [];
      let payload = 0;
      // A private read is not an exclusion granted in advance: the object the
      // handle declares is REQUIRED to be there, and to still be that object.
      // Its absence, an lstat failure on it or a replacement under the same
      // name is an uncertainty, never a clean store.
      let vistoMarcatore = false;
      for (const nome of nomi) {
        if (RE_TEMP_NAME.test(nome)) {
          if (escludi && nome === escludi.nome && marcatoreQualificato(dir, escludi)) {
            vistoMarcatore = true;
            continue;
          }
          return vuoto('uncertain');
        }
        const m = RE_EVENT_NAME.exec(nome);
        if (!m) return vuoto('uncertain');
        const seq = Number(m[1]);
        const kind = m[2];
        if (!KIND_SET.has(kind)) return vuoto('uncertain');
        if (!Number.isSafeInteger(seq) || seq < 1 || seq > MAX_FILES) return vuoto('uncertain');

        const file = path.join(dir, nome);
        // The size is read from a no-follow lstat and decides BEFORE the content:
        // an oversize entry is refused by dimension, never by reading it whole.
        let stFile;
        try {
          stFile = fsRecovery.lstatSync(file);
        } catch (_) {
          return vuoto('uncertain');
        }
        if (!qualificaFileEvento(stFile)) return vuoto('uncertain');

        const buf = leggiEventoQualificato(fsRecovery, file, stFile);
        if (!buf) return vuoto('uncertain');
        if (buf.length > MAX_EVENT_BYTES) return vuoto('uncertain');
        payload += buf.length;
        if (payload > MAX_PAYLOAD_BYTES) return vuoto('uncertain');

        const testo = decodeCanonico(buf);
        if (testo === null) return vuoto('uncertain');
        let ev;
        try {
          ev = JSON.parse(testo.slice(0, -1));
        } catch (_) {
          return vuoto('uncertain');
        }
        if (!validateEvent(ev)) return vuoto('uncertain');
        if (ev.seq !== seq || ev.kind !== kind) return vuoto('uncertain');
        // Canonical means the same BYTES, not the same parsed value: comparing
        // the re-serialized line with what the descriptor returned is the only
        // check a decoder cannot soften.
        if (!buf.equals(Buffer.from(canonicalLine(ev), 'utf8'))) return vuoto('uncertain');
        eventi.push(ev);
      }

      // The sequence is global per cell and has no holes: a missing number is not
      // an empty page, it is an unexplained gap.
      if (escludi && !vistoMarcatore) return vuoto('uncertain');
      for (let i = 0; i < eventi.length; i += 1) {
        if (eventi[i].seq !== i + 1) return vuoto('uncertain');
      }

      // Everything read must still belong to the qualified object: the
      // descriptor and the name are compared with the identities taken before
      // the reads, so a store replaced during the enumeration leaves an
      // "uncertain" classification and never a "clear" one. A swap restored
      // between the two observations stays indistinguishable, as declared.
      const dopoF = fsRecovery.fstatSync(fd);
      // The object must still be the qualified one AND still be a store: an
      // inode that stays the same while the directory loses its mode is a
      // persistent change of the requirement, not the residual swap-and-restore.
      if (!qualificaDirStore(dopoF)) return vuoto('uncertain');
      if (dopoF.dev !== stF.dev || dopoF.ino !== stF.ino) return vuoto('uncertain');
      const dopoNome = fsRecovery.lstatSync(dir);
      if (!qualificaDirStore(dopoNome)) return vuoto('uncertain');
      if (dopoNome.dev !== stDir.dev || dopoNome.ino !== stDir.ino) return vuoto('uncertain');

      const digest = contextDigest(record);
      return { state: classificaTraccia(eventi, record.launchId, digest), events: eventi };
    } catch (_) {
      return vuoto('uncertain');
    } finally {
      try { fsRecovery.closeSync(fd); } catch (_) { /* best effort */ }
    }
  }

  // The public read never excludes anything: a marker is a residue for every
  // reader, this handle included, once the effect it guards is over.
  function readTrace(ctx) {
    return leggiTraccia(ctx, null);
  }

  // The marker of the TERM window is a private object of the handle: an empty
  // temporary created exclusively in the store, synced with its directory,
  // whose identity is kept only in the handle. It is qualified by the same
  // properties it was created with, never by its name alone.
  function marcatoreQualificato(dir, m) {
    if (!m || typeof m.nome !== 'string' || !RE_TEMP_NAME.test(m.nome)) return false;
    let st;
    try { st = fsRecovery.lstatSync(path.join(dir, m.nome)); } catch (_) { return false; }
    if (!st || typeof st.isFile !== 'function' || !st.isFile()) return false;
    if (typeof st.isSymbolicLink === 'function' && st.isSymbolicLink()) return false;
    if (st.nlink !== 1) return false;
    const uid = proprioUid();
    if (uid !== null && typeof st.uid === 'number' && st.uid !== uid) return false;
    if (modoDi(st) !== 0o600) return false;
    return st.dev === m.dev && st.ino === m.ino;
  }

  // The marker takes three places for the whole window: itself, the temporary
  // of the post-event and its final name. The check happens before creating it,
  // inside the attempt's own reservation, so a store without those places
  // refuses before any signal. A failed creation or sync leaves the object on
  // disk and answers a store failure.
  function creaMarcatore(st) {
    const dir = dirStore(st.stateDir);
    const vociOra = contaVoci(dir);
    if (vociOra === null) return { ok: false, code: 'STORE' };
    if (vociOra + 3 > MAX_FILES) return { ok: false, code: 'STORE_CAPACITY' };
    if (vociOra + 3 > st.vociAllApertura + st.need) return { ok: false, code: 'STORE_CAPACITY' };
    try { hostStop.assicuraDirDurevole(fsRecovery, dir); } catch (_) {
      return { ok: false, code: 'STORE' };
    }
    const C = fsRecovery.constants || fs.constants;
    let nome;
    try { nome = `.tmp-${crypto.randomBytes(16).toString('hex')}`; } catch (_) {
      return { ok: false, code: 'STORE' };
    }
    const tmp = path.join(dir, nome);
    let fd = null;
    try {
      fd = fsRecovery.openSync(tmp, C.O_CREAT | C.O_EXCL | C.O_WRONLY | (C.O_NOFOLLOW || 0), 0o600);
      const stTmp = fsRecovery.fstatSync(fd);
      if (!stTmp || typeof stTmp.isFile !== 'function' || !stTmp.isFile()) throw new Error('not a file');
      if (stTmp.nlink !== 1) throw new Error('linked marker');
      const uid = proprioUid();
      if (uid !== null && typeof stTmp.uid === 'number' && stTmp.uid !== uid) throw new Error('foreign marker');
      fsRecovery.fsyncSync(fd);
      const marcatore = { nome, dev: stTmp.dev, ino: stTmp.ino };
      fsRecovery.closeSync(fd);
      fd = null;
      fsyncDirQualificato(fsRecovery, dir);
      return { ok: true, marcatore };
    } catch (_) {
      if (fd !== null) { try { fsRecovery.closeSync(fd); } catch (_) { /* best effort */ } }
      return { ok: false, code: 'STORE' };
    }
  }

  // Removal happens only after the post-event is durable. The name must still
  // be the object this handle created: a different object under the same name
  // is never removed. A failed unlink leaves the marker and spends the handle;
  // a successful unlink followed by a failed directory sync is the cleanup
  // erratum — the post-event is already durable, so a later reader that finds
  // no marker and a clear store cannot repeat the signal.
  function rimuoviMarcatore(st, campo = 'marcatore') {
    const m = st[campo];
    if (!m) return { ok: true };
    const dir = dirStore(st.stateDir);
    if (!marcatoreQualificato(dir, m)) {
      st.speso = true;
      return { ok: false, code: 'STORE' };
    }
    try {
      fsRecovery.unlinkSync(path.join(dir, m.nome));
    } catch (_) {
      st.speso = true;
      return { ok: false, code: 'STORE' };
    }
    try {
      fsyncDirQualificato(fsRecovery, dir);
    } catch (_) {
      st.speso = true;
      st[campo] = null;
      lasciaResiduo(dir);
      return { ok: false, code: 'STORE' };
    }
    st[campo] = null;
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Durable append: one event, in order, never over an existing name
  // -------------------------------------------------------------------------
  //
  // The sequence is the one the contract fixes and every step is load-bearing:
  // preflight before any effect, chain and store made durable, a private
  // temporary written and synced, the exclusive publication, the two directory
  // syncs that put the new entry in the metadata, and only then the removal of
  // that one temporary. A failure BEFORE that removal leaves the temporary in
  // place, so the trace reads uncertain. The removal is itself followed by a
  // sync of the entry directory: if that last sync fails the name is already
  // gone, no temporary can be left as the trace of the failure, and the append
  // spends the attempt and tries to recreate a residual instead — an attempt,
  // not a guarantee: the erratum is stated where that failure is handled.
  function appendEvento(attempt, kind, extra = {}, opzioni = {}) {
    const st = ATTEMPTS.get(attempt);
    if (!st) return { ok: false, code: 'HANDLE' };
    // A spent attempt never acts again: its last write could not be made
    // durable, and a store in that state is not a place for new effects.
    if (st.speso) return { ok: false, code: 'STORE' };
    // Clock and fence are read before every append: a context that moved while
    // the attempt was running must not persist an intent, and a clock that went
    // backwards is no clock.
    const adesso = orologio(st);
    if (adesso === null) return { ok: false, code: 'BUDGET' };
    let consenso;
    try { consenso = st.fenceCheck(); } catch (_) { return { ok: false, code: 'FENCE' }; }
    if (consenso !== true) return { ok: false, code: 'FENCE' };

    // The private capability is circumscribed: a marker is ignored only by the
    // event that closes the window which created it — the term marker by the
    // term event, the kill marker by the kill event — and only when that caller
    // asks for it explicitly. Every other event of this handle — an attempt, a
    // CLI outcome, an intent, an exit, a close, a proof — reads the store with
    // the normal reader, so a leftover marker makes the trace uncertain and the
    // write is refused instead of sliding past its own residue.
    const escludi = opzioni.escludiMarcatore === true ? st.marcatore
      : (opzioni.escludiMarcatoreKill === true ? st.marcatoreKill : null);
    const traccia = leggiTraccia({ stateDir: st.stateDir, record: st.record }, escludi);
    if (traccia.state === 'uncertain') return { ok: false, code: 'TRACE_UNCERTAIN' };
    // The read is fresh, so a refusal recorded after the entry checked the
    // trace is visible here. A write that precedes an effect must not happen on
    // a blocking trace: only the proof may run on one, and only the proof is
    // exempt from this check.
    if (opzioni.requireClear && traccia.state === 'blocked') return { ok: false, code: 'TRACE_BLOCKED' };
    const seq = traccia.events.length + 1;
    if (seq > MAX_FILES) return { ok: false, code: 'STORE_CAPACITY' };

    const evento = {
      version: 1,
      launchId: st.record.launchId,
      attemptId: st.attemptId,
      seq,
      kind,
      contextDigest: st.digest,
      ...extra,
    };
    // Our own line goes through the same closed schema the reader applies: an
    // event this module cannot read back is not written at all.
    if (!validateEvent(evento)) return { ok: false, code: 'STORE' };
    const linea = Buffer.from(canonicalLine(evento), 'utf8');
    if (linea.length > MAX_EVENT_BYTES) return { ok: false, code: 'STORE_CAPACITY' };

    let payload = linea.length;
    for (const ev of traccia.events) payload += Buffer.byteLength(canonicalLine(ev), 'utf8');
    if (payload > MAX_PAYLOAD_BYTES) return { ok: false, code: 'STORE_CAPACITY' };

    const dir = dirStore(st.stateDir);
    const vociOra = contaVoci(dir);
    if (vociOra === null) return { ok: false, code: 'STORE' };
    // During a publication the temporary and the final name are both entries of
    // the namespace, so the interval needs TWO places and not one: reserving a
    // single one would let the peak reach one entry past the cap. The technical
    // place of the reservation belongs to the temporary and is never spent as
    // an event.
    if (vociOra + 2 > MAX_FILES) return { ok: false, code: 'STORE_CAPACITY' };
    // The places were taken at admission; an append that would exceed them
    // means somebody else consumed them.
    if (vociOra + 2 > st.vociAllApertura + st.need) return { ok: false, code: 'STORE_CAPACITY' };

    // Entry and chain first: the new name will live in their metadata, and a
    // directory that cannot be made durable is not a place to declare
    // persistence. The temporary is then created exclusively, so the name is
    // ours by construction and not by convention.
    try { hostStop.assicuraDirDurevole(fsRecovery, dir); } catch (_) {
      return { ok: false, code: 'STORE' };
    }

    const C = fsRecovery.constants || fs.constants;
    // The technical name is drawn from the random source inside a guarded
    // step: this path answers a value and never throws.
    let nomeTmp;
    try { nomeTmp = `.tmp-${crypto.randomBytes(16).toString('hex')}`; } catch (_) {
      return { ok: false, code: 'STORE' };
    }
    const tmp = path.join(dir, nomeTmp);
    const dest = path.join(dir, eventFilename(seq, kind));
    let fd = null;
    let identita = null;
    try {
      fd = fsRecovery.openSync(tmp, C.O_CREAT | C.O_EXCL | C.O_WRONLY | (C.O_NOFOLLOW || 0), 0o600);
      scriviTutto(fsRecovery, fd, linea);
      const stTmp = fsRecovery.fstatSync(fd);
      if (!stTmp || typeof stTmp.isFile !== 'function' || !stTmp.isFile()) throw new Error('not a file');
      if (stTmp.nlink !== 1) throw new Error('linked temporary');
      const uid = proprioUid();
      if (uid !== null && typeof stTmp.uid === 'number' && stTmp.uid !== uid) throw new Error('foreign temporary');
      // The temporary is synced before its name appears: the publication makes
      // the bytes reachable to a reader, and a reader must never see a file
      // whose content has not been made durable.
      fsRecovery.fsyncSync(fd);
      identita = { dev: stTmp.dev, ino: stTmp.ino };
      fsRecovery.closeSync(fd);
      fd = null;
    } catch (_) {
      if (fd !== null) { try { fsRecovery.closeSync(fd); } catch (_) { /* best effort */ } }
      return { ok: false, code: 'STORE' };
    }

    let esito;
    try { esito = publishExclusive({ src: tmp, dest, bytes: linea }); } catch (_) {
      return { ok: false, code: 'STORE' };
    }
    if (esito && esito.status === 'exists') {
      // The name was there: identical bytes confirm only that publication, and
      // never make this call a second one. Different bytes are a conflict, not
      // an overwrite.
      let stDest = null;
      try { stDest = fsRecovery.lstatSync(dest); } catch (_) { return { ok: false, code: 'STORE' }; }
      const letto = leggiEventoQualificato(fsRecovery, dest, stDest);
      if (!letto || !letto.equals(linea)) return { ok: false, code: 'STORE' };
    } else if (!esito || esito.status !== 'published') {
      return { ok: false, code: 'STORE' };
    }

    // The new entry lives in the metadata of two directories and both are
    // synced through qualified descriptors.
    try {
      fsyncDirQualificato(fsRecovery, dir);
      fsyncDirQualificato(fsRecovery, st.stateDir);
    } catch (_) {
      return { ok: false, code: 'STORE' };
    }

    // Only the temporary this call created is removed, and only after proving
    // it is still that object: an identity that moved is a change, not a
    // cleanup.
    let stOra;
    try { stOra = fsRecovery.lstatSync(tmp); } catch (_) { return { ok: false, code: 'STORE' }; }
    if (!stOra || stOra.dev !== identita.dev || stOra.ino !== identita.ino) return { ok: false, code: 'STORE' };
    try {
      fsRecovery.unlinkSync(tmp);
    } catch (_) {
      return { ok: false, code: 'STORE' };
    }
    try {
      fsyncDirQualificato(fsRecovery, dir);
    } catch (_) {
      // The event is already published and synced; what failed is the sync that
      // follows the removal, so the error is about cleanup and not about the
      // data.
      //
      // Contract for this one case. The handle is spent: every later operation
      // on it returns a store failure without effects. The module tries to
      // leave a residual so that later readers see the store as uncertain: that
      // is a best-effort attempt, not a guarantee. If the residual cannot be
      // created or made durable, a new handle or another process may read the
      // store as clear and resume; the resume starts from the durable events
      // already in the store, which stay canonical and are neither rewritten nor
      // duplicated by the cleanup.
      st.speso = true;
      lasciaResiduo(dir);
      return { ok: false, code: 'STORE' };
    }

    st.appesi += 1;
    return { ok: true, seq, kind };
  }

  // Best-effort residual of a failure that happened after the temporary was
  // already removed: an empty private temporary with the same exclusive flags
  // and the same mode as the ones this writer creates. Its name makes a later
  // read of the store uncertain — while it is there, and only then. It is
  // synced itself and synced again as an entry of the store directory, so the
  // uncertainty does not depend on a machine that happens to stay up; if either
  // sync fails, nothing is retried and the caller keeps its store failure. It
  // answers whether the residual is in place and durable, and never throws.
  function lasciaResiduo(dir) {
    let fd = null;
    try {
      const C = fsRecovery.constants || fs.constants;
      const nome = `.tmp-${crypto.randomBytes(16).toString('hex')}`;
      fd = fsRecovery.openSync(path.join(dir, nome), C.O_CREAT | C.O_EXCL | C.O_WRONLY | (C.O_NOFOLLOW || 0), 0o600);
      fsRecovery.fsyncSync(fd);
      fsRecovery.closeSync(fd);
      fd = null;
      fsyncDirQualificato(fsRecovery, dir);
      return true;
    } catch (_) {
      return false;
    } finally {
      if (fd !== null) { try { fsRecovery.closeSync(fd); } catch (_) { /* best effort */ } }
    }
  }

  // -------------------------------------------------------------------------
  // Kernel evidence and the proof that unblocks a silence
  // -------------------------------------------------------------------------

  function nodoOra() {
    try {
      const n = identitaNodo();
      return n && typeof n === 'object' ? n : null;
    } catch (_) { return null; }
  }

  function coordinatoreOra() {
    try {
      const c = identitaCoordinatore();
      return c && typeof c === 'object' ? c : null;
    } catch (_) { return null; }
  }

  // One observation, classified into three answers and nothing else: a proved
  // exit, a live host that passed the isolation judgement, or no evidence. A
  // tuple that differs only in one field is not a match and not a mismatch: it
  // is no evidence, unless the birth itself moved on the same node and
  // namespace, which is the one difference that proves the original process is
  // gone and this pid belongs to another one.
  function osservaEsito(st) {
    const registrata = st.record.hostIdentity;
    // The registered domain is the only domain in which this tuple can be
    // spoken about. A reading taken on another boot, or in another pid
    // namespace, describes a world in which the recorded process never existed:
    // two readings that agree with each other while disagreeing with the record
    // prove nothing about the record's process.
    const nodo = nodoOra();
    if (!nodo
      || nodo.bootId !== registrata.bootId
      || String(nodo.pidNamespaceInode) !== String(registrata.pidNamespaceInode)) {
      return { stato: 'incerto', code: 'IDENTITY_UNKNOWN' };
    }
    let oss;
    try { oss = osservaKernel(registrata.pid, registrata.instanceId); } catch (_) {
      return { stato: 'incerto', code: 'IDENTITY' };
    }
    if (!oss || typeof oss !== 'object') return { stato: 'incerto', code: 'IDENTITY' };

    if (oss.state === 'unverifiable') return { stato: 'incerto', code: 'IDENTITY' };
    if (oss.state === 'absent') {
      // An absence is a statement about the registered domain as well: the
      // observer must say which world it looked at, and that world must be the
      // one the process was registered in.
      const suo = oss.node;
      if (!suo
        || suo.bootId !== registrata.bootId
        || String(suo.pidNamespaceInode) !== String(registrata.pidNamespaceInode)) {
        return { stato: 'incerto', code: 'IDENTITY_UNKNOWN' };
      }
      return { stato: 'uscito', reason: 'absent' };
    }
    if (oss.state !== 'observed') return { stato: 'incerto', code: 'IDENTITY' };

    const osservata = oss.identity;
    if (!osservata || osservata.state !== 'live') return { stato: 'incerto', code: 'IDENTITY' };
    // The observation must be about the registered domain as well: a process
    // born in another boot or another namespace is not this tuple, whatever the
    // rest of its fields say.
    if (osservata.bootId !== registrata.bootId
      || String(osservata.pidNamespaceInode) !== String(registrata.pidNamespaceInode)) {
      return { stato: 'incerto', code: 'IDENTITY_UNKNOWN' };
    }

    if (confrontaTupla(registrata, osservata)) {
      let giudizio;
      try {
        giudizio = hostStop.giudicaIsolamento({
          registrata,
          osservata,
          coordinatore: coordinatoreOra(),
          nodo,
        });
      } catch (_) {
        return { stato: 'incerto', code: 'IDENTITY_UNKNOWN' };
      }
      if (giudizio === 'nel-gruppo') return { stato: 'incerto', code: 'HOST_IN_GROUP' };
      if (giudizio !== 'isolato') return { stato: 'incerto', code: 'IDENTITY_UNKNOWN' };
      // A zombie keeps the identity and the birth of the original process: it
      // is no longer running, and the barrier will say whether the root agrees.
      if (oss.processState === 'Z') return { stato: 'uscito', reason: 'zombie' };
      return { stato: 'vivo' };
    }

    // A different birth in the SAME registered domain is a reused pid. A
    // difference of uid alone is a mutation of the same process, and a mutation
    // is not a death; a birth in another domain is not this process at all.
    if (osservata.bootId === registrata.bootId
      && String(osservata.pidNamespaceInode) === String(registrata.pidNamespaceInode)
      && osservata.pid === registrata.pid
      && osservata.instanceId === registrata.instanceId
      && osservata.startTicks !== registrata.startTicks) {
      return { stato: 'uscito', reason: 'pid-reused' };
    }
    return { stato: 'incerto', code: 'IDENTITY' };
  }

  // The only event that removes a blocking trace is a NEW positive proof
  // of the original peer, recorded before the silence is lifted. It is not the
  // presence or the absence of a socket, and not an old file: the peer must
  // answer that its own identity is verified and coherent with the record, the
  // kernel must show that same process alive, on this node, out of the
  // coordinator's group, and the fence must be valid while all of it is read.
  async function provaPeer(attempt, st) {
    if (!probeRoot) return false;
    const adesso = orologio(st);
    if (adesso === null) return false;
    let consenso;
    try { consenso = st.fenceCheck(); } catch (_) { return false; }
    if (consenso !== true) return false;

    let sonda;
    try {
      sonda = await probeRoot({
        record: st.record,
        deadlineAt: st.deadlineAt,
        budgetMs: Math.max(0, st.deadlineAt - adesso),
      });
    } catch (_) { return false; }
    if (!sonda || !sonda.r || sonda.r.ok !== true) return false;
    const stato = sonda.stato;
    if (!stato || stato.ok !== true || stato.state !== 'live') return false;

    const peer = stato.peer_identity;
    if (!peer || peer.state !== 'verified') return false;
    const h = st.record.hostIdentity;
    if (peer.pid !== h.pid
      || peer.uid !== h.uid
      || peer.boot_id !== h.bootId
      || String(peer.pidns) !== String(h.pidNamespaceInode)
      || String(peer.starttime) !== String(h.startTicks)
      || peer.pgid !== h.pgid
      || peer.sid !== h.sid) return false;

    // The peer's word is not enough: the same process must be freshly observed
    // alive and isolated here, and the fence must still be valid after it.
    const oss = osservaEsito(st);
    if (oss.stato !== 'vivo') return false;
    let consensoDopo;
    try { consensoDopo = st.fenceCheck(); } catch (_) { return false; }
    if (consensoDopo !== true) return false;
    const adessoDopo = orologio(st);
    if (adessoDopo === null) return false;

    // Persisted BEFORE the block is lifted: the proof is what unblocks, and a
    // proof that is only in RAM would be gone with the process that took it.
    const esito = appendEvento(attempt, 'peer-verified', {});
    return Boolean(esito && esito.ok);
  }

  function openAttempt(ctx, mode) {
    if (mode !== 'expected' && mode !== 'silent') return fallimento('MODE');
    if (!contrattoSegnale(killProcess)) return fallimento('CONTEXT');
    if (!ctx || typeof ctx !== 'object' || Array.isArray(ctx)) return fallimento('CONTEXT');
    const chiaviCtx = ['record', 'stateDir', 'deadlineAt', 'phasePlan', 'allowHostRecovery', 'fenceCheck'];
    if (Object.keys(ctx).some((k) => !chiaviCtx.includes(k))) return fallimento('CONTEXT');

    const { stateDir, deadlineAt, phasePlan, allowHostRecovery, fenceCheck } = ctx;
    // The private copy is taken before the guard and is what the attempt keeps:
    // the pid guarded here is the pid the window will signal, whatever happens
    // to the object the caller passed.
    let record;
    try { record = congelaRecord(ctx.record); } catch (_) { return fallimento('RECORD'); }
    if (!guardRecord(record)) return fallimento('RECORD');
    if (typeof stateDir !== 'string' || !stateDir || stateDir.includes('\0')) return fallimento('CONTEXT');
    if (!Number.isFinite(deadlineAt)) return fallimento('BUDGET');
    if (typeof fenceCheck !== 'function') return fallimento('FENCE');
    const conRecovery = allowHostRecovery === true;
    // An explicit plan is required wherever recovery is authorized; without
    // consent the historical adapter keeps its own limits, so no plan travels.
    if (conRecovery && phasePlan === undefined) return fallimento('PLAN');
    if (phasePlan !== undefined && !planValido(phasePlan, deadlineAt)) return fallimento('PLAN');

    const adesso = monoNow();
    if (!Number.isFinite(adesso) || adesso >= deadlineAt) return fallimento('BUDGET');

    const assoluta = path.resolve(stateDir);
    // Same chain qualification the reader performs, applied before the
    // reservation is counted: capacity measured on an object we do not control
    // is not a bound.
    if (!catenaQualificata(fsRecovery, assoluta)) return fallimento('STORE');
    const dir = dirStore(assoluta);
    let stDir = null;
    try {
      stDir = fsRecovery.lstatSync(dir);
    } catch (e) {
      if (!e || e.code !== 'ENOENT') return fallimento('STORE');
      stDir = null;
    }
    if (stDir && !qualificaDirStore(stDir)) return fallimento('STORE');

    const traccia = readTrace({ stateDir: assoluta, record });
    if (traccia.state === 'uncertain') return fallimento('TRACE_UNCERTAIN');
    // A blocking trace does not refuse an attempt that may take the proof, and
    // refuses every attempt that could not: the proof is the only way out of a
    // block, and an attempt without consent to recovery can neither take it nor
    // write anything. The refusal itself stays where the contract puts it, in
    // the silent entry, before any effect.
    if (traccia.state === 'blocked' && !conRecovery) return fallimento('TRACE_BLOCKED');

    const chiave = chiaveStore(assoluta);
    // A silent entry without consent to recovery is read-only: it writes no
    // event and sends no signal, so it takes no place in the process and holds
    // no slot. It is neither refused by a place it would not use nor allowed to
    // subtract places from the attempt that will use them.
    const solaLettura = mode === 'silent' && !conRecovery;
    if (!solaLettura && PRENOTAZIONI.has(chiave)) return fallimento('ATTEMPT_OPEN');

    const voci = contaVoci(dir);
    if (voci === null) return fallimento('STORE');
    const riserva = RESERVED_SLOTS[`${mode}/${conRecovery ? 'recovery' : 'no-recovery'}`];
    if (voci + riserva > MAX_FILES) return fallimento('STORE_CAPACITY');

    // The plan binds the store only if the reservation can be taken, and the
    // fence is read synchronously, immediately before the attempt exists.
    let esitoFence;
    try {
      esitoFence = fenceCheck();
    } catch (_) {
      return fallimento('FENCE');
    }
    if (esitoFence !== true) return fallimento('FENCE');

    // The clock is read again after the synchronous work already done: the
    // qualification and the fence take time, and an admission decided on a
    // reading taken before them would be true about a moment that has passed.
    // Same deadline, no new budget; nothing has been reserved yet, so a refusal
    // here leaves no place behind.
    const adessoDopo = monoNow();
    if (!Number.isFinite(adessoDopo) || adessoDopo < adesso || adessoDopo >= deadlineAt) {
      return fallimento('BUDGET');
    }

    // The per-operation identity comes from the random source inside a guarded
    // step: an admission answers a value and never throws, and a refusal here
    // leaves no place behind because nothing has been reserved yet.
    let attemptId;
    try { attemptId = crypto.randomBytes(16).toString('hex'); } catch (_) {
      return fallimento('STORE');
    }

    const attempt = Object.freeze({
      mode,
      stateDir: assoluta,
      need: riserva,
    });
    // Only an attempt that may write takes the store. The read-only branch is
    // bound to the same handle for release, and releases nothing else.
    if (!solaLettura) PRENOTAZIONI.set(chiave, { attempt, need: riserva });
    TENTATIVI.set(attempt, chiave);
    ATTEMPTS.set(attempt, {
      chiave,
      mode,
      stateDir: assoluta,
      record,
      deadlineAt,
      phasePlan,
      allowHostRecovery: conRecovery,
      fenceCheck,
      digest: contextDigest(record),
      attemptId,
      need: riserva,
      vociAllApertura: voci,
      appesi: 0,
      // Set when a write could not be made durable after its temporary was
      // already removed: from that moment the handle may not act again.
      speso: false,
      // Set when this handle commits its one and only expected run: the mark is
      // taken before the attempt is written and is never released.
      cliImpegnata: false,
      // The part of the phase accounting that lives in this process: when the
      // operational path started on this handle, and what is left of the wait
      // phase. A repeated invocation on the same handle continues from the
      // remaining observations; it never reopens a spent phase.
      monoIngresso: null,
      atteseRimanenti: null,
      // The last clock value this handle accepted. Admission's final read is the
      // first one; from there every accepted read only moves forward.
      ultimoMono: adessoDopo,
      // The private marker of the TERM window: its identity while the handle
      // owns it, null before the window and after its removal.
      marcatore: null,
      // The marker of the KILL window is a second, distinct object: the two
      // windows never share one, so an exclusion granted to the kill cannot
      // reach the term and vice versa.
      marcatoreKill: null,
      // The phase accounting that lives in this process: when the wait phase was
      // entered and the credit it received, the observations still admitted to
      // the kill phase, and the last classification the kernel answered. A
      // repeated entry continues from these values and never recomputes them.
      ingressoP5: null,
      creditoP5: null,
      atteseKillRimanenti: null,
      ultimaOsservazione: null,
    });
    return { ok: true, attempt };
  }

  // An outcome of a run is one of the CLI events the schema already carries,
  // with its own closed reason. The object the callback answers is checked
  // through the same closed schema the writer applies to the full event: a
  // field it cannot carry, or a reason outside the vocabulary, is not an
  // outcome and is never written.
  // The kind of the answer is not read here: the caller acquires it once, inside
  // the guard, and hands over the value it acquired. A second read of the
  // caller's object — here or in the append — would reopen the door this
  // function exists to close.
  function eventoClienteValido(st, evento, kind) {
    if (!evento || typeof evento !== 'object' || Array.isArray(evento)) return false;
    const prototipo = Object.getPrototypeOf(evento);
    if (prototipo !== Object.prototype && prototipo !== null) return false;
    if (Object.getOwnPropertySymbols(evento).length !== 0) return false;
    if (Object.getOwnPropertyNames(evento).length !== Object.keys(evento).length) return false;
    if (Object.keys(evento).some((k) => k !== 'kind' && k !== 'reason')) return false;
    if (kind !== 'cli-ack' && kind !== 'cli-refusal' && kind !== 'cli-failed') return false;
    const candidato = {
      version: 1,
      launchId: st.record.launchId,
      attemptId: st.attemptId,
      seq: 1,
      kind,
      contextDigest: st.digest,
    };
    if (Object.prototype.hasOwnProperty.call(evento, 'reason')) candidato.reason = evento.reason;
    return validateEvent(candidato);
  }

  // One expected run for one attempt. The attempt is durable before the CLI is
  // invoked, so a CLI that answers nothing still leaves the open marker that
  // forbids acting as if nothing had happened; the outcome is durable after it,
  // and a failure of either write is a stop of this handle. The callback is
  // invoked exactly once, with the same deadline the context was admitted with
  // and the limit that the phase balance and the real residual allow.
  async function runExpected(attempt, runCli) {
    const st = ATTEMPTS.get(attempt);
    if (!st) return fallimento('HANDLE');
    if (st.mode !== 'expected') return fallimento('MODE');
    if (typeof runCli !== 'function') return fallimento('CONTEXT');
    if (st.speso) return fallimento('STORE');
    // One expected run for one attempt: the mark is set before the attempt is
    // written and never removed, so a refused or failed run cannot turn into a
    // second CLI later in the life of this handle.
    if (st.cliImpegnata) return fallimento('CLI_USED');
    const adesso = orologio(st);
    if (adesso === null) return fallimento('BUDGET');
    if (st.monoIngresso !== null && adesso < st.monoIngresso) return fallimento('BUDGET');
    if (st.monoIngresso === null) st.monoIngresso = adesso;
    if (!consenso(st)) return fallimento('FENCE');
    // Pre-CLI reserve. With an explicit plan it is the CLI phase and one
    // interval for each phase that still has to run, plus the margin. Without a
    // plan — the historical path, admitted only when recovery is not authorized
    // — no phase has to run, so the margin alone stands before the write.
    if (st.deadlineAt - adesso < (st.phasePlan === undefined ? margine(st) : 350 + margine(st))) {
      return fallimento('BUDGET');
    }

    // The CLI is committed from here on: the mark is set before the durable
    // attempt, so even a failed write leaves the run consumed and no later call
    // can invoke the callback again.
    st.cliImpegnata = true;
    // A write that precedes an effect never happens on a blocking trace: an
    // unresolved attempt is not a place to start another run, and only the
    // proof may lift the silence.
    const appeso = appendEvento(attempt, 'cli-attempt', {}, { requireClear: true });
    if (!appeso.ok) return fallimento(appeso.code);

    // The limit is recomputed after the durable attempt and is never widened:
    // it is the balance of the CLI phase plus the credit, which is zero here
    // because no phase of this run preceded the CLI, bounded by the real
    // residual minus the margin and the phases that still have to run.
    const dopo = orologio(st);
    if (dopo === null) return fallimento('BUDGET');
    if (dopo < adesso) return fallimento('BUDGET');
    const residuo = st.deadlineAt - dopo - margine(st);
    // Without a plan the limit is the whole residual of the historical path,
    // minus the margin: no allowance and no floor.
    const budgetMs = st.phasePlan === undefined ? residuo : Math.min(allowanceDi(st, 'p3'), residuo - 50 * 6);
    if (budgetMs < 1) return fallimento('BUDGET');

    // The consent is read synchronously again after all the durable
    // preparation and immediately before the CLI: a fence lost while the
    // attempt was being persisted must stop the run before the effect, never
    // after it. The already written attempt stays open and blocks.
    if (!consenso(st)) return fallimento('FENCE');

    let risultato;
    try {
      risultato = await runCli({ deadlineAt: st.deadlineAt, budgetMs });
    } catch (_) {
      // The attempt stays open and blocking: a run that rejected did not
      // answer, and the trace must say so.
      return fallimento('CLI');
    }
    // The answer of the CLI is read under a guard. A getter or a proxy that
    // throws is not an outcome and must not turn into a rejected promise: the
    // attempt stays open and blocking, and the caller gets a code like for any
    // other unwritable answer.
    let evento = null;
    let valore;
    let tipo = null;
    let valido = false;
    let extra = {};
    try {
      evento = risultato && typeof risultato === 'object' ? risultato.event : null;
      valore = risultato ? risultato.result : undefined;
      // Every field of the answer is acquired once, here. The value the append
      // writes is the value this read produced and the validation checked: the
      // caller's object is never read again after the guard.
      if (evento && typeof evento === 'object' && !Array.isArray(evento)) tipo = evento.kind;
      valido = eventoClienteValido(st, evento, tipo);
      if (valido && Object.prototype.hasOwnProperty.call(evento, 'reason')) extra = { reason: evento.reason };
    } catch (_) {
      return fallimento('STORE');
    }
    if (!valido) return fallimento('STORE');
    const chiusura = appendEvento(attempt, tipo, extra);
    if (!chiusura.ok) return fallimento(chiusura.code);
    return { ok: true, result: valore };
  }

  function closeAttempt(attempt) {
    const chiave = attempt && typeof attempt === 'object' ? TENTATIVI.get(attempt) : undefined;
    if (!chiave) return;
    TENTATIVI.delete(attempt);
    ATTEMPTS.delete(attempt);
    // A look-alike object, or a handle this module never issued, releases
    // nothing: the check binds the release to the exact handle that took the
    // place. It does not prove which factory is calling, and it does not need
    // to: the place belongs to the store, not to the caller.
    const corrente = PRENOTAZIONI.get(chiave);
    if (corrente && corrente.attempt === attempt) PRENOTAZIONI.delete(chiave);
  }

  // -------------------------------------------------------------------------
  // Recovery: entry, trace, consent, kernel, intent, barrier
  // -------------------------------------------------------------------------

  function fallimentoStop(code) {
    return { outcome: 'host-stop-failed', code };
  }

  // The clock of a handle only moves forward. Every read this module accepts
  // for the attempt updates its last value; a read that is not finite, past the
  // deadline or behind the last accepted one is no clock at all, and the
  // caller refuses before its next effect.
  function orologio(st) {
    let adesso;
    try { adesso = monoNow(); } catch (_) { return null; }
    if (!Number.isFinite(adesso) || adesso >= st.deadlineAt) return null;
    if (st.ultimoMono !== null && adesso < st.ultimoMono) return null;
    st.ultimoMono = adesso;
    return adesso;
  }

  function consenso(st) {
    try { return st.fenceCheck() === true; } catch (_) { return false; }
  }

  function margine(st) {
    return marginePer(st.phasePlan && Number.isSafeInteger(st.phasePlan.budgetMs) ? st.phasePlan.budgetMs : 8000);
  }

  // An event of a context is an event of this launch and this digest: a store
  // may carry other launches, and another launch's signal says nothing about
  // this process.
  function eventoSuo(st, ev) {
    return ev.launchId === st.record.launchId && ev.contextDigest === st.digest;
  }

  function haEvento(st, eventi, kind) {
    return eventi.some((ev) => ev.kind === kind && eventoSuo(st, ev));
  }

  // The last event of a kind that belongs to this context, or null.
  function eventoDelContesto(st, eventi, kind) {
    let ultimo = null;
    for (const ev of eventi) {
      if (ev.kind === kind && eventoSuo(st, ev)) ultimo = ev;
    }
    return ultimo;
  }

  // The method of an exit and of a close is the signal this context already
  // attempted. A kill, when it exists, is the later of the two; a context that
  // attempted nothing has no method, and null is that absence and not a guess.
  function metodoDelContesto(st, eventi) {
    if (haEvento(st, eventi, 'signaled-kill')) return 'kill';
    if (haEvento(st, eventi, 'signaled-term')) return 'term';
    return null;
  }

  function sommaAllowance(st, ids) {
    const fasi = st.phasePlan && Array.isArray(st.phasePlan.phases) ? st.phasePlan.phases : [];
    let somma = 0;
    for (const fase of fasi) {
      if (ids.includes(fase.id) && Number.isSafeInteger(fase.allowanceMs)) somma += fase.allowanceMs;
    }
    return somma;
  }

  function allowanceDi(st, id) {
    const fasi = st.phasePlan && Array.isArray(st.phasePlan.phases) ? st.phasePlan.phases : [];
    const fase = fasi.find((f) => f.id === id);
    return fase && Number.isSafeInteger(fase.allowanceMs) ? fase.allowanceMs : 0;
  }

  // The barrier is the only place that writes `closed`, and it writes it
  // only on a fresh `none` from the root. A lock, a live peer or an
  // inconclusive probe leave the attempt failed and the root untouched: this
  // module removes nothing.
  async function barriera(attempt, st, reason) {
    if (!probeRoot) return fallimentoStop('PROBE');
    const adesso = orologio(st);
    if (adesso === null) return fallimentoStop('BUDGET');
    let sonda;
    try {
      sonda = await probeRoot({
        record: st.record,
        deadlineAt: st.deadlineAt,
        budgetMs: Math.max(0, st.deadlineAt - adesso),
      });
    } catch (_) { return fallimentoStop('PROBE'); }
    if (!sonda || !sonda.r || sonda.r.ok !== true || !sonda.stato || sonda.stato.ok !== true) {
      return fallimentoStop('PROBE');
    }
    if (sonda.stato.state !== 'none') return fallimentoStop('BARRIER');
    if (!consenso(st)) return fallimentoStop('FENCE');
    if (orologio(st) === null) return fallimentoStop('BUDGET');
    const traccia = readTrace({ stateDir: st.stateDir, record: st.record });
    if (traccia.state === 'uncertain') return fallimentoStop('STORE');
    const metodo = metodoDelContesto(st, traccia.events);
    const giaUscito = haEvento(st, traccia.events, 'exited');
    const giaChiuso = haEvento(st, traccia.events, 'closed');
    // An exit and a close already recorded for this context are already the
    // whole attestation: the root was probed again just now and the trace was
    // read again, and nothing is written a second time. A close without an exit
    // is not that pair, and the barrier completes the exit it is missing.
    if (giaUscito && giaChiuso) {
      return { outcome: 'host-stopped-attested', method: metodo };
    }
    // One exit per context. The exit is a fact about the recorded process, not
    // about this operation: a previous operation may already have recorded it,
    // and a second one would tell a reader that the process exited twice. When
    // it is already there the barrier goes straight to the close, and the close
    // carries the method the context actually attempted.
    if (!giaUscito) {
      const uscita = appendEvento(attempt, 'exited', { method: metodo, reason });
      if (!uscita.ok) return fallimentoStop(uscita.code);
      if (!consenso(st)) return fallimentoStop('FENCE');
      if (orologio(st) === null) return fallimentoStop('BUDGET');
    }
    if (giaChiuso) return { outcome: 'host-stopped-attested', method: metodo };
    const chiuso = appendEvento(attempt, 'closed', { method: metodo });
    if (!chiuso.ok) return fallimentoStop(chiuso.code);
    return { outcome: 'host-stopped-attested', method: metodo };
  }

  // The wait phase: the exit of the original is observed, never assumed. The
  // number of observations is fixed once, when the phase is entered — the
  // balance of the phase plus the allowances this path left unspent, bounded by
  // the real residual minus the margin and the phases that still have to run —
  // and it is never recomputed while the clock stands still. A repeated entry on
  // the same handle continues from the remaining observations and never reopens
  // a spent phase. An uncertain or unreadable snapshot is not proof of an exit
  // and does not stop the wait: only the barrier attests a stop.
  async function attesaUscita(attempt, st, dopoTerm) {
    if (st.atteseRimanenti === null) {
      const adesso = orologio(st);
      if (adesso === null) return fallimentoStop('BUDGET');
      if (st.monoIngresso === null) st.monoIngresso = adesso;
      const consumato = adesso - st.monoIngresso;
      if (consumato < 0) return fallimentoStop('BUDGET');
      const credito = Math.max(0, sommaAllowance(st, ['p1', 'p2', 'p3', 'p4']) - consumato);
      const riserveFuture = 50 * 4;
      const saldo = Math.min(
        allowanceDi(st, 'p5') + credito,
        st.deadlineAt - adesso - margine(st) - riserveFuture,
      );
      // The entry of the wait phase is kept for the phase that follows it: the
      // credit this phase received is what the kill phase may find still
      // unspent, and the moment it was entered is what says how much of it was
      // consumed.
      st.ingressoP5 = adesso;
      st.creditoP5 = credito;
      st.atteseRimanenti = Math.min(301, 1 + Math.ceil(Math.max(0, Math.floor(saldo)) / 50));
    }
    let precedente = orologio(st);
    if (precedente === null) return fallimentoStop('BUDGET');
    while (st.atteseRimanenti > 0) {
      st.atteseRimanenti -= 1;
      const adesso = orologio(st);
      if (adesso === null) return fallimentoStop('BUDGET');
      if (adesso < precedente) return fallimentoStop('BUDGET');
      precedente = adesso;
      if (!consenso(st)) return fallimentoStop('FENCE');
      const oss = osservaEsito(st);
      if (oss.stato === 'uscito') return barriera(attempt, st, oss.reason);
      if (st.atteseRimanenti === 0) break;
      const residuo = st.deadlineAt - adesso;
      if (residuo <= 0) return fallimentoStop('BUDGET');
      try {
        await attesaImpl(Math.max(1, Math.min(50, Math.floor(residuo))));
      } catch (_) {
        return fallimentoStop('BUDGET');
      }
    }
    // The wait phase exhausted its observations without proof. A context that
    // already attempted a TERM does not stop here: the kill window takes over,
    // and its own checks decide whether the second signal is admissible.
    if (dopoTerm === true) return finestraKill(attempt, st);
    return fallimentoStop('BUDGET');
  }

  // The wait that follows a kill. Its counter is its own — the term phase has
  // already spent its observations — and it is fixed once on entry, bounded by
  // the real residual minus the margin and the observations the later phases
  // still need. A repeated entry continues from what is left and never reopens
  // a spent phase. An uncertain reading is not an exit and does not stop the
  // wait: only the barrier attests a stop.
  async function attesaKill(attempt, st) {
    if (st.atteseKillRimanenti === null) {
      const adesso = orologio(st);
      if (adesso === null) return fallimentoStop('BUDGET');
      // The credit of the wait phase is handed over once: what the term phase
      // received and did not consume is still available to the kill phase, and
      // what it already consumed is not. The balance is the kill phase's own
      // allowance plus that credit, bounded by the real residual minus the
      // margin and the observations the later phases still need.
      const ingressoP5 = st.ingressoP5 === null ? adesso : st.ingressoP5;
      const consumato = adesso - ingressoP5;
      if (consumato < 0) return fallimentoStop('BUDGET');
      const credito = Math.max(0, (st.creditoP5 === null ? 0 : st.creditoP5) + allowanceDi(st, 'p5') - consumato);
      const saldo = Math.min(
        allowanceDi(st, 'p6') + credito,
        st.deadlineAt - adesso - margine(st) - 150,
      );
      st.atteseKillRimanenti = Math.min(301, 1 + Math.ceil(Math.max(0, Math.floor(saldo)) / 50));
    }
    let precedente = orologio(st);
    if (precedente === null) return fallimentoStop('BUDGET');
    while (st.atteseKillRimanenti > 0) {
      st.atteseKillRimanenti -= 1;
      const adesso = orologio(st);
      if (adesso === null) return fallimentoStop('BUDGET');
      if (adesso < precedente) return fallimentoStop('BUDGET');
      precedente = adesso;
      if (!consenso(st)) return fallimentoStop('FENCE');
      const oss = osservaEsito(st);
      st.ultimaOsservazione = oss.stato;
      if (oss.stato === 'uscito') return barriera(attempt, st, oss.reason);
      if (st.atteseKillRimanenti === 0) break;
      const residuo = st.deadlineAt - adesso;
      if (residuo <= 0) return esitoKillEsaurito(st);
      try {
        await attesaImpl(Math.max(1, Math.min(50, Math.floor(residuo))));
      } catch (_) {
        return esitoKillEsaurito(st);
      }
    }
    return esitoKillEsaurito(st);
  }

  // The exhaustion of the kill wait is a failure that says one thing more: the
  // host is reported alive only when the LAST reading of the kernel was
  // positively the original process. An uncertain, unverifiable or absent
  // reading leaves the flag out, whatever an earlier reading said.
  function esitoKillEsaurito(st) {
    const esito = fallimentoStop('BUDGET');
    if (st.ultimaOsservazione === 'vivo') esito.hostAlive = true;
    return esito;
  }

  // The operational window. The intent is durable before anything is sent, a
  // fresh and complete snapshot is taken after it, the fence is read
  // synchronously and the clock is read once more immediately before the
  // syscall: no await, no promise and no store write stands between that
  // snapshot and the signal, or between the fence and the signal. What is
  // written after the syscall records what already happened; it never decides
  // it, and a failure there is a stop with no escalation and no new signal.
  async function finestraTerm(attempt, st, traccia) {
    if (!haEvento(st, traccia.events, 'intent-term')) {
      const intento = appendEvento(attempt, 'intent-term', { method: 'term' }, { requireClear: true });
      if (!intento.ok) return fallimentoStop(intento.code);
    }

    // The marker of the window: durable before the last snapshot, and removed
    // only after the post-event is durable. From here until the removal a new
    // process sees `uncertain` and cannot resume into a second signal.
    //
    // Rule of the marker, whole. Once it exists it stays on every refusal of
    // this window, including the refusals that come before the signal: an
    // uncertain private read, an uncertain or exited snapshot, a fallen fence,
    // a clock or a reserve that does not allow the call. Its presence records
    // that the window was entered, NOT that the signal was sent — a residue
    // without an effect is the conservative outcome of this design. The marker
    // is never adopted, reused or removed automatically by a later operation,
    // this handle or the next one: the store stays uncertain until a human
    // clears it. Every such refusal also spends the handle, so no later
    // operation of this handle can write through the exclusion the marker
    // grants to the window that created it.
    const marchio = creaMarcatore(st);
    if (!marchio.ok) return fallimentoStop(marchio.code);
    st.marcatore = marchio.marcatore;
    // Every exit of the window that leaves the marker on disk spends the
    // handle: the capability to ignore this object ends with the window, and a
    // handle that abandoned its window may not act on the store again.
    const abbandona = (code) => {
      st.speso = true;
      return fallimentoStop(code);
    };
    // The store is read again with the marker excluded: a foreign temporary, an
    // object that already replaced the marker, or a marker that is no longer
    // there at all is a refusal here, before the snapshot and the syscall.
    const conMarchio = leggiTraccia({ stateDir: st.stateDir, record: st.record }, st.marcatore);
    if (conMarchio.state === 'uncertain') return abbandona('STORE');
    // The same context that entered on a trace without a signal may have had
    // one recorded while the window was being prepared: the fresh read is the
    // one that decides, and a durable signal of this context stops here with
    // no syscall and no new signal.
    if (haEvento(st, conMarchio.events, 'signaled-term')) return abbandona('ESCALATION');

    const dopo = osservaEsito(st);
    if (dopo.stato === 'incerto') return abbandona(dopo.code);
    // The original exited while the window was being prepared: with the marker
    // on disk the store is uncertain and the barrier could only fail on it, so
    // the branch is explicit. No signal and no probe follow, nothing is
    // attested, and the residue stays for a manual cleanup: this is the
    // conservative stop of the design, not a success reached by ignoring the
    // marker.
    if (dopo.stato === 'uscito') return abbandona('STORE');

    if (!consenso(st)) return abbandona('FENCE');
    const adesso = orologio(st);
    if (adesso === null) return abbandona('BUDGET');
    if (st.deadlineAt - adesso < 250 + margine(st)) return abbandona('BUDGET');

    let errore = null;
    try {
      killProcess(st.record.hostIdentity.pid, 'SIGTERM');
    } catch (e) {
      errore = e;
    }

    // The syscall is a fact from here on, whatever it answered: the event that
    // records it is written first, and its failure ends the attempt instead of
    // leading to a new signal. This is the one event of the handle that is
    // written ignoring its own marker: the window that created the marker is
    // the window that closes it.
    const motivo = errore === null ? 'sent'
      : (errore && errore.code === 'ESRCH' ? 'esrch'
        : (errore && errore.code === 'EPERM' ? 'eperm' : 'error'));
    const segnale = appendEvento(attempt, 'signaled-term', { method: 'term', reason: motivo }, { escludiMarcatore: true });
    if (!segnale.ok) {
      st.speso = true;
      return fallimentoStop(segnale.code);
    }
    // The post-event is durable: only now the marker can go. Its removal is the
    // cleanup of a committed effect, and a failure there is the same erratum as
    // the temporary of an append.
    const pulizia = rimuoviMarcatore(st);
    if (!pulizia.ok) return fallimentoStop(pulizia.code);
    if (motivo === 'eperm') return fallimentoStop('EPERM');
    if (motivo === 'error') return fallimentoStop('SIGNAL');
    // An absence reported by the syscall is not an exit by itself: the wait
    // phase takes a fresh snapshot, and the barrier is what attests the stop.
    return attesaUscita(attempt, st, true);
  }

  // The kill window. It is entered only where the context already attempted a
  // TERM and its trace carries no kill: the reserve is checked before any
  // write, the durable intent precedes the marker, the marker is required by
  // the internal read, the snapshot and the fence are fresh, and no await and
  // no write stand between the last snapshot and the syscall. One signal, one
  // marker, the post-event before the cleanup.
  function finestraKill(attempt, st) {
    // The reserve of this window is its own: below it nothing is written, not
    // even the intent, and no signal can be reached.
    const adessoRiserva = orologio(st);
    if (adessoRiserva === null) return fallimentoStop('BUDGET');
    if (st.deadlineAt - adessoRiserva < 200 + margine(st)) return fallimentoStop('BUDGET');

    // The trace is read again, in public: the context may have gained an event
    // since the entry, and this reading decides what this window may do.
    const traccia = readTrace({ stateDir: st.stateDir, record: st.record });
    if (traccia.state === 'uncertain') return fallimentoStop('TRACE_UNCERTAIN');
    if (haEvento(st, traccia.events, 'signaled-kill')) return fallimentoStop('ESCALATION');
    const term = eventoDelContesto(st, traccia.events, 'signaled-term');
    // A kill is never authorized by a trace that never recorded a term, by a
    // term whose syscall answered that the process does not exist, or by a term
    // that failed at the kernel. All three are conservative refusals: no write,
    // no signal, and the handle is spent.
    if (!term) {
      st.speso = true;
      return fallimentoStop('TRACE_UNCERTAIN');
    }
    if (term.reason === 'esrch') {
      st.speso = true;
      return fallimentoStop('IDENTITY_UNKNOWN');
    }
    if (!ESCALATION_REASONS.has(term.reason)) {
      st.speso = true;
      return fallimentoStop(term.reason === 'eperm' ? 'EPERM' : 'SIGNAL');
    }

    if (!haEvento(st, traccia.events, 'intent-kill')) {
      const intento = appendEvento(attempt, 'intent-kill', { method: 'kill' }, { requireClear: true });
      if (!intento.ok) return fallimentoStop(intento.code);
    }

    // The marker of this window is a second object, distinct from the term one.
    // From here until its removal a new process sees `uncertain`.
    const marchio = creaMarcatore(st);
    if (!marchio.ok) return fallimentoStop(marchio.code);
    st.marcatoreKill = marchio.marcatore;
    const abbandona = (code) => {
      st.speso = true;
      return fallimentoStop(code);
    };

    const conMarchio = leggiTraccia({ stateDir: st.stateDir, record: st.record }, st.marcatoreKill);
    if (conMarchio.state === 'uncertain') return abbandona('STORE');
    if (haEvento(st, conMarchio.events, 'signaled-kill')) return abbandona('ESCALATION');

    const dopo = osservaEsito(st);
    st.ultimaOsservazione = dopo.stato;
    if (dopo.stato === 'incerto') return abbandona(dopo.code);
    // The original left while this window was being prepared: with the marker on
    // disk the store is uncertain and the barrier could only fail on it. No
    // signal, no probe, no exit and no close: the residue stays for a manual
    // cleanup.
    if (dopo.stato === 'uscito') return abbandona('STORE');

    if (!consenso(st)) return abbandona('FENCE');
    const adesso = orologio(st);
    if (adesso === null) return abbandona('BUDGET');
    if (st.deadlineAt - adesso < 200 + margine(st)) return abbandona('BUDGET');

    let errore = null;
    try {
      killProcess(st.record.hostIdentity.pid, 'SIGKILL');
    } catch (e) {
      errore = e;
    }

    // The syscall is a fact from here on. Its event is written first, with the
    // exclusion of this window's own marker only; a failure there ends the
    // attempt with no new signal and no replay.
    const motivo = errore === null ? 'sent'
      : (errore && errore.code === 'ESRCH' ? 'esrch'
        : (errore && errore.code === 'EPERM' ? 'eperm' : 'error'));
    const segnale = appendEvento(attempt, 'signaled-kill', { method: 'kill', reason: motivo }, { escludiMarcatoreKill: true });
    if (!segnale.ok) {
      st.speso = true;
      return fallimentoStop(segnale.code);
    }
    const pulizia = rimuoviMarcatore(st, 'marcatoreKill');
    if (!pulizia.ok) return fallimentoStop(pulizia.code);
    if (motivo === 'eperm') return fallimentoStop('EPERM');
    if (motivo === 'error') return fallimentoStop('SIGNAL');
    // An absence reported by the syscall is reclassified by the fresh snapshot
    // of the wait that follows; a delivery is awaited there in the same way.
    return attesaKill(attempt, st);
  }

  async function recover(attempt, entry) {
    const st = ATTEMPTS.get(attempt);
    if (!st) return fallimentoStop('HANDLE');
    // An attempt whose last write was not made durable does not resume: the
    // store is uncertain and this handle may not act on it again.
    if (st.speso) return fallimentoStop('STORE');
    if (entry !== 'after-ack' && entry !== 'silent' && entry !== 'server-absent') {
      return fallimentoStop('ENTRY');
    }
    // An attempt without the explicit consent of the caller is read-only.
    // It refuses here, with zero effects and without having reserved anything.
    if (st.allowHostRecovery !== true) return fallimentoStop('CONSENT');
    const ingresso = orologio(st);
    if (ingresso === null) return fallimentoStop('BUDGET');
    if (st.monoIngresso === null) st.monoIngresso = ingresso;
    if (!consenso(st)) return fallimentoStop('FENCE');

    // The trace of this context. A blocking trace is lifted only by the
    // proof, and only if the store then reads clear: the proof is the event,
    // not the intention to write it.
    let traccia = readTrace({ stateDir: st.stateDir, record: st.record });
    if (traccia.state === 'uncertain') return fallimentoStop('TRACE_UNCERTAIN');
    if (traccia.state === 'blocked') {
      const prova = await provaPeer(attempt, st);
      if (!prova) return fallimentoStop('TRACE_BLOCKED');
      traccia = readTrace({ stateDir: st.stateDir, record: st.record });
      if (traccia.state !== 'clear') return fallimentoStop('TRACE_BLOCKED');
    }

    // Entry protocol. An expected context that enters after an acknowledgement
    // must carry an outcome of its CLI in the trace: without one there is no
    // transition this context ever authorized, and the entry is refused before
    // any effect. The other combinations are governed by the trace rules.
    if (st.mode === 'expected' && entry === 'after-ack'
      && !traccia.events.some((ev) => eventoSuo(st, ev) && (ev.kind === 'cli-ack' || ev.kind === 'cli-failed'))) {
      return fallimentoStop('ENTRY');
    }

    // A `server-absent` entry is about the root. The root must be a real
    // directory of the record; a link, or a base that moved, is a refusal and
    // never a reason to reach for a signal.
    if (entry === 'server-absent') {
      let stRoot = null;
      try { stRoot = fsRecovery.lstatSync(st.record.serverRoot); } catch (_) { stRoot = null; }
      if (!stRoot || typeof stRoot.isDirectory !== 'function' || !stRoot.isDirectory()
        || (typeof stRoot.isSymbolicLink === 'function' && stRoot.isSymbolicLink())) {
        return fallimentoStop('ROOT');
      }
    }

    // The ledger that needs no kernel evidence comes first: a kill intent
    // without the term that authorizes it is incoherent whatever the original
    // is doing, and no snapshot, barrier or attestation can turn it into a
    // closed stop.
    const term = eventoDelContesto(st, traccia.events, 'signaled-term');
    if (haEvento(st, traccia.events, 'intent-kill') && !term) {
      st.speso = true;
      return fallimentoStop('TRACE_UNCERTAIN');
    }

    // The kernel snapshot and the isolation judgement that follows it.
    const prima = osservaEsito(st);
    if (prima.stato === 'incerto') return fallimentoStop(prima.code);
    if (prima.stato === 'uscito') return barriera(attempt, st, prima.reason);

    // A kill already recorded with the original still visible is not escalated
    // again: the refusal names the escalation and says the host is alive. A
    // term whose syscall answered that the process does not exist while that
    // process is visible again, and a term that failed at the kernel, are
    // incoherent traces: no signal follows, and the handle is spent. A term
    // already delivered opens the kill window, once.
    if (haEvento(st, traccia.events, 'signaled-kill')) {
      const rifiuto = fallimentoStop('ESCALATION');
      rifiuto.hostAlive = true;
      return rifiuto;
    }
    if (term && term.reason === 'esrch') {
      st.speso = true;
      return fallimentoStop('IDENTITY_UNKNOWN');
    }
    // A term that failed at the kernel — permission, unknown error — is a stop
    // of the escalation, not an authorization: the same codes the operational
    // window answers after that failure are answered here, with no signal.
    if (term && !ESCALATION_REASONS.has(term.reason)) {
      st.speso = true;
      return fallimentoStop(term.reason === 'eperm' ? 'EPERM' : 'SIGNAL');
    }
    if (term) return finestraKill(attempt, st);

    const adesso = orologio(st);
    if (adesso === null) return fallimentoStop('BUDGET');
    // Pre-TERM reserve: the wait and the barrier phases that follow it, plus
    // the margin of the plan.
    if (st.deadlineAt - adesso < 250 + margine(st)) return fallimentoStop('BUDGET');
    if (!consenso(st)) return fallimentoStop('FENCE');

    return finestraTerm(attempt, st, traccia);
  }

  return { openAttempt, runExpected, recover, readTrace, closeAttempt };
}

module.exports = {
  createHostRecovery,
  guardPid,
  guardRecord,
  confrontaTupla,
  validateEvent,
};
