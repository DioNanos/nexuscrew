'use strict';
// lib/notify/event-feed-routes.js — the closed SSE/JSON surface of the event
// feed, mounted INSIDE the authenticated API.
//
// Gate order on every request: kill-switch → proven federated origin (hop
// proof + trust) → hop chain EXACTLY [clientId, ownerId] → peer known in the
// store → class grants. There is NO "no hop means local" fallback: a local
// Bearer alone never opens this surface, because the feed is by definition a
// per-peer view and a local caller is not a peer.
//
// Ask ACTION routes are a later stage by design: the class exists in the
// classifier, the routes do not exist here yet.

const express = require('express');
const nodesStore = require('../nodes/store.js');
const eventFeedAcl = require('./event-feed-acl.js');

const SNAPSHOT_MAX_BYTES = 3 * 1024 * 1024;
const SNAPSHOT_MAX_ASKS = 100;
const SNAPSHOT_MAX_NOTIFY = 50;
const SNAPSHOT_MAX_CELLS = 1000;
const SNAPSHOT_RATE_PER_MIN = 6;
const SNAPSHOT_TIMEOUT_MS = 30000;

function parseCursor(raw) {
  if (raw === undefined || raw === null || raw === '') return { cursor: null };
  const m = /^([0-9]{1,12}):([0-9]{1,12})$/.exec(String(raw));
  if (!m) return { error: 'bad-cursor' };
  return { cursor: { epoch: Number(m[1]), seq: Number(m[2]) } };
}

// The feed gate, shared by EVERY /event-feed/* surface (stream, snapshot and
// the federated ask routes): kill-switch -> proven federated origin -> exact
// [clientId, ownerId] hop chain -> peer known in the store -> eventsAccess.
// The ask routes add askReplyAccess + the ask's own cell scope on top, they do
// NOT replace any of these steps.
function createFeedGate(deps) {
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  return async function gate(req, res) {
    if (deps.eventsEnabled() !== true) {
      res.status(403).json({ error: 'event feed disabled on this node', reason: 'events-disabled' });
      return null;
    }
    const resolved = await deps.originResolver.resolve(req, { requireCell: false });
    if (!resolved.ok) {
      res.status(403).json({ error: 'forbidden', reason: resolved.reason });
      return null;
    }
    // No hop, no feed. A local Bearer is not a peer identity.
    if (resolved.trust !== 'federated') {
      res.status(403).json({ error: 'forbidden', reason: 'federated-origin-required' });
      return null;
    }
    const self = deps.localNodeId();
    const visited = Array.isArray(resolved.visited) ? resolved.visited : [];
    // Direct peers only, exact chain: [clientId, ownerId]. A longer chain is
    // a relay and is not traversed.
    if (!self || visited.length !== 2 || visited[1] !== self) {
      res.status(403).json({ error: 'forbidden', reason: 'hop-chain' });
      return null;
    }
    const store = nodesStore.loadStore(deps.nodesPath);
    if (!store) { res.status(503).json({ error: 'node store unavailable' }); return null; }
    const peer = eventFeedAcl.resolvePeer(store, visited[0]);
    if (!peer) { res.status(403).json({ error: 'forbidden', reason: 'peer-unknown' }); return null; }
    // Grant re-read BEFORE anything else in the request: the gate above is a
    // snapshot of a store read made a line earlier — good enough only because
    // it IS the fresh read.
    if (peer.grants.eventsAccess !== true) {
      res.status(403).json({ error: 'risorsa non concessa a questo nodo', reason: 'grant-required:event-feed' });
      return null;
    }
    if (deps.eventFeed) {
      try {
        if (!deps.eventFeed.status(peer.nodeId)) deps.eventFeed.enablePeer(peer.nodeId);
      } catch (e) {
        res.status(429).json({ error: String(e.message || e), reason: e.reason || 'peer-budget' });
        return null;
      }
    }
    return { peer, self, store };
  };
}

