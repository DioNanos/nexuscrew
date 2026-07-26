'use strict';
// lib/audio/rate-limit.js — WP2: dedicated speak rate limiter, 3 buckets with
// a 60s sliding window. High urgency NEVER bypasses (a noisy or compromised
// caller cannot escalate out of the limit).
//   origin-cell   : per origin cell, 6/60s (any target)
//   target-origin : per (target, origin cell) pair, 6/60s
//   target-global : per target node, 12/60s (sum across all origins)
const WINDOW_MS = 60 * 1000;
const LIMITS = Object.freeze({ 'origin-cell': 6, 'target-origin': 6, 'target-global': 12 });

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

  function check({ originCell, target, urgency } = {}) {
    if (typeof originCell !== 'string' || !originCell) throw new Error('rate-limit: originCell mancante');
    if (typeof target !== 'string' || !target) throw new Error('rate-limit: target mancante');
    // urgency is intentionally ignored: never bypasses.
    void urgency;
    const t = now();
    prune(buckets['origin-cell'], t);
    prune(buckets['target-origin'], t);
    prune(buckets['target-global'], t);
    const keys = {
      'origin-cell': originCell,
      'target-origin': `${target}\x00${originCell}`,
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

module.exports = { createSpeakRateLimiter, LIMITS, WINDOW_MS };