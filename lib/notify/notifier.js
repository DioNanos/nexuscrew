'use strict';
// Facciata unica di emissione notifiche (MCP bridge §2): UI (SSE broadcast) +
// web-push. Riusata dalla route /api/notify, dagli ask (urgency high) e dalla
// consegna file in outbox — un solo punto che conosce entrambi i canali.

function createNotifier({ hub, push }) {
  // frame: {title, body?, urgency?, session?, lang?, url?}. Ritorna {ui, push} (conteggi).
  async function emit(frame) {
    const ui = hub.broadcast({
      type: 'notify',
      title: String(frame.title || ''),
      ...(frame.body ? { body: String(frame.body) } : {}),
      urgency: frame.urgency === 'high' ? 'high' : 'normal',
      ...(frame.session ? { session: String(frame.session) } : {}),
      ...(frame.lang ? { lang: String(frame.lang) } : {}),
      // Provenienza federata. `originNode` e' VERIFICATO (catena visited
      // costruita dal server); `originCell` e' soltanto ATTESTATO dal nodo di
      // origine, che l'ha verificata da se'. La differenza va fino alla UI: chi
      // guarda deve poter distinguere cio' che e' provato da cio' che e'
      // dichiarato, altrimenti il mittente diventa un campo di phishing.
      ...(frame.originNode ? { originNode: String(frame.originNode) } : {}),
      ...(frame.originCell ? { originCell: String(frame.originCell) } : {}),
      ts: Date.now(),
    });
    let pushed = 0;
    try {
      const r = await push.sendToAll({
        title: String(frame.title || ''),
        ...(frame.body ? { body: String(frame.body) } : {}),
        ...(frame.lang ? { lang: String(frame.lang) } : {}),
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
