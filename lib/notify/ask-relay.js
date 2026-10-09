'use strict';
// lib/notify/ask-relay.js — the client-side relay for federated ask answers.
//
// The local endpoint receives {ownerId, askId, text, requestId} from the PWA.
// The route to the owner is resolved from the AUTHORIZED node store (the
// outbound peer whose nodeId is the owner) — never from anything an event
// said. The forward uses the peer's own pair token and the visited header;
// the hop proof is minted by the owner on the last hop.
//
// Outcome contract: a committed/failed answer is final. An uncertain
// outcome (timeout, network error after the request left) is NOT retried: the
// attempt is parked as "uncertain" and the only allowed action is "verify
// status" (GET .../requests/:requestId). A new paste for the same ask is
// refused locally until verification resolves the attempt.

const crypto = require('node:crypto');
const { probeReverseSlot } = require('../nodes/reverse-slot-proof.js');
const { askSlotVerifier } = require('../nodes/ask-slot-verifier.js');
const { createOwnerChannel } = require('./owner-channel.js');
const OWNER_REASONS = new Set([
  'reverse-slot-unverified', 'peer-unknown', 'events-disabled', 'grant-required:ask-action',
  'peer-visibility', 'origin-visibility', 'federated-origin-required', 'hop-chain',
  'store-unavailable', 'unknown-peer', 'unknown-trust', 'no-delivering-peer',
  'no-node-identity', 'bad-visited', 'bad-hop', 'self-hop', 'bad-attested-cell',
  'origin-mismatch', 'fleet-unavailable', 'cell-not-active', 'answer-rate',
  'unknown', 'dismissed', 'answering', 'answered', 'store-unreadable',
  'delivery-unknown-block', 'already-delivered', 'paste-failed', 'bad-request-id',
  'no-receipts', 'request-conflict', 'receipt-cap', 'federation-peer-unreachable',
  'federation-peer-timeout', 'federation-body-consumed', 'generation-mismatch', 'invalid-generation', 'unsupported',
]);
function safeReason(reason) { return OWNER_REASONS.has(reason) ? reason : undefined; }

