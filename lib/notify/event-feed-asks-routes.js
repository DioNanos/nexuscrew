'use strict';
// lib/notify/event-feed-asks-routes.js — federated ask ANSWER surface.
//
//   POST   /event-feed/asks/:id/answer          {text, requestId}  (closed body)
//   DELETE /event-feed/asks/:id                                    (dismiss)
//   GET    /event-feed/asks/:id/requests/:requestId               (attempt status)
//
// The gate is the SAME as the stream/snapshot gate (kill-switch -> proven
// federated origin -> exact [clientId, ownerId] -> known peer -> eventsAccess)
// PLUS askReplyAccess plus the ask's own cell scope read from the ask store.
// Unknown and out-of-scope ids get the SAME opaque 404: an id that does not
// exist and an id the peer may not see must be indistinguishable. Answer and
// dismiss run on a DEDICATED budget (6/min/peer, 30/min global) that shares
// nothing with notify/audio/local ask creation.

const express = require('express');
const { createFeedGate } = require('./event-feed-routes.js');

const ANSWER_RATE_PER_MIN = 6;
const ANSWER_GLOBAL_PER_MIN = 30;

function createAskRateLimiter({ now = Date.now } = {}) {
  const perPeer = new Map();
  const global = [];
  function prune(list, t) {
    const cutoff = t - 60000;
    while (list.length > 0 && list[0] <= cutoff) list.shift();
  }
  function check(peerId) {
    const t = now();
    const list = perPeer.get(peerId) || [];
    prune(list, t); prune(global, t);
    if (list.length >= ANSWER_RATE_PER_MIN || global.length >= ANSWER_GLOBAL_PER_MIN) {
      return { allowed: false, reason: 'answer-rate' };
    }
    list.push(t); perPeer.set(peerId, list); global.push(t);
    return { allowed: true };
  }
  return { check };
}

function createEventFeedAsksRoutes(deps) {
  const r = express.Router();
  const json = express.json({ limit: '16kb' });
  // deps: { nodesPath, localNodeId, originResolver, eventsEnabled, asks,
  //         answerService, cellForSession, log }
  const gate = createFeedGate(deps);
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

  r.post('/:id/answer', json, async (req, res) => {
    const g = await gate(req, res);
    if (!g) return;
    const verdict = rate.check(g.peer.nodeId);
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
      askId, text: body.text, peerId: g.peer.nodeId, requestId: body.requestId,
    });
    if (out.ok) {
      // La chiusura nasce dal servizio; qui si aspetta il recapito, cosi' chi ha
      // risposto non vede una risposta che precede la chiusura dei peer.
      if (out.closure) { try { await out.closure; } catch (_) {} }
      return res.json({ status: out.replay ? out.state : 'committed', requestId: body.requestId });
    }
    return res.status(out.code || 500).json({ error: out.error, reason: out.reason });
  });

  r.delete('/:id', async (req, res) => {
    const g = await gate(req, res);
    if (!g) return;
    const verdict = rate.check(g.peer.nodeId);
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
    // Local answer in flight wins: 409, and a dismissed ask is not answerable.
    const out = deps.answerService.dismiss(askId);
    if (!out.ok) {
      if (out.reason === 'unknown') return res.status(404).json({ error: 'ask inesistente' });
      if (out.reason === 'answering') return res.status(409).json({ error: 'risposta in corso: non si scarta un ask in answering' });
      return res.status(500).json({ error: 'dismiss non riuscito' });
    }
    if (out.closure) { try { await out.closure; } catch (_) {} }
    return res.json({ dismissed: true, id: askId, idempotent: out.idempotent === true });
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
    const entry = deps.receipts.get(g.peer.nodeId, askId, requestId);
    if (!entry) return res.status(404).json({ error: 'ask inesistente' });
    return res.json({
      requestId, askId, state: entry.state,
      ...(entry.receipt ? { receipt: entry.receipt } : {}),
      ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {}),
    });
  });

  return r;
}

module.exports = { createEventFeedAsksRoutes, createAskRateLimiter };
