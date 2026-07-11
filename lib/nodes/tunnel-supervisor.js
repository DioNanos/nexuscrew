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
if (!sshBin || !statePath) process.exit(2);

let child = null;
let stopping = false;
let attempt = 0;
let retryTimer = null;
let upTimer = null;

function writeState(status, extra = {}) {
  const tmp = `${statePath}.tmp.${process.pid}`;
  const data = { status, supervisorPid: process.pid, attempt, updatedAt: Date.now(), ...extra };
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify(data)}\n`, { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, statePath);
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (_e) {}
  }
}

function scheduleRetry(detail) {
  if (stopping) return finish();
  const delayMs = backoffDelay(attempt, { baseMs: 1000, capMs: 60000 });
  writeState('retrying', { delayMs, detail });
  attempt += 1;
  retryTimer = setTimeout(run, delayMs);
}

function run() {
  if (stopping) return finish();
  writeState('starting');
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
    // ExitOnForwardFailure makes bind/auth failures exit. Surviving this short
    // grace window is the best portable readiness signal available for ssh -N.
    upTimer = setTimeout(() => {
      if (!stopping && child && child.exitCode == null) {
        attempt = 0;
        writeState('up', { sshPid: child.pid });
      }
    }, 750);
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
  writeState('down');
  try { fs.unlinkSync(statePath); } catch (_) {}
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
run();
