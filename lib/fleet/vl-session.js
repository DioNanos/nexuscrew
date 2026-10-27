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

// --- Launcher capabilities manifest verification ---------------------------
//
// Accanto al launcher: <command>.nc-caps.json
// Forma: { "version": "<versione>", "caps": { "newSessionEnv": 1 }, "launcherSha256": "<sha256>" }
// Il preflight legge il manifest SENZA eseguire nulla (mai un presunto --capabilities),
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_MANIFEST_VERSION_LEN = 128;
const MAX_LAUNCHER_BYTES = 256 * 1024 * 1024;

// calcola l'hash sha256 del launcher reale e lo confronta: la capacita' e' legata
// all'artefatto esatto. Manifest assente / rotto / hash mismatch / newSessionEnv
// non dichiarato -> rifiuto preflight fail-closed.

// Aprire SENZA potersi bloccare su un oggetto non regolare, poi qualificare
// dal medesimo fd. L'open e' O_RDONLY|O_NOFOLLOW|O_NONBLOCK: O_NOFOLLOW vieta
// il symlink finale, O_NONBLOCK fa tornare subito l'open di un FIFO (o di un
// device) invece di parcheggiare il thread sincrono del preflight in attesa
// di un writer; la regolarita' la decide il fstat SUL DESCRITTORE, perche'
// quello — e non un pathname riapribile — e' l'oggetto che verra' letto. Su
// un file regolare O_NONBLOCK non ha effetto: i lanci ordinari non cambiano.
function openQualifiedReadOnly(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath,
      fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
  } catch (e) {
    return { ok: false, why: e && e.code === 'ENOENT' ? 'missing' : 'open' };
  }
  let st;
  try {
    st = fs.fstatSync(fd);
  } catch (_) {
    try { fs.closeSync(fd); } catch (_) {}
    return { ok: false, why: 'stat' };
  }
  if (!st.isFile()) {
    try { fs.closeSync(fd); } catch (_) {}
    return { ok: false, why: 'not-regular' };
  }
  return { ok: true, fd, stat: st };
}

// Allocazione e lettura limitate, da un fd gia' qualificato. Ogni fallimento
// — fstat/read/allocazione, oltre alla lettura corta — diventa un esito
// CHIUSO: niente errno, niente e.message, niente pathname; il chiamante vede
// solo il minimo 'why'. La dimensione e' quella del fstat, gia' dentro il
// tetto deciso dal chiamante prima di arrivare qui.
function readFdBounded(fd, size) {
  let buf;
  try {
    buf = Buffer.alloc(size);
  } catch (_) {
    return { ok: false, why: 'alloc' };
  }
  let read;
  try {
    read = fs.readSync(fd, buf, 0, size, 0);
  } catch (_) {
    return { ok: false, why: 'read' };
  }
  if (read !== size) return { ok: false, why: 'short-read' };
  return { ok: true, bytes: buf };
}

