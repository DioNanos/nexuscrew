'use strict';
// Runtime Node qualificato per la claim della root vl.
//
// Il Node che esegue il figlio della claim non e' piu' un pin di release: e'
// il runtime effettivo di questo processo, qualificato qui una volta per
// istanza e fotografato in una copia privata content-addressed. L'hash
// misurato e' un controllo di INTEGRITA' della fotografia, non un consenso
// preventivo su dei byte: resta distinto dai pin con hash atteso di release
// (flock, helper) e non passa dal loro percorso.
//
//  - candidato unico: `process.execPath` (seam interno `deps.execPath` per i
//    test). Nessun manifest, env, config o richiesta puo' scegliere altri binari.
//  - qualifica prima di ogni esecuzione: catena di directory reali fidate,
//    file regolare nostro/di root, non scrivibile da altri, non setuid/setgid.
//  - lettura per fd nofollow, stabile (fstat prima/dopo con metadati di
//    mutazione), identita' nome/fd coerente e catena riverificata dopo
//    l'accesso, bounded 512 MiB.
//  - fotografia privata: directory 0700, file 0500 wx, fsync file+dir
//    vincolante (il fallimento rifiuta), rilettura verificata per byte e
//    identita' per fd. Un oggetto presente si riverifica SEMPRE: EEXIST non
//    e' una prova. L'istanza qualificata resta vincolata alla propria
//    fotografia: se lo storage non si riverifica, rifiuto senza riqualificare
//    la sorgente e senza riparare la copia.
//  - perimetro per incarnazione: la fotografia vive in una directory
//    esclusiva inst-<nonce> (nonce interno mai esterno, creazione non
//    ricorsiva 0700 mai adottata) sotto il parent per-uid, e i finali per
//    home si pubblicano in un namespace d'istanza. Processi fratelli dello
//    stesso uid/tmpdir, anche sulla stessa home, non condividono nessun
//    inode del runtime: le loro pubblicazioni non si vedono come EEXIST
//    reciproci e i loro link/unlink non mutano i metadati dell'altro.
//  - probe isolato della COPIA (mai del sorgente): `--version`, shell false,
//    stdin chiuso, env minimo senza loader/opzioni Node, timeout 2 s,
//    4 KiB per stream. Exit0 e versione unica = quella del processo.
//  - versione stabile >= 18.0.0, intera e non ambigua.
//
// Codici (enum promosso esistente): PIN_ABSENT solo per ENOENT, PIN_REREAD
// per catena/oggetto non qualificabili o mutati, PIN_VERSION per versione o
// probe incompatibili/inconclusive, PIN_DIR/PIN_STAGE per lo storage.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { pubblicaEsclusiva } = require('./exclusive-publish.js');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const LIMITE_BYTE = 512 * 1024 * 1024;
const CHUNK = 1024 * 1024;
const RE_VERSIONE = /^\d+\.\d+\.\d+$/;
const PROBE_TIMEOUT_MS = 2000;
const PROBE_CAP = 4096;

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function dirPrivata(deps) {
  const tmp = typeof deps.tmpdir === 'function' ? deps.tmpdir()
    : (typeof deps.tmpdir === 'string' && deps.tmpdir ? deps.tmpdir : os.tmpdir());
  return path.join(tmp, `nc-vl-node-${typeof process.getuid === 'function' ? process.getuid() : 0}`);
}

function errorCode(err, fallback) {
  return err && typeof err.code === 'string' ? err.code : fallback;
}

function assicuraDirPrivata(dir, deps) {
  const lstat = deps.lstat || fs.lstatSync;
  const mkdir = deps.mkdir || ((d) => { fs.mkdirSync(d, { recursive: true, mode: 0o700 }); });
  try {
    const st = lstat(dir);
    if (isQualifiedPrivateDir(st)) return { ok: true, dev: st.dev, ino: st.ino };
    return { ok: false };
  } catch (e) {
    if (!e || e.code !== 'ENOENT') return { ok: false };
  }
  try {
    mkdir(dir);
    const st = lstat(dir);
    // La directory appena creata si qualifica come una trovata: stessa
    // identita' richiesta, perche' il nome nuovo non e' una prova.
    if (isQualifiedPrivateDir(st)) return { ok: true, dev: st.dev, ino: st.ino };
    return { ok: false };
  } catch (_) { return { ok: false }; }
}

// Exclusive instance directory, one per module incarnation. The snapshot no
// longer lives directly under the uid-keyed private parent: two processes of
// the same uid sharing the tmpdir would converge on the same
// content-addressed name, and their concurrent link/unlink would mutate the
// shared inode's ctime until every stable read refuses. The directory name
// carries a nonce generated here, never taken from payload, config or
// environment: it is an isolation name, not an authorization. Creation is
// EXCLUSIVE (non-recursive mkdir, mode 0700): an EEXIST on a name this call
// did not create is never adopted and never triggers nonce regeneration; any
// collision or creation failure fails closed immediately. The directory is
// created lazily at the first snapshot and lives as long as the module: no new
// directory per claim.
const instanceDirs = new Map(); // parent -> { dir, nonce, qualified, identityUnknown, parentSynced, dev, ino }
const namespaces = new Map(); // namespace -> { dir, stagingDir, qualified, identityUnknown, parentSynced, dev, ino }
const creationEntries = new Map(); // `${kind}\0${path}` -> current-generation record
const creationHistory = []; // every record in creation order, retired generations included
// Live registry bound: entries whose removal was POSITIVELY confirmed
// (this incarnation's own successful unlink) and not-created attempts are
// compacted into the counters below when capacity is needed. Objects still
// present under their name, with unknown or uncertain identity, are never
// evicted to make room. Capacity is reserved BEFORE any name-creating
// effect; a saturated registry refuses with PIN_STAGE and a typed internal
// cause, and no uncensused object is left behind.
const CREATION_REGISTRY_LIVE_CAP = 256;
const REGISTRY_SATURATED = 'registry-saturated';
const compactedCounts = { notCreated: 0, removed: 0 };
// Monotonic serial of this module incarnation: every new registry record
// takes the next integer and compaction never renumbers or resets it. Unlike
// generation, seq is unique across the whole incarnation, which makes it the
// unambiguous identifier the future cleanup must use to tell distinct
// creations of the same name apart.
let creationSerial = 0;
let incarnationNonce = null;
// Cleanup state of this incarnation: once a valid proof is admitted the
// module is permanently disarmed for qualifica/pubblica and the first round
// outcome is frozen as the terminal result every later call replays.
let cleanupStarted = false;
let cleanupTerminal = null;

function instanceNonce() {
  if (incarnationNonce === null) {
    incarnationNonce = crypto.randomBytes(16).toString('hex');
  }
  return incarnationNonce;
}

function registryKey(kind, targetPath) {
  return `${kind}\0${targetPath}`;
}

// cleanupAllowed marks the entry as a CANDIDATE for the future cleanup
// procedure only: it says the registry holds a proven creation with enough
// identity data to attempt the re-verification protocol. It is never an
// authorization to remove anything by itself, and it never depends on a
// durability promise (fileSynced/durabilitySynced are proofs, not gates).
function isCleanupEligibleForState(entry) {
  if (entry.unlinked) return false;
  if (entry.state === 'not-created' || entry.state === 'created-identity-unknown') return false;
  if (entry.state === 'created-unqualified') {
    if (entry.kind === 'instance-dir' || entry.kind === 'home-namespace') return false;
    return Number.isSafeInteger(entry.dev)
      && Number.isSafeInteger(entry.ino)
      && Number.isSafeInteger(entry.uid)
      && Number.isSafeInteger(entry.mode);
  }
  return Number.isSafeInteger(entry.dev) && Number.isSafeInteger(entry.ino);
}

// The generation of a new record counts every still-censused entry of the
// same kind+path, history included: compaction may retire the current map
// entry while an older generation of the same name stays censused, and a
// recycled number would make two live entries share (kind, path, generation).
function highestCensusedGeneration(kind, targetPath) {
  let highest = 0;
  for (const entry of creationHistory) {
    if (entry.kind === kind && entry.path === targetPath && entry.generation > highest) {
      highest = entry.generation;
    }
  }
  return highest;
}

/**
 * Records or advances a creation entry in the per-incarnation registry without
 * ever backfilling unknown identities or letting non-owned attempts overwrite owned entries.
 *
 * A call carrying `provenCreate: true` describes an object THIS call just
 * created under the key's name: it always opens a new, successive generation
 * with its own original identity. The previous generation is neither filled,
 * deleted nor reused (an old unknown identity stays unknown; an already
 * removed temporary never covers a new one). Without the flag the call can
 * only advance the current generation: a failed attempt or an EEXIST never
 * owns the foreign object sitting under the name.
 *
 * A not-created attempt that cannot be admitted within the live cap is folded
 * into the compacted counter and returns null: its path is not retained.
 */
