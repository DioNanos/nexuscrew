#!/usr/bin/env node
'use strict';

// Private per-cell launcher and supervisor.  tmux sees only this helper plus a
// single-use broker ticket; the real command, provider environment and restart
// policy arrive in memory over the local 0600 Unix socket.
const net = require('node:net');
const path = require('node:path');
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
  if (Object.keys(value).some((key) => !['tmuxBin', 'tmuxSession', 'prompt', 'readyMs', 'client', 'readyWaitMs'].includes(key))) return false;
  return typeof value.tmuxBin === 'string' && value.tmuxBin.length > 0 && value.tmuxBin.length <= 4096
    && !/[\0\r\n]/.test(value.tmuxBin)
    && typeof value.tmuxSession === 'string' && /^[\w.@%:+-]{1,128}$/.test(value.tmuxSession)
    && promptCharsOk(value.prompt)
    && (value.readyMs === undefined || validInteger(value.readyMs, 0, 30000))
    && (value.client === undefined || value.client === '' || value.client === 'kimi' || value.client === 'claude')
    && (value.readyWaitMs === undefined || validInteger(value.readyWaitMs, 0, 120000));
}

function validLease(value) {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).some((k) => !['cellId', 'launchEpoch', 'capability', 'stablePath'].includes(k))) return false;
  return (value.cellId === undefined || (typeof value.cellId === 'string' && value.cellId.length > 0 && value.cellId.length <= 128))
    && typeof value.launchEpoch === 'string' && value.launchEpoch.length > 0 && value.launchEpoch.length <= 128
    && typeof value.capability === 'string' && /^[a-f0-9]{16,256}$/.test(value.capability)
    && typeof value.stablePath === 'string' && value.stablePath.length > 0 && value.stablePath.length <= 4096;
}

function validPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (Object.keys(payload).some((key) => !['command', 'args', 'env', 'supervise', 'restartPrompt', 'lease'].includes(key))) return false;
  if (typeof payload.command !== 'string' || !payload.command || !Array.isArray(payload.args)) return false;
  if (!payload.env || typeof payload.env !== 'object' || Array.isArray(payload.env)) return false;
  return payload.args.every((v) => typeof v === 'string')
    && Object.entries(payload.env).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) && typeof v === 'string')
    && validSupervise(payload.supervise)
    && validRestartPrompt(payload.restartPrompt)
    && validLease(payload.lease);
}

