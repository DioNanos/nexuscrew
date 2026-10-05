'use strict';
// lib/notify/event-feed-asks-routes.js — federated ask ANSWER surface.
//
//   POST   /event-feed/asks/:id/answer          {text, requestId}  (closed body)
//   DELETE /event-feed/asks/:id                                    (dismiss)
//   GET    /event-feed/asks/:id/requests/:requestId               (attempt status)
//
// The action gate verifies the bounded origin chain and the delivering peer,
// then intersects fresh ASK grants and the authoritative ask cell scope.
// It is independent of the stream/snapshot gate and local feed reception.
// Unknown and out-of-scope ids get the SAME opaque 404: an id that does not
// exist and an id the peer may not see must be indistinguishable. Answer and
// dismiss run on a DEDICATED budget (6/min/peer, 30/min global) that shares
// nothing with notify/audio/local ask creation.

const express = require('express');
const nodesStore = require('../nodes/store.js');
const accessPresets = require('../nodes/access-presets.js');
const { createAudioAcl } = require('../audio/acl.js');
const { visibilityAllows } = require('./event-feed-acl.js');

const ANSWER_RATE_PER_MIN = 6;
const ANSWER_GLOBAL_PER_MIN = 30;

function createAskRateLimiter({ now = Date.now } = {}) {
  const perPeer = new Map();
  const perOrigin = new Map();
  const global = [];
  function prune(list, t) {
    const cutoff = t - 60000;
    while (list.length > 0 && list[0] <= cutoff) list.shift();
  }
  function check(peerId, actorId = peerId) {
    const t = now();
    const list = perPeer.get(peerId) || [];
    const origin = perOrigin.get(actorId) || [];
    prune(list, t); prune(origin, t); prune(global, t);
    if (list.length >= ANSWER_RATE_PER_MIN || origin.length >= ANSWER_RATE_PER_MIN || global.length >= ANSWER_GLOBAL_PER_MIN) {
      return { allowed: false, reason: 'answer-rate' };
    }
    list.push(t); perPeer.set(peerId, list); origin.push(t); perOrigin.set(actorId, origin); global.push(t);
    return { allowed: true };
  }
  return { check };
}

function createAskActionGate(deps) {
  return async (req, res) => {
    const refuse = (code, reason) => { res.status(code).json({ error: 'forbidden', reason }); return null; };
    if (deps.eventsEnabled() !== true) return refuse(403, 'events-disabled');
    const resolved = await deps.originResolver.resolve(req, { requireCell: false });
    if (!resolved.ok) return refuse(403, resolved.reason);
    if (resolved.trust !== 'federated') return refuse(403, 'federated-origin-required');
    const visited = resolved.visited || [];
    const self = deps.localNodeId();
    if (visited.length < 2 || visited.at(-1) !== self) return refuse(403, 'hop-chain');
    const st = nodesStore.loadStore(deps.nodesPath);
    if (!st) return refuse(503, 'store-unavailable');
    const deliveringId = visited.at(-2);
    const delivering = (st.nodes || []).filter((n) => n && n.nodeId === deliveringId);
    if (delivering.length !== 1) return refuse(403, 'peer-unknown');
    const acl = createAudioAcl({ nodesPath: deps.nodesPath, loadStoreImpl: () => st });
    const visibility = acl.allows(resolved);
    if (!visibility.allowed) return refuse(403, visibility.reason);
    const actor = resolved.origin.node;
    const origins = actor === deliveringId ? [] : (st.nodes || []).filter((n) => n && n.nodeId === actor);
    if (origins.length > 1) return refuse(403, 'peer-unknown');
    const grants = [delivering[0], ...origins].map((node) => accessPresets.grantsOf(node));
    if (grants.some((view) => !view.configured || view.grants.eventsAccess !== true || view.grants.askReplyAccess !== true)) {
      return refuse(403, 'grant-required:ask-action');
    }
    return { self, actor, peer: { nodeId: deliveringId, grants: grants[0].grants,
      allows: ({ cellId }) => grants.every((view) => visibilityAllows(view.grants, cellId)) } };
  };
}

