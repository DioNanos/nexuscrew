'use strict';
// Facciata unica di emissione notifiche (MCP bridge §2): UI (SSE broadcast) +
// web-push. Riusata dalla route /api/notify, dagli ask (urgency high) e dalla
// consegna file in outbox — un solo punto che conosce entrambi i canali.

function createNotifier({ hub, push }) {
  // frame: {title, body?, urgency?, session?, url?}. Ritorna {ui, push} (conteggi).
  async function emit(frame) {
    const ui = hub.broadcast({
      type: 'notify',
      title: String(frame.title || ''),
      ...(frame.body ? { body: String(frame.body) } : {}),
      urgency: frame.urgency === 'high' ? 'high' : 'normal',
      ...(frame.session ? { session: String(frame.session) } : {}),
      ts: Date.now(),
    });
    let pushed = 0;
    try {
      const r = await push.sendToAll({
        title: String(frame.title || ''),
        ...(frame.body ? { body: String(frame.body) } : {}),
        url: typeof frame.url === 'string' ? frame.url : '/',
      });
      pushed = r.sent;
    } catch (_) { /* push best-effort: la notify UI resta valida */ }
    return { ui, push: pushed };
  }

  // Frame di servizio solo-UI (es. {type:'ask-answered', id}): nessun push.
  function emitRaw(frame) {
    return hub.broadcast(frame);
  }

  return { emit, emitRaw };
}

module.exports = { createNotifier };
