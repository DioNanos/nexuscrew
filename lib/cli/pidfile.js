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

// Exclusive create (wx): fallisce se il pidfile esiste già (no overwrite silenzioso).
function writePidfile(p, pid, cmd, extra = {}) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const safeExtra = extra && typeof extra === 'object' && !Array.isArray(extra) ? extra : {};
  const meta = JSON.stringify({ pid, cmd: cmd || '', startTs: Date.now(), ...safeExtra });
  fs.writeFileSync(p, meta + '\n', { flag: 'wx', mode: 0o600 });
}

function removePidfile(p) {
  try { fs.unlinkSync(p); } catch (_) {}
}

function pidExists(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // EPERM = esiste ma non nostro
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

// true se il pid esiste E il cmd matcha (o non verificabile).
function isAlive(meta) {
  if (!meta || !Number.isFinite(meta.pid)) return false;
  if (!pidExists(meta.pid)) return false;
  if (meta.cmd) {
    const live = readCmdline(meta.pid);
    if (live) return cmdMatches(meta.cmd, live);
  }
  return true;
}

// Rimuove pidfile stale (pid morto o non verificabile). Ritorna true se rimosso.
function cleanStale(p) {
  const meta = readPidfile(p);
  if (!meta) return false;
  if (!isAlive(meta)) { removePidfile(p); return true; }
  return false;
}

// Kill verificato: legge pidfile, verifica pid+cmd, signal. MAI broad match by name.
// Ritorna { killed, pid?, reason? }.
function killPidfile(p, signal = 'SIGTERM') {
  const meta = readPidfile(p);
  if (!meta) return { killed: false, reason: 'no pidfile' };
  if (!pidExists(meta.pid)) {
    removePidfile(p);
    return { killed: false, reason: 'stale (pid dead)' };
  }
  if (meta.cmd) {
    const live = readCmdline(meta.pid);
    if (live && !cmdMatches(meta.cmd, live)) {
      // PID reuse: processo diverso. Non killare. Rimuovi pidfile stale.
      removePidfile(p);
      return { killed: false, reason: 'pid reuse (cmd mismatch)', liveCmd: live };
    }
  }
  try {
    process.kill(meta.pid, signal);
    removePidfile(p);
    return { killed: true, pid: meta.pid };
  } catch (e) {
    return { killed: false, reason: e.message };
  }
}

module.exports = {
  defaultPidfilePath, readPidfile, writePidfile, removePidfile,
  pidExists, readCmdline, isAlive, cleanStale, killPidfile,
};
