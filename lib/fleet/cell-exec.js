#!/usr/bin/env node
'use strict';

// Private per-cell launcher and supervisor.  tmux sees only this helper plus a
// single-use broker ticket; the real command, provider environment and restart
// policy arrive in memory over the local 0600 Unix socket.
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { MAX_PAYLOAD } = require('./launch-broker.js');
const {
  validDaemonChallenge, validVerifyExpected, identityErrorCode,
  IDENTITY_FRAME_LIMIT, IDENTITY_TIMEOUT_MS,
} = require('./lease-client.js');

const DEFAULT_SUPERVISE = Object.freeze({
  enabled: true,
  initialReadyMs: 500,
  restartDelayMs: 1000,
  maxRestartDelayMs: 60000,
  resetAfterMs: 30000,
  rapidWindowMs: 60000,
  maxRapidRestarts: 8,
});

// da revisione (correzione escalation): limite ESPLICITO fra SIGTERM e
// SIGKILL quando la lease e' persa (onLost, main()). Un figlio che ignora
// SIGTERM non deve restare appeso a tempo indeterminato.
const LEASE_LOST_KILL_ESCALATION_MS = 5000;

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

function validIdentity(value) {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = new Set(['audience', 'daemonBootId', 'connectionId', 'challenge', 'grant', 'proof']);
  if (Object.keys(value).some((key) => !keys.has(key))) return false;
  if (typeof value.challenge !== 'string' || !/^[a-f0-9]{64}$/.test(value.challenge)) return false;
  if (!value.grant || typeof value.grant !== 'object' || Array.isArray(value.grant)) return false;
  if (!value.proof || typeof value.proof !== 'object' || Array.isArray(value.proof)) return false;
  return value.grant.kind === 'launch-grant' && value.proof.kind === 'identity-proof'
    && typeof value.audience === 'string' && value.audience.length > 0
    && typeof value.daemonBootId === 'string' && value.daemonBootId.length > 0
    && typeof value.connectionId === 'string' && value.connectionId.length > 0;
}

function validLease(value) {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  // 2b: la capability statica e' revocata e non esiste piu' nel payload.
  // Il proof supervisore NON transita qui: arriva sul canale lease dal server.
  if (Object.keys(value).some((k) => !['cellId', 'launchEpoch', 'stablePath'].includes(k))) return false;
  return (value.cellId === undefined || (typeof value.cellId === 'string' && value.cellId.length > 0 && value.cellId.length <= 128))
    && typeof value.launchEpoch === 'string' && value.launchEpoch.length > 0 && value.launchEpoch.length <= 128
    && typeof value.stablePath === 'string' && value.stablePath.length > 0 && value.stablePath.length <= 4096;
}

function validPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (Object.keys(payload).some((key) => !['command', 'args', 'env', 'supervise', 'restartPrompt', 'lease', 'identity', 'identityChannel'].includes(key))) return false;
  if (typeof payload.command !== 'string' || !payload.command || !Array.isArray(payload.args)) return false;
  if (!payload.env || typeof payload.env !== 'object' || Array.isArray(payload.env)) return false;
  // Il launcher decide se il canale identita' esiste (managed.js) e lo dichiara
  // nel payload con `identityChannel`: il supervisore non lo ricalcola. La chiave
  // va quindi ammessa qui, e SOLO come booleano: un valore di altro tipo e' un
  // payload malformato, non un "canale assente" (assente = caller precedente).
  if (payload.identityChannel !== undefined && typeof payload.identityChannel !== 'boolean') return false;
  return payload.args.every((v) => typeof v === 'string')
    && Object.entries(payload.env).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) && typeof v === 'string')
    && validSupervise(payload.supervise)
    && validRestartPrompt(payload.restartPrompt)
    && validLease(payload.lease)
    && validIdentity(payload.identity);
}

