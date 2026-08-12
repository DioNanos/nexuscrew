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

  let stopped = false;
  let current = initialSocket;
  let refreshTimer = null;
  let reconnectTimer = null;

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
    armReconnect(0); // primo tentativo subito, poi a cadenza RECONNECT_CADENCE_MS
  }

  function armReconnect(delay) {
    clearTimer(reconnectTimer);
    reconnectTimer = setTimer(() => {
      if (stopped) return;
      attemptReconnect();
    }, delay);
    if (reconnectTimer && typeof reconnectTimer.unref === 'function') reconnectTimer.unref();
  }

  function attemptReconnect() {
    let settled = false;
    const sock = netImpl.createConnection(info.stablePath, () => {
      try { sock.write(`${JSON.stringify({ type: 'reconnect', launchEpoch: info.launchEpoch, generation: info.generation || 0, capability: info.capability })}\n`); } catch (_) { try { sock.destroy(); } catch (e) {} }
    });
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
        // R3.3.4: reconnect riuscito, lease nuovo. Riprende il refresh loop.
        clearTimer(reconnectTimer);
        current = sock;
        bindLive(sock);
        armRefresh();
      } else if (msg.type === 'deny') {
        settled = true;
        // R3.3.5: rifiutato (oltre grace o identity). Riprova a cadenza: rev13
        // S3.3 garantisce >=2 tentativi strettamente dentro la grace.
        try { sock.destroy(); } catch (_) {}
        armReconnect(L.RECONNECT_CADENCE_MS);
      }
    });
    sock.once('close', () => {
      if (settled) return;
      settled = true;
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
