'use strict';
// lib/notify/push-relay.js — OS alert relay for IMPORTED notifications.
//
// Only NEW, authorized imported notify envelopes reach the push sender: ask
// closures and state frames update the UI silently, an ask's first alert
// travels with its correlated notify, and a snapshot or a replay of an
// already-known event never rings twice. The (owner, eventId) pair is
// persisted BEFORE the send — a crash in between may lose an alert, it may
// never duplicate one.
//
// The queue is its own budget, separate from local notifications: 32 alerts
// or 128 KiB, at most 2 concurrent sends, 10 s per send. Errors are counted,
// best-effort: a failed push NEVER causes a retry of the SSE stream that
// already accepted the event. The alert budget (6 per cell per minute,
// 12 per client per minute) is a dedicated window and urgency never
// bypasses it.

const fs = require('node:fs');
const path = require('node:path');

const QUEUE_MAX_ALERTS = 32;
const QUEUE_MAX_BYTES = 128 * 1024;
const MAX_CONCURRENT = 2;
const SEND_TIMEOUT_MS = 10000;
const PAYLOAD_MAX_BYTES = 3 * 1024;
const DEDUP_CAP = 4096;
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const CELL_ALERTS_PER_MIN = 6;
const CLIENT_ALERTS_PER_MIN = 12;

function truncateUtf8(str, maxBytes) {
  const out = [];
  let bytes = 0;
  for (const ch of String(str)) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (bytes + b > maxBytes) return { text: out.join('') + '…', truncated: true };
    bytes += b;
    out.push(ch);
  }
  return { text: out.join(''), truncated: false };
}

// Truncate at a UNICODE boundary (never splitting a code point) and say so.
function buildPayload(envelope) {
  const f = envelope.frame || {};
  const full = typeof f.body === 'string' ? f.body : '';
  const { text: preview, truncated } = truncateUtf8(full, 200);
  const where = envelope.scope === 'cell' && envelope.cellId ? envelope.cellId : '';
  const askId = typeof f.askId === 'string' && f.askId ? f.askId : null;
  // Local route only: the app decides what to open, the payload never carries a
  // peer URL. ask= is present only when the source names an ask.
  const url = `/#owner=${envelope.ownerId}`
    + (askId ? `&ask=${encodeURIComponent(askId)}` : '')
    + (where ? `&cell=${encodeURIComponent(where)}` : '');
  // The FULL body lives in the card (the app holds the imported envelope);
  // the OS payload carries the preview only.
  void full;
  return {
    title: truncateUtf8(f.title || 'NexusCrew', 120).text,
    ...(preview ? { body: truncated ? `${preview}…` : preview } : {}),
    ...(f.lang ? { lang: f.lang } : {}),
    tag: `nc:${envelope.ownerId}:${envelope.eventId}`,
    url,
    ownerId: envelope.ownerId,
    eventId: envelope.eventId,
    ...(askId ? { askId } : {}),
  };
}

function createPushDedup({ filePath, now = Date.now } = {}) {
  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && parsed.seen && typeof parsed.seen === 'object') return parsed;
    } catch (_) { /* fresh */ }
    return { seen: {} };
  }
  function seenBefore(owner, eventId) {
    return load().seen[`${owner}:${eventId}`] !== undefined;
  }
  // Persist BEFORE the send: the crash window may lose an alert, never
  // duplicate one.
  function mark(owner, eventId) {
    const state = load();
    state.seen[`${owner}:${eventId}`] = now();
    const cutoff = now() - DEDUP_TTL_MS;
    for (const [k, t] of Object.entries(state.seen)) {
      if (t < cutoff) delete state.seen[k];
    }
    const keys = Object.keys(state.seen);
    if (keys.length > DEDUP_CAP) {
      for (const k of keys.slice(0, keys.length - DEDUP_CAP)) delete state.seen[k];
    }
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      fs.renameSync(tmp, filePath);
    } catch (_) { return false; }
    return true;
  }
  return { seenBefore, mark };
}

