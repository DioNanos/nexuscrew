'use strict';
// Liveness guard of the portable service (Termux lifecycle).
//
// A kernel lock is taken BEFORE the pid file is judged, cleaned or reserved,
// and is kept for the whole life of the service process. It closes the race
// between two cleaners and lets a record written under the lock be recognised
// as stale after a crash or reboot even when the pid has been reused and
// /proc is unreadable.
//
// The lock is advisory and cooperative: it binds the entries of this product,
// on a local filesystem. It does not stop a process of the same user that
// edits the files on purpose or runs older code outside the protocol. It
// grants no right to signal any pid.
//
// Mechanism (Node >= 18, no native addon): a dedicated directory `<pid
// file>.guard/` (private) holds a fixed `lock` file. The service opens it and
// runs util-linux `flock` once with that descriptor inherited as fd 3; flock
// locks the open file description shared with this process and exits, so the
// lock stays with THIS process's descriptor until it exits. The descriptor is
// never closed, never passed to children, and the lock file is never removed
// or rotated (a new inode would be a new lock).
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const pidf = require('./pidfile.js');

const BUSY_EXIT = 73;

function errore(code, messaggio) {
  const e = new Error(`${code}: ${messaggio}`);
  e.code = code;
  return e;
}

function mioUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function guardDir(pidPath) {
  return `${pidPath}.guard`;
}

// The flock binary is the one next to the qualified Node of this prefix: no
// PATH search, no override from the environment or from a record. It must be
// a regular, executable file owned by us or by root and not writable by
// others.
function flockQualificato(percorso) {
  try {
    const st = fs.lstatSync(percorso);
    if (st.isSymbolicLink() || !st.isFile()) return false;
    if ((st.mode & 0o100) === 0 || (st.mode & 0o022) !== 0) return false;
    const uid = mioUid();
    return uid === null || st.uid === uid || st.uid === 0;
  } catch (_) {
    return false;
  }
}

function mioGid() {
  return typeof process.getgid === 'function' ? process.getgid() : null;
}

// Trust conditions already adopted by the product for directory ancestors
// (same shape as the roots walker): a real directory, never a symlink, owned
// by root or by the current user, not writable by group/others unless it is
// sticky and owned by root/us (the /tmp shape), and executable by us — with
// the effective group admitted where it matches. The directory holding the
// pid file itself must be ours, never writable by others.
function antenatoFidato(st, uid, gid) {
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return false;
  const mode = st.mode & 0o777;
  if (st.uid !== 0 && st.uid !== uid) return false;
  const sticky = (st.mode & 0o1000) !== 0 && (st.uid === 0 || st.uid === uid);
  if ((mode & 0o022) !== 0 && !sticky) return false;
  if (st.uid === uid) return (mode & 0o100) !== 0;
  if (gid !== null && st.gid === gid) return (mode & 0o010) !== 0;
  return (mode & 0o001) !== 0;
}

// Android layout. The private root of the app is attested by the path of the
// installed runtime (never by HOME/PREFIX taken from the environment). From
// that root down to the pid file everything must be ours, protected and a
// real directory. Above it only the platform owners named below are admitted
// (root and the system uid/gid), and only without write access for anybody
// else: not "any owner that is not writable". The platform alias /data/data
// <-> /data/user/0 is accepted only as that exact pair, owned by the
// platform, and resolved to the canonical path that is then walked.
const ANDROID_SYSTEM_IDS = Object.freeze([0, 1000]);
const ANDROID_ALIASES = Object.freeze([['data/data', 'data/user/0'], ['data/user/0', 'data/data']]);
const ANDROID_APP_RE = /^(data\/(?:data|user\/\d+)\/[^/]+)\/files\/usr\/bin\/[^/]+$/;

