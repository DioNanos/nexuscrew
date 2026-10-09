'use strict';
// lib/notify/notice-dismissals-queue.js — durable queue for notice dismissals
// this node could not hand to the owner yet, plus the drainer that retries them.
//
// The local intent is ALREADY honoured when a record lands here (the card is
// gone from this node's view): what is pending is the owner's copy, so the other
// devices stop seeing the notice too. Records carry no content — owner, event
// id, times, sync state — never a title, never a body.
//
// Bounds and failure policy mirror the dismissals store and the history: 200
// records, 64 KiB, retention equal to the notice's own life (15 minutes),
// atomic tmp+rename 0600, degradation declared in status(). An entry whose
// notice has expired is not worth carrying: it leaves the queue.

const fs = require('node:fs');
const path = require('node:path');

const MAX_ENTRIES = 200;
const MAX_BYTES = 64 * 1024;
const MAX_MS = 15 * 60 * 1000;
const SCHEMA = 'nexuscrew-notice-dismissal-queue-v1';
const OWNER_ID_RE = /^[a-f0-9]{32}$/;
const STATES = new Set(['pending', 'blocked']);

function createNoticeDismissalQueue({ filePath, now = Date.now, limits = {} }) {
  const maxEntries = limits.maxEntries || MAX_ENTRIES;
  const maxBytes = limits.maxBytes || MAX_BYTES;
  const maxMs = limits.maxMs || MAX_MS;

  let cache = null;
  let degraded = null;
  // The last load could not read or understand the file: the in-memory list
  // is INCOMPLETE until a retry succeeds. While it lasts, the operations the
  // node accepts go to an ordered journal and nothing is written: a successful
  // read replays the journal on top of the disk before writing.
  let loadFailed = false;
  let journal = [];

  function validateList(raw) {
    if (!Array.isArray(raw)) return null;
    const out = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') return null;
      if (!OWNER_ID_RE.test(String(entry.ownerId || ''))) return null;
      if (typeof entry.eventId !== 'string' || entry.eventId.length === 0) return null;
      if (!STATES.has(entry.syncState)) return null;
      if (typeof entry.at !== 'number' || !Number.isFinite(entry.at)) return null;
      out.push({
        ownerId: entry.ownerId, eventId: entry.eventId,
        at: entry.at, expiresAt: Number.isFinite(entry.expiresAt) ? entry.expiresAt : entry.at + maxMs,
        syncState: entry.syncState,
        attempts: Number.isSafeInteger(entry.attempts) && entry.attempts >= 0 ? entry.attempts : 0,
        nextRetryAt: Number.isFinite(entry.nextRetryAt) ? entry.nextRetryAt : 0,
        ...(typeof entry.lastReason === 'string' ? { lastReason: entry.lastReason } : {}),
        ...(typeof entry.retryBinding === 'string' || entry.retryBinding === null ? { retryBinding: entry.retryBinding } : {}),
      });
    }
    return out;
  }

  function prune(entries, t) {
    let out = entries.filter((e) => e.expiresAt > t);
    if (out.length > maxEntries) out = out.slice(out.length - maxEntries);
    return out;
  }

  // Pure disk read, no cache: {ok:true, entries} or {ok:false} with the
  // degradation reason set. ENOENT is a legitimate absence, not a failure.
  function readFromDisk() {
    let raw;
    try { raw = fs.readFileSync(filePath, 'utf8'); }
    catch (e) {
      if (!(e && e.code === 'ENOENT')) degraded = 'queue-read-failed';
      return e && e.code === 'ENOENT' ? { ok: true, entries: [] } : { ok: false };
    }
    if (Buffer.byteLength(raw, 'utf8') > maxBytes * 4) { degraded = 'queue-oversize'; return { ok: false }; }
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) { degraded = 'queue-schema'; return { ok: false }; }
    const entries = parsed && parsed.schema === SCHEMA ? validateList(parsed.entries) : null;
    if (!entries) { degraded = 'queue-schema'; return { ok: false }; }
    return { ok: true, entries: prune(entries, now()) };
  }

  function load() {
    if (cache) return cache;
    const read = readFromDisk();
    if (!read.ok) {
      loadFailed = true;
      cache = [];
      return cache;
    }
    loadFailed = false;
    cache = read.entries;
    return cache;
  }

  function persist(entries) {
    let body;
    try { body = JSON.stringify({ schema: SCHEMA, savedAt: now(), entries }); }
    catch (_) { degraded = 'queue-write-failed'; return { ok: false, reason: 'write-failed', list: entries }; }
    if (Buffer.byteLength(body, 'utf8') > maxBytes) { degraded = 'queue-oversize'; return { ok: false, reason: 'oversize', list: entries }; }
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, body, { mode: 0o600 });
      fs.renameSync(tmp, filePath);
    } catch (_) { degraded = 'queue-write-failed'; return { ok: false, reason: 'write-failed', list: entries }; }
    // A successful write holds everything this queue knows: the degradation is
    // over and the answers go back to attesting full durability. A past
    // failure must not stick to every future answer.
    loadFailed = false;
    degraded = null;
    return { ok: true, list: entries };
  }

  // Recovery from a failed load: the disk is the base and the journal replays
  // on top of it IN ORDER (the node's current intent wins), then the normal
  // prune applies — the oldest records leave, a fresh accepted intent never
  // does. Returns false when the disk is still unreadable: nothing is written
  // then, the intent stays in memory (journal included) and the answers keep
  // declaring durable:false with the read degradation reason.
  function attemptRecovery() {
    const read = readFromDisk();
    if (!read.ok) return false;
    let entries = read.entries;
    for (const op of journal) {
      if (op.op === 'enqueue') {
        if (!entries.some((e) => e.ownerId === op.ownerId && e.eventId === op.eventId)) entries.push(op.record);
      } else if (op.op === 'update') {
        const i = entries.findIndex((e) => e.ownerId === op.ownerId && e.eventId === op.eventId);
        if (i >= 0) entries[i] = { ...entries[i], ...op.patch };
      } else {
        entries = entries.filter((e) => !(e.ownerId === op.ownerId && e.eventId === op.eventId));
      }
    }
    const rebuilt = prune(entries, now());
    cache = rebuilt;
    const written = persist(rebuilt);
    if (!written.ok) return false;
    journal = [];
    loadFailed = false;
    degraded = null;
    return true;
  }

  function indexOf(entries, ownerId, eventId) {
    return entries.findIndex((e) => e.ownerId === ownerId && e.eventId === eventId);
  }

  function get(ownerId, eventId) {
    const entries = prune(load(), now());
    const i = indexOf(entries, ownerId, eventId);
    return i < 0 ? null : { ...entries[i] };
  }

  function list(ownerId) {
    const entries = prune(load(), now());
    return entries.filter((e) => (ownerId ? e.ownerId === ownerId : true)).map((e) => ({ ...e }));
  }

  function enqueue({ ownerId, eventId } = {}) {
    if (!OWNER_ID_RE.test(String(ownerId || ''))) return { ok: false, reason: 'bad-owner' };
    if (typeof eventId !== 'string' || !eventId) return { ok: false, reason: 'bad-event' };
    const entries = prune(load(), now());
    const i = indexOf(entries, ownerId, eventId);
    if (i >= 0) return { ok: true, record: { ...entries[i] }, existed: true };
    const t = now();
    const record = { ownerId, eventId, at: t, expiresAt: t + maxMs, syncState: 'pending', attempts: 0, nextRetryAt: 0 };
    entries.push(record);
    const kept = prune(entries, t);
    cache = kept;
    if (loadFailed) {
      journal.push({ op: 'enqueue', ownerId, eventId, record });
      attemptRecovery();
      return { ok: true, record: { ...record }, existed: false };
    }
    const written = persist(kept);
    if (written.ok) degraded = null;
    return { ok: true, record: { ...record }, existed: false };
  }

  function update(ownerId, eventId, patch = {}) {
    const entries = prune(load(), now());
    const i = indexOf(entries, ownerId, eventId);
    if (i < 0) return { ok: false, reason: 'unknown' };
    entries[i] = { ...entries[i], ...patch, ownerId, eventId };
    cache = prune(entries, now());
    if (loadFailed) {
      journal.push({ op: 'update', ownerId, eventId, patch });
      attemptRecovery();
      return { ok: true, record: get(ownerId, eventId) || { ...entries[i] } };
    }
    const written = persist(entries);
    if (written.ok) degraded = null;
    return { ok: true, record: { ...entries[i] } };
  }

  // Confirmed: the owner has it, the record leaves the queue. While the load
  // is failing the removal is journaled even when the record is not in the
  // incomplete in-memory list: the replay applies it to what the disk holds.
  function confirm(ownerId, eventId) {
    const entries = prune(load(), now());
    const i = indexOf(entries, ownerId, eventId);
    if (loadFailed) {
      journal.push({ op: 'confirm', ownerId, eventId });
      if (i >= 0) entries.splice(i, 1);
      cache = prune(entries, now());
      attemptRecovery();
      return { ok: true, removed: i >= 0 };
    }
    if (i < 0) return { ok: true, removed: false };
    entries.splice(i, 1);
    cache = entries;
    const written = persist(entries);
    if (written.ok) degraded = null;
    return { ok: true, removed: true };
  }

  function status() {
    const entries = prune(load(), now());
    return {
      degraded: degraded || null,
      count: entries.length,
      pending: entries.filter((e) => e.syncState === 'pending').length,
      blocked: entries.filter((e) => e.syncState === 'blocked').length,
    };
  }

  return { enqueue, get, list, update, confirm, status, MAX_MS };
}

