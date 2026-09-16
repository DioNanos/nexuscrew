'use strict';
// lib/notify/event-feed-history.js — durable store of LOCAL notifies only.
//
// It exists so an owner restart can still answer a snapshot with the recent
// notify past: the ring is memory and dies with the process, the asks store is
// durable, and this file is the third leg. Imported events NEVER enter it —
// the writer refuses anything that did not originate here — and the file is
// 0600 atomic-write, loaded back only after schema/size/retention validation.
// Persistence failure never blocks a local notify: it degrades the history and
// the degradation is visible in the snapshot status.

const fs = require('node:fs');
const path = require('node:path');

const MAX_ENTRIES = 50;
const MAX_BYTES = 1024 * 1024;
const MAX_MS = 15 * 60 * 1000;
const SCHEMA = 'nexuscrew-event-feed-history-v1';

function createEventFeedHistory({ filePath, now = Date.now, limits = {} }) {
  const maxEntries = limits.maxEntries || MAX_ENTRIES;
  const maxBytes = limits.maxBytes || MAX_BYTES;
  const maxMs = limits.maxMs || MAX_MS;

  let cache = null;       // validated entries, oldest first
  let degraded = null;    // null | reason string
  let writeChain = Promise.resolve();

  function validateList(raw) {
    if (!Array.isArray(raw)) return null;
    const out = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') return null;
      if (entry.origin !== 'local') return null; // imported events are never durable here
      if (typeof entry.eventId !== 'string' || entry.eventId.length === 0) return null;
      if (!entry.envelope || typeof entry.envelope !== 'object') return null;
      if (typeof entry.at !== 'number') return null;
      out.push(entry);
    }
    return out;
  }

  function load() {
    if (cache) return cache;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (Buffer.byteLength(raw, 'utf8') > maxBytes * 4) {
        degraded = 'history-oversize';
        cache = [];
        return cache;
      }
      const parsed = JSON.parse(raw);
      const entries = validateList(parsed && parsed.entries);
      if (!entries) { degraded = 'history-schema'; cache = []; return cache; }
      const cutoff = now() - maxMs;
      cache = entries.filter((e) => e.at >= cutoff);
    } catch (_) {
      // Missing file is a fresh install, not a degradation.
      cache = [];
    }
    return cache;
  }

  function serialize(entries) {
    return JSON.stringify({ schema: SCHEMA, savedAt: now(), entries });
  }

  function persist(entries) {
    // Serialized writer: generations never overwrite newer data with older
    // flushes. Atomic tmp+rename, 0600.
    writeChain = writeChain.then(() => new Promise((resolve) => {
      try {
        const body = serialize(entries);
        if (Buffer.byteLength(body, 'utf8') > maxBytes) {
          degraded = 'history-oversize';
          resolve();
          return;
        }
        const dir = path.dirname(filePath);
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, body, { mode: 0o600 });
        fs.renameSync(tmp, filePath);
      } catch (_) {
        degraded = 'history-write-failed';
      }
      resolve();
    }));
    return writeChain;
  }

  // Record ONE local envelope. Refuses imported entries structurally: the
  // origin flag is part of the entry, not a per-call courtesy.
  function record(envelope) {
    const entries = load();
    const entry = { origin: 'local', eventId: envelope.eventId, at: now(), envelope };
    entries.push(entry);
    while (entries.length > maxEntries) entries.shift();
    const cutoff = now() - maxMs;
    while (entries.length > 0 && entries[0].at < cutoff) entries.shift();
    cache = entries;
    return persist(entries);
  }

  function list() { return load().slice(); }

  function status() {
    load();
    return { degraded: degraded || null, count: cache.length, origin: 'local-only' };
  }

  return { record, list, status };
}

module.exports = { createEventFeedHistory, MAX_ENTRIES, MAX_BYTES, MAX_MS };
