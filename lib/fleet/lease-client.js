'use strict';

// Lease-client lato SUPERVISORE (cell-exec.js).
//
// Mantiene la connessione lease iniziale (la stessa del broker one-shot che resta
// APERTA dopo il payload, R3.1.1), invia refresh a cadenza 20s (R3.2 heartbeat),
// e su EOF reconnecta all'endpoint stabile (R3.3.2).
//
// Fetta 2b (contratto rev1, A2/B1): l'autenticazione del reconnect e' un proof
// HMAC firmato dal server col verifier per-installazione — la capability statica
// della 2a e' revocata. Il proof NON arriva nel payload: il server lo consegna
// sul canale (frame lease all'attach, ack a ogni refresh) e il supervisore lo
// detiene in memoria, presentandolo tale e quale al reconnect. R3.1.2 invariato:
// niente di tutto questo transita mai nell'env del child.
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
  const issuedAt = Number(value.issuedAt);
  const expiresAt = Number(value.expiresAt);
  return value.version === 1
    && nonEmptyString(value.audience) && nonEmptyString(value.daemonBootId)
    && nonEmptyString(value.connectionId) && /^[a-f0-9]{64}$/.test(value.nonce)
    && Number.isSafeInteger(issuedAt) && Number.isSafeInteger(expiresAt)
    && issuedAt >= 0 && expiresAt > issuedAt;
}

function identityErrorCode(reason) {
  switch (reason) {
    case 'expired': return 'EXPIRED';
    case 'replay': case 'challenge-replay': return 'REPLAY';
    case 'audience': case 'daemonBootId': case 'connectionId': return 'AUDIENCE_MISMATCH';
    case 'lease-down': case 'revoked': case 'generation': return 'REVOKED';
    case 'timeout': case 'authority-unavailable': case 'authority': return 'AUTHORITY_UNAVAILABLE';
    default: return 'IDENTITY_UNVERIFIED';
  }
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
  // SOLO in memoria qui: e' effimero per costruzione (B8), non si persiste.
  let heldProof = null;
  // R3.2: bound di grace per i reconnect (eofAt + GRACE_MS). Oltre non si ritenta.
  let reconnectDeadline = null;
  const identityPending = new Map();

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
    // R3.2: la grace parte dall'EOF lato supervisore. I reconnect sono bounded da
    // eofAt + GRACE_MS: rev13 S3.3 garantisce >=2 tentativi STRETTAMENTE dentro.
    reconnectDeadline = now() + L.GRACE_MS;
    armReconnect(0); // primo tentativo subito, poi a cadenza RECONNECT_CADENCE_MS
  }

  let lostNotified = false;

  function armReconnect(delay) {
    clearTimer(reconnectTimer);
    // R3.2: oltre la grace non si ritenta (deny o server muto non vanno in loop).
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
    // R3.3.4: generation puo' essere un getter (cell-exec la fa avanzare coi restart)
    // o un valore; al reconnect presentiamo sempre quella corrente.
    const curGeneration = typeof info.generation === 'function' ? info.generation() : (info.generation || 0);
    const sock = netImpl.createConnection(info.stablePath, () => {
      // 2b: presentiamo il proof detenuto. Senza proof (nessun ack ricevuto, o
      // persistenza fallita lato server) il messaggio parte comunque senza: il
      // server nega — e il tentativo resta bounded dalla grace, come in 2a.
      const msg = { type: 'reconnect', generation: curGeneration, ...(heldProof ? { proof: heldProof } : {}) };
      try { sock.write(`${JSON.stringify(msg)}\n`); } catch (_) { try { sock.destroy(); } catch (e) {} }
    });
    // R3.2: per-attempt timeout. Se il server accetta la connessione ma non risponde
    // (socket appesa) forziamo la chiusura e ritentiamo: senza questo il client
    // restava con 1 solo tentativo e 0 timer successivi. Cadence come upper bound.
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
        // R3.3.4: reconnect riuscito, lease nuovo. Il proof consegnato col lease
        // nuovo diventa quello detenuto; riprende il refresh loop.
        clearTimer(reconnectTimer);
        if (msg.proof && typeof msg.proof === 'object') heldProof = msg.proof;
        current = sock;
        bindLive(sock);
        armRefresh();
      } else if (msg.type === 'deny') {
        settled = true;
        clearTimer(attemptTimer);
        // R3.3.5: rifiutato (proof rifiutato, oltre grace o identity). Riprova a
        // cadenza: rev13 S3.3 garantisce >=2 tentativi strettamente dentro la grace.
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

  return {
    stop() {
      stopped = true;
      rejectIdentity('lease-down');
      clearTimer(refreshTimer);
      clearTimer(reconnectTimer);
      try { current && current.destroy(); } catch (_) {}
      current = null;
    },
    challengeProof,
    cancelIdentityChallenge: cancelIdentity,
    _isConnected: () => !!current && !current.destroyed,
    _heldProof: () => heldProof,
    _identityPendingCount: () => identityPending.size,
  };
}

module.exports = {
  startLeaseClient, validDaemonChallenge, identityErrorCode,
  IDENTITY_FRAME_LIMIT, IDENTITY_TIMEOUT_MS,
};