function receivePayload(socketPath, nonce, timeoutMs = 5000, opts = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let data = Buffer.alloc(0); let expected = null; let done = false;
    const finish = (error, payload) => {
      if (done) return; done = true;
      if (error) { socket.destroy(); reject(error); return; }
      // Opt-in keepOpen: the caller receives the OPEN socket (lease broker)
      // and passes it to the lease-client. Default: destroy (one-shot).
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

function identityErrorResponse(id, code, message) {
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32000, message, data: { code } },
  };
}

const IDENTITY_METHODS = new Set([
  'nexuscrew/identity/challengeProof',
  'nexuscrew/identity/verify',
]);

function validIdentityRequest(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false;
  const keys = Object.keys(msg);
  if (keys.length !== 4 || !['jsonrpc', 'id', 'method', 'params'].every((key) => Object.hasOwn(msg, key))) return false;
  if (msg.jsonrpc !== '2.0' || !IDENTITY_METHODS.has(msg.method)) return false;
  if (!Number.isSafeInteger(msg.id) || msg.id < 0) return false;
  return true;
}

//  schema chiuso del metodo verify (v1). Il proof viene VERIFICATO
// Online dall'authority: il daemon non valuta nulla da solo.
function validVerifyRequest(msg, channelGeneration) {
  if (msg.method !== 'nexuscrew/identity/verify') return false;
  const params = msg.params;
  if (!params || typeof params !== 'object' || Array.isArray(params)) return false;
  // Verify v1.1: la tupla attesa {nonce, connectionId, daemonBootId, audience}
  // e' opzionale (retro-compat v1) ma, se presente, ha schema chiuso.
  if (Object.keys(params).length !== 3 && Object.keys(params).length !== 4) return false;
  if (!Object.hasOwn(params, 'v') || !Object.hasOwn(params, 'generation')
    || !Object.hasOwn(params, 'proof')) return false;
  if (Object.hasOwn(params, 'expected') && !validVerifyExpected(params.expected)) return false;
  if (params.v !== 1) return false;
  if (!Number.isSafeInteger(params.generation) || params.generation !== channelGeneration) return false;
  if (!params.proof || typeof params.proof !== 'object' || Array.isArray(params.proof)) return false;
  return true;
}

