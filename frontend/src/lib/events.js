// Canale eventi UI del MCP bridge: EventSource su GET /api/events.
// EventSource non puo' settare header -> token in query (il server e'
// loopback-only e la accetta col pattern gia' usato dal proxy WS).
// Riconnessione: nativa di EventSource (retry hint dal server); i frame
// malformati si scartano in silenzio (fail-closed, mai crash della UI).
export function connectEvents(token, onFrame) {
  if (typeof EventSource === 'undefined' || !token) return () => {};
  const es = new EventSource(`/api/events?token=${encodeURIComponent(token)}`);
  es.onmessage = (e) => {
    try {
      const frame = JSON.parse(e.data);
      if (frame && typeof frame === 'object' && typeof frame.type === 'string') onFrame(frame);
    } catch (_) { /* frame malformato: scarta */ }
  };
  return () => { try { es.close(); } catch (_) {} };
}
