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
const IDLE_MS = 15000;

function createAskRelay({ loadStore, now = Date.now, fetchImpl = fetch, log = () => {} } = {}) {
  // (ownerId|askId|requestId) -> {state: 'sent'|'committed'|'failed'|'uncertain', requestId}
  const attempts = new Map();

  function requestId() { return crypto.randomUUID(); }

  function resolveOwner(ownerId) {
    const store = loadStore();
    if (!store) return null;
    return (store.nodes || []).find((n) => n && n.direction === 'outbound'
      && n.nodeId === ownerId && n.token && n.localPort) || null;
  }

  function ownerUrl(peer, path) {
    return `http://127.0.0.1:${peer.localPort}/federation/route/_/${path.replace(/^\//, '')}`;
  }

  function attemptKey(ownerId, askId, rid) { return `${ownerId}|${askId}|${rid}`; }

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

  async function relayAnswer({ ownerId, askId, text, rid: providedRid } = {}) {
    if (!ownerId || !askId || typeof text !== 'string' || !text.trim()) {
      return { ok: false, code: 400, error: 'ownerId, askId e text richiesti' };
    }
    const peer = resolveOwner(ownerId);
    if (!peer) return { ok: false, code: 404, error: 'owner non tra i peer autorizzati', reason: 'owner-unknown' };
    // Local reconciliation FIRST: an uncertain attempt on this ask must be
    // verified before any new paste leaves this node.
    if (isUncertain(ownerId, askId)) {
      return { ok: false, code: 409, error: 'esito incerto: verifica lo stato prima di rispondere', reason: 'uncertain', uncertain: true };
    }
    const rid = providedRid || requestId();
    const key = attemptKey(ownerId, askId, rid);
    const store = loadStore();
    attempts.set(key, { requestId: rid, state: 'sent', askId, ownerId });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), IDLE_MS);
    try {
      const r = await fetchImpl(ownerUrl(peer, `/event-feed/asks/${askId}/answer`), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${peer.token}`,
          'content-type': 'application/json',
          'x-nexuscrew-visited': store.nodeId,
        },
        body: JSON.stringify({ text, requestId: rid }),
        signal: ctrl.signal,
      });
      const body = await r.json().catch(() => ({}));
      if (r.status === 200) {
        const state = body.status === 'answered' ? 'committed' : body.status || 'committed';
        attempts.get(key).state = body.replay ? (body.state || state) : state;
        return { ok: true, status: attempts.get(key).state, requestId: rid };
      }
      const entry = attempts.get(key);
      // 409 request-conflict / answering are definitive; anything else that
      // could have pasted (timeout-ish) parks as uncertain, never retried.
      if (r.status === 409) {
        if (entry) entry.state = body.reason === 'delivery-unknown-block' ? 'uncertain' : 'failed';
        return { ok: false, code: 409, error: body.error || 'conflict', reason: body.reason };
      }
      if (r.status === 502) {
        if (entry) entry.state = 'uncertain';
        return { ok: false, code: 200, uncertain: true, reason: 'delivery-unknown', requestId: rid,
          error: 'esito incerto: verifica lo stato prima di rispondere' };
      }
      if (entry) entry.state = 'failed';
      return { ok: false, code: r.status, error: body.error || `HTTP ${r.status}`, reason: body.reason };
    } catch (_) {
      // The request may or may not have pasted: uncertain, never retried.
      const entry = attempts.get(key);
      if (entry) entry.state = 'uncertain';
      return { ok: false, code: 200, uncertain: true, reason: 'delivery-unknown', requestId: rid,
        error: 'esito incerto: verifica lo stato prima di rispondere' };
    } finally {
      clearTimeout(timer);
    }
  }

  // Remote dismiss: same resolution rules as the answer (DELETE on the owner).
  async function relayDismiss({ ownerId, askId } = {}) {
    const peer = resolveOwner(ownerId);
    if (!peer) return { ok: false, code: 404, error: 'owner non tra i peer autorizzati' };
    const store = loadStore();
    try {
      const r = await fetchImpl(ownerUrl(peer, `/event-feed/asks/${askId}`), {
        method: 'DELETE',
        headers: { authorization: `Bearer ${peer.token}`, 'x-nexuscrew-visited': store ? store.nodeId : '' },
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, code: r.status, error: body.error || `HTTP ${r.status}` };
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  async function verifyStatus({ ownerId, askId, requestId: rid }) {
    const peer = resolveOwner(ownerId);
    if (!peer) return { ok: false, code: 404, error: 'owner non tra i peer autorizzati' };
    const store = loadStore();
    try {
      const r = await fetchImpl(ownerUrl(peer, `/event-feed/asks/${askId}/requests/${rid}`), {
        headers: { authorization: `Bearer ${peer.token}`, 'x-nexuscrew-visited': store ? store.nodeId : '' },
      });
      if (!r.ok) return { ok: false, code: r.status };
      const body = await r.json();
      const key = attemptKey(ownerId, askId, rid);
      if (attempts.has(key) && (body.state === 'committed' || body.state === 'failed')) {
        attempts.get(key).state = body.state;
      }
      return { ok: true, state: body.state || 'unknown' };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  function state() {
    return [...attempts.entries()].map(([key, a]) => ({ key, ...a }));
  }

  return { relayAnswer, relayDismiss, verifyStatus, state, isUncertain, requestId };
}

module.exports = { createAskRelay };
