'use strict';
// Contatore di cadute WebSocket: trasforma «celle che vanno e vengono»
// in numeri — quante cadute nella finestra (default 10 minuti) e, alla
// riconnessione, quanto è durata la caduta (gap tra close e reopen).
// In memoria, zero I/O: i valori viaggiano nei meta dei log di bridge.js.
function createDropCounter({ windowMs = 10 * 60 * 1000, now = Date.now } = {}) {
  const drops = []; // { ts, sessionId }
  const lastClose = new Map(); // sessionId -> ts
  const key = (s) => String(s == null ? '' : s);
  function prune(ts) {
    const cutoff = ts - windowMs;
    while (drops.length && drops[0].ts < cutoff) drops.shift();
  }
  return {
    recordDrop(session, ts = now()) {
      const k = key(session);
      drops.push({ ts, sessionId: k });
      if (k) lastClose.set(k, ts);
      prune(ts);
      return { drops: drops.length, windowSeconds: Math.round(windowMs / 1000) };
    },
    // Alla riconnessione: la durata della caduta e' il gap close->reopen.
    // Consuma il last close: una connessione lunga e sana non e' «ritorno».
    recordReopen(session, ts = now()) {
      const k = key(session);
      const last = lastClose.get(k);
      lastClose.delete(k);
      prune(ts);
      return { gapMs: last == null ? null : Math.max(0, ts - last), drops: drops.length };
    },
    snapshot(ts = now()) {
      prune(ts);
      return { drops: drops.length, windowSeconds: Math.round(windowMs / 1000) };
    },
  };
}
module.exports = { createDropCounter };