function androidApp(seam) {
  try {
    const root = seam && seam.fsRoot ? path.resolve(seam.fsRoot) : path.sep;
    const real = fs.realpathSync(seam && seam.execPath ? seam.execPath : process.execPath);
    const rel = path.relative(root, real);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const m = ANDROID_APP_RE.exec(rel.split(path.sep).join('/'));
    if (!m) return null;
    return {
      root,
      appRoot: path.join(root, ...m[1].split('/')),
      lstat: (seam && seam.lstat) || fs.lstatSync,
      sysIds: (seam && seam.systemIds) || ANDROID_SYSTEM_IDS,
    };
  } catch (_) {
    return null;
  }
}

function aliasEquivalenti(relUn, relCanon) {
  if (relUn === relCanon) return { ok: true, alias: null };
  for (const [da, a] of ANDROID_ALIASES) {
    if (relUn === da || relUn.startsWith(`${da}/`)) {
      const rimappato = a + relUn.slice(da.length);
      if (rimappato === relCanon) return { ok: true, alias: da };
    }
  }
  return { ok: false, alias: null };
}

function piattaformaFidata(st, sys) {
  if (!st || st.isSymbolicLink() || !st.isDirectory()) return false;
  if (!sys.includes(st.uid)) return false;
  const mode = st.mode & 0o777;
  if ((mode & 0o002) !== 0) return false;
  if ((mode & 0o020) !== 0 && !sys.includes(st.gid)) return false;
  return true;
}

// An app ancestor (below the attested app root) is trusted when it belongs to
// the process user, is never writable by others, keeps its execute bit, and is
// group-writable only for the app's own private group: the app uid and gid
// coincide (Android gives every app a unique uid==gid pair; Linux
// user-private-groups behave the same), so that group adds no writer the
// directory owner is not already. Anything else with g+w stays refused.
function appFidata(st, uid, gid) {
  if (!st || st.isSymbolicLink() || !st.isDirectory() || uid === null) return false;
  if (st.uid !== uid) return false;
  const mode = st.mode & 0o777;
  if ((mode & 0o002) !== 0) return false;
  if ((mode & 0o020) !== 0 && !(gid !== null && gid === uid && st.gid === gid)) return false;
  return (mode & 0o100) !== 0;
}

// Bounded refusal detail of a rejected ancestor: path and octal mode only.
function antenatoRifiutato(p, st) {
  return { path: p, mode: (st.mode & 0o777).toString(8) };
}

const idDi = (st) => `${st.dev}:${st.ino}`;

// Returns null when the pid directory is not inside the attested app root
// (the generic rule then applies unchanged), otherwise { ok, ids }.
function catenaAndroid(pidPath, app, uid, gid) {
  const dir = path.resolve(path.dirname(pidPath));
  let canon;
  try { canon = fs.realpathSync(dir); } catch (_) { return { ok: false, ids: null }; }
  if (canon !== app.appRoot && !canon.startsWith(app.appRoot + path.sep)) return null;
  const relUn = path.relative(app.root, dir).split(path.sep).join('/');
  const relCanon = path.relative(app.root, canon).split(path.sep).join('/');
  const eq = aliasEquivalenti(relUn, relCanon);
  if (!eq.ok) return { ok: false, ids: null };
  const ids = [];
  try {
    if (eq.alias) {
      // The alias entry itself belongs to the platform.
      const st = app.lstat(path.join(app.root, ...eq.alias.split('/')));
      if (!st || !app.sysIds.includes(st.uid)) return { ok: false, ids: null };
      ids.push(idDi(st));
    }
    let acc = app.root;
    let st = app.lstat(acc);
    if (!piattaformaFidata(st, app.sysIds)) return { ok: false, ids: null, detail: antenatoRifiutato(app.root, st) };
    ids.push(idDi(st));
    for (const nome of relCanon.split('/').filter((p) => p.length > 0)) {
      acc = path.join(acc, nome);
      st = app.lstat(acc);
      const sopra = acc !== app.appRoot && !acc.startsWith(app.appRoot + path.sep);
      if (!(sopra ? piattaformaFidata(st, app.sysIds) : appFidata(st, uid, gid))) {
        return { ok: false, ids: null, detail: antenatoRifiutato(acc, st) };
      }
      ids.push(idDi(st));
    }
    return { ok: true, ids };
  } catch (_) {
    return { ok: false, ids: null };
  }
}

