'use strict';
// Hub SSE per gli eventi UI (notify/ask) — MCP bridge, design §2a.
// Non esisteva un canale UI-broadcast (i WS sono per-attach PTY, il frame
// 'files' viaggia solo verso i client attached alla sessione): GET /api/events
// e' il canale EventSource su cui OGNI vista della UI ascolta notify/ask.
// L'auth sta nel chiamante (server.js: Bearer o ?token= sul loopback, stesso
// pattern dell'upgrade WS proxy — EventSource non puo' settare header).

const HEARTBEAT_MS = 25000;

function createEventsHub(opts = {}) {
  const clients = new Set(); // res HTTP vivi
  const heartbeatMs = opts.heartbeatMs || HEARTBEAT_MS;

  // Commento SSE periodico: fa emergere i TCP half-open (mobile/tunnel) e tiene
  // vivi i proxy che chiudono le connessioni idle. unref: non tiene su il processo.
  const heartbeat = setInterval(() => {
    for (const res of clients) {
      try { res.write(':hb\n\n'); } catch (_) { clients.delete(res); }
    }
  }, heartbeatMs);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();

  // Handler della route GET /api/events (montata gia' autenticata).
  function handle(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 5000\n\n');
    clients.add(res);
    req.on('close', () => { clients.delete(res); });
  }

  // Broadcast di un frame JSON a tutte le UI connesse. Ritorna il numero di
  // client raggiunti (best-effort: un write fallito espelle il client).
  function broadcast(frame) {
    const data = `data: ${JSON.stringify(frame)}\n\n`;
    let sent = 0;
    for (const res of clients) {
      try { res.write(data); sent += 1; } catch (_) { clients.delete(res); }
    }
    return sent;
  }

  function clientCount() { return clients.size; }

  function closeAll() {
    clearInterval(heartbeat);
    for (const res of clients) { try { res.end(); } catch (_) { /* best-effort */ } }
    clients.clear();
  }

  return { handle, broadcast, clientCount, closeAll };
}

module.exports = { createEventsHub };
