'use strict';
// Pidfile con verified kill: metadata {pid, cmd, startTs}; kill verifica cmd+pid
// prima di signalare (no PID reuse, no broad match by name). [R1]
// Primario su Termux (serve --pidfile); opzionale --manual su linux/mac.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function defaultPidfilePath(home = os.homedir()) {
  return process.env.NEXUSCREW_PIDFILE || path.join(home, '.nexuscrew', 'nexuscrew.pid');
}

function readPidfile(p) {
  try {
    const obj = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (obj && typeof obj === 'object' && Number.isFinite(obj.pid)) ? obj : null;
  } catch (_) { return null; }
}

function currentUid() {
  try { return typeof process.getuid === 'function' ? process.getuid() : null; }
  catch (_) { return null; }
}

// `/proc/<pid>/stat` field 22 is the kernel start tick.  Unlike a PID or an
// argv it cannot be recreated by a later process.  macOS has no /proc, so a
// conservative `ps lstart` fallback still combines with UID, argv and runId.
function readProcessStart(pid) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').trim();
    const match = raw.match(/^\d+\s+\([^)]*\)\s+(.+)$/);
    const fields = match && match[1].trim().split(/\s+/);
    const ticks = fields && fields[19]; // field 22, after state=field 3
    if (/^\d+$/.test(String(ticks || ''))) return `linux:${ticks}`;
  } catch (_) {}
  try {
    const text = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim();
    return text ? `ps:${text}` : null;
  } catch (_) { return null; }
}

// Exclusive create (wx): fallisce se il pidfile esiste già (no overwrite silenzioso).
function writePidfile(p, pid, cmd, extra = {}) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const safeExtra = extra && typeof extra === 'object' && !Array.isArray(extra) ? extra : {};
  const processStart = readProcessStart(pid);
  const uid = currentUid();
  const meta = JSON.stringify({
    pid, cmd: cmd || '', startTs: Date.now(),
    ...(uid === null ? {} : { uid }),
    ...(processStart ? { processStart } : {}),
    ...safeExtra,
  });
  fs.writeFileSync(p, meta + '\n', { flag: 'wx', mode: 0o600 });
}

function removePidfile(p) {
  try { fs.unlinkSync(p); } catch (_) {}
}

// A PID can exist without belonging to this UID. Android commonly reuses PIDs
// across app sandboxes; kill(pid, 0) then returns EPERM and /proc is hidden.
// Keep generic existence separate from NexusCrew ownership so a foreign PID
// can never keep one of our pidfiles "alive" forever.
function pidOwnership(pid, killImpl = process.kill) {
  try {
    killImpl(pid, 0);
    return 'owned';
  } catch (e) {
    if (e && e.code === 'EPERM') return 'foreign';
    if (e && e.code === 'ESRCH') return 'missing';
    return 'unknown';
  }
}

function pidExists(pid, killImpl = process.kill) {
  const ownership = pidOwnership(pid, killImpl);
  return ownership === 'owned' || ownership === 'foreign';
}

function readCmdline(pid) {
  // Linux/Termux: /proc/<pid>/cmdline; fallback ps (mac)
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
  } catch (_) {
    try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }).trim(); }
    catch (_) { return ''; }
  }
}

function cmdMatches(savedCmd, liveCmd) {
  if (!savedCmd || !liveCmd) return true; // conservativo: non posso verificare, assumo match (no broad-kill)
  return liveCmd.includes(savedCmd) || savedCmd.includes(liveCmd);
}

// true se il pid appartiene a questo UID E il cmd matcha (o non verificabile).
// EPERM is deliberately false: NexusCrew must neither adopt nor signal a
// process owned by another Android/Linux user.
function isAlive(meta, impl = {}) {
  if (!meta || !Number.isFinite(meta.pid)) return false;
  if (pidOwnership(meta.pid, impl.killImpl || process.kill) !== 'owned') return false;
  if (meta.cmd) {
    const live = (impl.readCmdlineImpl || readCmdline)(meta.pid);
    if (live) return cmdMatches(meta.cmd, live);
  }
  return true;
}

// Strong ownership used by per-slot reverse supervisors.  Older generic
// pidfiles remain readable for lifecycle compatibility, but a rotatable slot
// is never stopped or adopted unless all four local facts are present.
function isAttributable(meta, impl = {}) {
  if (!meta || !Number.isFinite(meta.pid) || !Number.isInteger(meta.uid)
    || typeof meta.processStart !== 'string' || !meta.processStart) return false;
  const uid = impl.currentUidImpl ? impl.currentUidImpl() : currentUid();
  if (uid === null || uid !== meta.uid) return false;
  if (!isAlive(meta, impl)) return false;
  const liveStart = (impl.readProcessStartImpl || readProcessStart)(meta.pid);
  return typeof liveStart === 'string' && liveStart === meta.processStart;
}

// Rimuove pidfile stale (pid morto o non verificabile). Ritorna true se rimosso.
function cleanStale(p, impl = {}) {
  const meta = readPidfile(p);
  if (!meta) return false;
  if (!isAlive(meta, impl)) { removePidfile(p); return true; }
  return false;
}

// Kill verificato: legge pidfile, verifica pid+cmd, signal. MAI broad match by name.
// Ritorna { killed, pid?, reason? }.
function killPidfile(p, signal = 'SIGTERM', impl = {}) {
  const meta = readPidfile(p);
  if (!meta) return { killed: false, reason: 'no pidfile' };
  const killImpl = impl.killImpl || process.kill;
  const ownership = pidOwnership(meta.pid, killImpl);
  if (ownership === 'missing' || ownership === 'unknown') {
    removePidfile(p);
    return { killed: false, reason: 'stale (pid dead)' };
  }
  if (ownership === 'foreign') {
    // Never send a real signal after an EPERM ownership probe. The pidfile is
    // ours; the process is not.
    removePidfile(p);
    return { killed: false, reason: 'stale (pid not owned)' };
  }
  if (meta.cmd) {
    const live = (impl.readCmdlineImpl || readCmdline)(meta.pid);
    if (live && !cmdMatches(meta.cmd, live)) {
      // PID reuse: processo diverso. Non killare. Rimuovi pidfile stale.
      removePidfile(p);
      return { killed: false, reason: 'pid reuse (cmd mismatch)', liveCmd: live };
    }
  }
  try {
    killImpl(meta.pid, signal);
    removePidfile(p);
    return { killed: true, pid: meta.pid };
  } catch (e) {
    return { killed: false, reason: e.message };
  }
}

module.exports = {
  defaultPidfilePath, readPidfile, writePidfile, removePidfile,
  currentUid, readProcessStart, pidOwnership, pidExists, readCmdline,
  isAlive, isAttributable, cleanStale, killPidfile,
};
