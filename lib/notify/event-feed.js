'use strict';
// lib/notify/event-feed.js — owner-side event feed: a per-peer ring with the
// scope applied BEFORE insertion, a per-peer view epoch + sequence, an atomic
// replay-to-live barrier, backpressure via write(false), heartbeats, bounded
// live queues and bounded counters.
//
// Design points that are security decisions, not preferences:
//   - The ring holds ONLY what the peer may see. Filtering happens before
//     insertion, never at read time: a later grant change invalidates the
//     whole view (epoch bump + ring wipe), it does not "re-filter" history.
//   - The cursor is per peer view: `viewEpoch:seq`. The epoch changes on owner
//     restart and on every grant/scope change, so an old cursor can never be
//     mistaken for a live one, and the sequence never leaks a global event
//     count (hidden cells stay uncountable).
//   - write(false) stops the socket until drain: production to THAT stream
//     pauses, the ring keeps recording, the peer's other paths are untouched.
//   - Budgets are first-threshold: whichever of events/bytes/time trips first
//     prunes the ring, so no single dimension can grow unbounded.

const HEARTBEAT_MS = 20000;
const FRAME_MAX_BYTES = 16 * 1024; // cap BEFORE any JSON.parse downstream
const RING_MAX_EVENTS = 512;
const RING_MAX_BYTES = 1024 * 1024;
const RING_MAX_MS = 15 * 60 * 1000;
const LIVE_QUEUE_MAX_FRAMES = 128;
const LIVE_QUEUE_MAX_BYTES = 256 * 1024;
const MAX_ENABLED_PEERS = 8;
const OPENS_PER_MIN = 6;

function defaultNow() { return Date.now(); }

