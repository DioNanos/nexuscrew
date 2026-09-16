'use strict';
// lib/notify/event-feed-client.js — the subscriber that runs in the CLIENT
// server, one subscription per paired owner with eventsReceive=true.
//
// Hard rules (§3.5, §5): the peer is chosen ONLY from the authorized node
// store — never a host/port/URL taken from an event; the Hydra route is opened
// with the server-side Bearer; the FIRST access (and every reset) is a
// SNAPSHOT, then the SSE stream resumes from the snapshot cursor; a frame
// attributed to another owner disconnects the stream; imported events are
// re-emitted locally ONLY — they can never re-enter a publisher, so A→B→A
// dies by construction. Transport failures back off with jitter 5→60 s; a
// stream silent for 60 s is aborted and resynced.

const BACKOFF_MIN_MS = 5000;
const BACKOFF_MAX_MS = 60000;
const IDLE_TIMEOUT_MS = 60000;
const MAX_CONSECUTIVE_RESETS = 3;

function createEventFeedClient(opts = {}) {
  // deps: { nodesPath, token(), eventsHub, now, fetchImpl, log }
  const fetchImpl = opts.fetchImpl || fetch;
  const now = opts.now || Date.now;
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  // ownerId -> view state {cursor, generation, asks, notifications, fleetState,
  //   stale, lastError}; generation guards against obsolete fetches (§5.4).
  const views = new Map();
  const running = new Map(); // nodeId -> {abort}
  let stopped = false;
  let generation = 0;

  function backoffMs(peer) {
    const fails = (peer._fails || 0) + 1;
    peer._fails = fails;
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * Math.pow(2, fails - 1));
    return Math.floor(base / 2 + Math.random() * (base / 2));
  }

  function viewFor(ownerId) {
    if (!views.has(ownerId)) {
      views.set(ownerId, { ownerId, cursor: null, asks: [], notifications: [], fleetState: null, stale: true, generation: 0 });
    }
    return views.get(ownerId);
  }

  // One resync round that ended WITHOUT a usable frame counts as a reset: a
  // peer that keeps asking to resync (409 reset-required / cursor-future, or a
  // frame from an unknown epoch) would otherwise be re-snapshotted forever.
  // Past the cap the view goes to the error state and the poll gate stops it;
  // a single healthy frame clears the streak.
  function noteReset(view) {
    view.consecutiveResets = (view.consecutiveResets || 0) + 1;
    if (view.consecutiveResets >= MAX_CONSECUTIVE_RESETS) {
      view.stale = true;
      view.lastError = 'resync-exhausted';
    }
  }

  function routeUrl(peer, resource, query = '') {
    // Peer identity comes from the STORE record (name + localPort + token):
    // nothing here ever reads a target from an event frame.
    return `http://127.0.0.1:${peer.localPort}/federation/route/_/${resource.startsWith('/') ? resource.slice(1) : resource}${query}`;
  }

  function dedupKey(envelope) { return `${envelope.ownerId}:${envelope.eventId}`; }
  const seen = new Map(); // dedupKey -> at, bounded to the replay horizon

  function markSeen(key) {
    seen.set(key, now());
    if (seen.size > 2000) {
      const cutoff = now() - 16 * 60 * 1000;
      for (const [k, at] of seen) if (at < cutoff) seen.delete(k);
    }
  }

  // Apply a fetched snapshot ONLY if it belongs to the current generation:
  // an obsolete fetch must never overwrite a newer view (§5.4 — the snapshot
  // WINS over the previous view of the same owner).
  function applySnapshot(ownerId, snap, gen) {
    const view = viewFor(ownerId);
    if (gen !== generation) return false;
    view.cursor = snap.cursor || null;
    view.asks = Array.isArray(snap.asks) ? snap.asks.map((a) => ({ ...a, ownerId })) : [];
    view.notifications = Array.isArray(snap.notifications) ? snap.notifications.map((e) => ({ ...e, ownerId })) : [];
    view.fleetState = snap.fleetState || null;
    view.viewEpoch = snap.viewEpoch;
    view.stale = false;
    view.generation = gen;
    return true;
  }

  // Local re-emission of ONE imported envelope: attributed to the owner, into
  // the local SSE hub only. The hub is the browser-facing surface — this call
  // deliberately bypasses the notifier so the imported event can never be
  // recorded into a feed history or re-published to other peers.
  function reemit(envelope) {
    const key = dedupKey(envelope);
    if (seen.has(key)) return false;
    markSeen(key);
    if (!envelope.frame || envelope.hop !== 1) return false;
    const f = envelope.frame;
    if (f.type === 'notify') {
      opts.eventsHub.broadcast({
        type: 'notify', title: f.title, ...(f.body ? { body: f.body } : {}),
        urgency: f.urgency === 'high' ? 'high' : 'normal',
        ...(f.lang ? { lang: f.lang } : {}),
        originNode: envelope.ownerId, ownerId: envelope.ownerId,
        ...(envelope.scope === 'cell' && envelope.cellId ? { originCell: envelope.cellId } : {}),
        eventId: envelope.eventId, ts: Date.now(),
      });
    } else if (f.type === 'ask') {
      opts.eventsHub.broadcast({ type: 'ask', ownerId: envelope.ownerId, eventId: envelope.eventId,
        ask: { id: f.askId, question: f.question, options: f.options, session: f.session, ownerId: envelope.ownerId } });
    } else if (f.type === 'ask-closed') {
      opts.eventsHub.broadcast({ type: f.outcome === 'dismissed' ? 'ask-dismissed' : 'ask-answered',
        id: f.askId, ownerId: envelope.ownerId, eventId: envelope.eventId });
    } else if (f.type === 'file-notice') {
      opts.eventsHub.broadcast({ type: 'notify', title: `file: ${f.name}`, ...(f.caption ? { body: f.caption } : {}),
        originNode: envelope.ownerId, ownerId: envelope.ownerId, eventId: envelope.eventId, ts: Date.now() });
    } else if (f.type === 'fleet-state' || f.type === 'node-state') {
      opts.eventsHub.broadcast({ type: 'feed-state', ownerId: envelope.ownerId, eventId: envelope.eventId, state: f });
    }
    return true;
  }

  // One streaming session against one owner. Resolves when the stream ends.
  // First-hop identity headers: the visited chain starts with THIS node (the
  // owner's gate re-binds it to the token-authenticated peer, so a client can
  // only ever claim itself) and the hop proof is minted on the owner side.
  function identityHeaders(peer, store) {
    return {
      authorization: `Bearer ${peer.token}`,
      'x-nexuscrew-visited': store.nodeId,
    };
  }

  const ingress = { frames: [], bytes: [], globalFrames: [], globalBytes: [] };
  function ingressOver(t, bytes, ownerId) {
    const cutoff = t - 60000;
    const slide = (list) => { while (list.length && list[0].t <= cutoff) list.shift(); };
    slide(ingress.frames); slide(ingress.bytes); slide(ingress.globalFrames); slide(ingress.globalBytes);
    ingress.frames.push({ t, ownerId }); ingress.bytes.push({ t, bytes, ownerId });
    ingress.globalFrames.push({ t }); ingress.globalBytes.push({ t, bytes });
    const ownFrames = ingress.frames.filter((x) => x.ownerId === ownerId).length;
    const ownBytes = ingress.bytes.filter((x) => x.ownerId === ownerId).reduce((a, x) => a + x.bytes, 0);
    const globalBytes = ingress.globalBytes.reduce((a, x) => a + x.bytes, 0);
    return ownFrames > 120 || ownBytes > 1024 * 1024
      || ingress.globalFrames.length > 480 || globalBytes > 4 * 1024 * 1024;
  }

  async function streamOnce(peer, ownerId, store) {
    const view = viewFor(ownerId);
    const after = view.cursor ? `?after=${encodeURIComponent(view.cursor)}` : '';
    const ctrl = new AbortController();
    running.set(ownerId, { abort: () => ctrl.abort() });
    let timer = setTimeout(() => ctrl.abort(), IDLE_TIMEOUT_MS); // 60 s without bytes
    try {
      const r = await fetchImpl(routeUrl(peer, '/event-feed', after), {
        headers: identityHeaders(peer, store), signal: ctrl.signal,
      });
      if (r.status === 403 && (await r.json().catch(() => ({}))).reason === 'events-disabled') {
        view.stale = true; return;
      }
      if (r.status === 409) { // reset-required / cursor-future: resync from a fresh snapshot
        view.cursor = null;
        noteReset(view);
        return;
      }
      if (!r.ok) { view.stale = true; throw new Error(`event-feed HTTP ${r.status}`); }
      peer._fails = 0;
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        // ONE idle timer, rearmed on every chunk: a stale armed timeout must
        // never survive next to a new one.
        clearTimeout(timer);
        timer = setTimeout(() => ctrl.abort(), IDLE_TIMEOUT_MS);
        const chunk = dec.decode(value, { stream: true });
        buffer += chunk;
        // Ingress budget: a too-chatty owner is disconnected; the others keep
        // streaming untouched.
        if (ingressOver(Date.now(), Buffer.byteLength(chunk, 'utf8'), ownerId)) {
          view.lastError = 'ingress-budget';
          log(`event-feed-client: ${ownerId.slice(0, 8)}… over the ingress budget, disconnect`);
          return;
        }
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx); buffer = buffer.slice(idx + 2);
          if (block.startsWith(':')) continue; // heartbeat
          const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          // Frame cap BEFORE JSON.parse (§5).
          if (dataLine.length > 16 * 1024) { log('event-feed-client: oversized frame, resync'); view.cursor = null; return; }
          let envelope;
          try { envelope = JSON.parse(dataLine.slice(6)); } catch (_) { view.cursor = null; return; }
          // Owner mismatch on a frame: disconnect, never apply.
          if (envelope.ownerId !== ownerId) { log('event-feed-client: owner mismatch, disconnect'); return; }
          // Sequence continuity within the same epoch; anything else resyncs.
          const [, seqStr] = (block.split('\n').find((l) => l.startsWith('id: ')) || '').split(': ');
          const [epochStr, sStr] = String(seqStr || '').split(':');
          if (Number(epochStr) !== view.viewEpoch) {
            view.cursor = null;
            noteReset(view);
            return;
          }
          if (view.lastSeq !== undefined && Number(sStr) !== view.lastSeq + 1) { view.cursor = null; return; }
          view.lastSeq = Number(sStr);
          view.consecutiveResets = 0; // a usable frame: the streak is over
          view.cursor = `${epochStr}:${sStr}`;
          reemit(envelope);
        }
      }
    } finally {
      clearTimeout(timer);
      running.delete(ownerId);
    }
  }

  // Capability BEFORE subscribing: an owner without the feed capability makes
  // the view unsupported — no fallback, no infinite backoff.
  async function checkCapability(peer, ownerId) {
    const view = viewFor(ownerId);
    if (view.capabilityChecked) return true;
    // The health endpoint of the OWNER is probed directly (same pattern as
    // the tunnel health probe): /federation/health with the peer's token.
    const r = await fetchImpl(`http://127.0.0.1:${peer.localPort}/federation/health`, {
      headers: { authorization: `Bearer ${peer.token}` },
    });
    if (!r.ok) { view.stale = true; throw new Error(`health HTTP ${r.status}`); }
    const body = await r.json();
    console.error('[dbg-capability]', JSON.stringify({ eventFeedV1: body.eventFeedV1, instanceId: body.instanceId, ownerId }));
    if (body.eventFeedV1 !== true || body.instanceId !== ownerId) {
      view.unsupported = true;
      view.lastError = 'event-feed-unsupported';
      return false;
    }
    view.capabilityChecked = true;
    return true;
  }

  async function snapshotOnce(peer, ownerId, store) {
    const view = viewFor(ownerId);
    const gen = generation;
    const r = await fetchImpl(routeUrl(peer, '/event-feed/snapshot'), {
      headers: identityHeaders(peer, store),
    });
    if (!r.ok) { view.stale = true; throw new Error(`snapshot HTTP ${r.status}`); }
    // Size cap BEFORE JSON.parse: a body over the server budget is refused on
    // sight, never parsed.
    const text = await r.text();
    if (Buffer.byteLength(text, 'utf8') > 3 * 1024 * 1024) {
      view.stale = true; view.lastError = 'snapshot-oversize';
      return false;
    }
    const snap = JSON.parse(text);
    // Owner mismatch on the snapshot: disconnect, never apply.
    if (snap.ownerId !== ownerId) {
      view.stale = true; view.lastError = 'owner-mismatch';
      return false;
    }
    // Per-element sanity: bounded ids, bounded frames.
    if (Array.isArray(snap.notifications)) {
      for (const e of snap.notifications) {
        if (!e || typeof e.eventId !== 'string' || e.eventId.length > 64
          || Buffer.byteLength(JSON.stringify(e), 'utf8') > 16 * 1024) {
          view.stale = true; view.lastError = 'snapshot-element-oversize';
          return false;
        }
      }
    }
    // A snapshot over the server budget is a floor, not a whole: resync.
    if (snap.resyncRequired) { view.stale = true; return false; }
    applySnapshot(ownerId, snap, gen);
    return true;
  }

  // One reconciliation round across every enabled peer. Never throws.
  async function poll() {
    if (stopped) return;
    const store = opts.loadStore();
    if (!store) return;
    const peers = (store.nodes || []).filter((n) => n && n.direction === 'outbound'
      && n.eventsReceive === true && n.token && n.localPort && n.nodeId);
    await Promise.all(peers.map(async (peer) => {
      const ownerId = peer.nodeId;
      if (running.has(ownerId)) return; // one loop per pair
      const view = viewFor(ownerId);
      console.error('[dbg-poll]', ownerId.slice(0,8), 'unsupported=', !!view.unsupported, 'resets=', view.consecutiveResets||0);
      try {
        if (view.unsupported || (view.consecutiveResets || 0) >= MAX_CONSECUTIVE_RESETS
          || (view.ingressBlockedUntil || 0) > Date.now()) return;
        if (!view.capabilityChecked) {
          const ok = await checkCapability(peer, ownerId);
          if (!ok) return;
        }
        if (!view.cursor) {
          const ok = await snapshotOnce(peer, ownerId, store);
          if (!ok) return;
        }
        await streamOnce(peer, ownerId, store);
      } catch (e) {
        view.stale = true;
        // A named feed reason (e.g. owner-mismatch) survives a later transport
        // error: it is the reason the operator needs to see.
        if (view.lastError !== 'owner-mismatch') {
          view.lastError = String((e && e.message) || e);
        }
        const delay = backoffMs(peer);
        log(`event-feed-client: ${ownerId.slice(0, 8)}… retry in ${delay} ms (${view.lastError})`);
        setTimeout(() => { void poll(); }, delay);
      }
    }));
  }

  let pollTimer = null;
  function start() {
    stopped = false; generation += 1;
    void poll();
    // The store is written AFTER boot in real life (pairing happens later):
    // keep scanning for newly enabled peers. Streams are long-lived, so this
    // tick only ever picks up peers that are not running yet.
    if (!pollTimer) {
      pollTimer = setInterval(() => { void poll(); }, opts.pollMs || 4000);
      if (typeof pollTimer.unref === 'function') pollTimer.unref();
    }
  }
  function stop() {
    stopped = true; generation += 1;
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    for (const [, h] of running) { try { h.abort(); } catch (_) {} }
  }

  // Local aggregated read: connected views only, with the watermark the UI
  // needs to initialize without racing the live stream (§5.4).
  function state() {
    return {
      views: [...views.entries()].map(([ownerId, v]) => ({
        ownerId, cursor: v.cursor, viewEpoch: v.viewEpoch, stale: v.stale,
        lastError: v.lastError || null,
        asks: v.asks, notifications: v.notifications, fleetState: v.fleetState,
      })),
    };
  }

  return { start, stop, poll, state, reemit, viewFor };
}

module.exports = { createEventFeedClient };