function createEventFeedRoutes(deps) {
  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const r = express.Router();
  // deps: { nodesPath, localNodeId, originResolver, eventFeed, history,
  //         asksStore, fleetP, eventsEnabled, log, cellForSession }
  const gate = createFeedGate(deps);

  // Snapshot rate, per peer, its own budget (never the notify/audio one).
  const snapshotOpens = new Map(); // nodeId -> [timestamps]

  r.get('/', async (req, res) => {
    const g = await gate(req, res);
    if (!g) return;
    const parsed = parseCursor(req.query.after);
    if (parsed.error) return res.status(400).json({ error: 'bad cursor', reason: parsed.error });
    const result = deps.eventFeed.subscribe(g.peer.nodeId, res, parsed.cursor);
    if (!result.ok) {
      if (!res.headersSent) return res.status(result.status).json({ error: 'cursor refused', reason: result.reason });
      return;
    }
    log(`event-feed: stream open for peer ${g.peer.nodeId} at ${g.peer.grants.signature ? '' : ''}${result.epoch}:${result.seq}`);
  });

  r.get('/snapshot', async (req, res) => {
    const g = await gate(req, res);
    if (!g) return;
    const cut = Date.now() - 60000;
    const opens = (snapshotOpens.get(g.peer.nodeId) || []).filter((t) => t > cut);
    if (opens.length >= SNAPSHOT_RATE_PER_MIN) {
      return res.status(429).json({ error: 'snapshot rate', reason: 'snapshot-rate' });
    }
    opens.push(Date.now());
    snapshotOpens.set(g.peer.nodeId, opens);

    const timeout = new Promise((resolve) => setTimeout(() => resolve('timeout'), SNAPSHOT_TIMEOUT_MS));
    const work = buildSnapshot(g);
    const built = await Promise.race([work, timeout]);
    if (built === 'timeout') {
      return res.status(503).json({ error: 'snapshot timeout', reason: 'snapshot-timeout' });
    }
    // A build can wait up to 30 s on the fleet: the kill switch and the grants
    // are RE-READ after it, so a revocation during the build wins over the
    // response (stale content never ships).
    if (deps.eventsEnabled() !== true) {
      return res.status(403).json({ error: 'event feed disabled on this node', reason: 'events-disabled' });
    }
    const fresh = await gate(req, res);
    if (!fresh) return;
    const body = Buffer.from(JSON.stringify(built), 'utf8');
    if (body.length > SNAPSHOT_MAX_BYTES) {
      // An over-budget snapshot is declared, never shipped as a "complete"
      // partial.
      return res.status(409).json({ error: 'snapshot over budget', reason: 'resync-required' });
    }
    res.set('Cache-Control', 'no-store');
    return res.json(built);
  });

  // Cell-scoped stream: same grants, one cell, still per-peer view.
  r.get('/:cellId', async (req, res) => {
    const g = await gate(req, res);
    if (!g) return;
    const cellId = String(req.params.cellId || '');
    if (!g.peer.allows({ scope: 'cell', cellId })) {
      return res.status(403).json({ error: 'risorsa non concessa a questo nodo', reason: 'grant-required:event-feed' });
    }
    const parsed = parseCursor(req.query.after);
    if (parsed.error) return res.status(400).json({ error: 'bad cursor', reason: parsed.error });
    const result = deps.eventFeed.subscribe(g.peer.nodeId, res, parsed.cursor, {
      filter: (entry) => entry.envelope.scope === 'cell' && entry.envelope.cellId === cellId,
    });
    if (!result.ok) {
      if (!res.headersSent) return res.status(result.status).json({ error: 'cursor refused', reason: result.reason });
      return;
    }
  });

  // Node-scoped stream: needs nodeEventsAccess; the node id must be THIS node.
  r.get('/node/:nodeId', async (req, res) => {
    const g = await gate(req, res);
    if (!g) return;
    if (String(req.params.nodeId || '') !== g.self) {
      return res.status(403).json({ error: 'forbidden', reason: 'wrong-node' });
    }
    if (g.peer.grants.nodeEventsAccess !== true) {
      return res.status(403).json({ error: 'risorsa non concessa a questo nodo', reason: 'grant-required:node-event-feed' });
    }
    const parsed = parseCursor(req.query.after);
    if (parsed.error) return res.status(400).json({ error: 'bad cursor', reason: parsed.error });
    const result = deps.eventFeed.subscribe(g.peer.nodeId, res, parsed.cursor, {
      filter: (entry) => entry.envelope.scope === 'node',
    });
    if (!result.ok) {
      if (!res.headersSent) return res.status(result.status).json({ error: 'cursor refused', reason: result.reason });
      return;
    }
  });

  async function buildSnapshot({ peer, self }) {
    // Cursor captured atomically with the snapshot content: the feed engine is
    // synchronous, so one turn later nothing has been inserted in between.
    const st = deps.eventFeed.status(peer.nodeId);
    const cursor = st ? `${st.viewEpoch}:${st.seq}` : null;
    const viewEpoch = st ? st.viewEpoch : null;

    // Asks: open asks of VISIBLE cells only, capped.
    let asks = [];
    try {
      const open = deps.asksStore.list({ open: true }) || [];
      const visible = open
        .map((a) => ({ id: a.id, question: a.question, options: a.options, session: a.session, ts: a.ts }))
        .filter((a) => peer.allows({ scope: 'cell', cellId: deps.cellForSession(a.session) }))
        .slice(0, SNAPSHOT_MAX_ASKS);
      asks = visible;
    } catch (_) { asks = []; }

    // Notify history: local-only, ACL-filtered per envelope, capped.
    const notifications = deps.history.list()
      .filter((e) => peer.allows(e.envelope))
      .map((e) => {
        // Node frames can carry cell lists (fleet state): project them with
        // the same visibility rule, so history never leaks hidden cells.
        if (e.envelope.scope === 'node' && Array.isArray(e.envelope.frame && e.envelope.frame.cells)) {
          const cells = peer.projectCells(e.envelope.frame.cells);
          return { ...e, envelope: { ...e.envelope, frame: { ...e.envelope.frame, cells } } };
        }
        return e;
      })
      .slice(-SNAPSHOT_MAX_NOTIFY);

    // Fleet state: projected by visibility, hidden cells contribute nothing.
    let fleetState = { available: false, cells: [] };
    try {
      const fleet = await deps.fleetP;
      if (fleet && typeof fleet.status === 'function') {
        const stt = await fleet.status();
        const raw = (stt && Array.isArray(stt.cells) ? stt.cells : [])
          .slice(0, SNAPSHOT_MAX_CELLS)
          .map((c) => ({ cell: c && c.cell, active: c && c.active === true }));
        fleetState = { available: stt && stt.available === true, cells: peer.projectCells(raw) };
      }
    } catch (_) { /* fleet unavailable: declared, not faked */ }

    const built = {
      v: 1,
      ownerId: self,
      peerId: peer.nodeId,
      viewEpoch,
      cursor,
      // Whether THIS peer may answer/dismiss the owner's asks: the UI gates
      // the remote reply affordance on it (read-only otherwise).
      askReplyAccess: peer.grants.askReplyAccess === true,
      asks,
      notifications: notifications.map((e) => e.envelope),
      fleetState,
      nodeState: { nodeId: self },
      historyStatus: deps.history.status(),
    };
    if (asks.length >= SNAPSHOT_MAX_ASKS
      || notifications.length >= SNAPSHOT_MAX_NOTIFY
      || (fleetState.cells || []).length >= SNAPSHOT_MAX_CELLS) {
      built.resyncRequired = true; // at a cap: the client must treat this as a floor, not a whole
    }
    return built;
  }

  return r;
}

module.exports = { createEventFeedRoutes, parseCursor, createFeedGate };
