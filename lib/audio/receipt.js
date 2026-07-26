'use strict';
// lib/audio/receipt.js — WP2: caller-scoped speak receipt store.
// Bounded (<=512 per caller), TTL 24h, immutable utteranceId (origin generates
// one if omitted). Attribution carries origin {node, cell}, target, timestamp,
// status, reason ONLY — NEVER text/lang/voice/path/secret. Per-endpoint status
// enum: refused|unreachable|accepted|spoken|unknown. No aggregate success bool.
const crypto = require('node:crypto');

const STATUS = Object.freeze(['refused', 'unreachable', 'accepted', 'spoken', 'unknown']);
const CAP = 512;
const TTL_MS = 24 * 60 * 60 * 1000;

function createReceiptStore({ now = Date.now } = {}) {
  const byCaller = new Map(); // caller -> Map(utteranceId -> entry)

  const expired = (entry, t) => t - entry.timestamp > TTL_MS;

  function cleanCaller(caller, t) {
    const m = byCaller.get(caller);
    if (!m) return;
    for (const [id, e] of m) if (expired(e, t)) m.delete(id);
    if (m.size === 0) byCaller.delete(caller);
  }

  // Redacted, value-free receipt: only attribution + status/reason/timestamp.
  function redact(entry) {
    const out = {
      utteranceId: entry.utteranceId,
      origin: { node: entry.origin.node, cell: entry.origin.cell },
      target: entry.target,
      status: entry.status,
      timestamp: entry.timestamp,
    };
    if (entry.reason) out.reason = entry.reason;
    return out;
  }

  function record(opts) {
    if (!opts || typeof opts !== 'object') throw new Error('record: opts mancante');
    const caller = opts.caller;
    if (typeof caller !== 'string' || !caller) throw new Error('record: caller mancante');
    if (!opts.origin || typeof opts.origin !== 'object') throw new Error('record: origin mancante');
    if (typeof opts.target !== 'string' || !opts.target) throw new Error('record: target mancante');
    if (!STATUS.includes(opts.status)) throw new Error(`status non valida (enum: ${STATUS.join('|')})`);
    const utteranceId = typeof opts.utteranceId === 'string' && opts.utteranceId
      ? opts.utteranceId : crypto.randomUUID();
    const t = now();
    let m = byCaller.get(caller);
    if (!m) { m = new Map(); byCaller.set(caller, m); }
    const entry = {
      utteranceId,
      origin: { node: opts.origin.node, cell: opts.origin.cell },
      target: opts.target,
      status: opts.status,
      ...(opts.reason ? { reason: String(opts.reason) } : {}),
      timestamp: t,
    };
    m.set(utteranceId, entry);
    cleanCaller(caller, t);
    if (m.size > CAP) {
      // FIFO eviction: drop oldest by timestamp until within cap.
      const sorted = [...m.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
      for (let i = 0; i < m.size - CAP; i += 1) m.delete(sorted[i][0]);
    }
    return redact(entry);
  }

  function get(caller, utteranceId) {
    const m = byCaller.get(caller);
    if (!m) return null;
    const e = m.get(utteranceId);
    if (!e) return null;
    if (expired(e, now())) { m.delete(utteranceId); return null; }
    return redact(e);
  }

  function list(caller) {
    const m = byCaller.get(caller);
    if (!m) return [];
    const t = now();
    const out = [];
    for (const [, e] of m) if (!expired(e, t)) out.push(redact(e));
    return out;
  }

  function count(caller) {
    const m = byCaller.get(caller);
    if (!m) return 0;
    const t = now();
    let c = 0;
    for (const [, e] of m) if (!expired(e, t)) c += 1;
    return c;
  }

  return { record, get, list, count, STATUS };
}

module.exports = { createReceiptStore, STATUS, CAP, TTL_MS };