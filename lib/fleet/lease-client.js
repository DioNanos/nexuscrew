'use strict';

// Lease-client lato SUPERVISORE (cell-exec.js).
//
// Keeps the initial lease connection (the same one-shot broker connection that
// stays OPEN after the payload), sends refreshes every 20s (heartbeat),
// and on EOF reconnects to the stable endpoint.
//
// Fetta 2b (contratto rev1, /): l'autenticazione del reconnect e' un proof
// HMAC firmato dal server col verifier per-installazione — la capability statica
// della 2a e' revocata. Il proof NON arriva nel payload: il server lo consegna
// sul canale (frame lease all'attach, ack a ogni refresh) e il supervisore lo
// held in memory, presented as-is on reconnect. Unchanged:
// none of this ever transits in the child env.
//
// Side effect isolati e iniettabili (seams) per testabilita', come altrove.

const net = require('node:net');
const L = require('./cell-lease.js');

const IDENTITY_FRAME_LIMIT = 8 * 1024;
const IDENTITY_TIMEOUT_MS = 4000;
const IDENTITY_CHALLENGE_KEYS = Object.freeze([
  'version', 'audience', 'daemonBootId', 'connectionId', 'nonce', 'issuedAt', 'expiresAt',
]);

function nonEmptyString(value, max = 256) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

function validDaemonChallenge(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== IDENTITY_CHALLENGE_KEYS.length
    || IDENTITY_CHALLENGE_KEYS.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) return false;
  // Tipi JSON originari, niente coercizioni (Number/regex su non-stringhe).
  const issuedAt = value.issuedAt;
  const expiresAt = value.expiresAt;
  return value.version === 1
    && nonEmptyString(value.audience) && nonEmptyString(value.daemonBootId)
    && nonEmptyString(value.connectionId)
    && typeof value.nonce === 'string' && /^[a-f0-9]{64}$/.test(value.nonce)
    && Number.isSafeInteger(issuedAt) && Number.isSafeInteger(expiresAt)
    && issuedAt >= 0 && expiresAt > issuedAt;
}

function identityErrorCode(reason) {
  switch (reason) {
    case 'expired': return 'EXPIRED';
    case 'replay': case 'challenge-replay': return 'REPLAY';
    // Verify v1.1: la tupla della connessione non corrisponde -> stesso codice
    // del mismatch challenge-side lato daemon (prepare: AudienceMismatch).
    case 'challenge_mismatch':
    case 'audience': case 'daemonBootId': case 'connectionId': return 'AUDIENCE_MISMATCH';
    case 'lease-down': case 'revoked': case 'generation': return 'REVOKED';
    case 'timeout': case 'authority-unavailable': case 'authority': return 'AUTHORITY_UNAVAILABLE';
    default: return 'IDENTITY_UNVERIFIED';
  }
}

// Forma chiusa della tupla attesa (v1.1), condivisa da lease client e server:
// nonce hex64, gli altri tre stringhe non vuote limitate; nessun campo extra.
function validVerifyExpected(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 4) return false;
  for (const key of ['nonce', 'connectionId', 'daemonBootId', 'audience']) {
    if (!Object.hasOwn(value, key)) return false;
  }
  if (typeof value.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(value.nonce)) return false;
  return ['connectionId', 'daemonBootId', 'audience'].every((key) => (
    typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 200
  ));
}

function validIdentityRequestId(value) {
  return (typeof value === 'string' && value.length > 0 && value.length <= 128)
    || Number.isSafeInteger(value);
}