function recordCreation(fields) {
  const key = registryKey(fields.kind, fields.path);
  const prev = creationEntries.get(key);
  if (prev && !fields.provenCreate) {
    if (prev.state === 'created-identity-unknown') {
      if (fields.unlinked === true) prev.unlinked = true;
      return prev;
    }
    if (prev.state === 'not-created' && fields.state === 'not-created') {
      // A repeated failed attempt refreshes the cause of the same entry: it
      // is not a new creation and must not multiply registry entries.
      if (fields.cause !== undefined && fields.cause !== null) prev.cause = fields.cause;
      return prev;
    }
    if (prev.state !== 'not-created' && fields.state === 'not-created') {
      return prev;
    }
    if (prev.state === 'created-unqualified') {
      if (fields.unlinked === true) {
        prev.unlinked = true;
        prev.cleanupAllowed = false;
      }
      return prev;
    }
    if (prev.state === 'qualified-unsynced') {
      if (fields.state === 'qualified-synced' && fields.dev === prev.dev && fields.ino === prev.ino) {
        prev.state = 'qualified-synced';
        prev.durabilitySynced = true;
        prev.cause = null;
        prev.cleanupAllowed = isCleanupEligibleForState(prev);
      } else if (fields.state === 'qualified-unsynced' && fields.cause !== undefined && fields.cause !== null) {
        prev.cause = fields.cause;
      }
      if (fields.unlinked === true) {
        prev.unlinked = true;
        prev.cleanupAllowed = false;
      }
      return prev;
    }
    if (prev.state === 'qualified-synced') {
      if (fields.unlinked === true) {
        prev.unlinked = true;
        prev.cleanupAllowed = false;
      }
      return prev;
    }
  }
  const hasIdentity = fields.state !== 'not-created' && fields.state !== 'created-identity-unknown';
  // Bounded admission for attempts that created nothing: this rule covers
  // every not-created recording point, including the ones that never cross a
  // capacity reservation (foreign preexisting names, namespace checks that
  // fail before the reservation). Compact before inserting a new not-created
  // key; when only non-compactable entries remain the attempt folds into the
  // compacted counter without retaining its path. Present, unknown or
  // uncertain entries are never evicted to make room, and nothing on disk is
  // ever touched here.
  if (fields.state === 'not-created') {
    if (creationHistory.length >= CREATION_REGISTRY_LIVE_CAP) compactCreationRegistry();
    if (creationHistory.length >= CREATION_REGISTRY_LIVE_CAP) {
      compactedCounts.notCreated += 1;
      return null;
    }
  }
  creationSerial += 1;
  const next = {
    kind: fields.kind,
    path: fields.path,
    nonce: fields.nonce !== undefined ? fields.nonce : instanceNonce(),
    parentPath: fields.parentPath ?? null,
    parentDev: Number.isSafeInteger(fields.parentDev) ? fields.parentDev : null,
    parentIno: Number.isSafeInteger(fields.parentIno) ? fields.parentIno : null,
    dev: hasIdentity && Number.isSafeInteger(fields.dev) ? fields.dev : null,
    ino: hasIdentity && Number.isSafeInteger(fields.ino) ? fields.ino : null,
    uid: hasIdentity && Number.isSafeInteger(fields.uid) ? fields.uid : null,
    mode: hasIdentity && Number.isSafeInteger(fields.mode) ? fields.mode : null,
    state: fields.state,
    qualified: fields.state === 'qualified-unsynced' || fields.state === 'qualified-synced',
    durabilitySynced: fields.state === 'qualified-synced',
    // Proof that the FILE DESCRIPTOR was synced. It says nothing about the
    // directory entry of this name: durabilitySynced stays false until the
    // containing directory fsync succeeds.
    fileSynced: Boolean(fields.fileSynced),
    seq: creationSerial,
    generation: highestCensusedGeneration(fields.kind, fields.path) + 1,
    unlinked: Boolean(fields.unlinked),
    cleanupAllowed: false,
    cause: fields.cause ?? null,
  };
  next.cleanupAllowed = isCleanupEligibleForState(next);
  creationEntries.set(key, next);
  creationHistory.push(next);
  return next;
}

// Frees registry capacity by folding compactable entries into counters:
// not-created attempts (never owned) and entries whose removal was
// positively confirmed by this incarnation's own successful unlink.
// Never touches objects still present, unknown or uncertain.
function compactCreationRegistry() {
  for (let i = creationHistory.length - 1; i >= 0; i -= 1) {
    const entry = creationHistory[i];
    if (entry.state !== 'not-created' && entry.unlinked !== true) continue;
    creationHistory.splice(i, 1);
    if (entry.state === 'not-created') compactedCounts.notCreated += 1;
    else compactedCounts.removed += 1;
    const key = registryKey(entry.kind, entry.path);
    if (creationEntries.get(key) === entry) creationEntries.delete(key);
  }
}

// Reserve one registry slot BEFORE the effect that may create a name. When
// the registry is full, compaction runs first; if no compactable entry
// exists the new creation is refused and nothing is created uncensused.
function reserveCreationCapacity() {
  if (creationHistory.length < CREATION_REGISTRY_LIVE_CAP) return { ok: true };
  compactCreationRegistry();
  if (creationHistory.length < CREATION_REGISTRY_LIVE_CAP) return { ok: true };
  return { ok: false, cause: REGISTRY_SATURATED };
}

function promoteTempFileSynced(tmpPath) {
  const entry = creationEntries.get(registryKey('temp-file', tmpPath));
  if (!entry || entry.state !== 'created-unqualified') return;
  // fsync(fd) proves the file object, not the directory entry of this name:
  // the temporary stays qualified-unsynced and never claims durability from
  // the descriptor sync alone. fileSynced records the proof that was earned.
  entry.state = 'qualified-unsynced';
  entry.qualified = true;
  entry.fileSynced = true;
  entry.cause = null;
  entry.cleanupAllowed = isCleanupEligibleForState(entry);
}

function markEntryUnlinked(kind, targetPath) {
  const entry = creationEntries.get(registryKey(kind, targetPath));
  if (!entry) return;
  entry.unlinked = true;
  entry.cleanupAllowed = false;
}

function inspectCreatedAttrs(targetPath, expectedDev, expectedIno, lstatFn) {
  try {
    const st = lstatFn(targetPath);
    if (st && st.dev === expectedDev && st.ino === expectedIno) {
      return { uid: st.uid, mode: st.mode & 0o777 };
    }
  } catch (_) {}
  return { uid: null, mode: null };
}

/**
 * Returns a read-only deep-frozen snapshot of all creation entries recorded
 * during this module incarnation without exposing mutable references.
 */
function getCreationRegistry() {
  const entries = [];
  for (const entry of creationHistory) {
    entries.push(Object.freeze({
      kind: entry.kind,
      path: entry.path,
      nonce: entry.nonce,
      parentPath: entry.parentPath,
      parentDev: entry.parentDev,
      parentIno: entry.parentIno,
      dev: entry.dev,
      ino: entry.ino,
      uid: entry.uid,
      mode: entry.mode,
      state: entry.state,
      qualified: entry.qualified,
      durabilitySynced: entry.durabilitySynced,
      fileSynced: entry.fileSynced,
      seq: entry.seq,
      generation: entry.generation,
      cleanupAllowed: entry.cleanupAllowed,
      unlinked: entry.unlinked,
      cause: entry.cause,
    }));
  }
  const freezeList = (items) => Object.freeze(items);
  return Object.freeze({
    nonce: incarnationNonce,
    compacted: Object.freeze({ notCreated: compactedCounts.notCreated, removed: compactedCounts.removed }),
    entries: freezeList(entries),
    instanceDirs: freezeList(entries.filter((e) => e.kind === 'instance-dir')),
    homeNamespaces: freezeList(entries.filter((e) => e.kind === 'home-namespace')),
    snapshots: freezeList(entries.filter((e) => e.kind === 'snapshot-file')),
    homeFinals: freezeList(entries.filter((e) => e.kind === 'home-final')),
    tempFiles: freezeList(entries.filter((e) => e.kind === 'temp-file')),
    partials: freezeList(entries.filter((e) => (
      e.kind === 'temp-file'
      || ((e.kind === 'snapshot-file' || e.kind === 'home-final')
        && (e.state === 'created-unqualified' || e.state === 'created-identity-unknown'))
    ))),
    owned: freezeList(entries.filter((e) => e.state !== 'not-created')),
    nonOwned: freezeList(entries.filter((e) => e.state === 'not-created')),
  });
}

// Qualification-only check of a private directory: real (not a symlink),
// owned by this uid, exactly 0700. No repair, no creation.
function isQualifiedPrivateDir(st) {
  return !!st && !st.isSymbolicLink() && st.isDirectory()
    && (typeof process.getuid !== 'function' || st.uid === process.getuid())
    && (st.mode & 0o777) === 0o700;
}

// Durability of the instance directory entry: the parent is fsynced once
// per creation. "Once" means once SUCCESSFUL: on failure the flag stays
// unset, the refusal propagates, and the next attempt repeats the fsync.
// An EEXIST is never an attestation of durability.
function fsyncParentOnce(memo, parent, deps) {
  if (memo.parentSynced) return { ok: true };
  const openSync = deps.open || fs.openSync;
  const closeSync = deps.close || fs.closeSync;
  const fsync = deps.fsync || ((fd) => { fs.fsyncSync(fd); });
  try {
    const fd = openSync(parent, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fsync(fd); } finally { closeSync(fd); }
  } catch (e) { return { ok: false, code: 'PIN_STAGE', cause: errorCode(e, 'PIN_STAGE') }; }
  memo.parentSynced = true;
  return { ok: true };
}

