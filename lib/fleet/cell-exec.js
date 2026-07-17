#!/usr/bin/env node
'use strict';

// Private per-cell launcher and supervisor.  tmux sees only this helper plus a
// single-use broker ticket; the real command, provider environment and restart
// policy arrive in memory over the local 0600 Unix socket.
const net = require('node:net');
const { spawn } = require('node:child_process');
const { MAX_PAYLOAD } = require('./launch-broker.js');

const DEFAULT_SUPERVISE = Object.freeze({
  enabled: true,
  initialReadyMs: 500,
  restartDelayMs: 1000,
  maxRestartDelayMs: 60000,
  resetAfterMs: 30000,
  rapidWindowMs: 60000,
  maxRapidRestarts: 8,
});

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === '--socket') out.socketPath = argv[i + 1];
    else if (argv[i] === '--nonce') out.nonce = argv[i + 1];
    else return null;
  }
  if (typeof out.socketPath !== 'string' || !out.socketPath
    || typeof out.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(out.nonce)) return null;
  return out;
}

function validInteger(value, min, max) {
  return Number.isInteger(value) && value >= min && value <= max;
}

function validSupervise(value) {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = new Set([
    'enabled', 'initialReadyMs', 'restartDelayMs', 'maxRestartDelayMs',
    'resetAfterMs', 'rapidWindowMs', 'maxRapidRestarts',
  ]);
  if (Object.keys(value).some((key) => !keys.has(key))) return false;
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') return false;
  const checks = [
    ['initialReadyMs', 50, 30000], ['restartDelayMs', 50, 60000],
    ['maxRestartDelayMs', 100, 300000], ['resetAfterMs', 1000, 3600000],
    ['rapidWindowMs', 1000, 3600000], ['maxRapidRestarts', 1, 100],
  ];
  return checks.every(([key, min, max]) => value[key] === undefined || validInteger(value[key], min, max));
}

function promptCharsOk(prompt) {
  if (typeof prompt !== 'string' || prompt.length > 131072) return false;
  for (let i = 0; i < prompt.length; i += 1) {
    const code = prompt.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) continue;
    if (code < 32 || code === 127) return false;
  }
  return true;
}

function validRestartPrompt(value) {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => !['tmuxBin', 'tmuxSession', 'prompt', 'readyMs'].includes(key))) return false;
  return typeof value.tmuxBin === 'string' && value.tmuxBin.length > 0 && value.tmuxBin.length <= 4096
    && !/[\0\r\n]/.test(value.tmuxBin)
    && typeof value.tmuxSession === 'string' && /^[\w.@%:+-]{1,128}$/.test(value.tmuxSession)
    && promptCharsOk(value.prompt)
    && (value.readyMs === undefined || validInteger(value.readyMs, 0, 30000));
}

function validPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (Object.keys(payload).some((key) => !['command', 'args', 'env', 'supervise', 'restartPrompt'].includes(key))) return false;
  if (typeof payload.command !== 'string' || !payload.command || !Array.isArray(payload.args)) return false;
  if (!payload.env || typeof payload.env !== 'object' || Array.isArray(payload.env)) return false;
  return payload.args.every((v) => typeof v === 'string')
    && Object.entries(payload.env).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) && typeof v === 'string')
    && validSupervise(payload.supervise)
    && validRestartPrompt(payload.restartPrompt);
}

function receivePayload(socketPath, nonce, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = Buffer.alloc(0); let expected = null; let done = false;
    const finish = (error, payload) => {
      if (done) return; done = true; socket.destroy();
      if (error) reject(error); else resolve(payload);
    };
    socket.setTimeout(timeoutMs, () => finish(new Error('launch broker timed out')));
    socket.once('connect', () => socket.write(`${JSON.stringify({ nonce })}\n`));
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (expected === null && data.length >= 4) {
        expected = data.readUInt32BE(0); data = data.subarray(4);
        if (!expected || expected > MAX_PAYLOAD) return finish(new Error('invalid launch payload length'));
      }
      if (expected !== null && data.length >= expected) {
        try {
          const payload = JSON.parse(data.subarray(0, expected).toString('utf8'));
          if (!validPayload(payload)) return finish(new Error('invalid launch payload'));
          finish(null, payload);
        } catch (error) { finish(error); }
      }
    });
    socket.once('error', (error) => finish(error));
    socket.once('end', () => { if (!done) finish(new Error('launch broker closed early')); });
  });
}

function normalizeSupervise(value = {}) {
  return { ...DEFAULT_SUPERVISE, ...(value || {}) };
}