function createEventFeedAsksRoutes(deps) {
  const r = express.Router();
  const json = express.json({ limit: '16kb' });
  // deps: { nodesPath, localNodeId, originResolver, eventsEnabled, asks,
  //         answerService, cellForSession, log }
  const gate = createAskActionGate(deps);
  const rate = createAskRateLimiter({ now: deps.now });
  const log = typeof deps.log === 'function' ? deps.log : () => {};

  // Resolve the ask for THIS peer: the cell comes from the ask store (never
  // from the request), then the peer's cell scope decides. Unknown and
  // out-of-scope are the same opaque 404.
  function resolveAskForPeer(peer, askId) {
    const ask = deps.asks.get(askId);
    if (!ask) return null;
    const cellId = deps.cellForSession(ask.session);
    if (!cellId || !peer.allows({ scope: 'cell', cellId })) return null;
    return { ask, cellId };
  }

  r.get('/:id/capability', async (req, res) => {
    const g = await gate(req, res);
    if (!g) return;
    const askId = String(req.params.id || '');
    const resolved = resolveAskForPeer(g.peer, askId);
    const readonly = deps.readonly && deps.readonly();
    const status = !resolved || readonly ? 'denied'
      : resolved.ask.dismissed ? 'dismissed' : resolved.ask.answered ? 'answered' : 'open';
    return res.json({ ownerId: g.self, askId, canReply: status === 'open', status,
      ...(resolved && !readonly ? { generationPrecondition: true, ask: { id: resolved.ask.id, ts: resolved.ask.ts, question: resolved.ask.question,
        ...(resolved.ask.options ? { options: resolved.ask.options } : {}), session: resolved.ask.session } } : {}) });
  });

  r.post('/:id/answer', json, async (req, res) => {
    const g = await gate(req, res);
    if (!g) return;
    const verdict = rate.check(g.peer.nodeId, g.actor);
    if (!verdict.allowed) return res.status(429).json({ error: 'answer rate', reason: verdict.reason });
    if (deps.readonly && deps.readonly()) {
      return res.status(403).json({ error: 'READONLY: mutazione bloccata' });
    }
    // askReplyAccess on top of the feed gate: seeing the card does not
    // grant the action. It is re-read with the same fresh store the gate used.
    if (g.peer.grants.askReplyAccess !== true) {
      return res.status(403).json({ error: 'risorsa non concessa a questo nodo', reason: 'grant-required:ask-action' });
    }
    const askId = String(req.params.id || '');
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    // CLOSED body: {text, requestId}. Anything that tries to choose a session,
    // a target or an origin is a 400 before any other consideration.
    for (const key of Object.keys(body)) {
      if (!['text', 'requestId'].includes(key)) {
        return res.status(400).json({ error: `campo non ammesso: "${key}"` });
      }
    }
    if (typeof body.text !== 'string') return res.status(400).json({ error: 'text deve essere una stringa' });
    const resolved = resolveAskForPeer(g.peer, askId);
    if (!resolved) return res.status(404).json({ error: 'ask inesistente' });
    const out = await deps.answerService.answerFederated({
      askId, text: body.text, peerId: g.actor, requestId: body.requestId,
    });
    if (out.ok) {
      // La chiusura nasce dal servizio; qui si aspetta il recapito, cosi' chi ha
      // risposto non vede una risposta che precede la chiusura dei peer.
      if (out.closure) { try { await out.closure; } catch (_) {} }
      return res.json({ status: out.replay ? out.state : 'committed', requestId: body.requestId,
        ownerId: g.self, askId, actor: g.actor });
    }
    return res.status(out.code || 500).json({ error: out.error, reason: out.reason });
  });

  r.delete('/:id', async (req, res) => {
    const g = await gate(req, res);
    if (!g) return;
    const verdict = rate.check(g.peer.nodeId, g.actor);
    if (!verdict.allowed) return res.status(429).json({ error: 'answer rate', reason: verdict.reason });
    if (deps.readonly && deps.readonly()) {
      return res.status(403).json({ error: 'READONLY: mutazione bloccata' });
    }
    if (g.peer.grants.askReplyAccess !== true) {
      return res.status(403).json({ error: 'risorsa non concessa a questo nodo', reason: 'grant-required:ask-action' });
    }
    const askId = String(req.params.id || '');
    const resolved = resolveAskForPeer(g.peer, askId);
    if (!resolved) return res.status(404).json({ error: 'ask inesistente' });
    const expected = req.headers['x-nexuscrew-ask-ts'];
    if (expected !== undefined && (typeof expected !== 'string' || !/^[1-9][0-9]{0,15}$/.test(expected)
      || !Number.isSafeInteger(Number(expected)))) {
      return res.status(400).json({ error: 'invalid generation precondition', reason: 'invalid-generation' });
    }
    // Keep the generation and terminal guards next to the synchronous service:
    // authorization may await, but no yield is allowed between this check and dismiss.
    if (expected !== undefined && resolved.ask.ts !== Number(expected)) {
      return res.status(409).json({ error: 'ask generation changed', reason: 'generation-mismatch' });
    }
    if (resolved.ask.answered) return res.json({ dismissed: false, id: askId, outcome: 'answered', idempotent: true });
    if (resolved.ask.dismissed) return res.json({ dismissed: true, id: askId, outcome: 'dismissed', idempotent: true });
    const out = deps.answerService.dismiss(askId);
    if (!out.ok) {
      if (out.reason === 'unknown') return res.status(404).json({ error: 'ask inesistente' });
      if (['answering', 'delivery-unknown-block'].includes(out.reason)) return res.status(409).json({ error: out.error || 'ask cannot be dismissed', reason: out.reason });
      return res.status(out.code || 500).json({ error: out.error || 'dismiss failed', reason: out.reason });
    }
    if (out.closure) { try { await out.closure; } catch (_) {} }
    return res.json({ dismissed: true, id: askId, outcome: 'dismissed', idempotent: out.idempotent === true });
  });

  r.get('/:id/requests/:requestId', async (req, res) => {
    const g = await gate(req, res);
    if (!g) return;
    if (g.peer.grants.askReplyAccess !== true) {
      return res.status(403).json({ error: 'risorsa non concessa a questo nodo', reason: 'grant-required:ask-action' });
    }
    const askId = String(req.params.id || '');
    const requestId = String(req.params.requestId || '');
    const resolved = resolveAskForPeer(g.peer, askId);
    if (!resolved) return res.status(404).json({ error: 'ask inesistente' });
    // Scoped: a peer sees ONLY its own attempts, and never the answer text of
    // anyone — the receipt carries a digest, not a payload.
    const entry = deps.receipts.get(g.actor, askId, requestId);
    if (!entry) return res.status(404).json({ error: 'ask inesistente' });
    return res.json({
      requestId, askId, ownerId: g.self, actor: g.actor, state: entry.state,
      ...(entry.receipt ? { receipt: entry.receipt } : {}),
      ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
    });
  });

  return r;
}

module.exports = { createEventFeedAsksRoutes, createAskRateLimiter };
