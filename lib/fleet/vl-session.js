'use strict';
// Explicit "new session" requests for vl cells, plus the read-only legacy
// state inventory. Two separate contracts live here because both are pure
// filesystem concerns of the vl engine family and neither belongs to the
// managed-spec resolution (managed.js) or the launch cycle (runtime.js):
//
//  - NEW SESSION: an explicit operator action writes a PERSISTENT marker
//    under the NexusCrew state tree. The launch cycle (runtime.up) consumes
//    it ATOMICALLY (rename) before the spawn, exactly once: an ordinary
//    start/restart never rotates the session, and a supervisor retry cannot
//    repeat a rotation that already happened. If the outcome is uncertain
//    (crash between consumption and spawn), the consumed record stays on
//    disk and reports its state — a second automatic rotation never happens.
//
//  - LEGACY INVENTORY: the pre-contract vl cells shared a handful of
//    state directories (~/.local/state/vl*). Migration is an explicit,
//    operator-driven procedure (nothing moves or gets deleted here, ever):
//    this only LISTS what exists so the operator can decide with data.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { safePrivateDir } = require('./credentials.js');

// Same self-defense as writeVlCellPrompt (managed.js): the cell id is already
// validated upstream (CELL_ID_RE, definitions.js), but '.' and '..' pass that
// RE and, as a FILE NAME, they are traversal. The refusal happens before any
// disk access.
function assertSafeCellId(cellId) {
  const id = typeof cellId === 'string' ? cellId : '';
  if (!id || id === '.' || id === '..' || id.includes('/') || /[\x00-\x1f\x7f]/.test(id)) {
    throw new Error('unsafe vl cell id');
  }
  return id;
}

function vlNewSessionDir(home) {
  const nexus = path.join(home, '.nexuscrew');
  safePrivateDir(nexus, { create: true });
  const dir = path.join(nexus, 'vl-new-session');
  safePrivateDir(dir, { create: true });
  return dir;
}

function markerPaths(home, cellId) {
  const id = assertSafeCellId(cellId);
  const dir = vlNewSessionDir(home);
  return { dir, requested: path.join(dir, `${id}.requested`), consumed: path.join(dir, `${id}.consumed`) };
}

// I percorsi dei marcatori per una LETTURA: nessuna directory viene creata.
// La vista dello stato e' read-only per contratto, e una lettura che lascia
// una directory sul disco non e' una lettura. La richiesta e il consumo
// scrivono, e quelli passano da `markerPaths`.
function markerPathsReadOnly(home, cellId) {
  const id = assertSafeCellId(cellId);
  const dir = path.join(home, '.nexuscrew', 'vl-new-session');
  return { dir, requested: path.join(dir, `${id}.requested`), consumed: path.join(dir, `${id}.consumed`) };
}

// Atomic JSON write (tmp + fsync + rename, mode 0600) — same shape as the vl
// catalog copy. Never a secret: the record carries ids and timestamps only.
function writeRecordAtomic(target, record) {
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(record));
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, target);
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

function readRecord(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) { return null; }
}

// Request a fresh session for a vl cell (explicit operator action, owner
// node). Idempotent on a pending request: a double click or a UI retry finds
// the SAME pending marker instead of stacking a second one — the request is
// consumable once, so there is nothing a second click could add.
function requestVlNewSession({ home, cellId, now = Date.now() }) {
  const { requested, consumed } = markerPaths(home, cellId);
  const pending = readRecord(requested);
  if (pending) {
    return { state: 'pending', requestedAt: pending.requestedAt || 0, alreadyPending: true };
  }
  const previous = readRecord(consumed);
  writeRecordAtomic(requested, { cell: cellId, requestedAt: now });
  return {
    state: 'pending',
    requestedAt: now,
    alreadyPending: false,
    // The last consumption, if any: with a pending request on top of it this
    // is also how an "outcome unknown" previous rotation surfaces.
    ...(previous ? { lastConsumedAt: previous.consumedAt || 0 } : {}),
  };
}

// Consume the pending request ATOMICALLY, before the spawn. The rename IS the
// consumption: two consumers cannot both win, and a crash before the rename
// leaves the request pending (the launch never happened, the rotation never
// happened — the next launch may consume it). `consumedAt` is stamped just
// before the rename: a crash between the stamp and the rename keeps the
// request pending with a slightly early timestamp, which is harmless — the
// record still tells the truth about WHAT happened, never invents a rotation.
function consumeVlNewSession({ home, cellId, now = Date.now() }) {
  const { requested, consumed } = markerPaths(home, cellId);
  const pending = readRecord(requested);
  if (!pending) return { consumed: false };
  writeRecordAtomic(requested, { cell: cellId, requestedAt: pending.requestedAt || 0, consumedAt: now });
  fs.renameSync(requested, consumed);
  return { consumed: true, requestedAt: pending.requestedAt || 0, consumedAt: now };
}

