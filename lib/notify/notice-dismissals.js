'use strict';
// lib/notify/notice-dismissals.js — durable set of the notices THIS node cleared.
//
// The owner is the source of truth for its own notices, so the dismissal lives
// here too: the snapshot it serves stops carrying the entry, and every device
// that reads that snapshot stops seeing it. The file holds ids and timestamps
// and nothing else — never a title, never a body — and it expires exactly with
// the history it filters (MAX_MS == event-feed-history.js MAX_MS): dismissing an
// entry that is no longer anywhere means nothing.
//
// Bounds and failure policy mirror the history: schema/size validation on load,
// prune of expired entries on load and on every write, caps on count AND bytes,
// atomic tmp+rename 0600. A disk failure degrades the store and is DECLARED in
// status(); it never throws into the caller, because a local dismissal is an
// operator intent and losing it silently would resurrect the card.
//
// The flush is SYNCHRONOUS on purpose. event-feed-history.js serializes its
// writes on a promise chain because its flush is async; here the write is
// writeFileSync+renameSync inside the mutation, so there is no interleaving to
// serialize and no window in which a 200 has answered before the entry is
// durable — which is the whole point of answering 200 to the peer.

const fs = require('node:fs');
const path = require('node:path');

const MAX_ENTRIES = 200;
const MAX_BYTES = 64 * 1024;
const MAX_MS = 15 * 60 * 1000;
const SCHEMA = 'nexuscrew-notice-dismissals-v1';

function createNoticeDismissals({ filePath, now = Date.now, limits = {} }) {
  const maxEntries = limits.maxEntries || MAX_ENTRIES;
  const maxBytes = limits.maxBytes || MAX_BYTES;
  const maxMs = limits.maxMs || MAX_MS;

  let cache = null;       // validated entries, oldest first
  let degraded = null;    // null | reason string

  function validateList(raw) {
    if (!Array.isArray(raw)) return null;
    const out = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') return null;
      if (typeof entry.eventId !== 'string' || entry.eventId.length === 0) return null;
      if (typeof entry.at !== 'number' || !Number.isFinite(entry.at)) return null;
      out.push({ eventId: entry.eventId, at: entry.at });
    }
    return out;
  }

  function prune(entries, t) {
    const cutoff = t - maxMs;
    let out = entries.filter((e) => e.at >= cutoff);
    if (out.length > maxEntries) out = out.slice(out.length - maxEntries);
    return out;
  }

  function load() {
    if (cache) return cache;
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      // A missing file is a fresh install, not a degradation; any other read
      // failure is declared, because an unreadable store must not look empty.
      degraded = e && e.code === 'ENOENT' ? degraded : 'dismissals-read-failed';
      cache = [];
      return cache;
    }
    // A file wildly larger than the cap is not parsed at all: it cannot be
    // trusted and reading it is the only cost that grows without bound.
    if (Buffer.byteLength(raw, 'utf8') > maxBytes * 4) {
      degraded = 'dismissals-oversize';
      cache = [];
      return cache;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      degraded = 'dismissals-schema';
      cache = [];
      return cache;
    }
    const entries = parsed && parsed.schema === SCHEMA ? validateList(parsed.entries) : null;
    if (!entries) { degraded = 'dismissals-schema'; cache = []; return cache; }
    cache = prune(entries, now());
    return cache;
  }

  function serialize(entries) {
    return JSON.stringify({ schema: SCHEMA, savedAt: now(), entries });
  }

  // Returns { ok: true } when the candidate list reached the disk, or
  // { ok: false, reason } when it could not — in which case the previous state
  // stays authoritative in memory and on disk.
  function persist(entries) {
    let body;
    try {
      body = serialize(entries);
    } catch (_) {
      degraded = 'dismissals-write-failed';
      return { ok: false, reason: 'write-failed' };
    }
    if (Buffer.byteLength(body, 'utf8') > maxBytes) {
      degraded = 'dismissals-oversize';
      return { ok: false, reason: 'oversize' };
    }
    try {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, filePath);
    } catch (_) {
      degraded = 'dismissals-write-failed';
      return { ok: false, reason: 'write-failed' };
    }
    return { ok: true };
  }

  function isDismissed(eventId) {
    if (typeof eventId !== 'string' || eventId.length === 0) return false;
    const entries = load();
    pruneInPlace(entries);
    return entries.some((e) => e.eventId === eventId);
  }

  // Expiry is applied on every read too: a long-lived process must not answer
  // from a snapshot of the file taken before the entries expired.
  function pruneInPlace(entries) {
    const live = prune(entries, now());
    if (live.length === entries.length && live.every((e, i) => e === entries[i])) return entries;
    cache = live;
    return cache;
  }

  function dismiss(eventId) {
    const entries = load();
    const current = pruneInPlace(entries);
    if (current.some((e) => e.eventId === eventId)) {
      return { ok: true, idempotent: true };
    }
    const candidate = prune([...current, { eventId, at: now() }], now());
    // Byte cap: drop the oldest until it fits, so a full store keeps accepting
    // new dismissals instead of refusing them for a stale tail.
    let fitted = candidate;
    while (fitted.length > 1 && Buffer.byteLength(serialize(fitted), 'utf8') > maxBytes) {
      fitted = fitted.slice(1);
    }
    const written = persist(fitted);
    if (!written.ok && written.reason === 'oversize') {
      // The list cannot be represented at all: no partial truth, the caller is
      // told and the previous state stays authoritative on both sides.
      return written;
    }
    // A failed WRITE is different from an unrepresentable list: the operator
    // asked for this notice to be cleared, so the owner honours it in every view
    // it serves from now on (memory is authoritative in-process, exactly like
    // the history) and declares the lost durability in status(). The window is
    // bounded by the retention TTL: the entry and the notice it filters expire
    // together.
    cache = fitted;
    return { ok: true, idempotent: false };
  }

  function list() { return pruneInPlace(load()).map((e) => ({ ...e })); }

  function status() {
    const entries = pruneInPlace(load());
    return { degraded: degraded || null, count: entries.length };
  }

  return { isDismissed, dismiss, list, status };
}

module.exports = { createNoticeDismissals, MAX_ENTRIES, MAX_BYTES, MAX_MS, SCHEMA };
