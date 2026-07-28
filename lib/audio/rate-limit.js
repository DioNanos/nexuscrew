'use strict';
// lib/audio/rate-limit.js — budget dedicato agli enunciati, separato da quello
// delle notifiche visuali: saturare le notifiche non deve poter zittire la voce,
// e viceversa.
//
// Tre finestre scorrevoli da 60s, tutte e tre da rispettare:
//   origin-cell   : per (nodo, cella) di origine — 6/60s verso qualunque target
//   target-origin : per (target, nodo, cella) — 6/60s
//   target-global : per nodo target — 12/60s sommando TUTTE le origini
//
// Il terzo bucket e' quello che limita il danno di un nodo che mente sulla
// propria cella: puo' inventare nomi quanto vuole, ma il tetto per target e'
// calcolato sul nodo, che invece e' verificato dalla catena `visited`.
//
// L'urgency non scavalca nulla. Un chiamante rumoroso — o compromesso — non deve
// poter uscire dal limite semplicemente dichiarandosi urgente.
const WINDOW_MS = 60 * 1000;
const LIMITS = Object.freeze({ 'origin-cell': 6, 'target-origin': 6, 'target-global': 12 });

// Stessa chiave dello store dei receipt: nodo + cella. Contare per sola cella
// permetterebbe a due nodi con celle omonime di consumarsi il budget a vicenda.
function originKey(origin) {
  if (!origin || typeof origin !== 'object') return null;
  const node = typeof origin.node === 'string' ? origin.node : '';
  const cell = typeof origin.cell === 'string' ? origin.cell : '';
  if (!node || !cell) return null;
  return `${node} ${cell}`;
}

function createSpeakRateLimiter({ now = Date.now } = {}) {
  const buckets = { 'origin-cell': new Map(), 'target-origin': new Map(), 'target-global': new Map() };

  function prune(map, t) {
    const cutoff = t - WINDOW_MS;
    for (const [k, ts] of map) {
      const kept = ts.filter((x) => x > cutoff);
      if (kept.length === 0) map.delete(k);
      else map.set(k, kept);
    }
  }

  function check({ origin, target, urgency } = {}) {
    const key = originKey(origin);
    if (!key) throw new Error('rate-limit: origin {node,cell} mancante');
    if (typeof target !== 'string' || !target) throw new Error('rate-limit: target mancante');
    void urgency; // ignorata di proposito: non esiste una corsia preferenziale
    const t = now();
    for (const name of Object.keys(buckets)) prune(buckets[name], t);
    const keys = {
      'origin-cell': key,
      'target-origin': `${target}\x00${key}`,
      'target-global': target,
    };
    for (const bucket of ['origin-cell', 'target-origin', 'target-global']) {
      const arr = buckets[bucket].get(keys[bucket]) || [];
      if (arr.length >= LIMITS[bucket]) {
        return { allowed: false, bucket, limit: LIMITS[bucket], retryInMs: WINDOW_MS - (t - arr[0]) };
      }
    }
    for (const bucket of ['origin-cell', 'target-origin', 'target-global']) {
      const arr = buckets[bucket].get(keys[bucket]) || [];
      arr.push(t);
      buckets[bucket].set(keys[bucket], arr);
    }
    return { allowed: true };
  }

  return { check, LIMITS, WINDOW_MS };
}

module.exports = { createSpeakRateLimiter, originKey, LIMITS, WINDOW_MS };
