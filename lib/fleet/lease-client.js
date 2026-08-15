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

  function send(obj) {
    if (!current || current.destroyed || !current.writable) return false;
    try { current.write(`${JSON.stringify(obj)}\n`); return true; } catch (_) { return false; }
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
      // F-B (audit 2a @ 142e272): la grace e' scaduta senza un reconnect
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

  return {
    stop() {
      stopped = true;
      clearTimer(refreshTimer);
      clearTimer(reconnectTimer);
      try { current && current.destroy(); } catch (_) {}
      current = null;
    },
    _isConnected: () => !!current && !current.destroyed,
    _heldProof: () => heldProof,
  };
}

module.exports = { startLeaseClient };