function ensureInstanceDir(parent, deps, parentMeta) {
  const lstat = deps.lstat || fs.lstatSync;
  const nonce = instanceNonce();
  const baseFor = (dirPath, entryNonce) => ({
    kind: 'instance-dir',
    path: dirPath,
    nonce: entryNonce,
    parentPath: parent,
    parentDev: parentMeta ? parentMeta.dev : null,
    parentIno: parentMeta ? parentMeta.ino : null,
  });
  const gia = instanceDirs.get(parent);
  if (gia) {
    // Bounded failure state: if the created directory never qualified or its
    // identity could not be read after mkdir, stay pinned to PIN_DIR without
    // new mkdirs, late stat backfills, chmod, removal, or directory scans.
    if (!gia.qualified) return { ok: false, code: 'PIN_DIR' };
    // Reuse only re-qualifies the remembered directory: a name that no
    // longer qualifies refuses; it is neither repaired nor replaced.
    let st;
    try {
      st = lstat(gia.dir);
      if (!isQualifiedPrivateDir(st)) return { ok: false, code: 'PIN_DIR' };
    } catch (_) { return { ok: false, code: 'PIN_DIR' }; }
    const sync = fsyncParentOnce(gia, parent, deps);
    if (!sync.ok) {
      recordCreation({
        ...baseFor(gia.dir, gia.nonce),
        dev: gia.dev,
        ino: gia.ino,
        uid: st.uid,
        mode: st.mode & 0o777,
        state: 'qualified-unsynced',
        cause: sync.cause,
      });
      return { ok: false, code: sync.code };
    }
    recordCreation({
      ...baseFor(gia.dir, gia.nonce),
      dev: st.dev,
      ino: st.ino,
      uid: st.uid,
      mode: st.mode & 0o777,
      state: 'qualified-synced',
      cause: null,
    });
    return { ok: true, dir: gia.dir, dev: gia.dev, ino: gia.ino };
  }
  const dir = path.join(parent, `inst-${nonce}`);
  const dirBase = baseFor(dir, nonce);
  const slot = reserveCreationCapacity();
  if (!slot.ok) return { ok: false, code: 'PIN_STAGE', motivo: slot.cause };
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    // A name that already exists (EEXIST) or cannot be created is never
    // adopted and never triggers nonce regeneration: fail closed.
    recordCreation({ ...dirBase, state: 'not-created', cause: errorCode(e, 'PIN_DIR') });
    return { ok: false, code: 'PIN_DIR' };
  }
  // Bind the created name in the parent map immediately after mkdir succeeds
  // so an lstat or qualification failure never orphans this directory or
  // attempts a second creation under the same parent.
  const memo = {
    dir,
    nonce,
    qualified: false,
    identityUnknown: false,
    parentSynced: false,
    dev: null,
    ino: null,
  };
  instanceDirs.set(parent, memo);
  // The fresh name qualifies like a found one: same identity checks right
  // after the creation, no repairing chmod on the new name.
  let st;
  try {
    st = lstat(dir);
  } catch (e) {
    memo.identityUnknown = true;
    recordCreation({ ...dirBase, provenCreate: true, state: 'created-identity-unknown', cause: errorCode(e, 'lstat-failed') });
    return { ok: false, code: 'PIN_DIR' };
  }
  if (!isQualifiedPrivateDir(st)) {
    memo.dev = st.dev;
    memo.ino = st.ino;
    recordCreation({
      ...dirBase,
      provenCreate: true,
      dev: st.dev,
      ino: st.ino,
      uid: st.uid,
      mode: st.mode & 0o777,
      state: 'created-unqualified',
      cause: 'unqualified-dir',
    });
    return { ok: false, code: 'PIN_DIR' };
  }
  memo.qualified = true;
  memo.dev = st.dev;
  memo.ino = st.ino;
  const stAttrs = { dev: st.dev, ino: st.ino, uid: st.uid, mode: st.mode & 0o777 };
  recordCreation({ ...dirBase, ...stAttrs, provenCreate: true, state: 'qualified-unsynced', cause: null });
  const sync = fsyncParentOnce(memo, parent, deps);
  if (!sync.ok) {
    recordCreation({ ...dirBase, ...stAttrs, state: 'qualified-unsynced', cause: sync.cause });
    return { ok: false, code: sync.code };
  }
  recordCreation({ ...dirBase, ...stAttrs, state: 'qualified-synced', cause: null });
  return { ok: true, dir, dev: st.dev, ino: st.ino };
}

// Directory fidata della catena del runtime: reale (non link), di root o
// dell'account del servizio, senza scrittura NON FIDATA. La scrittura di
// gruppo e' fidata solo nel gruppo proprio del servizio (gid del processo):
// un gruppo qualsiasi che scrive nella catena del runtime e' un rifiuto. Lo
// sticky bit di sistema (tipo /tmp) e' ammesso esplicitamente solo su
// root/owner: non e' un generico genitore 0777.
function directoryFidata(st, uid, gid) {
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return false;
  if (st.uid !== 0 && st.uid !== uid) return false;
  const mode = st.mode & 0o777;
  const sticky = (st.mode & 0o1000) !== 0;
  // Directory sticky di sistema (tipo /tmp) con proprietario root/servizio:
  // il caso va trattato ESPPLICITAMENTE, non come generico genitore 0777.
  if (sticky && (st.uid === 0 || st.uid === uid)) return true;
  if ((mode & 0o002) !== 0) return false;
  if ((mode & 0o020) !== 0 && st.gid !== gid) return false;
  if (st.uid === uid) return (mode & 0o100) !== 0;
  return true;
}

function fileFidato(st, uid) {
  if (!st || st.isSymbolicLink() || !st.isFile()) return false;
  if (st.uid !== 0 && st.uid !== uid) return false;
  const mode = st.mode & 0o777;
  if ((mode & 0o022) !== 0) return false;
  if ((st.mode & 0o6000) !== 0) return false; // niente setuid/setgid
  if (st.uid === uid && (mode & 0o500) !== 0o500) return false;
  return true;
}

function probeVersione(exe, deps) {
  if (typeof deps.probe === 'function') return deps.probe(exe, ['--version'], {
    shell: false, timeout: PROBE_TIMEOUT_MS, cap: PROBE_CAP,
    env: { PATH: '/usr/bin:/bin', LANG: 'C' },
  });
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(exe, ['--version'], {
    shell: false,
    timeout: PROBE_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: PROBE_CAP,
    env: { PATH: '/usr/bin:/bin', LANG: 'C' },
  });
  return {
    status: r.status, stdout: r.stdout ? r.stdout.toString('utf8') : '',
    stderr: r.stderr ? r.stderr.toString('utf8') : '', error: r.error || null,
  };
}

// Lettura bounded per fd, con fstat prima e dopo: la stessa identita' prima e
// dopo la lettura dimostra che il descriptor non ha cambiato oggetto. Anche i
// metadati di mutazione disponibili (mtime/ctime) devono restare fermi: una
// size uguale con mtime nuovo e' una scrittura avvenuta durante la lettura.
function leggiStabile(fd, st, deps) {
  const fstat = deps.fstat || fs.fstatSync;
  const read = deps.read || fs.readSync;
  const pezzi = [];
  let totale = 0;
  for (;;) {
    const buf = Buffer.alloc(CHUNK);
    let n;
    try { n = read(fd, buf, 0, CHUNK, null); } catch (_) { return null; }
    if (n === 0) break;
    totale += n;
    if (totale > LIMITE_BYTE) return null;
    pezzi.push(n === CHUNK ? buf : buf.subarray(0, n));
  }
  let dopo;
  try { dopo = fstat(fd); } catch (_) { return null; }
  if (dopo.dev !== st.dev || dopo.ino !== st.ino || dopo.mode !== st.mode
    || dopo.uid !== st.uid || dopo.size !== st.size
    || dopo.mtimeMs !== st.mtimeMs || dopo.ctimeMs !== st.ctimeMs) return null;
  return Buffer.concat(pezzi);
}

// Lettura finale di un oggetto pubblicato: per fd nofollow, con identita'
// nome/fd coerente prima e dopo e metadati di mutazione. Leggere per pathname
// non qualifica l'oggetto: l'ultimo componente e il proprietario si
// verificano qui, e la catena sopra si qualifica a parte.
function leggiFinale(filePath, deps) {
  const lstat = deps.lstat || fs.lstatSync;
  const openSync = deps.open || fs.openSync;
  const fstat = deps.fstat || fs.fstatSync;
  const closeSync = deps.close || fs.closeSync;
  let stNome;
  try { stNome = lstat(filePath); } catch (_) { return null; }
  if (!stNome.isFile() || stNome.isSymbolicLink()) return null;
  if (typeof process.getuid === 'function' && stNome.uid !== process.getuid()) return null;
  if ((stNome.mode & 0o777) !== 0o500) return null;
  let fd = null;
  try {
    fd = openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stFd = fstat(fd);
    // Il descriptor deve coincidere con la prima identita' del nome per
    // tipo, uid E modo: un allargamento di permessi avvenuto fra lo stat
    // del nome e l'apertura non e' un oggetto privato, anche se la lettura
    // resta coerente con se stessa.
    if (stFd.dev !== stNome.dev || stFd.ino !== stNome.ino || !stFd.isFile()
      || stFd.uid !== stNome.uid
      || (stFd.mode & 0o777) !== (stNome.mode & 0o777)) return null;
    const buf = leggiStabile(fd, stFd, deps);
    if (!buf) return null;
    const stDopo = lstat(filePath);
    if (stDopo.dev !== stNome.dev || stDopo.ino !== stNome.ino
      || !stDopo.isFile() || stDopo.uid !== stNome.uid
      || (stDopo.mode & 0o777) !== (stNome.mode & 0o777)) return null;
    return { buf, ino: stNome.ino, dev: stNome.dev, uid: stNome.uid, mode: stNome.mode & 0o777 };
  } catch (_) {
    return null;
  } finally {
    try { if (fd !== null) closeSync(fd); } catch (_) { /* fd chiuso su ogni ramo */ }
  }
}

// Best-effort removal of a temporary created by THIS call. The unlink is
// admitted only when the registry still holds the CURRENT entry for the name
// with its original identity proven (safe dev/ino) and the name still
// resolves, through the existing lstat seam, to that same real file (not a
// symlink). A substitute under the name, a missing or identity-unknown entry
// or a failed lstat (ENOENT included) cause NO unlink and NO marking: the
// residue stays censused with unlinked=false and is never adopted or hunted
// under other names. Only a successful unlink after the positive comparison
// marks removed THAT original entry, provided it is still the current one.
// The comparison is not an atomic compare-and-unlink: a same-uid actor can
// still swap the object between the lstat and the unlink.
function unlinkBestEffort(tmpPath, kind, deps) {
  const entry = creationEntries.get(registryKey(kind, tmpPath));
  if (!entry || !Number.isSafeInteger(entry.dev) || !Number.isSafeInteger(entry.ino)) return;
  const lstat = deps && typeof deps.lstat === 'function' ? deps.lstat : fs.lstatSync;
  try {
    const st = lstat(tmpPath);
    if (!st || st.isSymbolicLink() || !st.isFile()) return;
    if (st.dev !== entry.dev || st.ino !== entry.ino) return;
    if (deps && typeof deps.unlink === 'function') deps.unlink(tmpPath);
    else fs.unlinkSync(tmpPath);
    if (creationEntries.get(registryKey(kind, tmpPath)) === entry) markEntryUnlinked(kind, tmpPath);
  } catch (_) {
    // Residual file remains recorded with unlinked=false.
  }
}