function startLeaseClient(initialSocket, info, seams = {}) {
  if (!initialSocket || !info || !info.stablePath || !info.launchEpoch) return null;
  const setTimer = seams.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = seams.clearTimeout || ((t) => { if (t) clearTimeout(t); });
  const netImpl = seams.net || net;
  const now = seams.now || Date.now;

  let stopped = false;
  let current = initialSocket;
  let refreshTimer = null;
  let reconnectTimer = null;
  // 2b: ultimo proof consegnato dal server sul canale (attach/refresh). Vive
  // SOLO in memoria qui: e' effimero per costruzione, non si persiste.
  let heldProof = null;
  // Grace bound for reconnects (eofAt + GRACE_MS). Past it, no more attempts.
  let reconnectDeadline = null;
  const identityPending = new Map();
  const verifyPending = new Map();
  // Una sola transizione di generazione in volo (il supervisore e' sequenziale).
  let generationWaiter = null;

  function send(obj) {
    if (!current || current.destroyed || !current.writable) return false;
    try { current.write(`${JSON.stringify(obj)}\n`); return true; } catch (_) { return false; }
  }

  function rejectIdentity(reason) {
    for (const pending of identityPending.values()) {
      clearTimer(pending.timer);
      pending.reject(Object.assign(new Error(reason), { code: reason }));
    }
    identityPending.clear();
  }

  function identityDown() {
    rejectIdentity('lease-down');
    if (generationWaiter) {
      const waiter = generationWaiter;
      generationWaiter = null;
      clearTimer(waiter.timer);
      waiter.reject(Object.assign(new Error('lease-down'), { code: 'lease-down' }));
    }
    if (typeof info.onIdentityDown === 'function') {
      try { info.onIdentityDown(); } catch (_) {}
    }
  }

  function cancelIdentity(requestId) {
    const pending = identityPending.get(requestId);
    if (!pending) return false;
    identityPending.delete(requestId);
    clearTimer(pending.timer);
    pending.reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
    return true;
  }

  function armRefresh() {
    clearTimer(refreshTimer);
    refreshTimer = setTimer(() => {
      if (stopped) return;
      send({ type: 'refresh' });
      armRefresh();
    }, L.REFRESH_MS);
    if (refreshTimer && typeof refreshTimer.unref === 'function') refreshTimer.unref();
  }

  function onEOF() {
    if (stopped) return;
    identityDown();
    if (current) { try { current.removeAllListeners('data'); current.removeAllListeners('close'); current.removeAllListeners('end'); } catch (_) {} }
    current = null;
    clearTimer(refreshTimer);
    // The grace starts from the supervisor-side EOF. Reconnects are bounded by
    // eofAt + GRACE_MS: at least 2 attempts happen STRICTLY inside it.
    reconnectDeadline = now() + L.GRACE_MS;
    armReconnect(0); // primo tentativo subito, poi a cadenza RECONNECT_CADENCE_MS
  }

  let lostNotified = false;

  function armReconnect(delay) {
    clearTimer(reconnectTimer);
    // Past the grace no more attempts (deny or mute server must not loop).
    if (reconnectDeadline != null && now() >= reconnectDeadline) {
      // da revisione interna: la grace e' scaduta senza un reconnect
      // riuscito: la lease e' PERSA per questo supervisore. Prima si desisteva
      // in silenzio e il child restava un orfano senza lease per tutta la sua
      // vita, senza che nessuno lo sapesse. Ora il supervisore viene avvisato
      // (info.onLost, una volta sola): cell-exec ferma il child e muore con lui.
      if (!lostNotified) {
        lostNotified = true;
        if (typeof info.onLost === 'function') { try { info.onLost(); } catch (_) {} }
      }
      return;
    }
    reconnectTimer = setTimer(() => {
      if (stopped) return;
      attemptReconnect();
    }, delay);
    if (reconnectTimer && typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
  }

  function attemptReconnect() {
    let settled = false;
    // The generation may be a getter (cell-exec advances it with restarts)
    // or a value; on reconnect we always present the current one.
    const curGeneration = typeof info.generation === 'function' ? info.generation() : (info.generation || 0);
    const sock = netImpl.createConnection(info.stablePath, () => {
      // 2b: presentiamo il proof detenuto. Senza proof (nessun ack ricevuto, o
      // persistenza fallita lato server) il messaggio parte comunque senza: il
      // server nega — e il tentativo resta bounded dalla grace, come in 2a.
      const msg = { type: 'reconnect', generation: curGeneration, ...(heldProof ? { proof: heldProof } : {}) };
      try { sock.write(`${JSON.stringify(msg)}\n`); } catch (_) { try { sock.destroy(); } catch (e) {} }
    });
    // Per-attempt timeout. If the server accepts the connection but does not
    // answer (hanging socket) we force-close and retry: without this the client
    // stayed with 1 attempt and 0 following timers. Cadence as the upper bound.
    const attemptTimer = setTimer(() => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (_) {}
      armReconnect(0);
    }, L.RECONNECT_CADENCE_MS);
    if (attemptTimer && typeof attemptTimer.unref === 'function') attemptTimer.unref();
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let msg; try { msg = JSON.parse(line); } catch (_) { return; }
      if (settled) return;
      if (msg.type === 'lease') {
        settled = true;
        clearTimer(attemptTimer);
        // Successful reconnect, new lease. The proof delivered with the new
        // lease becomes the held one; the refresh loop resumes.
        clearTimer(reconnectTimer);
        if (msg.proof && typeof msg.proof === 'object') heldProof = msg.proof;
        current = sock;
        bindLive(sock);
        armRefresh();
      } else if (msg.type === 'deny') {
        settled = true;
        clearTimer(attemptTimer);
        // Refused (bad proof, past grace, or identity mismatch). Retry at
        // cadence: at least 2 attempts happen strictly inside the grace window.
        try { sock.destroy(); } catch (_) {}
        armReconnect(L.RECONNECT_CADENCE_MS);
      }
    });
    sock.once('close', () => {
      if (settled) return;
      settled = true;
      clearTimer(attemptTimer);
      armReconnect(L.RECONNECT_CADENCE_MS);
    });
    sock.once('error', () => { try { sock.destroy(); } catch (_) {} });
  }

  // 2b: il canale live legge cio' che il server consegna — ack col proof a ogni
  // refresh, frame lease (col proof) all'attach. Senza lettura il proof non
  // arriverebbe mai al detentore.
  function bindLive(sock) {
    sock.removeAllListeners('close');
    sock.removeAllListeners('end');
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
        if (msg.type === 'verifyResult' && validIdentityRequestId(msg.requestId)) {
          const pending = verifyPending.get(msg.requestId);
          if (pending) {
            verifyPending.delete(msg.requestId);
            clearTimer(pending.timer);
            if (msg.ok === true && msg.claims && typeof msg.claims === 'object') {
              pending.resolve({ ok: true, claims: msg.claims });
            } else {
              const reason = msg.ok === false && typeof msg.reason === 'string' ? msg.reason : 'identity-unverified';
              pending.resolve({ ok: false, reason });
            }
          }
        }
        if (msg.type === 'challengeProofResult' && validIdentityRequestId(msg.requestId)) {
          const pending = identityPending.get(msg.requestId);
          if (pending) {
            identityPending.delete(msg.requestId);
            clearTimer(pending.timer);
            if (msg.ok === true && msg.proof && typeof msg.proof === 'object') {
              pending.resolve({ ok: true, proof: msg.proof });
            } else {
              const reason = msg.ok === false && typeof msg.reason === 'string' ? msg.reason : 'identity-unverified';
              pending.reject(Object.assign(new Error(reason), { code: reason }));
            }
          }
        }
        if (msg.type === 'generationAck' && generationWaiter && msg.generation === generationWaiter.generation) {
          const waiter = generationWaiter;
          generationWaiter = null;
          clearTimer(waiter.timer);
          waiter.resolve({ ok: true, generation: msg.generation });
        }
        if (msg.type === 'generationDeny' && generationWaiter) {
          const waiter = generationWaiter;
          generationWaiter = null;
          clearTimer(waiter.timer);
          waiter.reject(Object.assign(new Error('revoked'), { code: 'revoked' }));
        }
        if ((msg.type === 'ack' || msg.type === 'lease') && msg.proof && typeof msg.proof === 'object') {
          heldProof = msg.proof;
        }
      }
    });
    sock.once('close', onEOF);
    sock.once('end', onEOF);
    // Il peer puo' morire senza leggere (RST: ECONNRESET su write/read): un
    // 'error' senza listener e' fatale per il processo supervisore. Assorbilo e
    // lascia che la 'close' che segue armi la grace, stessa forma del server.
    sock.once('error', () => { try { sock.destroy(); } catch (_) {} });
  }

  // Avvio: la connessione iniziale (broker) e' gia' aperta. Arma refresh + EOF.
  bindLive(current);
  armRefresh();
  send({ type: 'refresh' }); // primo refresh immediato

  function challengeProof({ requestId, generation, challenge } = {}) {
    if (!validIdentityRequestId(requestId) || !Number.isSafeInteger(generation) || generation < 0) {
      return Promise.resolve({ ok: false, reason: 'identity-unverified' });
    }
    if (!validDaemonChallenge(challenge)) return Promise.resolve({ ok: false, reason: 'challenge' });
    if (stopped || !current || current.destroyed || !current.writable || identityPending.has(requestId)) {
      return Promise.resolve({ ok: false, reason: 'authority-unavailable' });
    }
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, timer: null };
      pending.timer = setTimer(() => {
        if (!identityPending.has(requestId)) return;
        identityPending.delete(requestId);
        reject(Object.assign(new Error('timeout'), { code: 'timeout' }));
      }, IDENTITY_TIMEOUT_MS);
      if (pending.timer && typeof pending.timer.unref === 'function') pending.timer.unref();
      identityPending.set(requestId, pending);
      const sent = send({ type: 'challengeProof', requestId, generation, challenge });
      if (!sent) {
        identityPending.delete(requestId);
        clearTimer(pending.timer);
        reject(Object.assign(new Error('authority-unavailable'), { code: 'authority-unavailable' }));
      }
    });
  }

  //  verifica ONLINE di un identity proof presso l'authority. Risolve
  // SEMPRE con {ok:true, claims} | {ok:false, reason}: il rifiuto e' una
  // risposta, non un errore di trasporto. Solo timeout/authority giu'
  // viaggiano come rejection (il relay li mappa su ok:false).
  function verifyProof({ requestId, generation, proof, expected } = {}) {
    if (!validIdentityRequestId(requestId) || !Number.isSafeInteger(generation) || generation < 0) {
      return Promise.resolve({ ok: false, reason: 'identity-unverified' });
    }
    if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
      return Promise.resolve({ ok: false, reason: 'malformed' });
    }
    // Verify v1.1: tupla attesa opzionale (retro-compat v1), schema chiuso.
    if (expected !== undefined && !validVerifyExpected(expected)) {
      return Promise.resolve({ ok: false, reason: 'identity-unverified' });
    }
    if (stopped || !current || current.destroyed || !current.writable || verifyPending.has(requestId)) {
      return Promise.resolve({ ok: false, reason: 'authority-unavailable' });
    }
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, timer: null };
      pending.timer = setTimer(() => {
        if (!verifyPending.has(requestId)) return;
        verifyPending.delete(requestId);
        reject(Object.assign(new Error('timeout'), { code: 'timeout' }));
      }, IDENTITY_TIMEOUT_MS);
      if (pending.timer && typeof pending.timer.unref === 'function') pending.timer.unref();
      verifyPending.set(requestId, pending);
      const sent = send({
        type: 'verify', requestId, generation, v: 1, proof,
        ...(expected ? { expected } : {}),
      });
      if (!sent) {
        verifyPending.delete(requestId);
        clearTimer(pending.timer);
        reject(Object.assign(new Error('authority-unavailable'), { code: 'authority-unavailable' }));
      }
    });
  }

  // Annuncia la transizione di generazione sulla connessione viva PRIMA
  // che il supervisore apra il canale identita' della generazione nuova.
  function announceGeneration(generation) {
    if (!Number.isSafeInteger(generation) || generation < 0) {
      return Promise.resolve({ ok: false, reason: 'identity-unverified' });
    }
    if (stopped || !current || current.destroyed || !current.writable) {
      return Promise.resolve({ ok: false, reason: 'lease-down' });
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, timer: null, generation };
      generationWaiter = waiter;
      waiter.timer = setTimer(() => {
        if (generationWaiter !== waiter) return;
        generationWaiter = null;
        reject(Object.assign(new Error('timeout'), { code: 'timeout' }));
      }, IDENTITY_TIMEOUT_MS);
      if (waiter.timer && typeof waiter.timer.unref === 'function') waiter.timer.unref();
      if (!send({ type: 'generation', generation })) {
        if (generationWaiter === waiter) generationWaiter = null;
        clearTimer(waiter.timer);
        reject(Object.assign(new Error('lease-down'), { code: 'lease-down' }));
      }
    });
  }

  return {
    stop() {
      stopped = true;
      rejectIdentity('lease-down');
      if (generationWaiter) {
        const waiter = generationWaiter;
        generationWaiter = null;
        clearTimer(waiter.timer);
        waiter.reject(Object.assign(new Error('lease-down'), { code: 'lease-down' }));
      }
      for (const [, pending] of verifyPending) {
        clearTimer(pending.timer);
        pending.reject(Object.assign(new Error('lease-down'), { code: 'lease-down' }));
      }
      verifyPending.clear();
      clearTimer(refreshTimer);
      clearTimer(reconnectTimer);
      try { current && current.destroy(); } catch (_) {}
      current = null;
    },
    challengeProof,
    verifyProof,
    announceGeneration,
    cancelIdentityChallenge: cancelIdentity,
    _isConnected: () => !!current && !current.destroyed,
    _heldProof: () => heldProof,
    _identityPendingCount: () => identityPending.size,
  };
}

module.exports = {
  startLeaseClient, validDaemonChallenge, validVerifyExpected, identityErrorCode,
  IDENTITY_FRAME_LIMIT, IDENTITY_TIMEOUT_MS,
};