function createIdentityChannel({
  request,
  response,
  generation,
  relay,
  relayVerify,
  cancel = () => {},
  setTimeout: setTimer = (...args) => setTimeout(...args),
  clearTimeout: clearTimer = (timer) => { if (timer) clearTimeout(timer); },
} = {}) {
  if (!request || typeof request.on !== 'function'
    || !response || typeof response.write !== 'function') return null;
  let closed = false;
  let nextRequestId = 1;
  let pending = null;
  let buffer = '';

  const writeResponse = (obj, force = false) => {
    if ((!force && closed) || !response.writable) return false;
    try { response.write(`${JSON.stringify(obj)}\n`); return true; } catch (_) { return false; }
  };

  const sendError = (id, code, message, force = false) => (
    writeResponse(identityErrorResponse(id, code, message), force)
  );

  const finishPending = () => {
    if (!pending) return 0;
    const { rpcId } = pending;
    clearTimer(pending.timer);
    try { cancel(pending.requestId); } catch (_) {}
    pending = null;
    return rpcId;
  };

  const close = (code = null, message = '', rpcId = 0, sendEofError = true) => {
    if (closed) return;
    closed = true;
    const finishedId = finishPending() || 0;
    if (code && sendEofError) sendError(rpcId || finishedId, code, message, true);
    try { request.removeAllListeners('data'); request.destroy(); } catch (_) {}
    try { response.end(); } catch (_) {}
  };

  const settle = (outcome) => {
    const current = pending;
    if (closed || !current || current.done) return;
    current.done = true;
    clearTimer(current.timer);
    pending = null;
    try { cancel(current.requestId); } catch (_) {}
    if (outcome && outcome.ok === true && outcome.proof && typeof outcome.proof === 'object') {
      writeResponse({ jsonrpc: '2.0', id: current.rpcId, result: { proof: outcome.proof } });
      return;
    }
    const reason = outcome && typeof outcome.reason === 'string' ? outcome.reason : 'identity-unverified';
    const code = identityErrorCode(reason);
    sendError(current.rpcId, code, reason);
    // Bis: il canale e' terminato su timeout OLTRE che su revoke — dopo la
    // risposta di errore fd4 va in EOF (la TUI vede il canale chiuso).
    if (code === 'REVOKED' || reason === 'timeout') close(code, reason, current.rpcId, false);
  };

  const handleLine = (line) => {
    if (closed) return;
    if (pending) {
      let id = 0;
      try {
        const msg = JSON.parse(line);
        id = validIdentityRequest(msg) ? msg.id : 0;
      } catch (_) { id = 0; }
      sendError(id, 'IDENTITY_UNVERIFIED', 'busy');
      return;
    }
    let msg = null;
    try { msg = JSON.parse(line); } catch (_) {
      sendError(0, 'IDENTITY_UNVERIFIED', 'invalid request');
      return;
    }
    if (!validIdentityRequest(msg)
      || !msg.params || typeof msg.params !== 'object' || Array.isArray(msg.params)) {
      sendError(validIdentityRequest(msg) ? msg.id : 0, 'IDENTITY_UNVERIFIED', 'invalid request');
      return;
    }
    if (msg.method === 'nexuscrew/identity/verify') {
      if (typeof relayVerify !== 'function') {
        sendError(msg.id, 'IDENTITY_UNVERIFIED', 'verify-unsupported');
        return;
      }
      if (!validVerifyRequest(msg, generation)) {
        sendError(msg.id, 'IDENTITY_UNVERIFIED', 'invalid request');
        return;
      }
      const verifyRequestId = `g${generation}-v${nextRequestId}`;
      nextRequestId += 1;
      pending = {
        requestId: verifyRequestId, rpcId: msg.id, generation, done: false,
        timer: null, verify: true,
      };
      pending.timer = setTimer(() => settleVerify({ ok: false, reason: 'timeout' }), IDENTITY_TIMEOUT_MS);
      if (pending.timer && typeof pending.timer.unref === 'function') pending.timer.unref();
      Promise.resolve(relayVerify(verifyRequestId, msg.params.proof, msg.params.expected)).then(settleVerify, (error) => {
        settleVerify({ ok: false, reason: error && error.code ? error.code : 'authority-unavailable' });
      });
      return;
    }
    if (Object.keys(msg.params).length !== 1 || !Object.hasOwn(msg.params, 'challenge')
      || !validDaemonChallenge(msg.params.challenge)) {
      sendError(msg.id, 'IDENTITY_UNVERIFIED', 'invalid request');
      return;
    }
    const requestId = `g${generation}-r${nextRequestId}`;
    nextRequestId += 1;
    pending = {
      requestId, rpcId: msg.id, generation, done: false, timer: null,
    };
    pending.timer = setTimer(() => settle({ ok: false, reason: 'timeout' }), IDENTITY_TIMEOUT_MS);
    if (pending.timer && typeof pending.timer.unref === 'function') pending.timer.unref();
    Promise.resolve(relay(requestId, msg.params.challenge)).then(settle, (error) => {
      settle({ ok: false, reason: error && error.code ? error.code : 'authority-unavailable' });
    });
  };

  //  esito del verify come RISULTATO JSON-RPC (ok:false e' una risposta
  // valida, non un errore di trasporto). Solo un 'revoked' chiude il canale:
  // il lease/generazione non c'e' piu', il daemon deve ribindare da zero.
  const settleVerify = (outcome) => {
    if (closed) return;
    const current = pending;
    if (!current || current.done) return;
    current.done = true;
    clearTimer(current.timer);
    pending = null;
    const ok = outcome && outcome.ok === true;
    const payload = ok
      ? { ok: true, v: 1, claims: outcome.claims }
      : { ok: false, v: 1, reason: outcome && typeof outcome.reason === 'string' ? outcome.reason : 'identity-unverified' };
    try {
      response.write(`${JSON.stringify({ jsonrpc: '2.0', id: current.rpcId, result: payload })}\n`);
    } catch (_) {}
    if (!ok && payload.reason === 'revoked') close('REVOKED', 'revoked', current.rpcId, false);
  };

  request.on('data', (chunk) => {
    if (closed) return;
    buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (Buffer.byteLength(buffer, 'utf8') > IDENTITY_FRAME_LIMIT) {
      close();
      return;
    }
    let nl;
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim()) handleLine(line);
      if (closed || Buffer.byteLength(buffer, 'utf8') > IDENTITY_FRAME_LIMIT) {
        if (buffer) close();
        break;
      }
    }
  });
  request.once('end', () => close());
  request.once('error', () => close());
  response.once('error', () => close());

  return {
    close,
    isClosed: () => closed,
    pendingCount: () => (pending ? 1 : 0),
  };
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