function receivePayload(socketPath, nonce, timeoutMs = 5000, opts = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = Buffer.alloc(0); let expected = null; let done = false;
    const finish = (error, payload) => {
      if (done) return; done = true;
      if (error) { socket.destroy(); reject(error); return; }
      // R3.1.1 (opt-in): keepOpen restituisce il socket APERTO al caller (broker
      // lease); il caller lo passa al lease-client. Default: destroy (one-shot).
      if (opts.keepOpen) { resolve({ payload, socket }); return; }
      socket.destroy(); resolve(payload);
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

function sanitizeSpawnError(error, command) {
  const rawCode = error && typeof error.code === 'string' ? error.code : '';
  const code = /^[A-Z][A-Z0-9_]{0,31}$/.test(rawCode) ? rawCode : 'SPAWN_ERROR';
  let base = '';
  try { base = path.basename(String(command || '')); } catch (_) { base = ''; }
  base = base.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 128);
  if (!base) base = 'client';
  return `nexuscrew cell spawn failed: ${code} ${base}`;
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

// Delivery del bootstrap prompt per generazione (0.8.47, R2/R3).
//
// OWNER UNICO: per gli engine managed Kimi (client 'kimi'/'claude') il
// supervisore consegna il prompt per TUTTE le generazioni, gen0 compresa —
// il runtime non esegue MAI paste/Enter per questi engine (legge solo l'esito
// bounded via opzione di pane @nc_delivery). Cosi' non esiste doppio writer
// cross-generation: se gen0 muore durante l'attesa readiness, la sua delivery
// viene cancellata e attesa PRIMA dello spawn di gen1, che ricevera' al
// massimo una nuova consegna. Engine custom send-keys: contratto legacy
// invariato (gen0 = runtime.injectPrompt; qui solo gen>0, paste senza Enter).
//
// CANCELLAZIONE (R3): cancel() ferma il timer E il polling in volo tramite
// isCancelled valutato dentro deliverBootstrapPrompt (ogni poll, pre-paste,
// pre-Enter); il chiamante fa cancel() + await settled prima dello spawn
// della generazione successiva: zero paste/Enter da un task della generazione
// precedente.
//
// REPORT: esito pubblicato con set-option -p @nc_delivery '<state>[:notReady]'
// (solo enum chiusi; l'opzione muore col pane, nessuno state file). Best
// effort: un set-option fallito lascia up() in report-timeout (onesto), la
// consegna resta fatta.
// CANCELLAZIONE (R3+R8): cancel() ferma il timer E il polling in volo tramite
// isCancelled valutato dentro deliverBootstrapPrompt (ogni poll, pre-paste,
// pre-Enter, post-Enter); il chiamante fa cancel() + await settled prima dello
// spawn della generazione successiva. cancel() con timer ANCORA PENDENTE
// (child uscito prima di readyMs, caso early-exit) risolve settled SUBITO:
// mai deadlock (R8). settled risolve con l'esito della delivery: null se
// nessun paste incerto, {state} se la generazione e' terminata con un
// post-paste incerto (delivery-unknown / staged-not-submitted) — il main loop
// NON auto-restarta in quel caso (R9: byte potenzialmente residui nel PTY del
// pane riusato; fermo bounded + restart operatore).
function startGenerationPrompt(config, generation, childState, seams = {}) {
  if (!config) return null;
  const classified = config.client === 'kimi' || config.client === 'claude';
  if (!classified && generation === 0) return null;  // legacy: gen0 resta al runtime
  const setTimer = seams.setTimeout || setTimeout;
  const clearTimer = seams.clearTimeout || clearTimeout;
  const runTmux = seams.tmuxExec || ((bin, args, opts = {}) => new Promise((resolve) => {
    require('node:child_process').execFile(bin, args, { env: opts.env, timeout: opts.timeoutMs || 10000 },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || ''), code: err ? (typeof err.code === 'number' ? err.code : 1) : 0 }));
  }));
  const paneTarget = process.env.TMUX_PANE || `=${config.tmuxSession}`;
  const markDelivery = async (value) => {
    if (!classified) return;
    try { await runTmux(config.tmuxBin, ['set-option', '-p', '-t', paneTarget, '@nc_delivery', value], {}); }
    catch (_) { /* best-effort: il report timeout di up() resta onesto */ }
  };
  let timer = null; let cancelled = false;
  let settledDone = false; let settleResolve = null;
  const settled = new Promise((resolve) => { settleResolve = resolve; });
  const settle = (value) => {
    if (settledDone) return;
    settledDone = true;
    settleResolve(value);
  };
  const isCancelled = () => cancelled || childState.exited === true;
  timer = setTimer(async () => {
    timer = null;
    if (isCancelled()) { settle(null); return; }
    const task = (async () => {
      try {
        if (classified) {
          await markDelivery('');
          const deliver = seams.deliverBootstrapPrompt
            || require('./prompt-delivery.js').deliverBootstrapPrompt;
          const result = await deliver({
            tmuxBin: config.tmuxBin,
            session: config.tmuxSession,
            prompt: config.prompt,
            client: config.client,
            paneTarget: process.env.TMUX_PANE || undefined,
            readyWaitMs: config.readyWaitMs,
            isCancelled,
          });
          const state = result && typeof result.state === 'string' ? result.state : '';
          const uncertain = state === 'delivery-unknown' || state === 'staged-not-submitted';
          if (isCancelled()) {
            // R9: la generazione e' finita. Propago SOLO gli esiti post-paste
            // incerti (residuo PTY possibile); cancelled pre-paste e' pulito.
            return uncertain ? { state } : null;
          }
          if (state) {
            const kind = state === 'skipped-not-ready' && result.notReady ? `:${result.notReady}` : '';
            await markDelivery(`${state}${kind}`);
          }
          // R12: l'esito post-paste incerto va conservato ANCHE se il child
          // era vivo al ritorno di deliver: i byte possono restare nel PTY del
          // pane e sommarsi al bootstrap della generazione successiva. Al
          // prossimo child exit il main ferma il supervisor (no auto-restart).
          return uncertain ? { state } : null;
        }
        const inject = seams.injectPrompt || require('./launch.js').injectPrompt;
        await inject(config.tmuxBin, config.tmuxSession, config.prompt, {
          target: paneTarget,
          readyMs: 0,
        });
        return null;
      } catch (_) { return null; /* keepalive must not die because prompt reinjection failed */ }
    })();
    settle(await task);
  }, config.readyMs ?? 400);
  timer.unref?.();
  return {
    settled,
    // R8: timer ancora pendente -> settle IMMEDIATO (idempotente): il main
    // loop non resta mai appeso su un child uscito prima di readyMs.
    cancel() {
      cancelled = true;
      if (timer) { clearTimer(timer); timer = null; settle(null); }
    },
  };
}

