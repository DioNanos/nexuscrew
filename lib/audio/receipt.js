'use strict';
// lib/audio/receipt.js — WP2R: GLOBALLY bounded speak receipt store.
// cap 512 GLOBAL (not per-caller), TTL 24h global cleanup, per-caller view is a
// bounded filter over the global map. utteranceId is immutable: lookup/idempotency
// runs BEFORE rate/gates that mutate quota — an identical retry does NOT consume
// rate and returns the existing receipt. A collision (same utteranceId, different
// caller/target) is fail-closed. The caller is NEVER client-controllable here:
// it is supplied by the authenticated integration (bridge/fleet cell), not by
// headers. Attribution is origin{node,cell}/target/timestamp/status/reason ONLY:
// NEVER text/lang/voice/path/secret. Status enum: refused|unreachable|accepted|
// spoken|unknown. No aggregate success boolean.
const crypto = require('node:crypto');

const STATUS = Object.freeze(['refused', 'unreachable', 'accepted', 'spoken', 'unknown']);
const CAP = 512; // GLOBALE
const TTL_MS = 24 * 60 * 60 * 1000;

function createReceiptStore({ now = Date.now } = {}) {
  const byId = new Map(); // utteranceId -> entry (GLOBAL, bounded)

  const expired = (e, t) => t - e.timestamp > TTL_MS;

  function cleanup(t) {
    for (const [id, e] of byId) if (expired(e, t)) byId.delete(id);
  }

  function redact(e) {
    const o = {
      utteranceId: e.utteranceId,
      origin: { node: e.origin.node, cell: e.origin.cell },
      target: e.target,
      status: e.status,
      timestamp: e.timestamp,
    };
    if (e.reason) o.reason = e.reason;
    return o;
  }

  // Idempotency probe: returns the redacted entry if the utteranceId is already
  // recorded for the SAME caller+target; 'collision' if recorded for a different
  // caller/target (fail-closed signal); null if absent. Does not mutate.
  function find(utteranceId, caller, target) {
    if (typeof utteranceId !== 'string' || !utteranceId) return null;
    const e = byId.get(utteranceId);
    if (!e) return null;
    if (expired(e, now())) { byId.delete(utteranceId); return null; }
    if (e.caller !== caller || e.target !== target) return 'collision';
    return redact(e);
  }

  function record(opts) {
    if (!opts || typeof opts !== 'object') throw new Error('record: opts mancante');
    const caller = opts.caller;
    if (typeof caller !== 'string' || !caller) throw new Error('record: caller mancante');
    if (!opts.origin || typeof opts.origin !== 'object') throw new Error('record: origin mancante');
    if (typeof opts.target !== 'string' || !opts.target) throw new Error('record: target mancante');
    if (!STATUS.includes(opts.status)) throw new Error(`status non valida (enum: ${STATUS.join('|')})`);
    const t = now();
    cleanup(t);
    const provided = typeof opts.utteranceId === 'string' && opts.utteranceId;
    if (provided) {
      const existing = byId.get(provided);
      if (existing && !expired(existing, t)) {
        if (existing.caller === caller && existing.target === opts.target) {
          return redact(existing); // idempotent: do not overwrite, do not consume
        }
        throw new Error('utteranceId collision (diverso caller/target)');
      }
    }
    const utteranceId = provided || crypto.randomUUID();
    const entry = {
      utteranceId, caller,
      origin: { node: opts.origin.node, cell: opts.origin.cell },
      target: opts.target,
      status: opts.status,
      ...(opts.reason ? { reason: String(opts.reason) } : {}),
      timestamp: t,
    };
    byId.set(utteranceId, entry);
    if (byId.size > CAP) {
      const sorted = [...byId.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
      for (let i = 0; i < byId.size - CAP; i += 1) byId.delete(sorted[i][0]);
    }
    return redact(entry);
  }

  // caller-scoped read: only the SAME authenticated caller sees its receipts.
  function get(caller, utteranceId) {
    const e = byId.get(utteranceId);
    if (!e) return null;
    if (expired(e, now())) { byId.delete(utteranceId); return null; }
    if (e.caller !== caller) return null;
    return redact(e);
  }

  function list(caller) {
    const t = now();
    const out = [];
    for (const [, e] of byId) if (!expired(e, t) && e.caller === caller) out.push(redact(e));
    return out;
  }

  function count() {
    const t = now();
    let c = 0;
    for (const [, e] of byId) if (!expired(e, t)) c += 1;
    return c;
  }

  return { record, find, get, list, count, STATUS };
}

module.exports = { createReceiptStore, STATUS, CAP, TTL_MS };