function verifyLauncherCaps(command, opts) {
  if (typeof command !== 'string' || !command) {
    return { ok: false, code: 'LAUNCHER_PATH_INVALID', reason: 'command non valido' };
  }
  const manifestPath = `${command}.nc-caps.json`;
  const openedManifest = openQualifiedReadOnly(manifestPath);
  if (!openedManifest.ok) {
    if (openedManifest.why === 'missing') {
      return { ok: false, code: 'MANIFEST_MISSING', reason: 'manifest di capacita assente o inaccessibile' };
    }
    return { ok: false, code: 'MANIFEST_NOT_REGULAR', reason: 'manifest di capacita non regolare' };
  }
  let manifestBuf;
  try {
    const manifestStat = openedManifest.stat;
    if (typeof process.getuid === 'function') {
      const uid = process.getuid();
      if (manifestStat.uid !== uid && manifestStat.uid !== 0) {
        return { ok: false, code: 'MANIFEST_UNTRUSTED', reason: 'owner del manifest non fidato' };
      }
    }
    if ((manifestStat.mode & 0o002) !== 0) {
      return { ok: false, code: 'MANIFEST_PERMS_UNSAFE', reason: 'permessi del manifest non sicuri' };
    }
    if (manifestStat.size > MAX_MANIFEST_BYTES) {
      return { ok: false, code: 'MANIFEST_TOO_LARGE', reason: 'manifest supera la dimensione massima' };
    }
    if (manifestStat.size === 0) {
      return { ok: false, code: 'MANIFEST_EMPTY', reason: 'manifest vuoto' };
    }
    const readManifest = readFdBounded(openedManifest.fd, manifestStat.size);
    if (!readManifest.ok) {
      return { ok: false, code: 'MANIFEST_READ_FAILED', reason: 'lettura del manifest non riuscita' };
    }
    manifestBuf = readManifest.bytes;
  } finally {
    try { fs.closeSync(openedManifest.fd); } catch (_) {}
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestBuf.toString('utf8'));
  } catch (_) {
    return { ok: false, code: 'MANIFEST_INVALID_JSON', reason: 'manifest non parsabile' };
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, code: 'MANIFEST_MALFORMED', reason: 'manifest non e un oggetto' };
  }
  for (const k of Object.keys(manifest)) {
    if (k !== 'version' && k !== 'caps' && k !== 'launcherSha256') {
      return { ok: false, code: 'MANIFEST_MALFORMED', reason: 'manifest contiene campi non riconosciuti' };
    }
  }
  if (typeof manifest.version !== 'string' || !manifest.version) {
    return { ok: false, code: 'MANIFEST_VERSION_MISSING', reason: 'versione mancante nel manifest' };
  }
  if (manifest.version.length > MAX_MANIFEST_VERSION_LEN) {
    return { ok: false, code: 'MANIFEST_VERSION_INVALID', reason: 'versione del manifest troppo lunga' };
  }
  if (!manifest.caps || typeof manifest.caps !== 'object' || Array.isArray(manifest.caps) || manifest.caps.newSessionEnv !== 1) {
    return { ok: false, code: 'CAPS_NOT_DECLARED', reason: 'capacita newSessionEnv non dichiarata o diversa da 1' };
  }
  for (const k of Object.keys(manifest.caps)) {
    if (k !== 'newSessionEnv') {
      return { ok: false, code: 'CAPS_NOT_DECLARED', reason: 'capacita sconosciute nel manifest' };
    }
  }
  if (typeof manifest.launcherSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(manifest.launcherSha256)) {
    return { ok: false, code: 'MANIFEST_HASH_INVALID', reason: 'launcherSha256 non valido nel manifest' };
  }

  // Contratto identico per il launcher: open non bloccante, qualifica dal
  // medesimo fd, letture limitate ed esiti chiusi.
  const openedLauncher = openQualifiedReadOnly(command);
  if (!openedLauncher.ok) {
    if (openedLauncher.why === 'not-regular' || openedLauncher.why === 'stat') {
      return { ok: false, code: 'LAUNCHER_NOT_REGULAR', reason: 'launcher non e un file regolare' };
    }
    return { ok: false, code: 'LAUNCHER_UNREADABLE', reason: 'launcher non leggibile' };
  }
  let launcherBytes;
  let actualHash;
  try {
    const lStat = openedLauncher.stat;
    if (typeof process.getuid === 'function') {
      const uid = process.getuid();
      if (lStat.uid !== uid && lStat.uid !== 0) {
        return { ok: false, code: 'LAUNCHER_UNTRUSTED', reason: 'owner del launcher non fidato' };
      }
    }
    if ((lStat.mode & 0o002) !== 0) {
      return { ok: false, code: 'LAUNCHER_PERMS_UNSAFE', reason: 'permessi del launcher non sicuri' };
    }
    if (lStat.size > MAX_LAUNCHER_BYTES) {
      return { ok: false, code: 'LAUNCHER_TOO_LARGE', reason: 'launcher supera la dimensione massima' };
    }
    const readLauncher = readFdBounded(openedLauncher.fd, lStat.size);
    if (!readLauncher.ok) {
      return { ok: false, code: 'LAUNCHER_READ_FAILED', reason: 'lettura del launcher non riuscita' };
    }
    launcherBytes = readLauncher.bytes;
    actualHash = crypto.createHash('sha256').update(launcherBytes).digest('hex');
  } finally {
    try { fs.closeSync(openedLauncher.fd); } catch (_) {}
  }

  if (actualHash.toLowerCase() !== manifest.launcherSha256.toLowerCase()) {
    return { ok: false, code: 'HASH_MISMATCH', reason: 'hash sha256 del launcher non corrisponde al manifest' };
  }

  if (opts && (opts.home || opts.cellId)) {
    if (!opts.home || !opts.cellId) {
      return { ok: false, code: 'PIN_OPTS_INVALID', reason: 'parametri di pinning non validi' };
    }
    const pinRes = pinLauncher({
      home: opts.home,
      cellId: opts.cellId,
      launcherBytes,
      launcherSha256: actualHash,
    });
    if (!pinRes.ok) {
      return { ok: false, code: pinRes.code || 'PIN_FAILED', reason: 'pin del launcher non materializzabile' };
    }
    return { ok: true, manifest, launcherBytes, launcherSha256: actualHash, pinnedPath: pinRes.pinnedPath };
  }
  return { ok: true, manifest, launcherBytes, launcherSha256: actualHash };
}