function deferDelay(attempts, random, retryAfterMs = 0) {
  const base = Math.min(300000, 1000 * 2 ** Math.min(attempts, 9)) * (0.5 + random() * 0.5);
  return Math.max(retryAfterMs, base);
}

// The drainer: one attempt per owner at a time, a global budget and a per-owner
// one, exponential backoff with jitter, and `blocked` records that stay put
// until the binding to that owner changes (a re-pair is the only thing that can
// make a refusal meaningful again).
function createNoticeDismissalDrainer({
  queue, relay, now = Date.now, random = Math.random,
  setTimer = setTimeout, clearTimer = clearTimeout, intervalMs = 15000,
  globalBudget = 4, ownerBudget = 1, budgetWindowMs = 60000,
  bindingForOwner = () => null, readonly = () => false, log = () => {},
} = {}) {
  const flights = new Set();
  const globalHits = [];
  const ownerHits = new Map();
  let stopped = false;
  let timer = null;
  let running = null;

  function defer(record, reason, blocked = false, retryAfterMs = 0) {
    const attempts = (record.attempts || 0) + 1;
    return queue.update(record.ownerId, record.eventId, {
      syncState: blocked ? 'blocked' : 'pending',
      retryBinding: bindingForOwner(record.ownerId),
      attempts, lastReason: reason || 'owner-unreachable',
      nextRetryAt: now() + deferDelay(attempts, random, retryAfterMs),
    });
  }

  function rejected(record, result = {}) {
    const reason = result.reason || 'owner-unreachable';
    const pending = result.transient === true || (result.code === 429) || (typeof result.code === 'number' && result.code >= 500);
    return defer(record, reason, !pending, result.retryAfterMs || 0);
  }

  async function attempt(record) {
    const key = `${record.ownerId}|${record.eventId}`;
    if (flights.has(key) || stopped || readonly()) return;
    flights.add(key);
    try {
      const current = queue.get(record.ownerId, record.eventId);
      if (!current || current.syncState !== 'pending') return;
      const result = await relay.relayNoticeDismiss({ ownerId: record.ownerId, eventId: record.eventId });
      if (stopped || readonly()) return;
      const latest = queue.get(record.ownerId, record.eventId);
      if (!latest || latest.syncState !== 'pending' || latest.at !== current.at) return;
      if (result.ok) { queue.confirm(latest.ownerId, latest.eventId); return; }
      if (result.reason === 'unsupported') { defer(latest, 'unsupported', true); return; }
      rejected(latest, result);
    } catch (error) {
      const current = queue.get(record.ownerId, record.eventId);
      if (!stopped && current && current.syncState === 'pending') defer(current, 'owner-unreachable');
      log(`notice dismissal synchronization failed: ${String(error.message || error)}`);
    } finally { flights.delete(key); }
  }

  async function run() {
    if (stopped || readonly()) return;
    const t = now();
    const pruneHits = (hits) => { while (hits.length && hits[0] <= t - budgetWindowMs) hits.shift(); };
    pruneHits(globalHits);
    for (const [ownerId, hits] of ownerHits) { pruneHits(hits); if (!hits.length) ownerHits.delete(ownerId); }
    for (let record of queue.list()) {
      if (globalHits.length >= globalBudget) break;
      if (record.syncState === 'blocked') {
        const binding = bindingForOwner(record.ownerId);
        if (binding === null || binding === record.retryBinding) continue;
        const resumed = queue.update(record.ownerId, record.eventId, { syncState: 'pending', nextRetryAt: 0, retryBinding: binding });
        if (resumed.ok) record = resumed.record; else continue;
      }
      if (record.syncState !== 'pending' || (record.nextRetryAt || 0) > now()) continue;
      const hits = ownerHits.get(record.ownerId) || [];
      if (hits.length >= ownerBudget) continue;
      hits.push(t); ownerHits.set(record.ownerId, hits); globalHits.push(t);
      await attempt(record);
    }
  }

  function drain() {
    if (running) return running;
    const flight = run().finally(() => { if (running === flight) running = null; });
    running = flight;
    return flight;
  }

  function schedule() {
    if (stopped || timer) return;
    timer = setTimer(() => { timer = null; void drain().catch(error => log(String(error.message || error))).finally(schedule); }, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  function start() { schedule(); void drain().catch(error => log(String(error.message || error))); }
  function stop() { stopped = true; if (timer) clearTimer(timer); timer = null; }
  function nudge() { if (!stopped) void drain().catch(error => log(String(error.message || error))); }

  return { start, stop, drain, nudge };
}

module.exports = {
  createNoticeDismissalQueue, createNoticeDismissalDrainer,
  MAX_ENTRIES, MAX_BYTES, MAX_MS, SCHEMA,
};
