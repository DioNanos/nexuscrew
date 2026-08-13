'use strict';

// Lease-client lato SUPERVISORE (cell-exec.js).
//
// Mantiene la connessione lease iniziale (la stessa del broker one-shot che resta
// APERTA dopo il payload, R3.1.1), invia refresh a cadenza 20s (R3.2 heartbeat),
// e su EOF reconnecta all'endpoint stabile (R3.3.2) presentando capability
// DISTINCT dal nonce one-shot (R3.3.3). rev13 S3.3: a cadenza 20s garantisce
// almeno due tentativi strettamente dentro la grace 60s. R3.1.2: la capability
// vive SOLO in questo modulo, NON transita mai nell'env del child: il caller
// (cell-exec) spawnImpl continua a passare solo env+stdio inherit.
//
// Side effect isolati e iniettabili (seams) per testabilita', come altrove.

const net = require('node:net');
const L = require('./cell-lease.js');

function startLeaseClient(initialSocket, info, seams = {}) {
  if (!initialSocket || !info || !info.stablePath || !info.launchEpoch || !info.capability) return null;
  const setTimer = seams.setTimeout || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = seams.clearTimeout || ((t) => { if (t) clearTimeout(t); });
  const netImpl = seams.net || net;
  const now = seams.now || Date.now;

  let stopped = false;
  let current = initialSocket;
  let refreshTimer = null;
  let reconnectTimer = null;
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

  function armReconnect(delay) {
    clearTimer(reconnectTimer);
    // R3.2: oltre la grace non si ritenta (deny o server muto non vanno in loop).
    if (reconnectDeadline != null && now() >= reconnectDeadline) return;
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
      try { sock.write(`${JSON.stringify({ type: 'reconnect', launchEpoch: info.launchEpoch, generation: curGeneration, capability: info.capability })}\n`); } catch (_) { try { sock.destroy(); } catch (e) {} }
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
        // R3.3.4: reconnect riuscito, lease nuovo. Riprende il refresh loop.
        clearTimer(reconnectTimer);
        current = sock;
        bindLive(sock);
        armRefresh();
      } else if (msg.type === 'deny') {
        settled = true;
        clearTimer(attemptTimer);
        // R3.3.5: rifiutato (oltre grace o identity). Riprova a cadenza: rev13
        // S3.3 garantisce >=2 tentativi strettamente dentro la grace.
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

  function bindLive(sock) {
    sock.removeAllListeners('close');
    sock.removeAllListeners('end');
    sock.once('close', onEOF);
    sock.once('end', onEOF);
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
  };
}

module.exports = { startLeaseClient };