function pinLauncher({ home, cellId, launcherBytes, launcherSha256 }) {
  if (typeof home !== 'string' || !home) return { ok: false, code: 'PIN_HOME_INVALID' };
  let id;
  try {
    id = assertSafeCellId(cellId);
  } catch (_) {
    return { ok: false, code: 'PIN_CELL_INVALID' };
  }
  if (typeof launcherSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(launcherSha256)) {
    return { ok: false, code: 'PIN_HASH_INVALID' };
  }
  if (!Buffer.isBuffer(launcherBytes) || launcherBytes.length === 0) {
    return { ok: false, code: 'PIN_BYTES_INVALID' };
  }
  const nexusDir = path.join(home, '.nexuscrew');
  const baseDir = path.join(nexusDir, 'launcher-pins', id);
  const sha = launcherSha256.toLowerCase();
  const pinDir = path.join(baseDir, sha);
  // La catena privata si qualifica PRIMA della prima scrittura, componente
  // per componente: mkdir(recursive) non valida nulla di cio' che esiste
  // gia'. Ogni elemento esistente deve essere una directory reale (lstat,
  // mai seguito), di questo utente, non scrivibile da gruppo/mondo; gli
  // elementi mancanti nascono 0700. Un elemento alieno ovunque nella catena
  // rifiuta il pin: nessuno staging, nessun prune, nessuna scrittura attraverso
  // o attorno all'oggetto estraneo. Scritture e prune restano cosi' confinati
  // al namespace della cella realmente qualificato.
  for (const dir of [nexusDir, path.join(nexusDir, 'launcher-pins'), baseDir, pinDir]) {
    let st;
    try {
      st = fs.lstatSync(dir);
    } catch (e) {
      if (e && e.code === 'ENOENT') {
        try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (_) { return { ok: false, code: 'PIN_MKDIR_FAILED' }; }
        continue;
      }
      return { ok: false, code: 'PIN_NS_UNSAFE' };
    }
    if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, code: 'PIN_NS_UNSAFE' };
    if (typeof process.getuid === 'function') {
      const uid = process.getuid();
      if (st.uid !== uid && st.uid !== 0) return { ok: false, code: 'PIN_NS_UNSAFE' };
    }
    if ((st.mode & 0o022) !== 0) return { ok: false, code: 'PIN_NS_UNSAFE' };
  }
  const finale = path.join(pinDir, 'launcher');

  // RIUSO: una cache esistente del pin si qualifica con la STESSA disciplina
  // del pin nuovo, mai con il solo hash. lstat decide COS'E' l'oggetto (un
  // symlink non si segue e non si esegue mai):
  //  - oggetto non regolare perche' symlink: non e' un pin nostro. Semantica
  //    di cache-miss: viene sostituito ATOMICAMENTE dalla copia staged dei
  //    byte gia' verificati — rename() rimpiazza il link stesso, mai il suo
  //    bersaglio — e il link alieno non viene ne' letto ne' eseguito.
  //  - directory (o device) al posto del pin: non si rimuove alla cieca e
  //    non si sostituisce: rifiuto.
  //  - file regolare: deve essere di questo utente, non world-writable,
  //    eseguibile, di dimensione limitata, letto con tetto da un fd
  //    qualificato e con hash degli STESSI byte. Byte giusti ma permessi
  //    degradati (per esempio 0600) = RIFIUTO prima del consumo: la cache
  //    contiene un artefatto di questo namespace in uno stato che il nostro
  //    writer non produce mai — fail-closed, nessuna auto-riparazione.
  //    Byte diversi: cache-miss, la copia staged lo rimpiazza.
  {
    let st;
    try {
      st = fs.lstatSync(finale);
    } catch (e) {
      if (!e || e.code !== 'ENOENT') return { ok: false, code: 'PIN_UNQUALIFIED' };
      st = null;
    }
    if (st && st.isFile() && !st.isSymbolicLink()) {
      if (typeof process.getuid === 'function') {
        const uid = process.getuid();
        if (st.uid !== uid && st.uid !== 0) return { ok: false, code: 'PIN_UNQUALIFIED' };
      }
      if ((st.mode & 0o002) !== 0) return { ok: false, code: 'PIN_UNQUALIFIED' };
      if ((st.mode & 0o111) === 0) return { ok: false, code: 'PIN_UNQUALIFIED' };
      if (st.size > MAX_LAUNCHER_BYTES) return { ok: false, code: 'PIN_UNQUALIFIED' };
      const opened = openQualifiedReadOnly(finale);
      if (!opened.ok) return { ok: false, code: 'PIN_UNQUALIFIED' };
      let existingBytes = null;
      try {
        if (opened.stat.size <= MAX_LAUNCHER_BYTES) {
          const readPin = readFdBounded(opened.fd, opened.stat.size);
          if (readPin.ok) existingBytes = readPin.bytes;
        }
      } finally {
        try { fs.closeSync(opened.fd); } catch (_) {}
      }
      if (!existingBytes) return { ok: false, code: 'PIN_UNQUALIFIED' };
      const existingSha = crypto.createHash('sha256').update(existingBytes).digest('hex');
      if (existingSha === sha) {
        return { ok: true, pinnedPath: finale, sha256: launcherSha256, reused: true };
      }
      // Byte diversi al posto del pin: artefatto stantio, cache-miss.
      // Il rename dello staging qui sotto lo rimpiazza atomicamente.
    } else if (st && !st.isSymbolicLink()) {
      // directory o device: mai rimosso o sostituito alla cieca
      return { ok: false, code: 'PIN_UNQUALIFIED' };
    }
    // st === null (assente) oppure symlink: si va allo staging, che con il
    // rename sostituisce l'oggetto esistente senza mai leggerlo.
  }

  const tmp = path.join(pinDir, `.tmp-${crypto.randomBytes(6).toString('hex')}`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o500);
    fs.writeFileSync(fd, launcherBytes);
    fs.fchmodSync(fd, 0o500);
    fs.fsyncSync(fd);
  } catch (_) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    try { fs.unlinkSync(tmp); } catch (_) {}
    return { ok: false, code: 'PIN_WRITE_FAILED' };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }

  try {
    const writtenSha = crypto.createHash('sha256').update(fs.readFileSync(tmp)).digest('hex');
    if (writtenSha.toLowerCase() !== launcherSha256.toLowerCase()) {
      try { fs.unlinkSync(tmp); } catch (_) {}
      return { ok: false, code: 'PIN_VERIFY_FAILED' };
    }
    fs.renameSync(tmp, finale);
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    return { ok: false, code: 'PIN_RENAME_FAILED' };
  }

  try {
    for (const entry of fs.readdirSync(baseDir)) {
      if (entry.toLowerCase() !== launcherSha256.toLowerCase()) {
        fs.rmSync(path.join(baseDir, entry), { recursive: true, force: true });
      }
    }
  } catch (_) {}

  return { ok: true, pinnedPath: finale, sha256: launcherSha256 };
}

module.exports = {
  requestVlNewSession,
  consumeVlNewSession,
  vlNewSessionStatus,
  vlLegacyInventory,
  verifyLauncherCaps,
  pinLauncher,
};
