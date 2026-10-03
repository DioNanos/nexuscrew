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
const { NODE_NAME_RE } = require('../nodes/store.js');
const { probeReverseSlot } = require('../nodes/reverse-slot-proof.js');
const IDLE_MS = 15000;

function createAskRelay({ loadStore, now = Date.now, fetchImpl = fetch, log = () => {}, probeReverseSlotImpl = probeReverseSlot, peers = null, localPort = () => 0, localToken = () => '' } = {}) {
  // (ownerId|askId|requestId) -> {state: 'sent'|'committed'|'failed'|'uncertain', requestId}
  const attempts = new Map();
  const answerFlights = new Map();

  function requestId() { return crypto.randomUUID(); }

  // Risoluzione del produttore: peer OUTBOUND (canale proprio, come sempre)
  // oppure peer INBOUND condiviso con consenso eventi+risposta e slot reverse
  // attivo. Per gli inbound la porta dello slot DEVE essere verificata con la
  // stessa sonda dei terminali (secret del peer + instanceId atteso): nessun
  // fallback sulla localPort senza proof.
  async function candidateOwner(ownerId) {
    const store = loadStore();
    if (!store) return null;
    const nodes = store.nodes || [];
    const direct = nodes.filter((n) => n && n.nodeId === ownerId);
    if (direct.length > 1) return null;
    let routed = null;
    if (typeof peers === 'function') {
      let inventory;
      try { inventory = await peers(); } catch (_) { return null; }
      const matches = (Array.isArray(inventory) ? inventory : [])
        .filter((p) => p && (p.nodeId === ownerId || p.instanceId === ownerId));
      if (matches.length !== 1 || matches[0].stale === true) return null;
      const route = matches[0].route;
      if (!Array.isArray(route) || !route.length || route.length > 4
        || route.some((name) => typeof name !== 'string' || !NODE_NAME_RE.test(name))
        || new Set(route).size !== route.length) return null;
      routed = [...route];
    }
    const out = direct.find((n) => n.direction === 'outbound' && n.token && n.localPort);
    if (out) return { node: out, forwardPort: out.localPort, forwardToken: out.token, kind: 'outbound', route: routed };
    if (!direct.length && routed) return { node: null, kind: 'routed', route: routed };
    const inbound = nodes.find((n) => n && n.direction === 'inbound'
      && n.shared === true && n.nodeId === ownerId
      && n.token
      && n.askReplyAccess === true && n.eventsAccess === true
      && n.cellVisibility !== 'none');
    if (!inbound) return null;
    const forwardToken = inbound.token;
    const pool = inbound.reversePool;
    const slot = pool && Array.isArray(pool.slots) ? pool.slots[pool.activeSlot] : null;
    if (!slot || !Number.isInteger(slot.port)) {
      return { node: inbound, forwardPort: null, forwardToken, kind: 'inbound-unverified', route: routed };
    }
    return { node: inbound, forwardPort: slot.port, forwardToken, kind: 'inbound', route: routed };
  }

  function ownerUrl(port, path) {
    return `http://127.0.0.1:${port}/federation/route/_/${path.replace(/^\//, '')}`;
  }

  async function forward(candidate, path, { method = 'GET', body, timeoutMs = IDLE_MS } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let rejectAbort;
    const aborted = new Promise((_resolve, reject) => { rejectAbort = () => reject(new Error('relay deadline')); });
    ctrl.signal.addEventListener('abort', rejectAbort, { once: true });
    const st = loadStore();
    const routed = candidate.route;
    const url = routed
      ? `http://127.0.0.1:${localPort()}/api/route/${routed.map(encodeURIComponent).join('/')}/_${path}`
      : ownerUrl(candidate.forwardPort, path);
    const headers = routed ? { authorization: `Bearer ${localToken()}` }
      : { authorization: `Bearer ${candidate.forwardToken}`, 'x-nexuscrew-visited': st && st.nodeId || '' };
    try {
      return await Promise.race([(async () => {
        const r = await fetchImpl(url, { method, headers: { ...headers, 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: ctrl.signal });
        const payload = await r.json().catch(error => {
          if ([403, 404, 501].includes(r.status)) return {};
          throw error;
        });
        return { r, body: payload };
      })(), aborted]);
    } finally {
      clearTimeout(timer); ctrl.signal.removeEventListener('abort', rejectAbort);
    }
  }

  // Preflight del canale reverse per un peer inbound: rifiuto NETTO se lo slot
  // non e' verificato (non e' un esito incerto: il forward non e' mai partito).
  async function verifyInboundChannel(candidate) {
    const { node, forwardPort } = candidate;
    const pool = node.reversePool;
    const slot = pool && Array.isArray(pool.slots) ? pool.slots[pool.activeSlot] : null;
    const proof = await probeReverseSlotImpl({
      port: forwardPort, secret: node.token,
      expected: {
        remotePort: forwardPort,
        generation: pool && Number.isInteger(pool.activeGeneration) ? pool.activeGeneration : undefined,
        instanceId: node.nodeId,
      },
    });
    if (proof && proof.owned === true) return { ok: true };
    return {
      ok: false, code: 404,
      error: 'canale reverse non verificato: risposta non inoltrata',
      reason: 'reverse-slot-unverified',
    };
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

  // Il blocco precedente rifiuta il nuovo requestId PRIMA di creare la sua
  // ricevuta: la sola verifica possibile e' sull'ID originale ancora 'sent'
  // (se esiste), altrimenti resta solo la riconciliazione con l'owner.
  function originalSentRequestId(ownerId, askId, excludeRid) {
    const sent = statusFor(ownerId, askId)
      .filter((a) => (a.state === 'sent' || a.state === 'uncertain') && a.requestId !== excludeRid);
    return sent.length ? sent[sent.length - 1].requestId : null;
  }

  async function relayAnswerOnce({ ownerId, askId, text, rid: providedRid } = {}) {
    if (!ownerId || !askId || typeof text !== 'string' || !text.trim()) {
      return { ok: false, code: 400, error: 'ownerId, askId e text richiesti' };
    }
    const candidate = await candidateOwner(ownerId);
    if (!candidate) return { ok: false, code: 404, error: 'owner non tra i peer autorizzati', reason: 'owner-unknown' };
    if (candidate.kind === 'inbound-unverified') {
      return { ok: false, code: 404, error: 'canale reverse non verificato: risposta non inoltrata', reason: 'reverse-slot-unverified' };
    }
    if (candidate.kind === 'inbound') {
      const gate = await verifyInboundChannel(candidate);
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
      const { r, body } = await forward(candidate, `/event-feed/asks/${encodeURIComponent(askId)}/answer`, {
        method: 'POST', body: { text, requestId: rid },
      });
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
    const flight = relayAnswerOnce({ ...args, rid });
    const slot = { promise: flight, digest };
    answerFlights.set(key, slot);
    try { return await flight; } finally { if (answerFlights.get(key) === slot) answerFlights.delete(key); }
  }

  // Remote dismiss: same resolution rules as the answer (DELETE on the owner).
  async function relayDismiss({ ownerId, askId } = {}) {
    const candidate = await candidateOwner(ownerId);
    if (!candidate) return { ok: false, code: 404, error: 'owner non tra i peer autorizzati', reason: 'owner-unknown' };
    if (candidate.kind === 'inbound-unverified') {
      return { ok: false, code: 404, error: 'canale reverse non verificato: risposta non inoltrata', reason: 'reverse-slot-unverified' };
    }
    if (candidate.kind === 'inbound') {
      const gate = await verifyInboundChannel(candidate);
      if (!gate.ok) return { ok: false, code: gate.code, error: gate.error, reason: gate.reason };
    }
    const peer = candidate.node;
    const store = loadStore();
    try {
      const { r, body } = await forward(candidate, `/event-feed/asks/${encodeURIComponent(askId)}`, { method: 'DELETE' });
      if (!r.ok) return { ok: false, code: r.status, error: body.error || `HTTP ${r.status}` };
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  async function verifyStatus({ ownerId, askId, requestId: rid }) {
    const candidate = await candidateOwner(ownerId);
    if (!candidate) return { ok: false, code: 404, error: 'owner non tra i peer autorizzati', reason: 'owner-unknown' };
    if (candidate.kind === 'inbound-unverified') {
      return { ok: false, code: 404, error: 'canale reverse non verificato: risposta non inoltrata', reason: 'reverse-slot-unverified' };
    }
    if (candidate.kind === 'inbound') {
      const gate = await verifyInboundChannel(candidate);
      if (!gate.ok) return { ok: false, code: gate.code, error: gate.error, reason: gate.reason };
    }
    const peer = candidate.node;
    const store = loadStore();
    try {
      const { r, body } = await forward(candidate,
        `/event-feed/asks/${encodeURIComponent(askId)}/requests/${encodeURIComponent(rid)}`, { timeoutMs: 8000 });
      if (!r.ok) return { ok: false, code: r.status };
      const key = attemptKey(ownerId, askId, rid);
      if (attempts.has(key) && (body.state === 'committed' || body.state === 'failed')) {
        attempts.get(key).state = body.state;
      }
      return { ok: true, state: body.state || 'unknown',
        ...(body.ownerId ? { ownerId: body.ownerId } : {}), ...(body.askId ? { askId: body.askId } : {}),
        ...(body.actor ? { actor: body.actor } : {}), ...(body.receipt ? { receipt: body.receipt } : {}) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  async function replyCapability({ ownerId, askId } = {}) {
    const denied = (status, reason) => ({ ownerId, askId, canReply: false, status, ...(reason ? { reason } : {}) });
    const candidate = await candidateOwner(ownerId);
    if (!candidate) return denied('unreachable', 'owner-unknown');
    if (candidate.kind === 'inbound-unverified') return denied('unreachable', 'reverse-slot-unverified');
    if (candidate.kind === 'inbound') {
      const gate = await verifyInboundChannel(candidate);
      if (!gate.ok) return denied('unreachable', gate.reason);
    }
    try {
      const { r, body } = await forward(candidate, `/event-feed/asks/${encodeURIComponent(askId)}/capability`, { timeoutMs: 8000 });
      if (r.status === 404 || r.status === 501) return denied('unsupported');
      if (r.status === 403) return denied('denied');
      if (!r.ok || body.ownerId !== ownerId || body.askId !== askId || typeof body.canReply !== 'boolean'
        || !['open', 'denied', 'answered', 'dismissed'].includes(body.status)
        || (body.canReply && body.status !== 'open')) return denied('unreachable');
      return { ownerId, askId, canReply: body.canReply, status: body.status };
    } catch (_) { return denied('unreachable'); }
  }

  function state() {
    return [...attempts.entries()].map(([key, a]) => ({ key, ...a }));
  }

  return { relayAnswer, relayDismiss, verifyStatus, replyCapability, state, isUncertain, requestId };
}

module.exports = { createAskRelay };