// `send` is the push sender call (pushService.sendToAll wrapped with the
// timeout). Everything else is queue + budget + counters.
function createPushRelay({ pushDedup, send, now = Date.now, sendTimeoutMs = SEND_TIMEOUT_MS, log = () => {} } = {}) {
  const queue = [];
  let queueBytes = 0;
  let active = 0;
  const cellWindow = new Map();
  const clientWindow = [];
  const counters = { pushed: 0, dropped: 0, sendFailed: 0, since: now() };
  // Per-owner view of the same numbers, for the local observability surfaces:
  // an operator asking about ONE peer should not read the fleet total.
  const ownerCounters = new Map();
  function forOwner(ownerId) {
    const key = ownerId || 'unknown';
    if (!ownerCounters.has(key)) {
      ownerCounters.set(key, { pushed: 0, dropped: 0, sendFailed: 0, lastReason: null, since: counters.since });
    }
    return ownerCounters.get(key);
  }

  function budgetAllows(cellId) {
    const t = now();
    const cutoff = t - 60000;
    const clean = (m) => { for (const [k, v] of m) { const kept = v.filter((x) => x > cutoff); if (kept.length) m.set(k, kept); else m.delete(k); } };
    clean(cellWindow);
    while (clientWindow.length && clientWindow[0] <= cutoff) clientWindow.shift();
    const cellKey = cellId || 'node';
    const perCell = (cellWindow.get(cellKey) || []);
    if (perCell.length >= CELL_ALERTS_PER_MIN) return false;
    if (clientWindow.length >= CLIENT_ALERTS_PER_MIN) return false;
    perCell.push(t); cellWindow.set(cellKey, perCell);
    clientWindow.push(t);
    return true;
  }

  async function flush() {
    while (active < MAX_CONCURRENT && queue.length > 0) {
      const item = queue.shift();
      queueBytes -= item.bytes;
      active += 1;
      try {
        const out = await Promise.race([
          send(item.payload),
          new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), sendTimeoutMs)),
        ]);
        const own = forOwner(item.payload && item.payload.ownerId);
        if (out && out.timeout) {
          counters.sendFailed += 1; own.sendFailed += 1; own.lastReason = 'send-timeout';
          log('push-relay: send timeout');
        } else if (out && out.sent > 0) { counters.pushed += out.sent; own.pushed += out.sent; }
        else { counters.sendFailed += 1; own.sendFailed += 1; own.lastReason = 'send-failed'; }
      } catch (_) {
        counters.sendFailed += 1;
        const own = forOwner(item.payload && item.payload.ownerId);
        own.sendFailed += 1; own.lastReason = 'send-failed';
      }
      active -= 1;
    }
  }

  // Consider ONE imported notify envelope. Returns false when nothing was
  // sent (already known, filtered, out of budget or over the queue caps).
  function consider(envelope) {
    if (!envelope || envelope.frame && envelope.frame.type && envelope.frame.type !== 'notify') return false;
    if (!envelope.eventId || !envelope.ownerId) return false;
    if (pushDedup.seenBefore(envelope.ownerId, envelope.eventId)) return false;
    const payload = buildPayload(envelope);
    const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    if (bytes > PAYLOAD_MAX_BYTES) {
      counters.dropped += 1; const own = forOwner(envelope.ownerId);
      own.dropped += 1; own.lastReason = 'payload-oversize';
      return false;
    }
    if (!budgetAllows(envelope.cellId)) {
      counters.dropped += 1; const own = forOwner(envelope.ownerId);
      own.dropped += 1; own.lastReason = 'alert-budget';
      return false;
    }
    if (queue.length + 1 > QUEUE_MAX_ALERTS || queueBytes + bytes > QUEUE_MAX_BYTES) {
      counters.dropped += queue.length;
      const own = forOwner(envelope.ownerId);
      own.dropped += queue.length; own.lastReason = 'queue-overflow';
      queue.length = 0; queueBytes = 0;
      return false; // overflow: the UI resyncs, never a partial alert flood
    }
    // Dedup is durable and BEFORE the send.
    if (!pushDedup.mark(envelope.ownerId, envelope.eventId)) {
      counters.dropped += 1; counters.lastReason = 'dedup-persist-failed';
      const own = forOwner(envelope.ownerId);
      own.dropped += 1; own.lastReason = 'dedup-persist-failed';
      return false;
    }
    queue.push({ payload, bytes });
    queueBytes += bytes;
    void flush();
    return true;
  }

  // The client server re-emits one flattened event per imported envelope into
  // the local hub. That is the only place a NEW imported event exists on this
  // side, so the relay is fed from there: an ask or a closure updates the UI
  // silently (an ask's first alert travels with its correlated notify), and a
  // state frame never rings.
  function considerImported(event) {
    if (!event || event.type !== 'notify') return false;
    if (!event.ownerId || !event.eventId) return false;
    return consider({
      ownerId: event.ownerId,
      eventId: event.eventId,
      scope: event.originCell ? 'cell' : 'node',
      cellId: event.originCell || null,
      frame: {
        type: 'notify', title: event.title, body: event.body, lang: event.lang,
        ...(event.askId ? { askId: String(event.askId) } : {}),
      },
    });
  }

  // Local, read-only view: counters and reasons only — never an endpoint, a
  // subscription or a key.
  function status() {
    return {
      queued: queue.length, queueBytes, active,
      counters: { ...counters },
      byOwner: Object.fromEntries([...ownerCounters.entries()].map(([k, v]) => [k, {
        queued: queue.filter((q) => (q.payload && q.payload.ownerId) === k).length,
        pushed: v.pushed, dropped: v.dropped, sendFailed: v.sendFailed,
        lastReason: v.lastReason, since: v.since,
      }])),
    };
  }

  return { consider, considerImported, status, buildPayload };
}

module.exports = { createPushRelay, createPushDedup, buildPayload, truncateUtf8 };
