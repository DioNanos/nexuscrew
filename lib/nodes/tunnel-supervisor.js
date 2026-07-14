'use strict';

// Detached supervisor for one SSH tunnel. The parent NexusCrew process can exit;
// this process keeps the tunnel alive and retries failures with bounded backoff.
const fs = require('node:fs');
const net = require('node:net');
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
let forwardProbeTimer = null;
let forwardSocket = null;
let ownershipWaitTimer = null;
let ownershipTimer = null;

function localForwardPort(args) {
  for (let i = 0; i < args.length - 1; i += 1) {
    if (args[i] !== '-L') continue;
    const match = String(args[i + 1] || '').match(/^127\.0\.0\.1:(\d+):127\.0\.0\.1:\d+$/);
    const port = match ? Number(match[1]) : 0;
    if (Number.isInteger(port) && port >= 1 && port <= 65535) return port;
  }
  return null;
}

const forwardPort = localForwardPort(sshArgs);

function logEvent(message) {
  try { process.stderr.write(`[nexuscrew] ${String(message).replace(/[\r\n]+/g, ' ')}\n`); } catch (_) {}
}

function clearForwardProbe() {
  clearTimeout(forwardProbeTimer);
  forwardProbeTimer = null;
  if (forwardSocket) {
    try { forwardSocket.destroy(); } catch (_) {}
    forwardSocket = null;
  }
}

// A live ssh PID is not proof of authentication: the process may still be
// blocked connecting to an unreachable endpoint. Opening the local -L socket
// forces OpenSSH to establish the real forward channel. Only that event may
// advertise transport-ready or reset retry backoff.
function probeForward(expectedChild) {
  if (stopping || child !== expectedChild || !child || child.exitCode != null) return;
  if (!forwardPort) {
    writeState('transport-probing', { sshPid: child.pid, detail: 'local forward unavailable' });
    return;
  }
  let settled = false;
  const socket = net.connect({ host: '127.0.0.1', port: forwardPort });
  forwardSocket = socket;
  const done = (ready) => {
    if (settled) return;
    settled = true;
    try { socket.destroy(); } catch (_) {}
    if (forwardSocket === socket) forwardSocket = null;
    if (stopping || child !== expectedChild || !child || child.exitCode != null) return;
    if (ready) {
      attempt = 0;
      logEvent(`forward ready stableMs=${stableMs}`);
      if (!writeState('transport-ready', { sshPid: child.pid, stableMs, probe: 'tcp-forward' })) stop();
      return;
    }
    if (!writeState('transport-probing', { sshPid: child.pid, stableMs })) return stop();
    forwardProbeTimer = setTimeout(() => probeForward(expectedChild), 250);
  };
  socket.setTimeout(1000);
  socket.once('connect', () => done(true));
  socket.once('error', () => done(false));
  socket.once('timeout', () => done(false));
}

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
  logEvent(`ssh retry scheduled attempt=${attempt + 2} delayMs=${delayMs}`);
  if (!writeState('retrying', { delayMs, detail })) return stop();
  attempt += 1;
  retryTimer = setTimeout(run, delayMs);
}

function run() {
  if (stopping) return finish();
  if (!writeState('starting')) return stop();
  logEvent(`ssh attempt=${attempt + 1} starting`);
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
    clearForwardProbe();
    child = null;
    scheduleRetry(detail);
  };
  child.once('spawn', () => {
    logEvent(`ssh attempt=${attempt + 1} spawned`);
    // ExitOnForwardFailure only proves that the local bind was accepted. It
    // does not prove authentication or remote reachability, so after the
    // stability window require a real TCP open through the -L channel.
    upTimer = setTimeout(() => {
      if (!stopping && child && child.exitCode == null) {
        probeForward(child);
      }
    }, stableMs);
  });
  child.once('error', (e) => {
    logEvent(`ssh child error code=${(e && e.code) || 'unknown'}`);
    handleFailure(String(e && e.message || e));
  });
  child.once('exit', (code, signal) => {
    if (stopping) return finish();
    logEvent(`ssh exited code=${code === null ? 'null' : code} signal=${signal || 'none'}`);
    handleFailure(`ssh exited code=${code} signal=${signal || ''}`);
  });
}

function finish() {
  clearTimeout(retryTimer);
  clearTimeout(upTimer);
  clearForwardProbe();
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
  clearForwardProbe();
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
