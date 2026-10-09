'use strict';
// lib/notify/event-feed-notices-routes.js — the OWNER's notice dismissal surface.
//
//   DELETE /event-feed/notices/:eventId      clear one notice
//   POST   /event-feed/notices/dismiss-all   clear the visible set (closed body)
//
// The owner is the source of truth for its own notices, so this is where a
// dismissal is registered: the snapshot it serves stops carrying the entry
// (every other device inherits that at its next read) and a closure frame is
// published for the peers that already hold the card live.
//
// Authorization is the ask-action pattern, reused verbatim: kill switch →
// proven federated origin → chain ending here (direct or two hops) → visibility
// ACL of the origin → `eventsAccess` + `askReplyAccess` on EVERY ring. Seeing a
// notice is not what grants clearing it, and no new grant name is invented.
//
// Unknown and out-of-scope ids get the SAME opaque 404: an id that does not
// exist and an id the peer may not see must be indistinguishable. The budget is
// its own instance (6/min/peer, 30/min global) and `dismiss-all` counts once:
// N DELETEs through two hops would die in the per-request budget.

const express = require('express');
const { createAskActionGate, createAskRateLimiter } = require('./event-feed-asks-routes.js');

// The event id is a crypto.randomUUID() minted by the producer registry: it is
// validated here BEFORE any use — a path is never built from a request value.
const EVENT_ID_RE = /^[0-9a-f-]{36}$/;
// Same cap as SNAPSHOT_MAX_NOTIFY: `dismiss-all` covers what the peer can see,
// which is what the snapshot it just read held.
const MAX_VISIBLE = 50;

function createEventFeedNoticesRoutes(deps) {
  const r = express.Router();
  const json = express.json({ limit: '8kb' });
  const gate = createAskActionGate(deps);
  const rate = createAskRateLimiter({ now: deps.now });
  const log = typeof deps.log === 'function' ? deps.log : () => {};

  // Resolve the notice for THIS peer: it must be in the history of the owner
  // AND visible to the ASKING peer under the grants of the owner, by the same
  // rule the snapshot applies to the envelope it would ship. Visibility is a
  // decision of the ORIGIN (cross-chain transit is gated earlier in the hop
  // chain): a relay never gains a visibility of its own.
  function resolveNoticeForPeer(peer, eventId) {
    const entry = deps.history.list().find((e) => e && e.eventId === eventId);
    if (!entry || !entry.envelope) return null;
    if (!peer.allowsEnvelope(entry.envelope)) return null;
    return entry;
  }

  // The closure inherits scope and cell of the original, so the publisher
  // delivers it to exactly the peers that could see that notice. A failure to
  // publish never turns a registered dismissal into an error: the entry is
  // already gone from the snapshot, which is the durable half.
  async function publishClosures(entries) {
    for (const entry of entries) {
      try {
        await deps.closeNotice({
          scope: entry.envelope.scope,
          cellId: entry.envelope.scope === 'cell' ? entry.envelope.cellId : null,
          eventId: entry.eventId,
        });
      } catch (e) {
        log(`notices: closure not published for ${String(entry.eventId).slice(0, 8)}: ${String((e && e.message) || e)}`);
      }
    }
  }

  r.delete('/:eventId', async (req, res) => {
    const g = await gate(req, res);
    if (!g) return;
    const verdict = rate.check(g.peer.nodeId, g.actor);
    if (!verdict.allowed) return res.status(429).json({ error: 'dismiss rate', reason: verdict.reason });
    if (deps.readonly && deps.readonly()) {
      return res.status(403).json({ error: 'READONLY: mutazione bloccata' });
    }
    if (g.peer.grants.askReplyAccess !== true) {
      return res.status(403).json({ error: 'risorsa non concessa a questo nodo', reason: 'grant-required:ask-action' });
    }
    const eventId = String(req.params.eventId || '');
    if (!EVENT_ID_RE.test(eventId)) {
      return res.status(400).json({ error: 'eventId non valido' });
    }
    const entry = resolveNoticeForPeer(g.peer, eventId);
    if (!entry) {
      // Unknown and invisible are the same answer, so the surface cannot be
      // used to probe the owner's history.
      return res.status(404).json({ error: 'notify inesistente' });
    }
    const already = deps.dismissals.isDismissed(eventId);
    if (already) return res.json({ dismissed: true, idempotent: true });
    const written = deps.dismissals.dismiss(eventId);
    if (!written.ok) {
      // The store refused to represent the dismissal (declared as a
      // degradation): answering 200 would claim a truth we do not hold.
      return res.status(503).json({ error: 'dismissals unavailable', reason: written.reason });
    }
    await publishClosures([entry]);
    return res.json({ dismissed: true, idempotent: false });
  });

  r.post('/dismiss-all', json, async (req, res) => {
    const g = await gate(req, res);
    if (!g) return;
    const verdict = rate.check(g.peer.nodeId, g.actor);
    if (!verdict.allowed) return res.status(429).json({ error: 'dismiss rate', reason: verdict.reason });
    if (deps.readonly && deps.readonly()) {
      return res.status(403).json({ error: 'READONLY: mutazione bloccata' });
    }
    if (g.peer.grants.askReplyAccess !== true) {
      return res.status(403).json({ error: 'risorsa non concessa a questo nodo', reason: 'grant-required:ask-action' });
    }
    // CLOSED body: the set to clear is what the peer can see, never a list the
    // request brings. A body that tries to choose it is a 400 before anything.
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    for (const key of Object.keys(body)) {
      return res.status(400).json({ error: `campo non ammesso: "${key}"` });
    }
    const visible = deps.history.list()
      .filter((e) => e && e.envelope && g.peer.allowsEnvelope(e.envelope))
      .slice(-MAX_VISIBLE);
    const cleared = [];
    for (const entry of visible) {
      if (deps.dismissals.isDismissed(entry.eventId)) continue;
      const written = deps.dismissals.dismiss(entry.eventId);
      if (written.ok) cleared.push(entry);
    }
    await publishClosures(cleared);
    return res.json({ dismissed: cleared.length });
  });

  return r;
}

module.exports = { createEventFeedNoticesRoutes, EVENT_ID_RE, MAX_VISIBLE };