// Qualifies every ancestor of the pid file from the filesystem root down to
// its parent directory. Returns { ok, ids } where ids are the identities
// (dev:ino) seen, to be compared by the re-check after the lock is taken.
function catenaAntenatiFidata(pidPath, uid, gid, impl) {
  // Test seam: the chain qualification may run against an injected identity;
  // the guard directory and the lock keep the real process identity.
  const id = impl && impl.identity && typeof impl.identity === 'object' ? impl.identity : null;
  if (id && Number.isInteger(id.uid)) uid = id.uid;
  if (id && Number.isInteger(id.gid)) gid = id.gid;
  const app = androidApp(impl && impl.android);
  if (app) {
    const r = catenaAndroid(pidPath, app, uid, gid);
    if (r) return r;
  }
  const target = path.resolve(path.dirname(pidPath));
  const pezzi = target.split(path.sep).filter((p) => p.length > 0);
  let acc = path.parse(target).root;
  const ids = [];
  try {
    // The root itself (e.g. / or /data) is qualified like any ancestor.
    let st = fs.lstatSync(acc);
    if (!antenatoFidato(st, uid, gid)) return { ok: false, ids: null };
    ids.push(idDi(st));
    for (const nome of pezzi) {
      acc = path.join(acc, nome);
      st = fs.lstatSync(acc);
      if (!antenatoFidato(st, uid, gid)) return { ok: false, ids: null, detail: antenatoRifiutato(acc, st) };
      ids.push(idDi(st));
    }
    return { ok: true, ids };
  } catch (_) {
    return { ok: false, ids: null };
  }
}

function acquireGuard(pidPath, impl = {}) {
  const dir = guardDir(pidPath);
  const uid = mioUid();
  const gid = mioGid();
  let catena;
  try {
    // The pid directory is created first: on a fresh home it does not exist
    // yet and the ancestor chain is qualified only AFTER creation, never by
    // trusting a directory this call just made without looking at it.
    fs.mkdirSync(path.dirname(pidPath), { recursive: true, mode: 0o700 });
    catena = catenaAntenatiFidata(pidPath, uid, gid, impl);
    if (!catena.ok) return { ok: false, code: 'GUARD_UNSAFE', ...(catena.detail ? { detail: catena.detail } : {}) };
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return { ok: false, code: 'GUARD_UNSAFE' };
    }
    const stDir = fs.lstatSync(dir);
    if (stDir.isSymbolicLink() || !stDir.isDirectory() || (uid !== null && stDir.uid !== uid)
      || (stDir.mode & 0o777) !== 0o700) {
      return { ok: false, code: 'GUARD_UNSAFE' };
    }
  } catch (_) {
    return { ok: false, code: 'GUARD_UNSAFE' };
  }

  const lockPath = path.join(dir, 'lock');
  let fd;
  try {
    fd = fs.openSync(lockPath, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  } catch (_) {
    return { ok: false, code: 'GUARD_UNSAFE' };
  }
  const chiudi = (code) => { try { fs.closeSync(fd); } catch (_) { /* best-effort */ } return { ok: false, code }; };
  let st;
  try {
    st = fs.fstatSync(fd);
    const nome = fs.lstatSync(lockPath);
    if (!st.isFile() || st.nlink !== 1 || (uid !== null && st.uid !== uid) || (st.mode & 0o777) !== 0o600
      || nome.isSymbolicLink() || nome.dev !== st.dev || nome.ino !== st.ino) {
      return chiudi('GUARD_UNSAFE');
    }
  } catch (_) {
    return chiudi('GUARD_UNSAFE');
  }

  const flock = impl.flockPath || path.join(path.dirname(process.execPath), 'flock');
  if (!flockQualificato(flock)) return chiudi('GUARD_UNAVAILABLE');
  try {
    execFileSync(flock, ['-x', '-w', String(impl.waitSec === undefined ? 2 : impl.waitSec), '-E', String(BUSY_EXIT), '3'], {
      stdio: ['ignore', 'ignore', 'pipe', fd],
      timeout: 3000,
      maxBuffer: 4096,
      shell: false,
      env: { PATH: '/usr/bin:/bin', LANG: 'C' },
    });
  } catch (e) {
    return chiudi(e && e.status === BUSY_EXIT ? 'GUARD_BUSY' : 'GUARD_UNAVAILABLE');
  }

  // With the lock held, the directory and the name must still be what was
  // qualified: a replaced lock is a refusal, not an equivalent new lock. The
  // ancestor chain is re-checked too (before/after, as qualified).
  try {
    if (typeof impl.afterLock === 'function') impl.afterLock();
    const ora = catenaAntenatiFidata(pidPath, uid, gid, impl);
    if (!ora.ok || ora.ids.length !== catena.ids.length || ora.ids.some((x, i) => x !== catena.ids[i])) {
      return chiudi('GUARD_UNSAFE');
    }
    const nome = fs.lstatSync(lockPath);
    const stDir = fs.lstatSync(dir);
    const stFd = fs.fstatSync(fd);
    if (nome.isSymbolicLink() || nome.dev !== stFd.dev || nome.ino !== stFd.ino
      || stDir.isSymbolicLink() || !stDir.isDirectory() || (stDir.mode & 0o777) !== 0o700) {
      return chiudi('GUARD_UNSAFE');
    }
    return { ok: true, fd, dev: stFd.dev, ino: stFd.ino, lockPath };
  } catch (_) {
    return chiudi('GUARD_UNSAFE');
  }
}

