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
  scriviStato, scriviGenerazione, AVVIO, USCITA,
  scriviRecordTerminale,
} = require('../files/activity.js');
const {
  validDaemonChallenge, validVerifyExpected, identityErrorCode,
  IDENTITY_FRAME_LIMIT, IDENTITY_TIMEOUT_MS,
} = require('./lease-client.js');
const { creaCoordinatore, osservaProduzione } = require('./group-stop.js');

const DEFAULT_SUPERVISE = Object.freeze({
  enabled: true,
  initialReadyMs: 500,
  restartDelayMs: 1000,
  maxRestartDelayMs: 60000,
  resetAfterMs: 30000,
  rapidWindowMs: 60000,
  maxRapidRestarts: 8,
  // Tetto CUMULATIVO di restart per burst (budget): oltre la generazione 0 il
  // supervisore puo' impegnare al piu' questi spawn nuovi. Un runtime lungo
  // (>= resetAfterMs) azzera il contatore: il budget e' per burst di
  // generazioni brevi, non un tetto di vita della cella.
  maxTotalRestarts: 12,
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
    'resetAfterMs', 'rapidWindowMs', 'maxRapidRestarts', 'maxTotalRestarts',
  ]);
  if (Object.keys(value).some((key) => !keys.has(key))) return false;
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') return false;
  const checks = [
    ['initialReadyMs', 50, 30000], ['restartDelayMs', 50, 60000],
    ['maxRestartDelayMs', 100, 300000], ['resetAfterMs', 1000, 3600000],
    ['rapidWindowMs', 1000, 3600000], ['maxRapidRestarts', 1, 100],
    ['maxTotalRestarts', 1, 200],
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

// Gate readiness MCP nel payload. I nomi attesi sono quelli del file
// cell-mcp materializzato (qualsiasi stringa safe <=64: la charset stretta
// vale solo sui valori che finiscono nell'opzione pane @nc_mcp_list).
function validMcpReadiness(value) {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => !['cwd', 'expectedServers', 'budgetMs', 'pollMs', 'cacheRoot'].includes(key))) return false;
  return typeof value.cwd === 'string' && value.cwd.length > 0 && value.cwd.length <= 4096
    && !/[\0\r\n]/.test(value.cwd)
    && Array.isArray(value.expectedServers) && value.expectedServers.length > 0
    && value.expectedServers.length <= 64
    && value.expectedServers.every((n) => typeof n === 'string' && n.length >= 1
      && n.length <= 64 && !/[\0\r\n]/.test(n))
    && (value.budgetMs === undefined || validInteger(value.budgetMs, 0, 120000))
    && (value.pollMs === undefined || validInteger(value.pollMs, 50, 5000))
    && (value.cacheRoot === undefined || (typeof value.cacheRoot === 'string'
      && value.cacheRoot.length > 0 && value.cacheRoot.length <= 4096 && !/[\0\r\n]/.test(value.cacheRoot)));
}

function validRestartPrompt(value) {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => !['tmuxBin', 'tmuxSession', 'prompt', 'readyMs', 'client', 'readyWaitMs', 'mcpReadiness', 'submit', 'reprompt'].includes(key))) return false;
  return typeof value.tmuxBin === 'string' && value.tmuxBin.length > 0 && value.tmuxBin.length <= 4096
    && !/[\0\r\n]/.test(value.tmuxBin)
    && typeof value.tmuxSession === 'string' && /^[\w.@%:+-]{1,128}$/.test(value.tmuxSession)
    && promptCharsOk(value.prompt)
    && (value.readyMs === undefined || validInteger(value.readyMs, 0, 30000))
    && (value.client === undefined || value.client === '' || value.client === 'kimi' || value.client === 'claude')
    && (value.readyWaitMs === undefined || validInteger(value.readyWaitMs, 0, 120000))
    // Opt-in F4: solo booleano, e solo per engine custom (client vuoto).
    && (value.submit === undefined || (value.submit === true && (value.client === undefined || value.client === '')))
    // Policy di reinvio (restartReprompt della definizione): booleano, e solo
    // per engine custom (client vuoto), mai insieme a `submit` (due policy
    // di consegna non si sommano: una vincerebbe in silenzio). Vale per le
    // generazioni > 0; `false` sposta anche la gen0 al supervisore. Ogni
    // altro tipo rifiuta il payload.
    && (value.reprompt === undefined
      || (typeof value.reprompt === 'boolean' && (value.client === undefined || value.client === '')
        && value.submit === undefined))
    && (value.mcpReadiness === undefined || validMcpReadiness(value.mcpReadiness));
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