function createAskRelay({ loadStore, now = Date.now, fetchImpl = fetch, log = () => {}, probeReverseSlotImpl = probeReverseSlot, peers = null, localPort = () => 0, localToken = () => '', nodesPath = null, availabilityBinding = () => null, slotVerifier = askSlotVerifier } = {}) {
  // (ownerId|askId|requestId) -> {state: 'sent'|'committed'|'failed'|'uncertain', requestId}
  const channelObservations = new Map();
  const attempts = new Map();
  const answerFlights = new Map();

  const attemptKey = (ownerId, askId, rid) => `${ownerId}|${askId}|${rid}`;
  // The channel to the owner (resolution, deadline, forwarding, hop proof) is
  // SHARED with the notice dismissals: one implementation, one chain rule.
  const channel = createOwnerChannel({
    loadStore, now, fetchImpl, probeReverseSlotImpl, peers, localPort, localToken, nodesPath, slotVerifier,
    sanitizeReason: safeReason,
    onUncertain: (args) => {
      const entry = attempts.get(attemptKey(args.ownerId, args.askId, args.rid));
      if (entry) entry.state = 'uncertain';
    },
  });
  function requestId() { return crypto.randomUUID(); }

  function statusFor(ownerId, askId) {
    const out = [];
    for (const [key, a] of attempts) {
      if (key.startsWith(`${ownerId}|${askId}|`)) out.push(a);
    }
    return out;
  }

  function isUncertain(ownerId, askId) {
    return statusFor(ownerId, askId).some((a) => a.state === 'uncertain');
  }

  // Il blocco precedente rifiuta il nuovo requestId PRIMA di creare la sua
  // ricevuta: la sola verifica possibile e' sull'ID originale ancora 'sent'
  // (se esiste), altrimenti resta solo la riconciliazione con l'owner.
  function originalSentRequestId(ownerId, askId, excludeRid) {
    const sent = statusFor(ownerId, askId)
      .filter((a) => (a.state === 'sent' || a.state === 'uncertain') && a.requestId !== excludeRid);
    return sent.length ? sent[sent.length - 1].requestId : null;
  }

  async function relayAnswerOnce({ ownerId, askId, text, rid: providedRid } = {}, op) {
    if (!ownerId || !askId || typeof text !== 'string' || !text.trim()) {
      return { ok: false, code: 400, error: 'ownerId, askId e text richiesti' };
    }
    const candidate = await channel.candidateOwner(ownerId, op);
    if (!candidate) return { ok: false, code: 404, error: 'owner non tra i peer autorizzati', reason: 'owner-unknown' };
    if (candidate.kind === 'inbound-unverified') {
      return { ok: false, code: 404, error: 'canale reverse non verificato: risposta non inoltrata', reason: 'reverse-slot-unverified' };
    }
    if (candidate.kind === 'inbound') {
      const gate = await channel.verifyInboundChannel(candidate, op);
      if (!gate.ok) return { ok: false, code: gate.code, error: gate.error, reason: gate.reason };
    }
    const peer = candidate.node;
    // Local reconciliation FIRST: an uncertain attempt on this ask must be
    // verified before any new paste leaves this node.
    if (isUncertain(ownerId, askId)) {
      // L'ID originale e' quello verificabile: il nuovo invio non e' mai partito.
      return { ok: false, code: 409, error: 'esito incerto: verifica lo stato prima di rispondere', reason: 'uncertain', uncertain: true,
        originalRequestId: originalSentRequestId(ownerId, askId) };
    }
    const rid = providedRid || requestId();
    const key = attemptKey(ownerId, askId, rid);
    const store = loadStore();
    attempts.set(key, { requestId: rid, state: 'sent', askId, ownerId, digest: crypto.createHash('sha256').update(text).digest('hex') });
    try {
      const { r, body } = await channel.forward(candidate, `/event-feed/asks/${encodeURIComponent(askId)}/answer`, {
        method: 'POST', body: { text, requestId: rid }, op,
      });
      op.check();
      if (r.status === 200) {
        const state = body.status === 'answered' ? 'committed' : body.status;
        if (!['committed', 'failed'].includes(state)) {
          attempts.get(key).state = 'uncertain';
          return { ok: false, code: 200, uncertain: true, requestId: rid, reason: 'delivery-unknown' };
        }
        attempts.get(key).state = body.replay ? (body.state || state) : state;
        return { ok: true, status: attempts.get(key).state, requestId: rid,
          ...(body.ownerId ? { ownerId: body.ownerId } : {}), ...(body.askId ? { askId: body.askId } : {}),
          ...(body.actor ? { actor: body.actor } : {}), ...(body.receipt ? { receipt: body.receipt } : {}) };
      }
      const entry = attempts.get(key);
      // 409 request-conflict / answering are definitive; anything else that
      // could have pasted (timeout-ish) parks as uncertain, never retried.
      if (r.status === 409) {
        if (entry) entry.state = body.reason === 'delivery-unknown-block' ? 'uncertain' : 'failed';
        if (body.reason === 'delivery-unknown-block') {
          // Stesso contratto del ramo 502: la UI riceve 200+uncertain e non
          // ripete mai il paste. La verifica possibile e' sull'ID originale.
          return { ok: false, code: 200, uncertain: true, reason: body.reason,
            originalRequestId: originalSentRequestId(ownerId, askId, rid), requestId: rid,
            error: 'esito incerto: bloccato da un invio precedente' };
        }
        return { ok: false, code: 409, error: 'conflict', reason: body.reason };
      }
      if (r.status === 502) {
        if (entry) entry.state = 'uncertain';
        return { ok: false, code: 200, uncertain: true, reason: 'delivery-unknown', requestId: rid,
          error: 'esito incerto: verifica lo stato prima di rispondere' };
      }
      if (entry) entry.state = 'failed';
      return { ok: false, code: r.status, error: `HTTP ${r.status}`, reason: body.reason };
    } catch (error) {
      if (!op.active()) return channel.deadlineResult(op, { ownerId, askId, rid }, false);
      if (!op.delivered) {
        const entry = attempts.get(key); if (entry) entry.state = 'failed';
        return { ok: false, code: 404, reason: error.reason || 'reverse-slot-unverified', error: 'risposta non inoltrata' };
      }
      // The request may or may not have pasted: uncertain, never retried.
      const entry = attempts.get(key);
      if (entry) entry.state = 'uncertain';
      return { ok: false, code: 200, uncertain: true, reason: 'delivery-unknown', requestId: rid,
        error: 'esito incerto: verifica lo stato prima di rispondere' };
    }
  }

  async function relayAnswer(args = {}) {
    const rid = args.rid || requestId();
    const key = attemptKey(args.ownerId, args.askId, rid);
    const old = attempts.get(key);
    const digest = crypto.createHash('sha256').update(String(args.text || '')).digest('hex');
    if (old && old.digest !== digest) return { ok: false, code: 409, reason: 'request-conflict', error: 'stesso requestId con testo diverso' };
    const pending = answerFlights.get(key);
    if (pending && pending.digest !== digest) return { ok: false, code: 409, reason: 'request-conflict', error: 'stesso requestId con testo diverso' };
    if (pending) return pending.promise;
    const flight = channel.operation({ ...args, rid }, op => relayAnswerOnce({ ...args, rid }, op), false, true);
    const slot = { promise: flight, digest };
    answerFlights.set(key, slot);
    try { return await flight; } finally { if (answerFlights.get(key) === slot) answerFlights.delete(key); }
  }

  // Remote dismiss: same resolution rules as the answer (DELETE on the owner).
  function retryAfterMs(response) {
    const value = response.headers?.get?.('retry-after');
    if (typeof value !== 'string') return 0;
    const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : null;
    const delay = seconds === null ? Date.parse(value) - now() : seconds * 1000;
    return Number.isFinite(delay) && delay > 0 ? delay : 0;
  }

  async function relayDismissOnce({ ownerId, askId, expectedTs } = {}, op) {
    const candidate = await channel.candidateOwner(ownerId, op);
    if (!candidate) return { ok: false, code: 404, error: 'owner non tra i peer autorizzati', reason: 'owner-unknown' };
    if (candidate.kind === 'inbound-unverified') {
      return { ok: false, code: 404, error: 'canale reverse non verificato: risposta non inoltrata', reason: 'reverse-slot-unverified' };
    }
    if (candidate.kind === 'inbound') {
      const gate = await channel.verifyInboundChannel(candidate, op);
      if (!gate.ok) return { ok: false, code: gate.code, error: gate.error, reason: gate.reason };
    }
    const peer = candidate.node;
    const store = loadStore();
    try {
      const { r, body } = await channel.forward(candidate, `/event-feed/asks/${encodeURIComponent(askId)}`, { method: 'DELETE', expectedTs, op });
      if (!r.ok) return { ok: false, code: r.status, error: 'owner refused', reason: body.reason, retryAfterMs: retryAfterMs(r) };
      return { ok: true, ...(body.outcome ? { outcome: body.outcome } : {}) };
    } catch (e) { if (!op.active()) return channel.deadlineResult(op, { ownerId, askId }, false); return { ok: false, code: 502, reason: safeReason(e.reason), error: 'owner unreachable' }; }
  }

  async function verifyStatusOnce({ ownerId, askId, requestId: rid }, op) {
    const candidate = await channel.candidateOwner(ownerId, op);
    if (!candidate) return { ok: false, code: 404, error: 'owner non tra i peer autorizzati', reason: 'owner-unknown' };
    if (candidate.kind === 'inbound-unverified') {
      return { ok: false, code: 404, error: 'canale reverse non verificato: risposta non inoltrata', reason: 'reverse-slot-unverified' };
    }
    if (candidate.kind === 'inbound') {
      const gate = await channel.verifyInboundChannel(candidate, op);
      if (!gate.ok) return { ok: false, code: gate.code, error: gate.error, reason: gate.reason };
    }
    const peer = candidate.node;
    const store = loadStore();
    try {
      const { r, body } = await channel.forward(candidate,
        `/event-feed/asks/${encodeURIComponent(askId)}/requests/${encodeURIComponent(rid)}`, { op });
      if (!r.ok) return { ok: false, code: r.status, reason: body.reason, error: 'owner refused' };
      op.check();
      const key = attemptKey(ownerId, askId, rid);
      if (attempts.has(key) && (body.state === 'committed' || body.state === 'failed')) {
        attempts.get(key).state = body.state;
      }
      return { ok: true, state: body.state || 'unknown',
        ...(body.ownerId ? { ownerId: body.ownerId } : {}), ...(body.askId ? { askId: body.askId } : {}),
        ...(body.actor ? { actor: body.actor } : {}), ...(body.receipt ? { receipt: body.receipt } : {}) };
    } catch (e) {
      if (!op.active()) return channel.deadlineResult(op, { ownerId, askId }, false);
      return { ok: false, code: 502, reason: safeReason(e.reason), error: 'owner unreachable' };
    }
  }

  async function replyCapabilityOnce({ ownerId, askId } = {}, op) {
    const denied = (status, reason) => ({ ownerId, askId, canReply: false, status, ...(reason ? { reason } : {}) });
    const candidate = await channel.candidateOwner(ownerId, op);
    if (!candidate) return denied('unreachable', 'owner-unknown');
    if (candidate.kind === 'inbound-unverified') { op.channelUnavailable = true; return denied('unreachable', 'reverse-slot-unverified'); }
    if (candidate.kind === 'inbound') {
      const gate = await channel.verifyInboundChannel(candidate, op);
      if (!gate.ok) { op.channelUnavailable = true; return denied('unreachable', gate.reason); }
    }
    try {
      const { r, body } = await channel.forward(candidate, `/event-feed/asks/${encodeURIComponent(askId)}/capability`, { op });
      if (['reverse-slot-unverified', 'federation-peer-unreachable', 'federation-peer-timeout'].includes(body.reason)) { op.channelUnavailable = true; return denied('unreachable', body.reason); }
      if (r.status === 404 || r.status === 501) return denied('unsupported', body.reason);
      if (r.status === 403) return denied('denied', body.reason);
      if (!r.ok || body.ownerId !== ownerId || body.askId !== askId || typeof body.canReply !== 'boolean'
        || !['open', 'denied', 'answered', 'dismissed'].includes(body.status)
        || (body.canReply && body.status !== 'open')) return denied('unreachable');
      return { ownerId, askId, canReply: body.canReply, status: body.status };
    } catch (_) { op.channelUnavailable = true; return denied('unreachable', op.active() ? undefined : 'relay-deadline'); }
  }

  async function inspectDismissalOnce({ ownerId, askId } = {}, op) {
    const candidate = await channel.candidateOwner(ownerId, op);
    if (!candidate) return { ok: false, code: 404, reason: 'owner-unknown' };
    if (candidate.kind === 'inbound-unverified') return { ok: false, code: 404, reason: 'reverse-slot-unverified' };
    if (candidate.kind === 'inbound') {
      const proof = await channel.verifyInboundChannel(candidate, op);
      if (!proof.ok) return proof;
    }
    const { r, body } = await channel.forward(candidate, `/event-feed/asks/${encodeURIComponent(askId)}/capability`, { op });
    if (!r.ok) return { ok: false, code: r.status, reason: body.reason || 'unknown', retryAfterMs: retryAfterMs(r) };
    if (body.ownerId !== ownerId || body.askId !== askId || !['open', 'answered', 'dismissed'].includes(body.status)) {
      return { ok: false, code: 403, reason: 'unknown' };
    }
    if (body.generationPrecondition !== true) return { ok: false, code: 501, reason: 'unsupported' };
    const ask = body.ask;
    if (!ask || ask.id !== askId || !Number.isSafeInteger(ask.ts) || ask.ts <= 0
      || typeof ask.question !== 'string' || typeof ask.session !== 'string'
      || (ask.options !== undefined && (!Array.isArray(ask.options) || ask.options.some(option => typeof option !== 'string')))) {
      return { ok: false, code: 409, reason: 'generation-mismatch' };
    }
    return { ok: true, status: body.status, ask, generationPrecondition: true };
  }
  function inspectDismissal(args = {}) { return channel.operation(args, op => inspectDismissalOnce(args, op)); }

  function relayDismiss(args = {}) { return channel.operation(args, op => relayDismissOnce(args, op)); }
  function verifyStatus(args = {}) { return channel.operation(args, op => verifyStatusOnce(args, op)); }
  function channelBinding(ownerId) {
    const store = loadStore();
    // Kept only in process memory; credentials never enter the dismissal store.
    return crypto.createHash('sha256').update(JSON.stringify([store, availabilityBinding(ownerId)])).digest('hex');
  }
  function channelState(ownerId) {
    const observation = channelObservations.get(ownerId);
    return { unavailable: !!(observation && now() - observation.at < 30000 && observation.binding === channelBinding(ownerId) && observation.unavailable) };
  }
  function replyCapability(args = {}) {
    const initial = channelBinding(args.ownerId);
    return channel.operation(args, async op => {
      const result = await replyCapabilityOnce(args, op);
      channelObservations.set(args.ownerId, { at: now(), binding: initial, unavailable: op.channelUnavailable === true });
      return result;
    }, true);
  }

  function state() {
    return [...attempts.entries()].map(([key, a]) => ({ key, ...a }));
  }

  return { channelState, inspectDismissal, relayAnswer, relayDismiss, verifyStatus, replyCapability, state, isUncertain, requestId };
}

module.exports = { createAskRelay };