// Takes the guard, judges the existing record with positive evidence only and
// reserves the new one. Returns { runId, guard }; the guard descriptor stays
// open for the life of the process. On any refusal nothing is changed beyond
// the removal of a record proven stale, and the guard is released.
function claimService({ pidPath, cmd, port, guardImpl, pidImpl, hooks } = {}) {
  const g = acquireGuard(pidPath, guardImpl || {});
  if (!g.ok) {
    const dove = g.detail ? `; unsafe ancestor ${g.detail.path} mode ${g.detail.mode}` : '';
    throw errore(g.code, `service guard not acquired (${pidPath}${dove})`);
  }
  const rilascia = (e) => { try { fs.closeSync(g.fd); } catch (_) { /* best-effort */ } throw e; };

  const ins = pidf.inspectPidfile(pidPath, { ...(pidImpl || {}), guard: { dev: g.dev, ino: g.ino } });
  if (ins.state === 'alive') {
    rilascia(errore('PIDFILE_ALIVE', `already running (pid ${ins.meta.pid}) — pidfile ${pidPath}`));
  }
  if (ins.state === 'indeterminate') {
    rilascia(errore('PIDFILE_UNVERIFIABLE', `pidfile ${pidPath} cannot be attested (${ins.reason}); left untouched`));
  }
  if (ins.state === 'invalid') {
    rilascia(errore('PIDFILE_INVALID', `pidfile ${pidPath} is not a valid record (${ins.reason}); left untouched`));
  }
  if (ins.state === 'stale' && !pidf.removeStalePidfile(pidPath, ins)) {
    rilascia(errore('PIDFILE_CONFLICT', `pidfile ${pidPath} changed while it was being cleaned`));
  }

  const runId = crypto.randomBytes(16).toString('hex');
  if (hooks && typeof hooks.beforeCreate === 'function') hooks.beforeCreate();
  try {
    pidf.writePidfile(pidPath, process.pid, cmd, Number.isInteger(port) ? { port } : {}, {
      serviceRunId: runId,
      serviceGuard: { v: 1, dev: g.dev, ino: g.ino },
    });
  } catch (e) {
    // An unexpected existing name is a conflict: never overwritten, never
    // removed, never retried. Any other error leaves a possibly written
    // record in place for diagnosis.
    rilascia(errore(e && e.code === 'EEXIST' ? 'PIDFILE_CONFLICT' : 'PIDFILE_WRITE',
      `pidfile ${pidPath} not written (${(e && e.code) || 'error'})`));
  }
  return { runId, guard: g };
}

module.exports = { acquireGuard, claimService, guardDir };
