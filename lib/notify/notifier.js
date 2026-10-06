'use strict';
// Single facade for emitting notifications (MCP bridge): UI (SSE broadcast) +
// web-push. Reused by the /api/notify route, by the asks (high urgency) and
// by the outbox file delivery — one point that knows both channels.

const { alertFields } = require('./ask-alert-identity.js');

function createNotifier({ hub, push, alertRegistry }) {
  // frame: {title, body?, urgency?, session?, lang?, url?}. Ritorna {ui, push} (conteggi).
  async function emit(frame) {
    const uiClaim = alertRegistry ? alertRegistry.claim(frame, 'ui') : { allowed: true };
    const ui = uiClaim.allowed ? hub.broadcast({
      type: 'notify',
      ...alertFields(frame),
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
    }) : 0;
    if (uiClaim.allowed && alertRegistry) alertRegistry.complete(frame, 'ui', ui);
    let pushed = 0; let pushReason = null;
    const pushClaim = alertRegistry ? alertRegistry.claim(frame, 'push') : { allowed: true };
    try {
      if (pushClaim.allowed) {
      const r = await push.sendToAll({
        ...alertFields(frame),
        title: String(frame.title || ''),
        ...(frame.body ? { body: String(frame.body) } : {}),
        ...(frame.lang ? { lang: String(frame.lang) } : {}),
        url: typeof frame.url === 'string' ? frame.url : '/',
      });
      pushed = r && Number.isFinite(r.sent) ? r.sent : 0;
      if (!pushed) pushReason = 'no-delivery';
      } else pushReason = pushClaim.reason;
    } catch (_) { pushReason = 'send-failed'; }
    if (pushClaim.allowed && alertRegistry) alertRegistry.complete(frame, 'push', pushed);
    if (!frame.askId) return { ui, push: pushed };
    return { ui, push: pushed, uiAttempted: uiClaim.allowed === true, pushAttempted: pushClaim.allowed === true, alertStatus: ui > 0 || pushed > 0 ? 'delivered' : 'no-delivery', ...(pushReason ? { pushReason } : {}) };
  }

  // Frame di servizio solo-UI (es. {type:'ask-answered', id}): nessun push.
  function emitRaw(frame) {
    return hub.broadcast(frame);
  }

  return { emit, emitRaw };
}

module.exports = { createNotifier };