async function main(argv = process.argv.slice(2), seams = {}) {
  const parsed = parseArgs(argv);
  if (!parsed) throw new Error('usage: cell-exec --socket <path> --nonce <hex>');
  const received = await (seams.receivePayload || receivePayload)(parsed.socketPath, parsed.nonce, 5000, { keepOpen: true });
  // Compat: il seam di test puo' restituire un payload direttamente; la forma
  // produttiva restituisce { payload, socket } con socket APERTO (broker lease).
  const payload = received && typeof received === 'object' && received.payload ? received.payload : received;
  const leaseSocket = received && typeof received === 'object' && received.socket ? received.socket : null;
  // Se il payload non porta lease (cella non-ospite), rilascia subito il socket
  // broker: niente canale lease, e il supervisore non deve trattenere il loop.
  if (!payload.lease && leaseSocket) { try { leaseSocket.destroy(); } catch (_) {} }
  const supervise = normalizeSupervise(payload.supervise);
  const spawnImpl = seams.spawn || spawn;
  const now = seams.now || Date.now;
  const sleep = seams.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const proc = seams.process || process;
  const writeError = seams.writeError || seams.stderrWrite || ((message) => process.stderr.write(message));
  const childEnv = { ...payload.env };
  // tmux injects these only after the broker ticket was created. Preserve them
  // for the actual TUI and bind NexusCrew MCP callbacks to the owning session.
  if (process.env.TMUX) childEnv.TMUX = process.env.TMUX;
  if (process.env.TMUX_PANE) childEnv.TMUX_PANE = process.env.TMUX_PANE;

  // R3.1.2: nessun bearer di lease transita al child. childEnv deriva SOLO da
  // payload.env (piu' TMUX); payload.lease (launchEpoch/capability/stablePath)
  // resta nel supervisore e alimenta il lease-client. spawnImpl passa env +
  // stdio inherit. La capability NON compare mai nell'env del child.
  let generation = 0;
  let leaseCtl = null;
  if (payload.lease && leaseSocket && !leaseSocket.destroyed) {
    const { startLeaseClient } = require('./lease-client.js');
    leaseCtl = startLeaseClient(leaseSocket, {
      stablePath: payload.lease.stablePath,
      launchEpoch: payload.lease.launchEpoch,
      capability: payload.lease.capability,
      // R3.3.4: la generation AVANZA coi restart del supervisore (loop sotto,
      // generation += 1). Passiamo un getter cosicche' il reconnect presenti
      // sempre la generation corrente, non 0 fisso (riconcilia :301 con :381).
      generation: () => generation,
    }, seams);
  }

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

  let delayMs = supervise.restartDelayMs;
  let rapid = [];
  try {
    for (;;) {
      if (stopping) return 0;
      const startedAt = now();
      const childState = { exited: false };
      const promptCtl = startGenerationPrompt(payload.restartPrompt, generation, childState, seams);
      current = spawnImpl(payload.command, payload.args, { env: childEnv, stdio: 'inherit' });
      const result = await waitChild(current);
      childState.exited = true;
      current = null;
      // R2/R3: la generazione e' finita. Cancella la delivery in volo e ATTESA
      // del suo termine PRIMA di qualunque nuovo spawn. R9: se l'esito e' un
      // post-paste incerto (delivery-unknown / staged-not-submitted) i byte del
      // prompt possono essere residui nel PTY del pane riusato: NIENTE auto-
      // restart — fermo bounded del supervisor, restart esplicito operatore.
      if (promptCtl) {
        promptCtl.cancel();
        const promptOutcome = await promptCtl.settled;
        if (promptOutcome && (promptOutcome.state === 'delivery-unknown'
          || promptOutcome.state === 'staged-not-submitted')) {
          writeError('nexuscrew cell supervisor stopped: uncertain prompt delivery (operator restart required)\n');
          return result.signal ? 128 : (result.code || 1);
        }
      }
      if (result.error) {
        writeError(`${sanitizeSpawnError(result.error, payload.command)}\n`);
        return 1;
      }
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
  } finally { if (leaseCtl) { try { leaseCtl.stop(); } catch (_) {} } cleanup(); }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`nexuscrew cell launch failed: ${error.message}\n`); process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_SUPERVISE, parseArgs, validSupervise, validRestartPrompt, validPayload, validLease,
  receivePayload, sanitizeSpawnError, normalizeSupervise, waitChild, startGenerationPrompt, main,
};