function waitChild(child) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (code, signal, error = null) => {
      if (settled) return; settled = true; resolve({ code: code == null ? 1 : code, signal, error });
    };
    child.once('error', (error) => finish(1, null, error));
    child.once('exit', (code, signal) => finish(code, signal));
  });
}

function scheduleRestartPrompt(config, childState, seams = {}) {
  if (!config) return { cancel() {} };
  let timer = null; let cancelled = false;
  const setTimer = seams.setTimeout || setTimeout;
  const clearTimer = seams.clearTimeout || clearTimeout;
  timer = setTimer(async () => {
    timer = null;
    if (cancelled || childState.exited) return;
    try {
      const inject = seams.injectPrompt || require('./launch.js').injectPrompt;
      await inject(config.tmuxBin, config.tmuxSession, config.prompt, {
        target: process.env.TMUX_PANE || `=${config.tmuxSession}`,
        readyMs: 0,
      });
    } catch (_) { /* keepalive must not die because prompt reinjection failed */ }
  }, config.readyMs ?? 400);
  timer.unref?.();
  return { cancel() { cancelled = true; if (timer) clearTimer(timer); timer = null; } };
}

async function main(argv = process.argv.slice(2), seams = {}) {
  const parsed = parseArgs(argv);
  if (!parsed) throw new Error('usage: cell-exec --socket <path> --nonce <hex>');
  const payload = await (seams.receivePayload || receivePayload)(parsed.socketPath, parsed.nonce);
  const supervise = normalizeSupervise(payload.supervise);
  const spawnImpl = seams.spawn || spawn;
  const now = seams.now || Date.now;
  const sleep = seams.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const proc = seams.process || process;
  const writeError = seams.writeError || ((message) => process.stderr.write(message));
  const childEnv = { ...payload.env };
  // tmux injects these only after the broker ticket was created. Preserve them
  // for the actual TUI and bind NexusCrew MCP callbacks to the owning session.
  if (process.env.TMUX) childEnv.TMUX = process.env.TMUX;
  if (process.env.TMUX_PANE) childEnv.TMUX_PANE = process.env.TMUX_PANE;

  let current = null; let stopping = false;
  const handlers = new Map();
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    const handler = () => {
      stopping = true;
      try { if (current) current.kill(signal); } catch (_) {}
    };
    handlers.set(signal, handler);
    proc.once?.(signal, handler);
  }
  const cleanup = () => {
    for (const [signal, handler] of handlers) proc.off?.(signal, handler);
  };

  let generation = 0;
  let delayMs = supervise.restartDelayMs;
  let rapid = [];
  try {
    for (;;) {
      if (stopping) return 0;
      const startedAt = now();
      current = spawnImpl(payload.command, payload.args, { env: childEnv, stdio: 'inherit' });
      const childState = { exited: false };
      const prompt = generation > 0 ? scheduleRestartPrompt(payload.restartPrompt, childState, seams) : null;
      const result = await waitChild(current);
      childState.exited = true;
      prompt?.cancel();
      current = null;
      const runtimeMs = Math.max(0, now() - startedAt);
      if (stopping) return 0;
      if (!supervise.enabled) return result.signal ? 128 : result.code;

      // Preserve the launch readiness contract: a first child that dies before
      // the gate is a failed start, not a successfully supervised cell.
      if (generation === 0 && runtimeMs < supervise.initialReadyMs) {
        return result.signal ? 128 : (result.code || 1);
      }

      const stamp = now();
      if (runtimeMs >= supervise.resetAfterMs) {
        rapid = [];
        delayMs = supervise.restartDelayMs;
      } else {
        rapid = rapid.filter((value) => stamp - value <= supervise.rapidWindowMs);
        rapid.push(stamp);
        if (rapid.length > supervise.maxRapidRestarts) {
          writeError('nexuscrew cell supervisor stopped after repeated early exits\n');
          return result.signal ? 128 : (result.code || 1);
        }
      }
      await sleep(delayMs);
      // A down/kill-session can reach the supervisor while it is waiting in
      // backoff. Never start another client after that stop signal.
      if (stopping) return 0;
      delayMs = Math.min(supervise.maxRestartDelayMs, Math.max(supervise.restartDelayMs, delayMs * 2));
      generation += 1;
    }
  } finally { cleanup(); }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`nexuscrew cell launch failed: ${error.message}\n`); process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_SUPERVISE, parseArgs, validSupervise, validRestartPrompt, validPayload,
  receivePayload, normalizeSupervise, waitChild, scheduleRestartPrompt, main,
};