// Delivery del bootstrap prompt per generazione (0.8.47, /).
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
// CANCELLAZIONE: cancel ferma il timer E il polling in volo tramite
// isCancelled valutato dentro deliverBootstrapPrompt (ogni poll, pre-paste,
// pre-Enter); il chiamante fa cancel() + await settled prima dello spawn
// della generazione successiva: zero paste/Enter da un task della generazione
// precedente.
//
// REPORT: esito pubblicato con set-option -p @nc_delivery '<state>[:notReady]'
// (solo enum chiusi; l'opzione muore col pane, nessuno state file). Best
// effort: un set-option fallito lascia up() in report-timeout (onesto), la
// consegna resta fatta.
// CANCELLAZIONE (+): cancel ferma il timer E il polling in volo tramite
// isCancelled valutato dentro deliverBootstrapPrompt (ogni poll, pre-paste,
// pre-Enter, post-Enter); il chiamante fa cancel() + await settled prima dello
// spawn della generazione successiva. cancel() con timer ANCORA PENDENTE
// (child uscito prima di readyMs, caso early-exit) risolve settled SUBITO:
// Mai deadlock. settled risolve con l'esito della delivery: null se
// nessun paste incerto, {state} se la generazione e' terminata con un
// post-paste incerto (delivery-unknown / staged-not-submitted) — il main loop
// NON auto-restarta in quel caso (leftover bytes potenzialmente residui nel PTY del
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
            // La generazione e' finita. Propago SOLO gli esiti post-paste
            // incerti (residuo PTY possibile); cancelled pre-paste e' pulito.
            return uncertain ? { state } : null;
          }
          if (state) {
            const kind = state === 'skipped-not-ready' && result.notReady ? `:${result.notReady}` : '';
            await markDelivery(`${state}${kind}`);
          }
          // L'esito post-paste incerto va conservato ANCHE se il child
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
    // Timer ancora pendente -> settle IMMEDIATO (idempotente): il main
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
  // Il canale identita' nasce SOLO se il launcher lo ha deciso: la stessa
  // risoluzione che decide CODEX_APP_SERVER_IDENTITY_REQUIRED in managed.js
  // viaggia nel payload come `identityChannel`. Derivarlo qui (aggiungere
  // sempre fd 3:4) permetteva ai due di divergere: una cella standalone
  // riceveva il canale, avviava l'handshake contro un lease server legacy che
  // rispondeva 'revoked', e moriva. Un payload senza il campo (caller
  // precedenti) conserva il comportamento di prima.
  const identityChannel = payload.identityChannel !== false;
  const childEnv = { ...payload.env };
  if (identityChannel) childEnv.NEXUSCREW_IDENTITY_FD = '3:4';
  // tmux injects these only after the broker ticket was created. Preserve them
  // for the actual TUI and bind NexusCrew MCP callbacks to the owning session.
  if (process.env.TMUX) childEnv.TMUX = process.env.TMUX;
  if (process.env.TMUX_PANE) childEnv.TMUX_PANE = process.env.TMUX_PANE;

  // No lease bearer ever reaches the child. childEnv derives ONLY from
  // payload.env (plus TMUX); payload.lease (cellId/launchEpoch/stablePath) stays
  // in the supervisor and feeds the lease-client. spawnImpl passes env + stdio
  // inherit. The proof lives in the lease-client, NEVER in the child env.
  let generation = 0;
  let leaseCtl = null;
  // da revisione interna: current/stopping vivono QUI (prima del lease-client) perche'
  // la callback onLost qui sotto li riferisce dalla closure.
  let current = null; let stopping = false; let identityCtl = null;
  if (payload.lease && leaseSocket && !leaseSocket.destroyed) {
    const { startLeaseClient } = require('./lease-client.js');
    leaseCtl = startLeaseClient(leaseSocket, {
      stablePath: payload.lease.stablePath,
      launchEpoch: payload.lease.launchEpoch,
      // The generation ADVANCES with supervisor restarts (loop below,
      // generation += 1). We pass a getter so the reconnect always presents
      // the current generation, not a fixed 0 (reconciles :301 with :381).
      generation: () => generation,
      onIdentityDown: () => closeIdentityChannel('REVOKED', 'lease unavailable'),
      // da revisione interna: lease persa per tutta la grace senza un
      // reconnect riuscito. Prima il lease-client desisteva in silenzio dopo
      // 60s e il child restava un orfano senza lease per tutta la sua vita.
      // Ora il supervisore viene avvisato: ferma il child (stopping + SIGTERM)
      // e il main loop termina con lui — mai un child vivo oltre la lease.
      //
      // Correzione (seconda riconsegna): un SOLO SIGTERM senza escalation
      // lascia appeso un child che lo ignora (misurato sul percorso reale:
      // {spawned:1, kills:['SIGTERM'], state:'pending'}) — l'orfano non NASCE
      // piu' (caso originale chiuso davvero), ma un figlio gia' vivo che non
      // collabora non muore. LEASE_LOST_KILL_ESCALATION_MS e' il limite
      // ESPLICITO, scritto qui: se il child non e' uscito entro questa
      // finestra dal SIGTERM, si passa a SIGKILL. `target` fissa il processo
      // di QUESTA generazione: se nel frattempo e' gia' uscito (current
      // azzerato a null dal loop principale dopo waitChild), l'escalation e'
      // no-op — mai un kill fantasma su un pid riusato.
      onLost: () => {
        writeError('nexuscrew cell supervisor stopped: lease lost (reconnect grace expired)\n');
        closeIdentityChannel('REVOKED', 'lease lost');
        stopping = true;
        const target = current;
        try { if (target) target.kill('SIGTERM'); } catch (_) {}
        if (target) {
          const escalate = seams.setTimeout || setTimeout;
          const timer = escalate(() => {
            if (current === target) {
              try { target.kill('SIGKILL'); } catch (_) {}
            }
          }, LEASE_LOST_KILL_ESCALATION_MS);
          if (timer && typeof timer.unref === 'function') timer.unref();
        }
      },
    }, seams);
  }

  const closeIdentityChannel = (code = null, message = '') => {
    if (!identityCtl) return;
    const ctl = identityCtl;
    identityCtl = null;
    ctl.close(code, message);
  };

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
      current = spawnImpl(payload.command, payload.args, {
        env: childEnv,
        // Senza canale non si creano nemmeno le pipe: fd 3 e 4 chiusi nel
        // child (non pipe aperte e inutilizzate).
        stdio: identityChannel
          ? ['inherit', 'inherit', 'inherit', 'pipe', 'pipe']
          : ['inherit', 'inherit', 'inherit'],
      });
      // exit/error del figlio contano SUBITO, prima di qualunque await — se
      // il figlio esce durante l'handshake di generazione, l'evento non deve
      // andare perso (prima i listener arrivavano solo con waitChild, e il
      // supervisore restava appeso).
      let childSettled = false;
      const childExit = new Promise((resolve) => {
        current.once('exit', (code, signal) => {
          childSettled = true;
          resolve({ code: code == null ? 1 : code, signal, error: null });
        });
        current.once('error', (error) => {
          childSettled = true;
          resolve({ code: 1, signal: null, error });
        });
      });
      // Transizione di generazione comunicata al lease PRIMA di aprire il
      // canale identita' della generazione nuova. L'exit del figlio ha la
      // precedenza sull'annuncio; fail-closed: solo un annuncio RISOLTO con
      // ok === true E generazione corrispondente apre il canale — ok:false
      // (lease-down, identity-unverified), rifiuto, timeout ed exit restano
      // tutti negativi, con sola diagnostica: il figlio parte comunque,
      // senza identita'.
      if (leaseCtl && generation > 0) {
        const raced = await Promise.race([
          // Il valore RISOLTO va ispezionato: .then(() => 'ok', ...) scartava
          // il valore e trattava un annuncio risolto {ok:false} come successo,
          // aprendo il canale.
          leaseCtl.announceGeneration(generation).then(
            (announced) => (announced && announced.ok === true && announced.generation === generation
              ? 'ok'
              : `announce-refused:${(announced && announced.reason) || 'generation-mismatch'}`),
            () => 'announce-failed',
          ),
          childExit.then(() => 'exited'),
        ]);
        if (!identityChannel) {
          // Nessun canale da aprire: la transizione di generazione resta
          // annunciata al lease (bookkeeping), ma l'identita' non esiste e
          // non c'e' nessun fd da chiudere. L'uscita del figlio resta
          // diagnostica.
          if (raced === 'exited') {
            writeError(`nexuscrew cell: figlio uscito durante l'handshake di generazione (gen ${generation})\n`);
          }
        } else if (raced === 'ok' && !childSettled) {
          identityCtl = createIdentityChannel({
            request: current && current.stdio && current.stdio[3],
            response: current && current.stdio && current.stdio[4],
            generation,
            relay: leaseCtl
              ? (requestId, challenge) => leaseCtl.challengeProof({ requestId, generation, challenge })
              : async () => ({ ok: false, reason: 'lease-down' }),
            relayVerify: leaseCtl
              ? (requestId, proof, expected) => leaseCtl.verifyProof({ requestId, generation, proof, expected })
              : async () => ({ ok: false, reason: 'lease-down' }),
            cancel: leaseCtl
              ? (requestId) => leaseCtl.cancelIdentityChallenge(requestId)
              : () => {},
            setTimeout: seams.setTimeout,
            clearTimeout: seams.clearTimeout,
          });
        } else if (raced === 'exited') {
          writeError(`nexuscrew cell: figlio uscito durante l'handshake di generazione (gen ${generation})\n`);
        } else {
          writeError(`nexuscrew cell: generazione ${generation} senza identita' (${raced})\n`);
        }
      } else if (identityChannel) {
        identityCtl = createIdentityChannel({
          request: current && current.stdio && current.stdio[3],
          response: current && current.stdio && current.stdio[4],
          generation,
          relay: leaseCtl
            ? (requestId, challenge) => leaseCtl.challengeProof({ requestId, generation, challenge })
            : async () => ({ ok: false, reason: 'lease-down' }),
          relayVerify: leaseCtl
            ? (requestId, proof, expected) => leaseCtl.verifyProof({ requestId, generation, proof, expected })
            : async () => ({ ok: false, reason: 'lease-down' }),
          cancel: leaseCtl
            ? (requestId) => leaseCtl.cancelIdentityChallenge(requestId)
            : () => {},
          setTimeout: seams.setTimeout,
          clearTimeout: seams.clearTimeout,
        });
      }
      const result = await childExit;
      childState.exited = true;
      closeIdentityChannel();
      current = null;
      // : la generazione e' finita. Cancella la delivery in volo e ATTESA
      // Del suo termine PRIMA di qualunque nuovo spawn.: se l'esito e' un
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
  DEFAULT_SUPERVISE, LEASE_LOST_KILL_ESCALATION_MS, parseArgs, validSupervise, validRestartPrompt, validPayload, validLease,
  receivePayload, sanitizeSpawnError, normalizeSupervise, waitChild, startGenerationPrompt,
  createIdentityChannel, validIdentityRequest, validVerifyRequest, main,
};
