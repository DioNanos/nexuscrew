'use strict';

// Detached supervisor for one SSH tunnel. The parent NexusCrew process can exit;
// this process keeps the tunnel alive and retries failures with bounded backoff.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { backoffDelay } = require('./tunnel.js');

const sshBin = process.argv[2];
const sshArgs = process.argv.slice(3);
const statePath = process.env.NEXUSCREW_TUNNEL_STATE;
const pidPath = process.env.NEXUSCREW_TUNNEL_PIDFILE;
const runId = process.env.NEXUSCREW_TUNNEL_RUN_ID;
const stableMsRaw = Number(process.env.NEXUSCREW_TUNNEL_STABLE_MS || 3000);
const stableMs = Number.isFinite(stableMsRaw) && stableMsRaw >= 100 ? Math.min(stableMsRaw, 30000) : 3000;
const ownershipGraceRaw = Number(process.env.NEXUSCREW_TUNNEL_OWNERSHIP_GRACE_MS || 2000);
const ownershipGraceMs = Number.isFinite(ownershipGraceRaw) && ownershipGraceRaw >= 100
  ? Math.min(ownershipGraceRaw, 10000) : 2000;
if (!sshBin || !statePath || !pidPath || !runId) process.exit(2);

let child = null;
let stopping = false;
let attempt = 0;
let retryTimer = null;
let upTimer = null;
let ownershipWaitTimer = null;
let ownershipTimer = null;

function ownsGeneration() {
  try {
    const meta = JSON.parse(fs.readFileSync(pidPath, 'utf8'));
    return meta && meta.pid === process.pid && meta.runId === runId;
  } catch (_) { return false; }
}

function writeState(status, extra = {}) {
  if (!ownsGeneration()) return false;
  const tmp = `${statePath}.tmp.${process.pid}.${runId}`;
  const data = { status, runId, transport: path.basename(sshBin), supervisorPid: process.pid, attempt, updatedAt: Date.now(), ...extra };
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, statePath);
    return true;
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (_e) {}
    return false;
  }
}

function scheduleRetry(detail) {
  if (stopping) return finish();
  const delayMs = backoffDelay(attempt, { baseMs: 1000, capMs: 60000 });
  if (!writeState('retrying', { delayMs, detail })) return stop();
  attempt += 1;
  retryTimer = setTimeout(run, delayMs);
}

function run() {
  if (stopping) return finish();
  if (!writeState('starting')) return stop();
  try {
    child = spawn(sshBin, sshArgs, { stdio: 'inherit' });
  } catch (e) {
    child = null;
    return scheduleRetry(String(e && e.message || e));
  }

  let failureHandled = false;
  const handleFailure = (detail) => {
    if (failureHandled) return;
    failureHandled = true;
    clearTimeout(upTimer);
    child = null;
    scheduleRetry(detail);
  };
  child.once('spawn', () => {
    // ExitOnForwardFailure makes bind/auth failures exit. Do not reset backoff
    // or advertise readiness on the spawn event: only a stable transport window
    // qualifies as transport-ready; HTTP federation health is checked above us.
    upTimer = setTimeout(() => {
      if (!stopping && child && child.exitCode == null) {
        attempt = 0;
        if (!writeState('transport-ready', { sshPid: child.pid, stableMs })) stop();
      }
    }, stableMs);
  });
  child.once('error', (e) => {
    handleFailure(String(e && e.message || e));
  });
  child.once('exit', (code, signal) => {
    if (stopping) return finish();
    handleFailure(`ssh exited code=${code} signal=${signal || ''}`);
  });
}

function finish() {
  clearTimeout(retryTimer);
  clearTimeout(upTimer);
  clearTimeout(ownershipWaitTimer);
  clearInterval(ownershipTimer);
  if (ownsGeneration()) {
    writeState('down');
    try {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (state.runId === runId && state.supervisorPid === process.pid) fs.unlinkSync(statePath);
    } catch (_) {}
  }
  process.exit(0);
}

function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(retryTimer);
  clearTimeout(upTimer);
  if (child && child.exitCode == null) {
    try { child.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => { try { if (child && child.exitCode == null) child.kill('SIGKILL'); } catch (_) {} finish(); }, 1500).unref();
  } else {
    finish();
  }
}

process.on('SIGTERM', stop);
process.on('SIGINT', stop);

// The parent can only write our PID after spawn returns. Give that narrow race
// a bounded grace window, then enforce generation ownership continuously. A
// replaced/removed pidfile must stop both supervisor and ssh instead of leaving
// an invisible retrying orphan behind.
const ownershipDeadline = Date.now() + ownershipGraceMs;
function acquireGeneration() {
  if (stopping) return finish();
  if (ownsGeneration()) {
    ownershipTimer = setInterval(() => { if (!ownsGeneration()) stop(); }, 500);
    return run();
  }
  if (Date.now() >= ownershipDeadline) return finish();
  ownershipWaitTimer = setTimeout(acquireGeneration, 20);
}
acquireGeneration();