// Canale di attivita' della cella: dove il supervisore deve dichiarare l'uscita
// del client, e con quale generazione. Presente SOLO quando il launcher ha
// davvero iniettato gli hook (managed.js pubblica la generazione prima di
// costruire gli argv): senza canale non c'e' niente da invalidare, e un payload
// senza il campo conserva il comportamento di prima.
function validActivity(value) {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => !['dir', 'generation'].includes(key))) return false;
  return typeof value.dir === 'string' && value.dir.length > 0 && value.dir.length <= 4096
    && !/[\0\r\n]/.test(value.dir)
    && typeof value.generation === 'string' && value.generation.length > 0 && value.generation.length <= 128
    && !/[\0\r\n]/.test(value.generation);
}

// Ticket del canale di controllo (S3c): {launchId, token} dal payload di
// lancio. Forma chiusa: launchId hex16, token stringa non vuota limitata.
// Resta nel SUPERVISORE (come payload.lease): non entra mai nel child env.
function validControlTicket(value) {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => !['launchId', 'token'].includes(key))) return false;
  return typeof value.launchId === 'string' && /^[a-f0-9]{16}$/.test(value.launchId)
    && typeof value.token === 'string' && value.token.length > 0 && value.token.length <= 256;
}

function validPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (Object.keys(payload).some((key) => !['command', 'args', 'env', 'supervise', 'restartPrompt', 'lease', 'identity', 'identityChannel', 'activity', 'vlNewSession', 'control', 'newSessionTransport'].includes(key))) return false;
  if (typeof payload.command !== 'string' || !payload.command || !Array.isArray(payload.args)) return false;
  if (!payload.env || typeof payload.env !== 'object' || Array.isArray(payload.env)) return false;
  // Il launcher decide se il canale identita' esiste (managed.js) e lo dichiara
  // nel payload con `identityChannel`: il supervisore non lo ricalcola. La chiave
  // va quindi ammessa qui, e SOLO come booleano: un valore di altro tipo e' un
  // payload malformato, non un "canale assente" (assente = caller precedente).
  if (payload.identityChannel !== undefined && typeof payload.identityChannel !== 'boolean') return false;
  // Stessa regola per la sessione nuova vl: la decisione arriva GIÀ PRESA dal
  // launcher (che ha consumato il marcatore prima dello spawn), quindi qui è un
  // booleano o niente — mai un argv da reinterpretare.
  if (payload.vlNewSession !== undefined && typeof payload.vlNewSession !== 'boolean') return false;
  // Modalita di trasporto sessione nuova (D-523 / ND04): ammesso solo 'launcher-env'
  // se presente, nessun altro valore.
  if (payload.newSessionTransport !== undefined && payload.newSessionTransport !== 'launcher-env') return false;
  return payload.args.every((v) => typeof v === 'string')
    && payload.env.NEXUSCREW_VL_NEW === undefined
    && Object.entries(payload.env).every(([k, v]) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) && typeof v === 'string')
    && validSupervise(payload.supervise)
    && validRestartPrompt(payload.restartPrompt)
    && validLease(payload.lease)
    && validActivity(payload.activity)
    && validIdentity(payload.identity)
    && validControlTicket(payload.control);
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
// Gate readiness MCP per le claude.* (config.mcpReadiness dal payload).
// La deadline e' COMPOSTA sullo stesso orologio del launch (notBeforeMs =
// avvio della GENERAZIONE corrente, mai handshake di una generazione
// precedente; budgetMs dal tetto approvato) e la cancellazione ferma il polling
// prima del respawn (isCancelled valutato ad ogni poll dalla deliver).
function buildMcpWait(config, seams) {
  const mr = config && config.mcpReadiness;
  if (!mr || !Array.isArray(mr.expectedServers) || mr.expectedServers.length === 0) return null;
  const now = seams.nowImpl || Date.now;
  const startedAt = now();
  const budget = Math.max(0, Number(mr.budgetMs) || 20000);
  const waitImpl = seams.waitMcpReadiness || require('./mcp-cache-readiness.js').waitMcpReadiness;
  return async ({ isCancelled }) => waitImpl({
    params: { cacheRoot: mr.cacheRoot, cwd: mr.cwd, expectedServers: mr.expectedServers, notBeforeMs: startedAt },
    deadlineMs: startedAt + budget,
    pollMs: mr.pollMs || 500,
    sleepImpl: seams.sleepImpl,
    nowImpl: seams.nowImpl,
    isCancelled,
  });
}

const MCP_DELIVERY_STATES = ['ready', 'degraded'];
const MCP_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