// Current state of the request, for diagnostics and for reporting an
// uncertain outcome: 'pending' means the next launch will rotate; 'consumed'
// means a launch consumed the request — whether the runtime actually rotated
// is NOT tracked here (NexusCrew never reads vl session content), and that is
// exactly what the state says, instead of guessing.
function vlNewSessionStatus({ home, cellId }) {
  const { requested, consumed } = markerPathsReadOnly(home, cellId);
  const pending = readRecord(requested);
  if (pending) {
    const last = readRecord(consumed);
    return {
      state: 'pending',
      requestedAt: pending.requestedAt || 0,
      ...(last ? { lastConsumedAt: last.consumedAt || 0 } : {}),
    };
  }
  const done = readRecord(consumed);
  if (done) {
    return {
      state: 'consumed',
      requestedAt: done.requestedAt || 0,
      consumedAt: done.consumedAt || 0,
      outcome: 'not-tracked',
    };
  }
  return { state: 'none' };
}

// --- Legacy inventory (read-only) -------------------------------------------
//
// The shared pre-contract state directories: `~/.local/state/vl` and every
// `vl-*` sibling directory. Sessions live at
// `<dir>/vl/host-v1/sessions/<name>` (measured on the live tree). The new
// per-cell layout lives under ~/.nexuscrew/vl-cells and never matches this
// scan, so what this lists is legacy shared state by construction.
// Names only, never content: a session transcript stays with vl.
const LEGACY_SESSIONS_REL = path.join('vl', 'host-v1', 'sessions');
const LEGACY_SESSIONS_CAP = 64;

// True se un componente del percorso (a partire da `base`) e' un symlink.
// L'inventario legacy deve restare dentro l'albero dello stato: un symlink
// INTERMEDIO (per esempio `vl/host-v1` che punta altrove) porterebbe la
// scansione a elencare le sessioni di un albero esterno. Il controllo
// guardava solo la directory finale e il path terminale: i componenti in
// mezzo restavano fuori dal controllo.
function hasSymlinkComponent(base, target) {
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return true;
  let cur = base;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    let st;
    try { st = fs.lstatSync(cur); } catch (_) { return false; }
    if (st.isSymbolicLink()) return true;
  }
  return false;
}

function vlLegacyInventory(home) {
  const stateRoot = path.join(home, '.local', 'state');
  let names = [];
  try { names = fs.readdirSync(stateRoot); } catch (_) { names = []; }
  const entries = [];
  for (const name of names.sort()) {
    if (name !== 'vl' && !name.startsWith('vl-')) continue;
    const dir = path.join(stateRoot, name);
    let st;
    try { st = fs.lstatSync(dir); } catch (_) { continue; }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    const sessionsDir = path.join(dir, LEGACY_SESSIONS_REL);
    // Nessun componente del percorso puo' essere un symlink: un symlink
    // intermedio porterebbe l'inventario a elencare un albero esterno, che
    // e' esattamente cio' che l'inventario legacy non deve fare.
    if (hasSymlinkComponent(home, sessionsDir)) continue;
    const sessions = [];
    let hasSessionsDir = false;
    try {
      const sst = fs.lstatSync(sessionsDir);
      if (sst.isDirectory() && !sst.isSymbolicLink()) {
        hasSessionsDir = true;
        for (const s of fs.readdirSync(sessionsDir).sort()) sessions.push(s);
      }
    } catch (_) { /* unreadable or absent: listed as found, sessions empty */ }
    entries.push({
      name,
      sessionsDir: hasSessionsDir,
      sessionCount: sessions.length,
      ...(sessions.length > LEGACY_SESSIONS_CAP
        ? { sessions: sessions.slice(0, LEGACY_SESSIONS_CAP), truncated: true }
        : { sessions }),
    });
  }
  return {
    scanned: '.local/state',
    entries,
    moved: 0,
    deleted: 0,
    note: 'inventario read-only: nessuna migrazione, spostamento o cancellazione',
  };
}

module.exports = {
  requestVlNewSession,
  consumeVlNewSession,
  vlNewSessionStatus,
  vlLegacyInventory,
};