function updateOwnedDurability({ kind, path: targetPath, dev, ino, synced, cause }) {
  const entry = creationEntries.get(registryKey(kind, targetPath));
  if (!entry || entry.state !== 'qualified-unsynced') return;
  if (entry.dev !== dev || entry.ino !== ino) return;
  if (synced) {
    entry.state = 'qualified-synced';
    entry.durabilitySynced = true;
    entry.cause = null;
    entry.cleanupAllowed = isCleanupEligibleForState(entry);
  } else if (cause !== undefined && cause !== null) {
    entry.cause = cause;
  }
}

function recordPublishedTargetOutcome({
  kind, dest, parentPath, parentDev, parentIno,
  pub, linkSrcMeta, expectedHash, lstat, deps,
}) {
  const base = { kind, path: dest, parentPath, parentDev, parentIno };
  let justCreated = false;
  let createdId = null;
  if (pub) {
    if (pub.status === 'failed-before-create') {
      recordCreation({ ...base, state: 'not-created', cause: pub.code || 'failed-before-create' });
      return { ok: false, code: 'PIN_STAGE' };
    }
    if (pub.status === 'uncertain-after-create') {
      if (pub.created && Number.isSafeInteger(pub.created.dev) && Number.isSafeInteger(pub.created.ino)) {
        const attrs = inspectCreatedAttrs(dest, pub.created.dev, pub.created.ino, lstat);
        recordCreation({
          ...base,
          provenCreate: true,
          dev: pub.created.dev,
          ino: pub.created.ino,
          uid: attrs.uid,
          mode: attrs.mode,
          state: 'created-unqualified',
          cause: pub.code || 'uncertain-after-create',
        });
      } else {
        recordCreation({
          ...base,
          provenCreate: true,
          state: 'created-identity-unknown',
          cause: pub.code || 'uncertain-after-create',
        });
      }
      return { ok: false, code: 'PIN_REREAD' };
    }
    if (pub.status === 'exists') {
      recordCreation({ ...base, state: 'not-created', cause: 'EEXIST' });
    } else if (pub.status === 'published') {
      justCreated = true;
      createdId = pub.via === 'create' ? (pub.created || null) : linkSrcMeta;
    }
  } else {
    recordCreation({ ...base, state: 'not-created', cause: 'preexisting' });
  }
  const finale = leggiFinale(dest, deps);
  if (!finale || sha256(finale.buf) !== expectedHash) {
    if (justCreated) {
      if (createdId && Number.isSafeInteger(createdId.dev) && Number.isSafeInteger(createdId.ino)) {
        const attrs = inspectCreatedAttrs(dest, createdId.dev, createdId.ino, lstat);
        recordCreation({
          ...base,
          provenCreate: true,
          dev: createdId.dev,
          ino: createdId.ino,
          uid: attrs.uid,
          mode: attrs.mode,
          state: 'created-unqualified',
          cause: !finale ? 'leggiFinale-failed' : 'hash-mismatch',
        });
      } else {
        recordCreation({
          ...base,
          provenCreate: true,
          state: 'created-identity-unknown',
          cause: !finale ? 'leggiFinale-failed' : 'hash-mismatch',
        });
      }
    }
    return { ok: false, code: 'PIN_REREAD' };
  }
  if (justCreated) {
    // The identity captured at creation time is the authority. The reread
    // proves the object currently under the name is readable and has the
    // expected bytes, not that it is the one this call created: only a
    // matching dev/ino promotes the entry. Equal bytes, the name itself or
    // a late stat are never a substitute for this comparison.
    if (!createdId || !Number.isSafeInteger(createdId.dev) || !Number.isSafeInteger(createdId.ino)) {
      recordCreation({
        ...base,
        provenCreate: true,
        state: 'created-identity-unknown',
        cause: 'origin-identity-unknown',
      });
      return { ok: false, code: 'PIN_REREAD' };
    }
    if (finale.dev !== createdId.dev || finale.ino !== createdId.ino) {
      // A substitute with byte-identical content sits under the name: no
      // ownership is attributed to it. The trace of the original creation
      // stays, closed with a conservative refusal.
      const attrs = inspectCreatedAttrs(dest, createdId.dev, createdId.ino, lstat);
      recordCreation({
        ...base,
        provenCreate: true,
        dev: createdId.dev,
        ino: createdId.ino,
        uid: attrs.uid,
        mode: attrs.mode,
        state: 'created-unqualified',
        cause: 'reread-identity-mismatch',
      });
      return { ok: false, code: 'PIN_REREAD' };
    }
    recordCreation({
      ...base,
      provenCreate: true,
      dev: finale.dev,
      ino: finale.ino,
      uid: finale.uid,
      mode: finale.mode,
      state: 'qualified-unsynced',
      cause: null,
    });
  }
  return { ok: true, finale };
}

// Copia privata content-addressed del runtime qualificato. Un oggetto gia'
// presente si riverifica per intero (tipo, uid, mode, byte): il nome non e'
// una prova. La pubblicazione usa un temporaneo privato appena creato; EEXIST
// porta alla verifica completa del finale, mai a una sovrascrittura.
function fotografa(buf, hash, deps) {
  const parent = dirPrivata(deps);
  const parentMeta = assicuraDirPrivata(parent, deps);
  if (!parentMeta.ok) return { ok: false, code: 'PIN_DIR' };
  // The snapshot lives inside this incarnation's exclusive directory: no
  // sibling process can reach or mutate the same inode by name.
  const instance = ensureInstanceDir(parent, deps, parentMeta);
  if (!instance.ok) return instance;
  const dir = instance.dir;
  const lstat = deps.lstat || fs.lstatSync;
  const fstat = deps.fstat || fs.fstatSync;
  const openSync = deps.open || fs.openSync;
  const closeSync = deps.close || fs.closeSync;
  const fsync = deps.fsync || ((fd) => { fs.fsyncSync(fd); });
  const dest = path.join(dir, hash);
  let presente = false;
  try {
    const st = lstat(dest);
    presente = st.isFile() && !st.isSymbolicLink();
  } catch (_) {}
  let pub = null;
  let tmpMeta = null;
  if (!presente) {
    const tmp = `${dest}.tmp-${crypto.randomBytes(6).toString('hex')}`;
    let fd = null;
    const slotTmp = reserveCreationCapacity();
    if (!slotTmp.ok) return { ok: false, code: 'PIN_STAGE', motivo: slotTmp.cause };
    try {
      fd = openSync(tmp, 'wx', 0o500);
    } catch (e) {
      recordCreation({
        kind: 'temp-file',
        path: tmp,
        parentPath: dir,
        parentDev: instance.dev,
        parentIno: instance.ino,
        state: 'not-created',
        cause: errorCode(e, 'PIN_STAGE'),
      });
      return { ok: false, code: 'PIN_STAGE' };
    }
    try {
      const stTmp = fstat(fd);
      tmpMeta = { dev: stTmp.dev, ino: stTmp.ino, uid: stTmp.uid, mode: stTmp.mode & 0o777 };
      recordCreation({
        kind: 'temp-file',
        path: tmp,
        provenCreate: true,
        parentPath: dir,
        parentDev: instance.dev,
        parentIno: instance.ino,
        dev: tmpMeta.dev,
        ino: tmpMeta.ino,
        uid: tmpMeta.uid,
        mode: tmpMeta.mode,
        state: 'created-unqualified',
        cause: 'staging',
      });
    } catch (e) {
      recordCreation({
        kind: 'temp-file',
        path: tmp,
        provenCreate: true,
        parentPath: dir,
        parentDev: instance.dev,
        parentIno: instance.ino,
        state: 'created-identity-unknown',
        cause: errorCode(e, 'fstat-failed'),
      });
      try { closeSync(fd); } catch (_) {}
      // The open proved this call created an object, but its dev/ino is
      // unknown and the name is only a random label: after the close the
      // name may already point to a substitute. No removal by pathname
      // without the proven identity; the residual stays recorded as
      // created-identity-unknown and the caller fails closed.
      return { ok: false, code: 'PIN_STAGE' };
    }
    try {
      fs.writeSync(fd, buf);
      fs.fchmodSync(fd, 0o500);
      // Read the new mode back from the SAME descriptor: a stat by pathname
      // could describe a substitute object, and a hardcoded value would lie
      // about a creation masked by a restrictive umask.
      const stMode = fstat(fd);
      tmpMeta.mode = stMode.mode & 0o777;
      const tmpModeEntry = creationEntries.get(registryKey('temp-file', tmp));
      if (tmpModeEntry) tmpModeEntry.mode = tmpMeta.mode;
      fsync(fd);
    } catch (e) {
      const tmpEntry = creationEntries.get(registryKey('temp-file', tmp));
      if (tmpEntry) tmpEntry.cause = errorCode(e, 'PIN_STAGE');
      try { closeSync(fd); } catch (_) {}
      unlinkBestEffort(tmp, 'temp-file', deps);
      return { ok: false, code: 'PIN_STAGE' };
    }
    promoteTempFileSynced(tmp);
    try { closeSync(fd); } catch (_) {}
    const slotDest = reserveCreationCapacity();
    if (!slotDest.ok) {
      // Registry saturated: the already admitted temporary stays behind as a
      // censused, non-removed residual. Its descriptor is closed, so the name
      // is no longer bound to the identity proven at creation and a removal
      // by pathname could delete a substitute object. No unlink runs in this
      // branch; the caller fails closed with the typed saturation cause.
      return { ok: false, code: 'PIN_STAGE', motivo: slotDest.cause };
    }
    // link(2) when allowed; exclusive creation verified through its descriptor
    // on filesystems that deny it. A name already present is verified below.
    pub = pubblicaEsclusiva({ src: tmp, dest, bytes: buf, executable: true });
    unlinkBestEffort(tmp, 'temp-file', deps);
  }
  const recorded = recordPublishedTargetOutcome({
    kind: 'snapshot-file',
    dest,
    parentPath: dir,
    parentDev: instance.dev,
    parentIno: instance.ino,
    pub,
    linkSrcMeta: tmpMeta,
    expectedHash: hash,
    lstat,
    deps,
  });
  if (!recorded.ok) return recorded;
  const finale = recorded.finale;
  // La durabilita' della directory non e' best effort: senza fsync della
  // directory la pubblicazione non e' avvenuta.
  try {
    const fdDir = openSync(dir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fsync(fdDir); } finally { closeSync(fdDir); }
  } catch (e) {
    updateOwnedDurability({
      kind: 'snapshot-file',
      path: dest,
      dev: finale.dev,
      ino: finale.ino,
      synced: false,
      cause: errorCode(e, 'PIN_STAGE'),
    });
    return { ok: false, code: 'PIN_STAGE' };
  }
  updateOwnedDurability({
    kind: 'snapshot-file',
    path: dest,
    dev: finale.dev,
    ino: finale.ino,
    synced: true,
    cause: null,
  });
  return { ok: true, path: dest, hash, ino: finale.ino, dev: finale.dev };
}

