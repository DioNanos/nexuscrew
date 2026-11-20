'use strict';

// Lease-client lato SUPERVISORE (cell-exec.js).
//
// Keeps the initial lease connection (the same one-shot broker connection that
// stays OPEN after the payload), sends refreshes every 20s (heartbeat),
// and on EOF reconnects to the stable endpoint.
//
// Fetta 2b: l'autenticazione del reconnect e' un proof
// HMAC firmato dal server col verifier per-installazione — la capability statica
// della 2a e' revocata. Il proof NON arriva nel payload: il server lo consegna
// sul canale (frame lease all'attach, ack a ogni refresh) e il supervisore lo
// held in memory, presented as-is on reconnect. Unchanged:
// none of this ever transits in the child env.
//
// Side effect isolati e iniettabili (seams) per testabilita', come altrove.

const net = require('node:net');
const L = require('./cell-lease.js');
const controlProtocol = require('./control-protocol.js');
const promptSnapshot = require('./prompt-snapshot.js');

const IDENTITY_FRAME_LIMIT = 8 * 1024;
const IDENTITY_TIMEOUT_MS = 4000;
const IDENTITY_CHALLENGE_KEYS = Object.freeze([
  'version', 'audience', 'daemonBootId', 'connectionId', 'nonce', 'issuedAt', 'expiresAt',
]);