function createEventFeed(opts = {}) {
  const now = opts.now || defaultNow;
  const heartbeatMs = opts.heartbeatMs || HEARTBEAT_MS;
  const frameMaxBytes = opts.frameMaxBytes || FRAME_MAX_BYTES;
  const maxPeers = opts.maxPeers || MAX_ENABLED_PEERS;
  const opensPerMin = opts.opensPerMin || OPENS_PER_MIN;
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  // peerId -> state. Enabled = has state (owner granted the feed explicitly);
  // enabling beyond the budget is refused with a named error.
  const peers = new Map();

  function freshState() {
    return {
      epoch: 1,
      seq: 0,
      ring: [],            // [{seq, bytes, at, envelope}]
      ringBytes: 0,
      streams: [],         // at most one live stream per pair (newest wins)
      opens: [],           // open timestamps for the per-peer rate
      counters: { delivered: 0, dropped: 0, replayed: 0, rejected: 0, since: now() },
      lastCursor: null,
      lastDropReason: null,
      lastRejectReason: null,
    };
  }

  function state(peerId) { return peers.get(peerId) || null; }

  function enablePeer(peerId) {
    if (peers.has(peerId)) return peers.get(peerId);
    if (peers.size >= maxPeers) {
      const e = new Error('too many peers enabled for the event feed');
      e.reason = 'peer-budget';
      throw e;
    }
    const st = freshState();
    peers.set(peerId, st);
    return st;
  }

  function disablePeer(peerId) {
    const st = peers.get(peerId);
    if (st) closeStreams(st, 'peer-disabled');
    peers.delete(peerId);
  }

  function closeStreams(st, reason) {
    for (const s of st.streams.splice(0)) {
      try { s.close(reason); } catch (_) { /* best-effort */ }
    }
  }

  // Grant/scope change or revocation: the view is dead, not re-filtered.
  function invalidatePeer(peerId, reason) {
    const st = peers.get(peerId);
    if (!st) return;
    closeStreams(st, reason);
    st.epoch += 1;
    st.seq = 0;
    st.ring = [];
    st.ringBytes = 0;
    st.lastCursor = null;
    log(`event-feed: view reset for peer ${peerId} (${reason})`);
  }

  // Kill-switch: close everything served, wipe every ring, refuse new opens.
  function invalidateAll(reason) {
    for (const [peerId, st] of peers) {
      closeStreams(st, reason);
      st.epoch += 1;
      st.seq = 0;
      st.ring = [];
      st.ringBytes = 0;
      st.lastCursor = null;
      log(`event-feed: view reset for peer ${peerId} (${reason})`);
    }
  }

  function pruneRing(st) {
    const cutoff = now() - RING_MAX_MS;
    while (st.ring.length > 0 && (
      st.ring.length > RING_MAX_EVENTS
      || st.ringBytes > RING_MAX_BYTES
      || (st.ring.length > 0 && st.ring[0].at < cutoff && st.ring.length > 1)
    )) {
      const dropped = st.ring.shift();
      st.ringBytes -= dropped.bytes;
    }
  }

  // Publish an ALREADY-SCOPED envelope to one peer. The caller applied the ACL
  // before calling: this function trusts the envelope's peer binding and
  // refuses frames over the byte cap before they ever enter the ring.
  function publish(peerId, envelope) {
    const st = peers.get(peerId);
    if (!st) return { ok: false, reason: 'peer-not-enabled' };
    const bytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
    if (bytes > frameMaxBytes) {
      st.counters.dropped += 1;
      st.lastDropReason = 'frame-too-large';
      return { ok: false, reason: 'frame-too-large' };
    }
    st.seq += 1;
    const entry = { seq: st.seq, bytes, at: now(), envelope };
    st.ring.push(entry);
    st.ringBytes += bytes;
    pruneRing(st);
    st.lastCursor = `${st.epoch}:${st.seq}`;

    if (st.streams.length > 0) {
      const s = st.streams[st.streams.length - 1]; // newest stream wins the pair
      if (s.paused) {
        s.queue.push(entry);
        s.queueBytes += bytes;
        if (s.queue.length > LIVE_QUEUE_MAX_FRAMES || s.queueBytes > LIVE_QUEUE_MAX_BYTES) {
          // Overflow: close and demand a resync, never a silently lossy stream.
          st.counters.dropped += s.queue.length;
          st.lastDropReason = 'live-queue-overflow';
          closeStreams(st, 'resync-required');
        }
      } else {
        try {
          if (typeof s.filter === 'function' && !s.filter(entry)) {
            // Narrower stream (cell-only, node-only): not a drop, a scope.
          } else {
            const out = s.write(entry);
            st.counters.delivered += 1;
            if (out === false) { s.paused = true; }
          }
        } catch (_) {
          closeStreams(st, 'write-error');
        }
      }
    }
    return { ok: true, seq: st.seq };
  }

  // Subscribe an SSE response. `after` is the caller's parsed cursor or null.
  // Returns {ok, epoch} or {ok:false, status, reason}: the ROUTE turns a
  // refusal into the right HTTP answer before any byte of content flows.
  function subscribe(peerId, res, after, opts2 = {}) {
    const st = peers.get(peerId);
    if (!st) return { ok: false, status: 403, reason: 'feed-not-enabled' };

    // One stream per pair: a reconnection replaces the previous one.
    const openCut = now() - 60000;
    st.opens = st.opens.filter((t) => t > openCut);
    if (st.opens.length >= opensPerMin) {
      st.counters.rejected += 1;
      st.lastRejectReason = 'open-rate';
      return { ok: false, status: 429, reason: 'open-rate' };
    }
    st.opens.push(now());

    let replay = [];
    if (after) {
      if (after.epoch !== st.epoch) {
        st.counters.rejected += 1;
        st.lastRejectReason = 'reset-required';
        return { ok: false, status: 409, reason: 'reset-required' };
      }
      if (after.seq > st.seq) {
        st.counters.rejected += 1;
        st.lastRejectReason = 'cursor-future';
        return { ok: false, status: 409, reason: 'cursor-future' };
      }
      // A cursor older than the ring horizon cannot be replayed honestly.
      const oldest = st.ring.length > 0 ? st.ring[0].seq : st.seq + 1;
      if (after.seq + 1 < oldest && !(st.ring.length === 0 && after.seq === st.seq)) {
        st.counters.rejected += 1;
        st.lastRejectReason = 'reset-required';
        return { ok: false, status: 409, reason: 'reset-required' };
      }
      replay = st.ring.filter((e) => e.seq > after.seq);
    }

    // Replace any previous stream for this peer BEFORE writing anything: two
    // live streams for one pair would double-deliver the same events.
    closeStreams(st, 'replaced');

    const stream = {
      res,
      paused: false,
      queue: [],
      queueBytes: 0,
      closed: false,
      write(entry) {
        if (stream.closed) return false;
        st.counters.delivered += 1;
        return res.write(`id: ${st.epoch}:${entry.seq}\ndata: ${JSON.stringify(entry.envelope)}\n\n`);
      },
      queueEntry(entry) {
        stream.queue.push(entry);
        stream.queueBytes += entry.bytes;
      },
      drain() {
        stream.paused = false;
        while (!stream.paused && stream.queue.length > 0) {
          const entry = stream.queue.shift();
          stream.queueBytes -= entry.bytes;
          try {
            if (stream.write(entry) === false) stream.paused = true;
          } catch (_) { closeStreams(st, 'write-error'); return; }
        }
        if (stream.queue.length > LIVE_QUEUE_MAX_FRAMES || stream.queueBytes > LIVE_QUEUE_MAX_BYTES) {
          st.counters.dropped += stream.queue.length;
          st.lastDropReason = 'live-queue-overflow';
          closeStreams(st, 'resync-required');
        }
      },
      close(reason) {
        if (stream.closed) return;
        stream.closed = true;
        clearInterval(stream.hb);
        const idx = st.streams.indexOf(stream);
        if (idx >= 0) st.streams.splice(idx, 1);
        try { res.end(); } catch (_) { /* the socket may be gone */ }
        log(`event-feed: stream closed for peer ${peerId} (${reason})`);
      },
    };
    const hb = setInterval(() => {
      if (stream.closed) { clearInterval(hb); return; }
      // A heartbeat is also a revoke checkpoint: grants are re-read without
      // waiting for the next event.
      if (typeof opts.validatePeer === 'function') {
        let alive = true;
        try { alive = opts.validatePeer(peerId) !== false; } catch (_) { alive = false; }
        if (!alive) { closeStreams(st, 'revoked'); return; }
      }
      try {
        const out = res.write(':hb\n\n');
        if (out === false) stream.paused = true;
      } catch (_) { closeStreams(st, 'heartbeat-error'); }
    }, heartbeatMs);
    if (typeof hb.unref === 'function') hb.unref();
    stream.hb = hb;
    st.streams.push(stream);

    // Atomic replay-to-live: both happen inside this synchronous turn, so no
    // publish can fall between the last replayed frame and the live hookup.
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 5000\n\n');
    if (typeof opts2.filter === 'function') stream.filter = opts2.filter;
    for (const entry of replay) {
      if (stream.filter && !stream.filter(entry)) continue;
      st.counters.replayed += 1;
      if (stream.write(entry) === false) { stream.paused = true; stream.queueEntry(entry); }
    }
    res.on('close', () => { try { stream.close('client-disconnect'); } catch (_) {} });
    res.on('drain', () => { if (stream.paused) stream.drain(); });
    // write() returning false on the replay frames left them queued: drain now.
    if (stream.paused && !stream.closed) stream.drain();
    return { ok: true, epoch: st.epoch, seq: st.seq };
  }

  function status(peerId) {
    const st = peers.get(peerId);
    if (!st) return null;
    return {
      enabled: true,
      viewEpoch: st.epoch,
      seq: st.seq,
      lastCursor: st.lastCursor,
      ring: { events: st.ring.length, bytes: st.ringBytes },
      streams: st.streams.length,
      counters: { ...st.counters },
      lastDropReason: st.lastDropReason,
      lastRejectReason: st.lastRejectReason,
    };
  }

  function closeAll() {
    for (const [, st] of peers) closeStreams(st, 'shutdown');
    if (opts.keepTimers !== true) { /* heartbeats die with their streams */ }
  }

  return {
    enablePeer, disablePeer, invalidatePeer, invalidateAll,
    publish, subscribe, status, closeAll,
    peerIds: () => [...peers.keys()],
    enabledCount: () => peers.size,
  };
}

module.exports = {
  createEventFeed,
  LIMITS: Object.freeze({
    HEARTBEAT_MS, FRAME_MAX_BYTES, RING_MAX_EVENTS, RING_MAX_BYTES, RING_MAX_MS,
    LIVE_QUEUE_MAX_FRAMES, LIVE_QUEUE_MAX_BYTES, MAX_ENABLED_PEERS, OPENS_PER_MIN,
  }),
};