// Memo per istanza: la qualifica e' un'inizializzazione condivisa, non una
// rilettura del Node grande a ogni claim. Il riuso riverifica lo storage per
// intero: un oggetto perso o mutato rifiuta e l'istanza NON riallinea la
// sorgente, perche' la riqualifica appartiene a una nuova istanza.
const qualificati = new Map();

function qualifica(deps = {}) {
  // Cleanup disarm comes first, before any seam, effect or census: once the
  // incarnation cleanup has started this module admits no new work.
  if (cleanupStarted) {
    return { ok: false, code: 'PIN_STAGE', motivo: 'cleanup-started' };
  }
  if (deps && typeof deps.isDisarmed === 'function' && deps.isDisarmed()) {
    return { ok: false, code: 'PIN_REREAD', motivo: 'disarmed' };
  }
  const uid = typeof deps.uid === 'number' ? deps.uid
    : (typeof process.getuid === 'function' ? process.getuid() : 0);
  const gid = typeof deps.gid === 'number' ? deps.gid
    : (typeof process.getgid === 'function' ? process.getgid() : 0);
  // Un seam execPath fornito ma non valido rifiuta: non si ripiega sul
  // runtime reale del processo per un candidato dichiarato e rotto.
  const candidato = Object.prototype.hasOwnProperty.call(deps, 'execPath')
    ? deps.execPath : process.execPath;
  if (typeof candidato !== 'string' || candidato.length === 0 || !path.isAbsolute(candidato)) {
    return { ok: false, code: 'PIN_REREAD', motivo: 'percorso' };
  }
  const lstat = deps.lstat || fs.lstatSync;
  const realpath = deps.realpath || fs.realpathSync;
  const openSync = deps.open || fs.openSync;
  const fstat = deps.fstat || fs.fstatSync;
  const closeSync = deps.close || fs.closeSync;

  // Risoluzione canonica: un alias iniziale e' ammesso solo se la destinazione
  // canonica si qualifica; da qui in poi si lavora sul nome canonico.
  let canon;
  try { canon = path.resolve(realpath(candidato)); } catch (e) {
    return { ok: false, code: e && e.code === 'ENOENT' ? 'PIN_ABSENT' : 'PIN_REREAD', motivo: 'percorso' };
  }
  if (!path.isAbsolute(canon)) return { ok: false, code: 'PIN_REREAD', motivo: 'percorso' };

  const gia = qualificati.get(canon);
  if (gia) {
    // Riuso dell'oggetto gia' qualificato per questa istanza: lo storage si
    // riverifica per intero (directory privata reale, finale per fd nofollow,
    // byte e identita'), la sorgente non si rilegge e la probe non si ripete.
    // Se la fotografia non si riverifica, l'istanza rifiuta: niente
    // riqualifica della sorgente e niente riparazione della copia.
    const dirFoto = path.dirname(gia.path);
    const parentFoto = path.dirname(dirFoto);
    let okFoto = false;
    try {
      okFoto = isQualifiedPrivateDir(lstat(parentFoto))
        && isQualifiedPrivateDir(lstat(dirFoto));
    } catch (_) { okFoto = false; }
    if (!okFoto) {
      return { ok: false, code: 'PIN_REREAD', motivo: 'fotografia' };
    }
    const finale = leggiFinale(gia.path, deps);
    if (!finale || sha256(finale.buf) !== gia.hash) {
      return { ok: false, code: 'PIN_REREAD', motivo: 'fotografia' };
    }
    return { ...gia };
  }

  // Catena degli antenati: directory reali fidate dal root al padre.
  // L'identita' di ogni antenato si conserva, perche' si riverifica dopo la
  // lettura: una catena sostituita a lettura aperta non e' una qualifica.
  const pezzi = canon.split(path.sep).filter((p) => p.length > 0);
  let acc = path.parse(canon).root;
  const antenati = [];
  for (let i = 0; i < pezzi.length - 1; i += 1) {
    const next = path.join(acc, pezzi[i]);
    let st;
    try { st = lstat(next); } catch (e) {
      return { ok: false, code: e && e.code === 'ENOENT' ? 'PIN_ABSENT' : 'PIN_REREAD', motivo: 'catena' };
    }
    if (!directoryFidata(st, uid, gid)) return { ok: false, code: 'PIN_REREAD', motivo: 'catena' };
    antenati.push({ next, dev: st.dev, ino: st.ino });
    acc = next;
  }

  // Il file del runtime, per nome e per descriptor: l'apertura deve dare lo
  // stesso oggetto qualificato per nome, non un nome nel frattempo sostituito.
  let stNome;
  try { stNome = lstat(canon); } catch (e) {
    return { ok: false, code: e && e.code === 'ENOENT' ? 'PIN_ABSENT' : 'PIN_REREAD', motivo: 'percorso' };
  }
  if (!fileFidato(stNome, uid)) return { ok: false, code: 'PIN_REREAD', motivo: 'oggetto' };
  let fd = null;
  let buf = null;
  try {
    fd = openSync(canon, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stFd = fstat(fd);
    if (!fileFidato(stFd, uid)) return { ok: false, code: 'PIN_REREAD', motivo: 'oggetto' };
    if (stFd.dev !== stNome.dev || stFd.ino !== stNome.ino) {
      return { ok: false, code: 'PIN_REREAD', motivo: 'oggetto' };
    }
    buf = leggiStabile(fd, stFd, deps);
    if (!buf) return { ok: false, code: 'PIN_REREAD', motivo: 'lettura' };
  } catch (e) {
    return { ok: false, code: e && e.code === 'ENOENT' ? 'PIN_ABSENT' : 'PIN_REREAD', motivo: 'apertura' };
  } finally {
    try { if (fd !== null) closeSync(fd); } catch (_) { /* fd chiuso su ogni ramo */ }
  }
  // Nome e catena si riverificano DOPO la lettura: una sostituzione avvenuta
  // mentre il descriptor era aperto non e' una lettura stabile.
  {
    let stPost;
    try { stPost = lstat(canon); } catch (_) {
      return { ok: false, code: 'PIN_REREAD', motivo: 'lettura' };
    }
    if (stPost.dev !== stNome.dev || stPost.ino !== stNome.ino
      || stPost.mode !== stNome.mode || stPost.uid !== stNome.uid
      || stPost.mtimeMs !== stNome.mtimeMs) {
      return { ok: false, code: 'PIN_REREAD', motivo: 'lettura' };
    }
    for (const antenato of antenati) {
      let stA;
      try { stA = lstat(antenato.next); } catch (_) {
        return { ok: false, code: 'PIN_REREAD', motivo: 'catena' };
      }
      if (!directoryFidata(stA, uid, gid) || stA.dev !== antenato.dev || stA.ino !== antenato.ino) {
        return { ok: false, code: 'PIN_REREAD', motivo: 'catena' };
      }
    }
  }

  // Versione: prima lettura dal processo, ma e' la probe sulla copia che
  // qualifica i byte che verranno eseguiti. Stabile, intera, >= 18.
  const dichiarata = typeof deps.versionsNode === 'string' ? deps.versionsNode : process.versions.node;
  if (typeof dichiarata !== 'string' || !RE_VERSIONE.test(dichiarata)) {
    return { ok: false, code: 'PIN_VERSION', motivo: 'versione-processo' };
  }
  const major = Number(dichiarata.split('.')[0]);
  if (!Number.isFinite(major) || major < 18) {
    return { ok: false, code: 'PIN_VERSION', motivo: 'versione-processo' };
  }

  const hash = sha256(buf);
  const foto = fotografa(buf, hash, deps);
  if (!foto.ok) return foto;

  // Probe ISOLATA della fotografia: nessuna sonda sul sorgente aggiornabile.
  const esito = probeVersione(foto.path, deps);
  if (!esito || esito.error || esito.status !== 0) {
    return { ok: false, code: 'PIN_VERSION', motivo: 'probe' };
  }
  const righe = String(esito.stdout || '').split('\n').filter((r) => r.length > 0);
  if (righe.length !== 1 || String(esito.stderr || '').length > PROBE_CAP) {
    return { ok: false, code: 'PIN_VERSION', motivo: 'probe' };
  }
  const m = righe[0].match(/^v?(\d+\.\d+\.\d+)$/);
  if (!m || m[1] !== dichiarata) return { ok: false, code: 'PIN_VERSION', motivo: 'probe-versione' };

  const qualificato = { ok: true, path: foto.path, hash, version: dichiarata, ino: foto.ino, dev: foto.dev };
  qualificati.set(canon, qualificato);
  return qualificato;
}

// Pubblicazione per-home della fotografia qualificata: lo staging della claim
// riceve una copia dello stesso contenuto (link dal temporaneo privato appena
// creato, mai dal sorgente aggiornabile). EEXIST richiede la verifica
// completa del finale; la negazione del link e' un rifiuto.
//
// Contratto (precondizione del chiamante, non verificata qui):
//  - pubblica richiede un parent privato del chiamante, dello stesso uid e
//    mode 0700, con catena di accesso non sostituibile da altri uid.
//  - I processi dello stesso uid capaci di modificare questa catena sono
//    fidati: non si garantisce resistenza alle loro sostituzioni concorrenti.
//  - La qualifica del pathname e' puntuale; non garantisce che link e fsync
//    operino sulla stessa directory qualificata.
//  - Il mkdir e' non ricorsivo: un parent assente e' un rifiuto (PIN_DIR).
//  - Dove link(2) e' negato (solo per i cinque errno di exclusive-publish) la
//    pubblicazione ripiega sulla creazione esclusiva con verifica per fd: il
//    nome finale esiste prima di essere completo, quindi i lettori qualificano
//    sempre l'oggetto e un residuo si rifiuta senza ripararlo. La qualifica
//    del pathname e la precondizione del parent restano quelle sopra.
function pubblica(qualificato, stagingDir, deps = {}) {
  // Cleanup disarm comes first, before any seam, effect or census: once the
  // incarnation cleanup has started this module admits no new work.
  if (cleanupStarted) {
    return { ok: false, code: 'PIN_STAGE', motivo: 'cleanup-started' };
  }
  if (deps && typeof deps.isDisarmed === 'function' && deps.isDisarmed()) {
    return { ok: false, code: 'PIN_REREAD', motivo: 'disarmed' };
  }
  if (!qualificato || !qualificato.ok || typeof qualificato.path !== 'string'
    || typeof qualificato.hash !== 'string') {
    return { ok: false, code: 'PIN_REREAD' };
  }
  const lstat = deps.lstat || fs.lstatSync;
  const openSync = deps.open || fs.openSync;
  const closeSync = deps.close || fs.closeSync;
  const fsync = deps.fsync || ((fd) => { fs.fsyncSync(fd); });
  // Una directory di staging esistente si accetta solo GIA' qualificata:
  // niente mkdir o chmod di riparazione su un oggetto preesistente, raggiunto
  // tramite link o no. La creazione avviene solo sull'assenza attestata ed e'
  // ESCLUSIVA: non ricorsiva, cosi' un nome comparso nel frattempo dà EEXIST.
  // Dopo la creazione c'e' SOLO qualifica, mai riparazione: un chmod sul
  // pathname non e' vincolato all'oggetto creato da questa chiamata, perche'
  // il nome puo' essere gia' stato sostituito. Con un umask che restringe
  // oltre, il mode resta sotto 0700 e si rifiuta: fail-closed.
  let assente = false;
  let stStage;
  try {
    stStage = lstat(stagingDir);
    if (!isQualifiedPrivateDir(stStage)) return { ok: false, code: 'PIN_DIR' };
  } catch (e) {
    if (!e || e.code !== 'ENOENT') return { ok: false, code: 'PIN_DIR' };
    assente = true;
  }
  if (assente) {
    try {
      fs.mkdirSync(stagingDir, { mode: 0o700 });
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return { ok: false, code: 'PIN_DIR' };
    }
    try {
      stStage = lstat(stagingDir);
      if (!isQualifiedPrivateDir(stStage)) return { ok: false, code: 'PIN_DIR' };
    } catch (_) { return { ok: false, code: 'PIN_DIR' }; }
  }
  // Per-instance publication namespace under the qualified staging: the
  // final name stays content-addressed INSIDE a directory only this
  // incarnation created. A different process publishing on the same home
  // can then never find this incarnation's snapshot as its own EEXIST, and
  // hard links only ever happen between objects of this incarnation. The
  // namespace is accepted only if this incarnation created it (memo in RAM)
  // and it still qualifies; any other existing name is foreign and refused
  // without adoption or repair.
  const nonce = instanceNonce();
  const namespace = path.join(stagingDir, `inst-${nonce}`);
  const nsBase = {
    kind: 'home-namespace',
    path: namespace,
    nonce,
    parentPath: stagingDir,
    parentDev: stStage.dev,
    parentIno: stStage.ino,
  };
  const giaNs = namespaces.get(namespace);
  let stNs;
  if (giaNs) {
    // Stable failure state for failed-qualification or unknown-identity dirs:
    // never call lstat to backfill unknown identity or repair permissions.
    if (!giaNs.qualified) return { ok: false, code: 'PIN_DIR' };
    try {
      stNs = lstat(namespace);
      if (!isQualifiedPrivateDir(stNs)) return { ok: false, code: 'PIN_DIR' };
    } catch (_) { return { ok: false, code: 'PIN_DIR' }; }
  } else {
    try {
      lstat(namespace);
      // The name already exists and was not created by this incarnation.
      recordCreation({ ...nsBase, state: 'not-created', cause: 'EEXIST' });
      return { ok: false, code: 'PIN_DIR' };
    } catch (e) {
      if (!e || e.code !== 'ENOENT') {
        recordCreation({ ...nsBase, state: 'not-created', cause: errorCode(e, 'lstat-failed') });
        return { ok: false, code: 'PIN_DIR' };
      }
    }
    const slotNs = reserveCreationCapacity();
    if (!slotNs.ok) return { ok: false, code: 'PIN_STAGE', motivo: slotNs.cause };
    try {
      fs.mkdirSync(namespace, { mode: 0o700 });
    } catch (e) {
      // Creation is exclusive and non-recursive: a name that appeared after
      // the attested absence, EEXIST included, is not ours.
      recordCreation({ ...nsBase, state: 'not-created', cause: errorCode(e, 'mkdir-failed') });
      return { ok: false, code: 'PIN_DIR' };
    }
    const nsMemo = {
      dir: namespace,
      stagingDir,
      qualified: false,
      identityUnknown: false,
      parentSynced: false,
      dev: null,
      ino: null,
    };
    namespaces.set(namespace, nsMemo);
    try {
      stNs = lstat(namespace);
    } catch (e) {
      nsMemo.identityUnknown = true;
      recordCreation({ ...nsBase, provenCreate: true, state: 'created-identity-unknown', cause: errorCode(e, 'lstat-failed') });
      return { ok: false, code: 'PIN_DIR' };
    }
    if (!isQualifiedPrivateDir(stNs)) {
      nsMemo.dev = stNs.dev;
      nsMemo.ino = stNs.ino;
      recordCreation({
        ...nsBase,
        provenCreate: true,
        dev: stNs.dev,
        ino: stNs.ino,
        uid: stNs.uid,
        mode: stNs.mode & 0o777,
        state: 'created-unqualified',
        cause: 'unqualified-dir',
      });
      return { ok: false, code: 'PIN_DIR' };
    }
    nsMemo.qualified = true;
    nsMemo.dev = stNs.dev;
    nsMemo.ino = stNs.ino;
    recordCreation({
      ...nsBase,
      provenCreate: true,
      dev: stNs.dev,
      ino: stNs.ino,
      uid: stNs.uid,
      mode: stNs.mode & 0o777,
      state: 'qualified-unsynced',
      cause: null,
    });
  }
  const dest = path.join(namespace, qualificato.hash);
  const slotDest = reserveCreationCapacity();
  if (!slotDest.ok) return { ok: false, code: 'PIN_STAGE', motivo: slotDest.cause };
  const pub = pubblicaEsclusiva({
    src: qualificato.path,
    dest,
    executable: true,
    bytes: () => {
      const f = leggiFinale(qualificato.path, deps);
      if (!f || sha256(f.buf) !== qualificato.hash) throw Object.assign(new Error('snapshot changed'), { code: 'EIO' });
      return f.buf;
    },
  });
  const linkSrcMeta = Number.isSafeInteger(qualificato.dev) && Number.isSafeInteger(qualificato.ino)
    ? { dev: qualificato.dev, ino: qualificato.ino }
    : null;
  const recorded = recordPublishedTargetOutcome({
    kind: 'home-final',
    dest,
    parentPath: namespace,
    parentDev: stNs.dev,
    parentIno: stNs.ino,
    pub,
    linkSrcMeta,
    expectedHash: qualificato.hash,
    lstat,
    deps,
  });
  if (!recorded.ok) return recorded;
  const finale = recorded.finale;
  // Durability requires syncing both directory entries: the link inside the
  // namespace and the namespace inside the staging. Neither sync is best
  // effort.
  try {
    const fdNs = openSync(namespace, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fsync(fdNs); } finally { closeSync(fdNs); }
    const fdStage = openSync(stagingDir, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try { fsync(fdStage); } finally { closeSync(fdStage); }
  } catch (e) {
    const cause = errorCode(e, 'PIN_STAGE');
    updateOwnedDurability({
      kind: 'home-final',
      path: dest,
      dev: finale.dev,
      ino: finale.ino,
      synced: false,
      cause,
    });
    updateOwnedDurability({
      kind: 'home-namespace',
      path: namespace,
      dev: stNs.dev,
      ino: stNs.ino,
      synced: false,
      cause,
    });
    return { ok: false, code: 'PIN_STAGE' };
  }
  const activeNs = namespaces.get(namespace);
  if (activeNs) activeNs.parentSynced = true;
  updateOwnedDurability({
    kind: 'home-final',
    path: dest,
    dev: finale.dev,
    ino: finale.ino,
    synced: true,
    cause: null,
  });
  updateOwnedDurability({
    kind: 'home-namespace',
    path: namespace,
    dev: stNs.dev,
    ino: stNs.ino,
    synced: true,
    cause: null,
  });
  return { ok: true, path: dest };
}

// ---- incarnation cleanup: function only, no wiring ----
//
// cleanupInstance(proof, deps) removes ONLY the objects this module
// incarnation provably created and censused, after a process-wide quiescence
// proof supplied by the caller. It never builds that proof itself: no PID,
// socket or /proc reads, no down, no kill. The proof is a private record of
// plain data: cleanupInstance validates its projection and never treats the
// object as an external capability. The future coordinator must attest every
// producer of the process and the complete Fleet summary (disarmed and
// canCleanupOwnedResources included); here that attestation is only an input.
//
// The 300 ms budget caps the operations ADMITTED and the steps that follow
// them: synchronous syscalls are not preemptible, so the budget is not a
// hard wall-clock guarantee against a blocked I/O call.
//
// The name and chain comparisons immediately before each effect are not an
// atomic compare-and-unlink: a same-uid actor can still swap an object
// between the verification and the syscall. The trust boundary stays the one
// already declared for the publication flow.
const CLEANUP_PROOF_FIELDS = [
  'nonce', 'processDisarmed', 'processQuiescent', 'fleetDisarmed', 'timedOut',
  'producers', 'claims', 'consumers', 'canCleanupOwnedResources', 'deadlineMono',
];
const CLEANUP_BUDGET_MS = 300;

// Own fields only, exactly the mandated ones, with the mandated types:
// missing, inherited, extra or wrongly typed fields reject the proof.
function cleanupProofShapeValid(proof) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return false;
  // Count ALL own keys, symbols and non-enumerable ones included: the proof
  // must own EXACTLY the ten expected string names and nothing else.
  const nomi = Reflect.ownKeys(proof);
  if (nomi.length !== CLEANUP_PROOF_FIELDS.length) return false;
  for (const nome of nomi) {
    if (typeof nome !== 'string' || !CLEANUP_PROOF_FIELDS.includes(nome)) return false;
  }
  if (proof.nonce !== null && typeof proof.nonce !== 'string') return false;
  const booleani = ['processDisarmed', 'processQuiescent', 'fleetDisarmed', 'timedOut', 'canCleanupOwnedResources'];
  for (const f of booleani) {
    if (typeof proof[f] !== 'boolean') return false;
  }
  for (const f of ['producers', 'claims', 'consumers']) {
    if (!Number.isSafeInteger(proof[f])) return false;
  }
  if (typeof proof.deadlineMono !== 'number' || !Number.isFinite(proof.deadlineMono)) return false;
  return true;
}

function cleanupInstance(proof, deps = {}) {
  // A concluded admitted round is terminal: every later call replays the
  // same frozen data with replayed=true, whatever proof it carries, with no
  // syscall, no new removal and no budget renewal. The first result of an
  // admitted round always carries replayed=false.
  if (cleanupTerminal !== null) {
    return Object.freeze({
      schema: cleanupTerminal.schema,
      outcome: cleanupTerminal.outcome,
      reason: cleanupTerminal.reason,
      counts: cleanupTerminal.counts,
      replayed: true,
    });
  }
  const refused = (reason) => Object.freeze({
    schema: 1,
    outcome: 'refused',
    reason,
    counts: Object.freeze({
      candidates: 0, removed: 0, alreadyAbsent: 0, skipped: 0, residues: 0, durabilityUnattested: 0,
    }),
    replayed: false,
  });
  // An invalid proof is never terminal: no I/O, no disarm, nothing stored.
  // A valid call may follow it. The same closed refusal applies to an
  // explicitly malformed deps (null, array or non-object), which must never
  // throw before admission; an omitted/undefined deps keeps the default {}.
  if (!cleanupProofShapeValid(proof)) return refused('proof-invalid');
  if (deps === null || Array.isArray(deps) || typeof deps !== 'object') {
    return refused('proof-invalid');
  }
  const monotonicNow = typeof deps.monotonicNow === 'function' ? deps.monotonicNow : performance.now.bind(performance);
  const lstatSync = typeof deps.lstatSync === 'function' ? deps.lstatSync : fs.lstatSync;
  const unlinkSync = typeof deps.unlinkSync === 'function' ? deps.unlinkSync : fs.unlinkSync;
  const rmdirSync = typeof deps.rmdirSync === 'function' ? deps.rmdirSync : fs.rmdirSync;
  const openSync = typeof deps.openSync === 'function' ? deps.openSync : fs.openSync;
  const fstatSync = typeof deps.fstatSync === 'function' ? deps.fstatSync : fs.fstatSync;
  const fsyncSync = typeof deps.fsyncSync === 'function' ? deps.fsyncSync : fs.fsyncSync;
  const closeSync = typeof deps.closeSync === 'function' ? deps.closeSync : fs.closeSync;
  // The clock seam is read before admission: a clock that throws or returns
  // a non-finite value refuses with proof-invalid and no I/O, no disarm.
  let now;
  try { now = monotonicNow(); } catch (_) { return refused('proof-invalid'); }
  if (!Number.isFinite(now)) return refused('proof-invalid');
  // The proof nonce must correspond to this module's incarnation nonce,
  // which is never generated here. A null nonce is admitted ONLY for a
  // module that was never initialized AND holds an actually empty registry.
  if (proof.nonce === null) {
    if (!(incarnationNonce === null && creationHistory.length === 0)) return refused('nonce-mismatch');
  } else if (proof.nonce !== incarnationNonce) {
    return refused('nonce-mismatch');
  }
  if (proof.processDisarmed !== true || proof.processQuiescent !== true
    || proof.fleetDisarmed !== true || proof.canCleanupOwnedResources !== true
    || proof.timedOut !== false
    || proof.producers !== 0 || proof.claims !== 0 || proof.consumers !== 0) {
    return refused('not-quiescent');
  }
  // First admitted call: permanent disarm BEFORE the snapshot, one single
  // deadline fixed as min(proof.deadlineMono, now+300). An already expired
  // deadline is an admitted but exhausted entry: zero I/O, incomplete, and
  // the deadline is never replaced with now+300.
  cleanupStarted = true;
  const deadline = Math.min(proof.deadlineMono, now + CLEANUP_BUDGET_MS);
  // Fresh snapshot after the disarm: the registry can no longer change, so
  // for every (kind, path) the record with the highest seq is the current
  // one. Historical generations of the same name never authorize anything
  // and are never used to obtain a more favorable identity. The counting
  // domain is the current owned, not already removed entries.
  const correntiPerChiave = new Map();
  for (const e of creationHistory) {
    const k = `${e.kind}\0${e.path}`;
    const prev = correntiPerChiave.get(k);
    if (!prev || e.seq > prev.seq) correntiPerChiave.set(k, e);
  }
  const dominio = [];
  for (const e of correntiPerChiave.values()) {
    if (e.state === 'not-created' || e.unlinked === true) continue;
    dominio.push({
      kind: e.kind, path: e.path, nonce: e.nonce,
      parentPath: e.parentPath, parentDev: e.parentDev, parentIno: e.parentIno,
      dev: e.dev, ino: e.ino, uid: e.uid, mode: e.mode,
      state: e.state, seq: e.seq, cleanupAllowed: e.cleanupAllowed,
    });
  }
  // cleanupAllowed is a precondition, never an authorization: candidacy is
  // recomputed here from the identity, attributes, parent and state data the
  // registry actually holds. Unknown-identity entries and unqualified
  // directories are never candidates; an unqualified directory is always a
  // residue.
  const eCandidata = (c) => c.cleanupAllowed === true
    && c.state !== 'created-identity-unknown'
    && c.nonce === incarnationNonce
    && Number.isSafeInteger(c.dev) && Number.isSafeInteger(c.ino)
    && Number.isSafeInteger(c.uid) && Number.isSafeInteger(c.mode)
    && typeof c.parentPath === 'string'
    && Number.isSafeInteger(c.parentDev) && Number.isSafeInteger(c.parentIno);
  const candidati = dominio.filter(eCandidata);
  const stato = {
    lastNow: now,
    clockFailed: false,
    expired: false,
    ioError: false,
    removed: 0,
    absent: 0,
    durabilityUnattested: 0,
  };
  // One clock read per check: forward and finite. After admission a clock
  // that is non-finite or has moved backwards stops everything
  // conservatively with no new mutating I/O, and the failure is persistent
  // for the whole round: a clock that becomes readable again never re-admits
  // a later fsync or rmdir.
  const leggiOrologio = () => {
    if (stato.clockFailed) return false;
    let t;
    try { t = monotonicNow(); } catch (_) { stato.clockFailed = true; return false; }
    if (!Number.isFinite(t) || t < stato.lastNow) { stato.clockFailed = true; return false; }
    stato.lastNow = t;
    if (t >= deadline) stato.expired = true;
    return !stato.expired;
  };
  const terminal = (outcome, reason) => {
    const counts = {
      candidates: candidati.length,
      removed: stato.removed,
      alreadyAbsent: stato.absent,
      durabilityUnattested: stato.durabilityUnattested,
    };
    counts.residues = dominio.length - stato.removed - stato.absent;
    // skipped counts the domain names not brought to removal or positive
    // absence, non-candidates included: in the current domain it COINCIDES
    // with residues and the two categories overlap — they are never summed
    // as disjoint classes of events.
    counts.skipped = dominio.length - stato.removed - stato.absent;
    const esito = Object.freeze({
      schema: 1,
      outcome,
      reason,
      counts: Object.freeze(counts),
      replayed: false,
    });
    cleanupTerminal = esito;
    return esito;
  };
  if (now >= deadline) {
    return terminal('incomplete', 'deadline-exhausted');
  }
  // The plan identity is the pair (incarnation nonce, seq): after a
  // successful syscall only the PLANNED entry is marked removed, and only if
  // it is still the current one.
  const segnaRimossa = (piano) => {
    const live = creationEntries.get(registryKey(piano.kind, piano.path));
    if (live && live.nonce === piano.nonce && live.seq === piano.seq) {
      markEntryUnlinked(piano.kind, piano.path);
    }
  };
  const uidCorrente = typeof process.getuid === 'function' ? process.getuid() : null;
  const dirQualificataPerNome = (dir) => {
    try {
      const st = lstatSync(dir.path);
      if (!st || st.isSymbolicLink() || !st.isDirectory()) return false;
      if (uidCorrente !== null && st.uid !== uidCorrente) return false;
      if ((st.mode & 0o777) !== 0o700) return false;
      return st.dev === dir.dev && st.ino === dir.ino;
    } catch (e) {
      // A read failure of the qualification lstat is an I/O error, distinct
      // from an identity mismatch; a missing name is not a read failure.
      if (!e || e.code !== 'ENOENT') stato.ioError = true;
      return false;
    }
  };
  const parenteCondivisoQualificatoPerNome = (dir) => {
    try {
      const st = lstatSync(dir.parentPath);
      if (!st || st.isSymbolicLink() || !st.isDirectory()) return false;
      if (uidCorrente !== null && st.uid !== uidCorrente) return false;
      if ((st.mode & 0o777) !== 0o700) return false;
      // The shared parent is compared with the identity the child
      // registered, but it is never removed or adopted as an own directory.
      return st.dev === dir.parentDev && st.ino === dir.parentIno;
    } catch (e) {
      // A read failure of the qualification lstat is an I/O error, distinct
      // from an identity mismatch; a missing name is not a read failure.
      if (!e || e.code !== 'ENOENT') stato.ioError = true;
      return false;
    }
  };
  // Own-directory candidates anchor the file branches: temp and snapshot
  // files live in this incarnation's instance directory, home finals in its
  // own per-home namespace. Files whose parent anchor is missing, incoherent
  // or not qualifiable stay residues: no adoption, no search for renamed
  // names, no late stat filling a missing identity.
  const KIND_PARENTE = { 'temp-file': 'instance-dir', 'snapshot-file': 'instance-dir', 'home-final': 'home-namespace' };
  const dirPerPath = new Map();
  for (const c of dominio) {
    if (c.kind === 'instance-dir' || c.kind === 'home-namespace') dirPerPath.set(c.path, c);
  }
  const rami = new Map(); // dir path -> { dir, files: [] }
  for (const c of candidati) {
    if (KIND_PARENTE[c.kind] === undefined) continue;
    const dir = dirPerPath.get(c.parentPath);
    if (!dir || dir.kind !== KIND_PARENTE[c.kind]
      || c.parentDev !== dir.dev || c.parentIno !== dir.ino) continue;
    if (!rami.has(dir.path)) rami.set(dir.path, { dir, files: [] });
    rami.get(dir.path).files.push(c);
  }
  for (const dir of dirPerPath.values()) {
    if (eCandidata(dir) && !rami.has(dir.path)) rami.set(dir.path, { dir, files: [] });
  }
  const ordineRami = [...rami.values()].sort((a, b) => a.dir.seq - b.dir.seq);
  for (const ramo of ordineRami) {
    if (stato.clockFailed || stato.expired) break; // the global expiry stops everything
    const { dir, files } = ramo;
    // An error or a qualification failure stops this directory and its
    // subtree, blocks the rmdir of its own ancestors and leaves every
    // remaining entry as a residue. Independent branches continue with
    // their valid chain and residual budget.
    const fermo = { stop: false };
    if (!dirQualificataPerNome(dir) || !parenteCondivisoQualificatoPerNome(dir)) {
      fermo.stop = true;
    }
    let rimossiQui = 0;
    if (!fermo.stop && files.length > 0) {
      // The parent that will be modified is opened and verified through the
      // SAME descriptor before any effect: directory, type, uid, mode and
      // identity must correspond to the qualified parent. That descriptor
      // carries the fsync of the removals made through this chain.
      let fdDir = null;
      try {
        try {
          fdDir = openSync(dir.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        } catch (_) {
          stato.ioError = true;
          fermo.stop = true;
        }
        if (fdDir !== null) {
          try {
            const stFd = fstatSync(fdDir);
            if (!stFd.isDirectory() || stFd.dev !== dir.dev || stFd.ino !== dir.ino
              || (uidCorrente !== null && stFd.uid !== uidCorrente)
              || (stFd.mode & 0o777) !== 0o700) {
              fermo.stop = true;
            }
          } catch (_) {
            stato.ioError = true;
            fermo.stop = true;
          }
        }
        // The whole registered chain, shared ancestor included, is re-verified
        // by name after the descriptor preparation and before the admitted
        // mutations: the descriptor attests the opened parent only, not the
        // chain that leads to it.
        if (!fermo.stop && (!dirQualificataPerNome(dir) || !parenteCondivisoQualificatoPerNome(dir))) {
          fermo.stop = true;
        }
        for (const file of files) {
          if (fermo.stop || !leggiOrologio()) break;
          // Name and full chain are re-verified immediately before every
          // mutation, together with the clock: a substituted link anywhere in
          // the registered chain means no removal through that chain.
          if (!dirQualificataPerNome(dir) || !parenteCondivisoQualificatoPerNome(dir)) { fermo.stop = true; break; }
          let st;
          try {
            st = lstatSync(file.path);
          } catch (e) {
            if (e && e.code === 'ENOENT') {
              // Positive absence of a candidate name after the qualification
              // of its chain: counted separately, never marked as removed.
              stato.absent += 1;
              continue;
            }
            stato.ioError = true;
            fermo.stop = true;
            break;
          }
          if (!st || st.isSymbolicLink() || !st.isFile()
            || st.dev !== file.dev || st.ino !== file.ino
            || (uidCorrente !== null && st.uid !== file.uid)
            || (st.mode & 0o777) !== file.mode) {
            fermo.stop = true;
            break;
          }
          // Final clock guard after the qualification I/O, immediately before
          // the unlink: the removal may not START when only the lstat has
          // crossed the deadline.
          if (!leggiOrologio()) break;
          try {
            unlinkSync(file.path);
          } catch (e) {
            if (e && e.code === 'ENOENT') {
              stato.absent += 1;
              continue;
            }
            stato.ioError = true;
            fermo.stop = true;
            break;
          }
          stato.removed += 1;
          rimossiQui += 1;
          segnaRimossa(file);
          if (!leggiOrologio()) break;
        }
        // Durability of this directory's modifications: the fsync runs while
        // the descriptor is still valid and before any rmdir removes the
        // name. No new fsync after the expiry: pending removals are counted
        // as unattested, once per removed entry.
        if (rimossiQui > 0 && !fermo.stop) {
          // The chain is re-verified when passing to the synchronization: no
          // fsync through a chain that is no longer qualified by name.
          if (dirQualificataPerNome(dir) && parenteCondivisoQualificatoPerNome(dir) && leggiOrologio()) {
            try {
              fsyncSync(fdDir);
            } catch (_) {
              stato.ioError = true;
              stato.durabilityUnattested += rimossiQui;
              fermo.stop = true;
            }
          } else {
            stato.durabilityUnattested += rimossiQui;
            fermo.stop = true;
          }
        } else if (rimossiQui > 0 && fermo.stop) {
          stato.durabilityUnattested += rimossiQui;
        }
      } finally {
        // Closing an already open descriptor is resource release, not a new
        // removal attempt. A failed close is still an I/O error for the
        // outcome AND stops this subpath: the rmdir of the directory whose
        // descriptor failed to close stays blocked.
        if (fdDir !== null) {
          try { closeSync(fdDir); } catch (_) { stato.ioError = true; fermo.stop = true; }
        }
      }
    }
    if (!fermo.stop && eCandidata(dir)) {
      // Bottom-up removal of the own qualified directory. The parent that
      // LOSES the name is the shared one: it is verified by name and then by
      // descriptor, the rmdir runs through the re-verified chain, and the
      // fsync of the shared parent is what attests the removal. A
      // substitution between the lstat and the open/fstat causes no removal
      // and no fsync on the substitute.
      if (leggiOrologio() && dirQualificataPerNome(dir) && parenteCondivisoQualificatoPerNome(dir)) {
        let fdP = null;
        try {
          try {
            fdP = openSync(dir.parentPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          } catch (_) {
            stato.ioError = true;
            fermo.stop = true;
          }
          if (fdP !== null) {
            let parenteVerificato = false;
            try {
              const stP = fstatSync(fdP);
              parenteVerificato = stP.isDirectory()
                && stP.dev === dir.parentDev && stP.ino === dir.parentIno
                && (uidCorrente === null || stP.uid === uidCorrente)
                && (stP.mode & 0o777) === 0o700;
            } catch (_) {
              stato.ioError = true;
            }
            if (!parenteVerificato) {
              // Substituted shared parent: no removal through that chain and
              // no fsync of the substitute.
              fermo.stop = true;
            } else if (dirQualificataPerNome(dir) && parenteCondivisoQualificatoPerNome(dir) && leggiOrologio()) {
              // The open/fstat of the parent attests the parent only, not the
              // target: the original target and the whole chain are re-verified
              // by name right before the rmdir, then the clock. A mismatch
              // stops the branch with no rmdir and no marking.
              let rimossa = false;
              try {
                rmdirSync(dir.path);
                rimossa = true;
              } catch (e) {
                if (e && e.code === 'ENOENT') {
                  stato.absent += 1;
                } else if (!(e && e.code === 'ENOTEMPTY')) {
                  // ENOTEMPTY leaves the directory as a residue without
                  // being an I/O error: strangers are never deleted to
                  // obtain an empty directory.
                  stato.ioError = true;
                }
              }
              if (rimossa) {
                stato.removed += 1;
                segnaRimossa(dir);
                // The fsync of the parent that lost the name is what
                // attests the removal of the directory itself.
                if (leggiOrologio()) {
                  try {
                    fsyncSync(fdP);
                  } catch (_) {
                    stato.ioError = true;
                    stato.durabilityUnattested += 1;
                  }
                } else {
                  stato.durabilityUnattested += 1;
                }
              }
            } else {
              fermo.stop = true;
            }
          }
        } finally {
          if (fdP !== null) {
            try { closeSync(fdP); } catch (_) { stato.ioError = true; }
          }
        }
      }
    }
  }
  // Clock before the final answer, also in rounds without filesystem I/O: a
  // late positive can never turn the round green.
  leggiOrologio();
  let reason = null;
  if (stato.clockFailed) reason = 'proof-invalid';
  else if (stato.expired) reason = 'deadline-exhausted';
  else if (stato.ioError) reason = 'io-error';
  else if (stato.removed + stato.absent < dominio.length) reason = 'residues';
  const outcome = reason === null
    && stato.removed + stato.absent === dominio.length
    && stato.durabilityUnattested === 0 ? 'done' : 'incomplete';
  return terminal(outcome, reason);
}

module.exports = { qualifica, pubblica, LIMITE_BYTE, getCreationRegistry, cleanupInstance };