// Finestra di recupero dopo EOF (episodio locale): retry ravvicinati entro
// RECONNECT_RETRY_MS da ogni esito negativo di un tentativo, sempre limitati
// dal residuo dell'episodio; timeout della SINGOLA connessione che conserva
// il massimo attuale ma viene tagliato alla deadline; cap difensivo di
// tentativi per episodio oltre al tempo. Le tre costanti separano
// semanticamente intervallo di retry e timeout del tentativo, prima entrambi
// alimentati dalla stessa RECONNECT_CADENCE_MS.
const RECONNECT_RETRY_MS = 1000;
const RECONNECT_ATTEMPT_TIMEOUT_MS = 20_000;
const MAX_RECONNECT_ATTEMPTS = 64;

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
  // Wall clock: resta iniettabile per i seam, ma NON alimenta la finestra di
  // recupero (vedi monoNow). La validita' del proof resta del verifier server.
  const now = seams.now || Date.now;
  // Orologio dell'EPISODIO: la grace e' una deadline locale MONOTONA, fissata
  // una volta a EOF+GRACE_MS. Un salto del wall clock (NTP, sospensioni) non
  // puo' allargare né restringere la finestra di recupero.
  const monoNow = seams.monoNow || (() => performance.now());
  // Seam di test: consente di esercitare il cap per episodio prima della grace.
  const retryDelayMs = seams.retryDelayMs != null ? seams.retryDelayMs : RECONNECT_RETRY_MS;

  let stopped = false;
  let current = initialSocket;
  let refreshTimer = null;
  let reconnectTimer = null;
  // 2b: ultimo proof consegnato dal server sul canale (attach/refresh). Vive
  // SOLO in memoria qui: e' effimero per costruzione, non si persiste.
  let heldProof = null;
  // Stato esplicito dell'episodio, legato all'EOF e al lancio corrente:
  // 'connected' (canale vivo), 'reconnecting' (EOF visto, finestra di
  // recupero attiva), 'terminal' (episodio chiuso: da qui non si riparte).
  // Un EOF su una connessione ristabilita apre un NUOVO episodio; deny,
  // errori, eventi duplicati su socket vecchi o un nuovo processo del server
  // NON riaprono l'episodio in corso.
  let episodeState = 'connected';
  // Deadline monotona dell'episodio, fissata UNA volta a EOF+GRACE_MS.
  let episodeDeadline = null;
  let episodeAttempts = 0;
  // Termine armato a EOF, indipendente dalle risposte del peer: un server
  // muto non puo' spostare la conclusione al timeout dell'ultimo tentativo.
  let terminalTimer = null;
  // L'unico socket di tentativo in volo (mai connessioni sovrapposte).
  let pendingSocket = null;
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
      if (stopped || episodeState !== 'connected') return;
      send({ type: 'refresh' });
      armRefresh();
    }, L.REFRESH_MS);
    if (refreshTimer && typeof refreshTimer.unref === 'function') refreshTimer.unref();
  }

  function onEOF() {
    if (stopped) return;
    // Solo un EOF sul canale CORRENTE apre un episodio: eventi duplicati di
    // socket vecchi (close/end ripetuti) non riaprono la finestra in corso.
    if (episodeState !== 'connected') return;
    identityDown();
    if (current) { try { current.removeAllListeners('data'); current.removeAllListeners('close'); current.removeAllListeners('end'); } catch (_) {} }
    current = null;
    clearTimer(refreshTimer);
    // La grace parte dall'EOF lato supervisore: deadline LOCALE e MONOTONA,
    // fissata una volta per episodio (eofMono + GRACE_MS).
    episodeState = 'reconnecting';
    episodeDeadline = monoNow() + L.GRACE_MS;
    episodeAttempts = 0;
    // Conclusione terminale armata subito, indipendente dal peer: scatta alla
    // deadline dell'episodio, che resta l'unica fonte dei tempi di recupero.
    clearTimer(terminalTimer);
    terminalTimer = setTimer(onEpisodeExpired, episodeDeadline - monoNow());
    if (terminalTimer && typeof terminalTimer.unref === 'function') terminalTimer.unref();
    armReconnect(0); // primo tentativo subito, poi retry ravvicinati
  }

  function onEpisodeExpired() {
    if (stopped || episodeState !== 'reconnecting') return;
    enterTerminal();
  }

  let lostNotified = false;

  // Conclusione dell'episodio: UNA transizione terminale, timer cancellati,
  // socket pendente chiuso, onLost UNA volta sola. La lease e' persa per
  // questo supervisore: prima si desisteva in silenzio e il child restava un
  // orfano senza lease; ora il supervisore viene avvisato (info.onLost) e
  // cell-exec ferma il child e muore con lui. Nessun frame tardivo del vecchio
  // tentativo puo' riattivare nulla dopo questo punto.
  function enterTerminal() {
    if (stopped || episodeState === 'terminal') return;
    episodeState = 'terminal';
    clearTimer(reconnectTimer);
    clearTimer(refreshTimer);
    clearTimer(terminalTimer);
    if (pendingSocket) {
      const sock = pendingSocket;
      pendingSocket = null;
      try { sock.destroy(); } catch (_) {}
    }
    if (!lostNotified) {
      lostNotified = true;
      if (typeof info.onLost === 'function') { try { info.onLost(); } catch (_) {} }
    }
  }

  function armReconnect(delay) {
    clearTimer(reconnectTimer);
    if (stopped || episodeState !== 'reconnecting') return;
    // Cap difensivo per episodio, oltre al tempo.
    if (episodeAttempts >= MAX_RECONNECT_ATTEMPTS) { enterTerminal(); return; }
    // Oltre la deadline monotona dell'episodio non si programma piu' nulla.
    const remaining = episodeDeadline - monoNow();
    if (remaining <= 0) { enterTerminal(); return; }
    const boundedDelay = Math.max(0, Math.min(delay, remaining));
    reconnectTimer = setTimer(() => {
      if (stopped || episodeState !== 'reconnecting') return;
      // Un timer armato dentro la grace ma eseguito a/oltre E NON parte: il
      // ricontrollo della deadline vive qui, nel callback.
      if (monoNow() >= episodeDeadline) { enterTerminal(); return; }
      attemptReconnect();
    }, boundedDelay);
    if (reconnectTimer && typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
  }

  function dropPending(sock) {
    if (pendingSocket === sock) pendingSocket = null;
  }

  function attemptReconnect() {
    if (stopped || episodeState !== 'reconnecting') return;
    if (monoNow() >= episodeDeadline) { enterTerminal(); return; }
    if (episodeAttempts >= MAX_RECONNECT_ATTEMPTS) { enterTerminal(); return; }
    episodeAttempts += 1;
    let settled = false;
    // The generation may be a getter (cell-exec advances it with restarts)
    // or a value; on reconnect we always present the current one.
    const curGeneration = typeof info.generation === 'function' ? info.generation() : (info.generation || 0);
    const sock = netImpl.createConnection(info.stablePath, () => {
      // Ricontrollo stato e deadline QUANDO la connessione si apre, prima di
      // scrivere: un callback ritardato a/oltre E non presenta il proof.
      if (settled || stopped || episodeState !== 'reconnecting') {
        try { sock.destroy(); } catch (_) {}
        return;
      }
      if (monoNow() >= episodeDeadline) {
        try { sock.destroy(); } catch (_) {}
        enterTerminal();
        return;
      }
      // 2b: presentiamo il proof detenuto. Senza proof (nessun ack ricevuto, o
      // persistenza fallita lato server) il messaggio parte comunque senza: il
      // server nega — e il tentativo resta bounded dalla grace, come in 2a.
      const msg = { type: 'reconnect', generation: curGeneration, ...(heldProof ? { proof: heldProof } : {}) };
      try { sock.write(`${JSON.stringify(msg)}\n`); } catch (_) { try { sock.destroy(); } catch (e) {} }
    });
    pendingSocket = sock;
    // Timeout della singola connessione: conserva il massimo attuale ma viene
    // TAGLIATO alla deadline dell'episodio; con un peer muto la finestra non
    // slitta oltre E. Senza questo limite il client restava con 1 tentativo e
    // 0 timer successivi.
    const attemptBudget = Math.max(0, Math.min(RECONNECT_ATTEMPT_TIMEOUT_MS, episodeDeadline - monoNow()));
    const attemptTimer = setTimer(() => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch (_) {}
      dropPending(sock);
      armReconnect(retryDelayMs);
    }, attemptBudget);
    if (attemptTimer && typeof attemptTimer.unref === 'function') attemptTimer.unref();
    let buf = '';
    sock.setEncoding('utf8');
    const onHandshakeData = (chunk) => {
      buf += chunk;
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      let msg; try { msg = JSON.parse(line); } catch (_) { return; }
      if (settled) return;
      if (msg.type === 'lease') {
        // Successo SOLO per un frame della connessione/episodio ATTUALE, entro
        // il proprio termine: un frame tardivo dopo terminal o stop e' ignorato.
        if (stopped || episodeState !== 'reconnecting') {
          sock.removeListener('data', onHandshakeData);
          try { sock.destroy(); } catch (_) {}
          return;
        }
        // Il frame va rifiutato anche se E e' gia' passato e i timer dovuti
        // non sono ancora stati eseguiti: nessun effetto (timer cancellati,
        // proof, socket, heartbeat) prima di questo controllo, e il termine
        // si conclude qui, una volta sola.
        if (monoNow() >= episodeDeadline) {
          sock.removeListener('data', onHandshakeData);
          try { sock.destroy(); } catch (_) {}
          enterTerminal();
          return;
        }
        settled = true;
        clearTimer(attemptTimer);
        clearTimer(reconnectTimer);
        clearTimer(terminalTimer);
        const residuo = buf;
        buf = '';
        sock.removeListener('data', onHandshakeData);
        dropPending(sock);
        // Successful reconnect, new lease. The proof delivered with the new
        // lease becomes the held one; the refresh loop resumes.
        if (msg.proof && typeof msg.proof === 'object') heldProof = msg.proof;
        current = sock;
        episodeState = 'connected';
        episodeDeadline = null;
        episodeAttempts = 0;
        bindLive(sock, residuo);
        armRefresh();
      } else if (msg.type === 'deny') {
        settled = true;
        clearTimer(attemptTimer);
        sock.removeListener('data', onHandshakeData);
        // Refused (bad proof, past grace, or identity mismatch): il retry
        // riparte ravvicinato, sempre dentro il residuo dell'episodio.
        try { sock.destroy(); } catch (_) {}
        dropPending(sock);
        armReconnect(retryDelayMs);
      }
    };
    sock.on('data', onHandshakeData);
    sock.once('close', () => {
      if (settled) return;
      settled = true;
      clearTimer(attemptTimer);
      dropPending(sock);
      armReconnect(retryDelayMs);
    });
    sock.once('error', () => { try { sock.destroy(); } catch (_) {} });
  }

  // 2b: il canale live legge cio' che il server consegna — ack col proof a ogni
  // refresh, frame lease (col proof) all'attach. Senza lettura il proof non
  // arriverebbe mai al detentore.
  // PARSER UNICO anche qui — frame lease ({type}) e frame di
  // controllo ({op}) sullo stesso accumulatore per byte, decodifica solo a
  // riga completa (UTF-8 frammentato ricomposto). I frame di controllo
  // validati nel modulo del protocollo passano all'hook info.onControlFrame;
  // una riga malformata spezza il canale (protocollo chiuso).
  function bindLive(sock, residuo = '') {
    sock.removeAllListeners('close');
    sock.removeAllListeners('end');
    const onLeaseLine = (msg) => {
      if (!msg || typeof msg !== 'object') return;
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
      if (msg.type === 'promptSnapshot') {
        // Consultazione di SOLA LETTURA del daemon: la risposta esce dalla
        // fotografia sincrona del proprietario (info.promptSnapshot), mai dal
        // file del prompt. Richiesta malformata o fotografia non valida:
        // nessuna risposta (il daemon va in timeout e dichiara unknown).
        if (typeof info.promptSnapshot === 'function' && promptSnapshot.validRequest(msg)) {
          let risposta = null;
          try { risposta = promptSnapshot.buildResult(msg.nonce, info.promptSnapshot()); } catch (_) { risposta = null; }
          if (risposta) send(risposta);
        }
        return;
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
    };
    const parser = controlProtocol.creaParserIbrido({
      onFrame: (frame) => {
        if (typeof info.onControlFrame === 'function') {
          try { info.onControlFrame(frame); } catch (_) { /* diagnostica */ }
        }
      },
      onLeaseLine,
      onRotto: () => { try { sock.destroy(); } catch (_) {} },
    });
    sock.on('data', (chunk) => {
      parser.spingiBytes(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
    });
    // Forward any bytes already read after the reconnect handshake frame so
    // coalesced server frames are not stranded in the handshake buffer.
    if (typeof residuo === 'string' && residuo.length > 0) {
      parser.spingiBytes(Buffer.from(residuo, 'utf8'));
    }
    sock.once('close', onEOF);
    sock.once('end', () => { parser.fine(); onEOF(); });
    // Il peer puo' morire senza leggere (RST: ECONNRESET su write/read): un
    // 'error' senza listener e' fatale per il processo supervisore. Assorbilo e
    // lascia che la 'close' che segue armi la grace, stessa forma del server.
    sock.once('error', () => { try { sock.destroy(); } catch (_) {} });
  }

  // Frame di controllo coordinatore -> NC: codifica validata dal modulo del
  // protocollo (mai frame invalidi in scrittura). Il chiamante mette nel
  // payload l'HASH del token, mai il token.
  function sendControl(frame) {
    let line;
    try { line = controlProtocol.codifica(frame); } catch (_) { return false; }
    if (!current || current.destroyed || !current.writable) return false;
    try { current.write(line); return true; } catch (_) { return false; }
  }

  // La write ritorna true quando il kernel ha accettato i byte. svuota attende
  // il drain se la write precedente ha riempito il buffer, cosi' il frame di
  // stop esce prima della chiusura del socket.
  function svuota(timeoutMs = 1000) {
    return new Promise((resolve) => {
      if (!current || current.destroyed) { resolve(false); return; }
      if (!current.writableNeedDrain) { resolve(true); return; }
      let concluso = false;
      let timer = null;
      const fine = (esito) => {
        if (concluso) return;
        concluso = true;
        if (timer) clearTimeout(timer);
        if (current) {
          current.removeListener('drain', suDrain);
          current.removeListener('close', suChiusura);
          current.removeListener('error', suErrore);
        }
        resolve(esito);
      };
      const suDrain = () => fine(true);
      const suChiusura = () => fine(false);
      const suErrore = () => fine(false);
      current.once('drain', suDrain);
      current.once('close', suChiusura);
      current.once('error', suErrore);
      if (timeoutMs > 0) {
        timer = setTimeout(() => fine(false), timeoutMs);
      }
    });
  }

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

  // Prima di bindLive: il chiamante puo' trattenere sendControl prima che un
  // frame gia' in buffer venga consegnato.
  if (typeof info.onPronto === 'function') {
    try { info.onPronto({ sendControl, svuota }); } catch (_) { /* il bind resta */ }
  }
  // Avvio: la connessione iniziale (broker) e' gia' aperta. Arma refresh + EOF.
  bindLive(current);
  armRefresh();
  send({ type: 'refresh' }); // primo refresh immediato

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
      clearTimer(terminalTimer);
      // Un frame su un tentativo in volo non deve riattivare nulla: il socket
      // pendente si chiude qui e lo stato episodio rende definitivo lo stop.
      if (pendingSocket) {
        const sock = pendingSocket;
        pendingSocket = null;
        try { sock.destroy(); } catch (_) {}
      }
      episodeState = 'terminal';
      try { current && current.destroy(); } catch (_) {}
      current = null;
    },
    challengeProof,
    verifyProof,
    announceGeneration,
    sendControl,
    svuota,
    cancelIdentityChallenge: cancelIdentity,
    _isConnected: () => !!current && !current.destroyed,
    _heldProof: () => heldProof,
    _identityPendingCount: () => identityPending.size,
  };
}

module.exports = {
  startLeaseClient, validDaemonChallenge, validVerifyExpected, identityErrorCode,
  IDENTITY_FRAME_LIMIT, IDENTITY_TIMEOUT_MS,
  RECONNECT_RETRY_MS, RECONNECT_ATTEMPT_TIMEOUT_MS, MAX_RECONNECT_ATTEMPTS,
};