function startGenerationPrompt(config, generation, childState, seams = {}) {
  if (!config) return null;
  const classified = config.client === 'kimi' || config.client === 'claude';
  // La consegna opt-in (`submit: true`) ha UN SOLO proprietario, questo
  // supervisore, per TUTTE le generazioni, la 0 compresa — la stessa
  // disciplina del bootstrap classificato: cancel() + await settled PRIMA del
  // respawn, quindi nessuna delivery di una generazione vecchia puo' toccare
  // il PTY riusato. Il runtime non digita mai per questi engine: legge
  // l'esito bounded da @nc_delivery. Due proprietari sullo stesso %N erano
  // il difetto: il %N sopravvive al restart, quindi riverificarlo non
  // distingue la generazione.
  // La policy `reprompt: false` (definizione `restartReprompt: false`) porta
  // la consegna della generazione 0 AL SUPERVISORE con lo stesso contratto
  // at-most-once: alle generazioni > 0 non si incolla NULLA (il prompt non si
  // reinvia), quindi il proprietario resta UNO per ogni generazione.
  const delivered = classified || config.submit === true || config.reprompt === false;
  if (!delivered && generation === 0) return null;  // legacy senza opt-in: gen0 resta al runtime
  const mcpWait = buildMcpWait(config, seams);
  const setTimer = seams.setTimeout || setTimeout;
  const clearTimer = seams.clearTimeout || clearTimeout;
  const runTmux = seams.tmuxExec || ((bin, args, opts = {}) => new Promise((resolve) => {
    require('node:child_process').execFile(bin, args, { env: opts.env, timeout: opts.timeoutMs || 10000 },
      (err, stdout, stderr) => resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || ''), code: err ? (typeof err.code === 'number' ? err.code : 1) : 0 }));
  }));
  const paneTarget = process.env.TMUX_PANE || `=${config.tmuxSession}`;
  const markDelivery = async (value) => {
    if (!delivered) return;
    try { await runTmux(config.tmuxBin, ['set-option', '-p', '-t', paneTarget, '@nc_delivery', value], {}); }
    catch (_) { /* best-effort: il report timeout di up() resta onesto */ }
  };
  // Elenco bounded dei server non pronti su @nc_mcp_list (solo nomi
  // validati e cap 16 per classe; muore col pane come @nc_delivery).
  const markMcpList = async (mcp) => {
    if (!classified || !mcp) return;
    const valida = (arr) => (Array.isArray(arr) ? arr : [])
      .filter((n) => typeof n === 'string' && MCP_NAME_RE.test(n)).slice(0, 16).sort();
    const f = valida(mcp.failed);
    const p = valida(mcp.pending);
    if (!f.length && !p.length) return;
    const value = `${f.length ? `failed=${f.join(',')}` : ''}${f.length && p.length ? '|' : ''}${p.length ? `pending=${p.join(',')}` : ''}`;
    try { await runTmux(config.tmuxBin, ['set-option', '-p', '-t', paneTarget, '@nc_mcp_list', value], {}); }
    catch (_) { /* best-effort come @nc_delivery */ }
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
            ...(mcpWait ? { mcpWait } : {}),
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
            const mcpState = result && result.mcp && MCP_DELIVERY_STATES.includes(result.mcp.state)
              ? `:mcp${result.mcp.state}` : '';
            await markDelivery(`${state}${kind}${mcpState}`);
            if (mcpState) await markMcpList(result.mcp);
          }
          // L'esito post-paste incerto va conservato ANCHE se il child
          // era vivo al ritorno di deliver: i byte possono restare nel PTY del
          // pane e sommarsi al bootstrap della generazione successiva. Al
          // prossimo child exit il main ferma il supervisor (no auto-restart).
          return uncertain ? { state } : null;
        }
        if (config.submit === true) {
          // Opt-in F4 (engine custom send-keys): stesso contratto del gen0 —
          // paste delimitato + UN Enter, at-most-once. `bracketedPaste` e' il
          // valore deciso dalla definizione (v. prompt-delivery.js: tmux non
          // espone lo stato di bracketed paste, quindi l'opt-in e' l'attestazione
          // e senza di esso non si digita nulla).
          const submitFn = seams.submitPromptWithEnter
            || require('./prompt-delivery.js').submitPromptWithEnter;
          // L'opt-in non prova il framing: l'attestatore (oggi sempre
          // negativo) decide se il percorso paste+Enter e' ammesso; senza
          // attestazione l'esito e' transport-unsupported e non si digita.
          const attest = (seams.attestBracketedPaste
            || require('./pane-attestation.js').attestBracketedPaste)({
            source: 'supervisor', session: config.tmuxSession, paneTarget, generation,
          });
          // Il report di questo ramo non era mai scritto: il runtime, che
          // aspetta proprio questa opzione di pane, arrivava alla propria
          // deadline e ripiegava su report-timeout invece di leggere il
          // rifiuto. Si azzera prima e si pubblica dopo, come nel percorso
          // classificato.
          await markDelivery('');
          const res = await submitFn({
            tmuxBin: config.tmuxBin,
            session: config.tmuxSession,
            prompt: config.prompt,
            paneTarget: paneTarget,
            readyWaitMs: config.readyWaitMs,
            bracketedPaste: attest.attested === true,
            isCancelled,
          });
          const state = res && typeof res.state === 'string' ? res.state : '';
          const uncertain = state === 'delivery-unknown' || state === 'staged-not-submitted';
          // Un esito di una generazione invalidata non deve diventare l'esito
          // della successiva: il pane vive oltre il restart, quindi dopo una
          // cancellazione NON si pubblica. L'incertezza interna, che blocca
          // l'autorestart, si conserva comunque.
          if (isCancelled()) return uncertain ? { state } : null;
          // Solo valori dell'enum chiuso finiscono nell'opzione di pane.
          const bounded = (require('./prompt-delivery.js').DELIVERY_STATES || []).includes(state)
            ? state : '';
          if (bounded) await markDelivery(bounded);
          // Come per il percorso classificato: dopo un paste incerto i byte
          // possono restare nel PTY del pane e sommarsi al bootstrap della
          // generazione successiva -> si propaga lo stato, mai un retry qui.
          return uncertain ? { state } : null;
        }
        if (config.reprompt === false) {
          // Policy `restartReprompt: false`: la generazione 0 ha UN SOLO
          // proprietario, questo supervisore, con una consegna paste SENZA
          // Enter — nessun Enter aggiunto dalla sola policy: la sottomissione
          // resta una decisione separata (attestata o del guardiano esterno).
          // Alle generazioni > 0 non si incolla nulla: il prompt non si reinvia.
          if (generation > 0) return null;
          // Consegna cancellabile e stage-aware, costruita DIRETTAMENTE su
          // securePaste (che valuta isCancelled dentro ogni stadio e pulisce
          // temp file + buffer tmux nel finally): il ramo injectPrompt legacy
          // comprimerebbe gli esiti perdendo la distinzione pre/post-paste.
          const pasteFn = seams.securePaste || require('./launch.js').securePaste;
          await markDelivery('');
          let res;
          try {
            res = await pasteFn(config.tmuxBin, config.tmuxSession, config.prompt, {
              target: paneTarget, isCancelled,
            });
          } catch (_) {
            // Un trasporto che BUTTA non permette di provare che il paste NON
            // sia partito: l'esito onesto e' l'incertezza, mai un null
            // innocuo e mai un successo di invio.
            const uncertain = { state: 'delivery-unknown' };
            if (!isCancelled()) await markDelivery('delivery-unknown');
            return uncertain;
          }
          const stage = res && typeof res.stage === 'string' ? res.stage : '';
          // Esito di una generazione invalidata: NON si pubblica (il pane
          // sopravvive al restart), ma l'incertezza interna si conserva per
          // OGNI esito post-paste. Il trasporto reale torna {ok:true,
          // stage:'pasted'} dopo un paste RIUSCITO, e quei byte sono gia'
          // nel PTY del pane che la generazione successiva riuserebbe:
          // come lo stadio 'paste' (tentato e fallito) e' incertezza, non
          // un null innocuo che lascerebbe ripartire il respawn.
          if (isCancelled()) {
            return stage === 'paste' || stage === 'pasted'
              ? { state: 'delivery-unknown' } : null;
          }
          if (res && res.ok === true) {
            // paste-only: NC NON attesta l'Enter (lo preme, se lo preme, il
            // guardiano esterno del launcher — limite dichiarato: il cancel
            // del task NC non ferma il guardiano).
            await markDelivery('paste-delivered');
            // L'intervallo protetto arriva fino al settled, non si chiude
            // all'ultimo controllo prima del report: la generazione puo'
            // essere invalidata MENTRE il report viene pubblicato, e un
            // paste completato su un pane che sta per essere riusato resta
            // un post-paste incerto. Nessuna pubblicazione ulteriore.
            if (isCancelled()) return { state: 'delivery-unknown' };
            return null;
          }
          if (stage === 'paste') {
            // Post-paste: il paste e' stato TENTATO, i byte possono essere
            // residui nel PTY del pane riusato -> fermata bounded, nessun retry.
            await markDelivery('delivery-unknown');
            return { state: 'delivery-unknown' };
          }
          // Pre-paste (validate/resolve/load): nulla e' stato digitato, la
          // generazione prosegue senza prompt, esito visibile al runtime. Il
          // valore di ritorno resta null: non c'e' incertezza da recintare.
          const boundedStage = ['validate', 'resolve', 'load'].includes(stage) ? stage : '';
          if (boundedStage) await markDelivery(`paste-failed:${boundedStage}`);
          return null;
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
  // DUE OROLOGI, usi separati. `now` (civile) serve ai TIMESTAMP dei record su
  // file (attività, record terminale): i loro lettori usano Date.now. `monoNow`
  // (monotono) serve a DURATE e DEADLINE: durata della generazione, finestra
  // rapid, backoff e budget. Un salto dell'orologio civile (NTP, correzione
  // manuale) non puo' gonfiare una generazione, azzerare un budget o allungare
  // una pausa — e nessun hrtime finisce nei file.
  const now = seams.now || Date.now;
  const monoNow = seams.monoNow
    || (() => Number(process.hrtime.bigint() / 1000000n));
  const sleep = seams.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const proc = seams.process || process;
  const writeError = seams.writeError || seams.stderrWrite || ((message) => process.stderr.write(message));
  const activity = payload.activity || null;
  // Uscita del client: il supervisore DICHIARA che il processo che pubblicava lo
  // stato non c'e' piu'. Serve perche' il riavvio avviene DENTRO lo stesso
  // lancio (loop sotto): `activity.gen` non cambia, quindi la generazione non
  // puo' accorgersi che il client precedente e' morto. Senza questa riga uno
  // `Stop` dell'ultimo turno resterebbe «ferma» per tutto il backoff — e per
  // sempre, ora che «ferma» non scade — mentre il client e' morto e il prossimo
  // non e' pronto. Il lettore mappa l'evento a null: «non verificato».
  const dichiaraUscita = () => {
    if (!activity) return;
    if (scriviStato(activity.dir, { evento: USCITA, generazione: activity.generation, ora: now() }) !== true) {
      writeError('nexuscrew cell: uscita del client non registrata nello stato di attivita\n');
    }
  };
  // Ragione terminale del supervisore, PUBBLICATA SU FILE per il lancio: il
  // record `terminal-<lancio>.json` sopravvive alla scomparsa del pane ed e'
  // cioe' che status e UI leggono quando la sessione non c'e' piu'. Una sola
  // pubblicazione per lancio: la ragione e' la CAUSA dell'uscita, non l'ultimo
  // evento — per questo il flag prevale sul richiamo ripetuto. Scrittura
  // CONTROLLATA: se il record non finisce su disco lo si dichiara
  // («diagnosi non disponibile»), mai uno stop «registrato» che non lo e'.
  // Senza canale attivita' (caller senza payload.activity) resta solo stderr:
  // la fermata c'e' sempre, la visibilita' persistente richiede il canale.
  let terminalePubblicato = false;
  const pubblicaTerminale = (reason) => {
    if (terminalePubblicato) return;
    terminalePubblicato = true;
    if (!activity) return;
    if (scriviRecordTerminale(activity.dir, {
      launchId: activity.generation, reason, ora: now(),
    }) !== true) {
      writeError('nexuscrew cell: terminal reason not published (diagnosis unavailable)\n');
    }
  };
  // Il canale identita' nasce SOLO se il launcher lo ha deciso: la stessa
  // risoluzione che decide CODEX_APP_SERVER_IDENTITY_REQUIRED in managed.js
  // viaggia nel payload come `identityChannel`. Derivarlo qui (aggiungere
  // sempre fd 3:4) permetteva ai due di divergere: una cella standalone
  // riceveva il canale, avviava l'handshake contro un lease server legacy che
  // rispondeva 'revoked', e moriva. Un payload senza il campo (caller
  // precedenti) conserva il comportamento di prima.
  const identityChannel = payload.identityChannel !== false;
  const childEnv = { ...payload.env };
  delete childEnv.NEXUSCREW_VL_NEW;
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
  let promptCorrente = null;
  let figlioUscito = false;
  let coordinatore = null;
  let ignoraTerm = null;
  const closeIdentityChannel = (code = null, message = '') => {
    if (!identityCtl) return;
    const ctl = identityCtl;
    identityCtl = null;
    ctl.close(code, message);
  };
  // Gli handler legacy vanno registrati PRIMA che il canale possa consegnare
  // uno stop: la fase di stop li disarma e non deve trovarli gia' in coda.
  const handlers = new Map();
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    const handler = () => {
      stopping = true;
      try { if (current) current.kill(signal); } catch (_) {}
    };
    handlers.set(signal, handler);
    proc.once?.(signal, handler);
  }
  const disarmaLegacy = () => {
    for (const [signal, handler] of handlers) proc.off?.(signal, handler);
    handlers.clear();
  };
  const installaIgnoraTerm = () => {
    if (ignoraTerm) return;
    // Handler, non maschera: i figli non ereditano un SIGTERM bloccato.
    ignoraTerm = () => {};
    proc.on?.('SIGTERM', ignoraTerm);
  };
  const cleanup = () => {
    disarmaLegacy();
    if (ignoraTerm) {
      proc.off?.('SIGTERM', ignoraTerm);
      ignoraTerm = null;
    }
  };
  const boxLease = { api: null };
  if (payload.control && payload.control.token && payload.lease && leaseSocket && !leaseSocket.destroyed) {
    coordinatore = creaCoordinatore({
      token: payload.control.token,
      launchId: payload.control.launchId,
      monoNow,
      sleep,
      killGruppo: seams.killGruppo,
      osserva: seams.osserva || (() => osservaProduzione(
        current && current.pid && !figlioUscito ? [{ pid: current.pid, exited: false }] : [],
      )),
      invia: (frame) => (boxLease.api ? boxLease.api.sendControl(frame) : false),
      svuota: () => (boxLease.api && boxLease.api.svuota ? boxLease.api.svuota() : Promise.resolve(true)),
      cancellaDelivery: async () => {
        const pending = promptCorrente;
        if (!pending) return null;
        try { pending.cancel(); } catch (_) {}
        try { return await pending.settled; } catch (_) { return null; }
      },
      scriviLog: (riga) => { try { writeError(`${riga}\n`); } catch (_) {} },
      dichiaraStopping: () => { stopping = true; },
      disarmaLegacy,
      installaIgnoraTerm,
    });
  }
  if (payload.lease && leaseSocket && !leaseSocket.destroyed) {
    const { startLeaseClient } = require('./lease-client.js');
    leaseCtl = startLeaseClient(leaseSocket, {
      stablePath: payload.lease.stablePath,
      launchEpoch: payload.lease.launchEpoch,
      // The generation ADVANCES with supervisor restarts (loop below,
      // generation += 1). We pass a getter so the reconnect always presents
      // the current generation, not a fixed 0 (reconciles :301 with :381).
      generation: () => generation,
      onPronto: (api) => { boxLease.api = api; },
      onControlFrame: (frame) => { if (coordinatore) coordinatore.onFrame(frame); },
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
      // La fase di stop del gruppo possiede i segnali: onLost non si sovrappone.
      onLost: () => {
        if (stopAttivo()) return;
        pubblicaTerminale('lease-lost');
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

  const stopAttivo = () => !!(coordinatore && (typeof coordinatore.stopAttivo === 'function' ? coordinatore.stopAttivo() : coordinatore.attiva()));
  const esciPerStop = async () => {
    const esito = await (typeof coordinatore.attendiStop === 'function' ? coordinatore.attendiStop().then(() => coordinatore.attiva()) : coordinatore.attiva());
    dichiaraUscita();
    pubblicaTerminale('operator-stop');
    return esito && Number.isInteger(esito.code) ? esito.code : 1;
  };

  // LA GENERAZIONE SI SCRIVE QUI, E SOLO QUI.
  //
  // Questo processo gira DENTRO la sessione tmux appena creata: chi perde la
  // corsa sulla new-session non arriva mai a un cell-exec e quindi non scrive
  // niente. Scriverla prima (nella risoluzione) significava scriverla anche per
  // il perdente: sul disco restava la generazione di chi non aveva lanciato
  // nulla, mentre gli hook del vincitore portavano la loro — e ogni suo evento
  // veniva scartato al lettore, cioe' «non verificato» su una cella che
  // lavorava.
  //
  // Prima del primo spawn, non dentro il ciclo: la generazione identifica il
  // LANCIO, e i riavvii interni del client (il ciclo sotto) restano lo stesso
  // lancio. Il client parte DOPO questa scrittura: mai un hook che scrive una
  // generazione che non e' ancora su disco.
  if (activity) {
    // (1) INVALIDA lo stato lasciato dal client precedente, PRIMA di pubblicare
    // la generazione. Un evento di lancio porta la generazione nuova e il
    // lettore lo mappa a null: senza, un «ferma» dell'ultimo turno del client
    // precedente sopravviverebbe al lancio — e con «ferma» che non scade
    // resterebbe vero finche' un hook non lo rinnova, cioe' per sempre su una
    // cella appena partita. Scrivo prima della generazione di proposito:
    // l'invalidazione non deve dipendere dalla pubblicazione riuscita.
    if (scriviStato(activity.dir, {
      evento: AVVIO, generazione: activity.generation, ora: now(),
    }) !== true) {
      // LIMITE DICHIARATO (accettato come tale, non un percorso normale): se la
      // directory e' diventata non scrivibile fra due lanci, QUI non si scrive
      // niente e lo stato che la UI mostra puo' essere QUELLO DEL LANCIO
      // PRECEDENTE — un «ferma» dell'ultimo turno di un client che non c'e'
      // piu'. Il lettore non puo' accorgersene: la generazione su disco e'
      // ancora la vecchia, e gli eventi nuovi non arrivano finche' un hook non
      // scrive. E' un guasto del filesystem durante la vita della cella (la
      // directory e' stata resa non scrivibile), non un esito che il codice
      // possa riparare da qui: si dichiara nel log, con la conseguenza.
      writeError("nexuscrew cell: stato di attivita' precedente non invalidato (directory non scrivibile); "
        + "lo stato mostrato puo' essere quello del lancio precedente\n");
    }
    // (2) PUBBLICA la generazione, e con essa il segno che questo supervisore
    // garantisce l'evento di uscita: e' quel segno a permettere la non scadenza
    // di «ferma»/«interrotta» nel lettore.
    if (scriviGenerazione(activity.dir, activity.generation, { uscitaGarantita: true }) !== true) {
      // Scrittura fallita: si avvia lo stesso, e lo si dichiara. Il client
      // scrivera' eventi con una generazione che non e' quella su disco, quindi
      // verranno scartati e la cella risultera' «non verificato» — l'esito
      // sicuro, mai «ferma» senza fondamento.
      writeError("nexuscrew cell: generazione di attivita' non pubblicata, stato non verificabile\n");
    }
    // (3) Il SELETTORE del lancio corrente (`launch-current`) NON e' qui: lo
    // pubblica il PROPRIETARIO del ciclo di vita (il runtime, dentro il lock
    // per cella) prima di avviare questo processo. Questo supervisore scrive
    // solo il PROPRIO record terminale: un supervisore vecchio che si sveglia
    // tardi, in qualunque momento, al piu' riscrive il proprio record vecchio
    // — non ha in mano la selezione di un lancio nuovo e non puo' spostarla.
    // Nemmeno la retention dei record passa da qui: e' del ciclo, non del
    // supervisore.
  }

  let delayMs = supervise.restartDelayMs;
  let rapid = [];
  // Budget cumulativo del burst: spawn OLTRE la generazione 0 che questo
  // supervisore ha gia' impegnato. Si incrementa solo quando il nuovo spawn e'
  // certo (dopo il backoff, oltre il check `stopping`), non quando si prepara
  // uno sleep che un segnale puo' ancora cancellare. Una generazione lunga
  // (>= resetAfterMs) lo azzera insieme a rapid/delayMs.
  let totalRestarts = 0;
  try {
    for (;;) {
      if (stopAttivo()) return await esciPerStop();
      if (stopping) { pubblicaTerminale('operator-stop'); return 0; }
      // Durata della generazione: orologio MONOTONO, partenza qui.
      const startedAt = monoNow();
      const childState = { exited: false };
      figlioUscito = false;
      const promptCtl = startGenerationPrompt(payload.restartPrompt, generation, childState, seams);
      promptCorrente = promptCtl;
      // Sessione nuova vl (D-523 / ND04):
      // - Per gli adattatori (payload.newSessionTransport === 'launcher-env'):
      //   l'adattatore riceve SOLO l'ambiente NEXUSCREW_VL_NEW=1 e MAI --new in argv.
      // - Per managed-vl (o client senza launcher-env):
      //   continua con argv `--new`.
      // Entrambi SOLO alla generazione 0 e SOLO se la decisione viaggia con vlNewSession === true.
      // Env nuovo per ogni generazione: childEnv baseline e' immutabile, gen1 non puo' ereditare la chiave.
      const isLauncherEnv = payload.newSessionTransport === 'launcher-env';
      const useVlNew = generation === 0 && payload.vlNewSession === true;
      const generationArgs = useVlNew && !isLauncherEnv
        ? [...payload.args, '--new']
        : payload.args;
      const generationEnv = { ...childEnv };
      if (useVlNew && isLauncherEnv) {
        generationEnv.NEXUSCREW_VL_NEW = '1';
      }
      current = spawnImpl(payload.command, generationArgs, {
        env: generationEnv,
        // Senza canale non si creano nemmeno le pipe: fd 3 e 4 chiusi nel
        // child (non pipe aperte e inutilizzate).
        stdio: identityChannel
          ? ['inherit', 'inherit', 'inherit', 'pipe', 'pipe']
          : ['inherit', 'inherit', 'inherit'],
      });
      // exit/error del figlio contano SUBITO, prima di qualunque await — se
      // il figlio esce durante l'handshake di generazione, l'evento non deve
      // andare perso (prima i listener arrivavano solo con waitChild, e il
      // supervisore restava appeso). L'istante di uscita si cattura QUI, nel
      // listener, sull'orologio monotono: cleanup, attese della delivery
      // dopo l'exit e backoff NON fanno parte della vita del figlio e non
      // devono gonfiarne la durata.
      let childSettled = false;
      const childExit = new Promise((resolve) => {
        current.once('exit', (code, signal) => {
          childSettled = true;
          figlioUscito = true;
          resolve({ code: code == null ? 1 : code, signal, error: null, exitedAt: monoNow() });
        });
        current.once('error', (error) => {
          childSettled = true;
          figlioUscito = true;
          resolve({ code: 1, signal: null, error, exitedAt: monoNow() });
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
        const gareAnnuncio = [
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
        ];
        if (coordinatore) gareAnnuncio.push(coordinatore.attendiStop().then(() => 'stop'));
        const raced = await Promise.race(gareAnnuncio);
        if (raced === 'stop' || stopAttivo()) return await esciPerStop();
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
      const result = coordinatore
        ? await Promise.race([childExit, coordinatore.attendiStop().then(() => null)])
        : await childExit;
      if (stopAttivo()) return await esciPerStop();
      childState.exited = true;
      closeIdentityChannel();
      current = null;
      // Il client non c'e' piu': QUALUNQUE sia la causa (uscita normale, segnale,
      // errore di spawn, stop dell'operatore) lo stato pubblicato non e' piu'
      // verificabile. Prima di ogni return del supervisore, cosi' nessuna delle
      // uscite resta con lo stato del client morto.
      dichiaraUscita();
      // : la generazione e' finita. Cancella la delivery in volo e ATTESA
      // Del suo termine PRIMA di qualunque nuovo spawn.: se l'esito e' un
      // post-paste incerto (delivery-unknown / staged-not-submitted) i byte del
      // prompt possono essere residui nel PTY del pane riusato: NIENTE auto-
      // restart — fermo bounded del supervisor, restart esplicito operatore.
      if (promptCtl) {
        promptCtl.cancel();
        const promptOutcome = await promptCtl.settled;
        if (stopAttivo()) return await esciPerStop();
        if (promptOutcome && (promptOutcome.state === 'delivery-unknown'
          || promptOutcome.state === 'staged-not-submitted')) {
          pubblicaTerminale('uncertain-delivery');
          writeError('nexuscrew cell supervisor stopped: uncertain prompt delivery (operator restart required)\n');
          return result.signal ? 128 : (result.code || 1);
        }
      }
      if (stopAttivo()) return await esciPerStop();
      if (coordinatore && typeof coordinatore.preparazione === 'function' && coordinatore.preparazione()) {
        await coordinatore.attendiStop();
        return await esciPerStop();
      }
      if (result.error) {
        pubblicaTerminale('spawn-error');
        writeError(`${sanitizeSpawnError(result.error, payload.command)}\n`);
        return 1;
      }
      // Durata reale della generazione: uscita catturata nel listener (mono),
      // non letta adesso — una delivery lenta dopo l'exit non trasforma una
      // figlia morta in pochi ms in una generazione «lunga» che azzera il
      // budget e la finestra rapid.
      const runtimeMs = Math.max(0, result.exitedAt - startedAt);
      if (stopAttivo()) return await esciPerStop();
      if (stopping) { pubblicaTerminale('operator-stop'); return 0; }
      if (!supervise.enabled) return result.signal ? 128 : result.code;

      // Preserve the launch readiness contract: a first child that dies before
      // the gate is a failed start, not a successfully supervised cell.
      if (generation === 0 && runtimeMs < supervise.initialReadyMs) {
        return result.signal ? 128 : (result.code || 1);
      }

      const stamp = monoNow();
      if (runtimeMs >= supervise.resetAfterMs) {
        // Generazione lunga: il burst e' finito. Il reset e' COMPLETO — anche
        // il budget cumulativo riparte da zero, non solo la finestra rapida e
        // il backoff: un burst lungo puo' di nuovo impegnare i suoi spawn.
        rapid = [];
        totalRestarts = 0;
        delayMs = supervise.restartDelayMs;
      } else {
        rapid = rapid.filter((value) => stamp - value <= supervise.rapidWindowMs);
        rapid.push(stamp);
        if (rapid.length > supervise.maxRapidRestarts) {
          writeError('nexuscrew cell supervisor stopped after repeated early exits\n');
          return result.signal ? 128 : (result.code || 1);
        }
      }
      // Tetto cumulativo del burst: controllato ALLA DECISIONE di restart,
      // prima di dormire un backoff che non servira' a niente. Fermata
      // terminale, visibile e persistente (record per lancio), stessa forma
      // dello stop rapido.
      if (totalRestarts >= supervise.maxTotalRestarts) {
        pubblicaTerminale('restart-budget-exhausted');
        writeError('nexuscrew cell supervisor stopped: total restart budget exhausted\n');
        return result.signal ? 128 : (result.code || 1);
      }
      if (coordinatore) await Promise.race([sleep(delayMs), coordinatore.attendiSveglia()]);
      else await sleep(delayMs);
      // A down/kill-session can reach the supervisor while it is waiting in
      // backoff. Never start another client after that stop signal.
      // La fase di stop non usa questo return: possiede lei l'uscita.
      if (stopAttivo()) return await esciPerStop();
      if (coordinatore && typeof coordinatore.preparazione === 'function' && coordinatore.preparazione()) {
        await coordinatore.attendiStop();
        return await esciPerStop();
      }
      if (stopping) { pubblicaTerminale('operator-stop'); return 0; }
      // Punto di IMPEGNO del budget: oltre il check stopping il nuovo spawn e'
      // certo. Solo qui lo si paga — mai prima, quando uno sleep cancellabile
      // non ha ancora impegnato nulla.
      totalRestarts += 1;
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
