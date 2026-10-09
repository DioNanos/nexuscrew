'use strict';
// lib/notify/owner-channel.js — the channel to an OWNER node, resolved from the
// authorized store and never from anything an event said.
//
// Extracted from ask-relay.js so the ask answers and the notice dismissals share
// ONE implementation of the same three things: which peer carries the request
// (direct outbound, shared inbound with a proven reverse slot, or a route from
// the authorized inventory), the forwarding with its deadline and typed
// outcomes, and the hop proof. Two copies of this would drift, and a drifted
// chain rule is a security bug, not a duplication smell.

const { NODE_NAME_RE } = require('../nodes/store.js');
const { probeReverseSlot } = require('../nodes/reverse-slot-proof.js');
const { askSlotVerifier, binding } = require('../nodes/ask-slot-verifier.js');

const RELAY_DEADLINE_MS = 8000;

function createOwnerChannel({
  loadStore, now = Date.now, fetchImpl = fetch,
  probeReverseSlotImpl = probeReverseSlot, peers = null,
  localPort = () => 0, localToken = () => '', nodesPath = null,
  slotVerifier = askSlotVerifier, deadlineMs = RELAY_DEADLINE_MS,
  // Caller-owned hook: what to do when a request that may have travelled dies
  // with the deadline (the ask relay parks the attempt as uncertain).
  onUncertain = null,
  // Callers surface `body.reason` to their own API: each one keeps its own
  // allowlist, so an arbitrary string from the owner never travels upward.
  sanitizeReason = (reason) => reason,
} = {}) {
  const proofScope = nodesPath || loadStore;

  function deadlineResult(op, args, capability) {
    if (capability) return { ownerId: args.ownerId, askId: args.askId, canReply: false, status: 'unreachable', reason: 'relay-deadline' };
    if (op.answer && op.delivered && args.rid) {
      return { ok: false, code: 200, uncertain: true, requestId: args.rid, reason: 'delivery-unknown', error: 'esito incerto: verifica lo stato prima di rispondere' };
    }
    return { ok: false, code: 504, reason: 'relay-deadline', error: 'relay deadline' };
  }

  // One request, one deadline. The work function receives `op` and must call
  // op.check()/op.wait() so an expired deadline aborts the travel instead of
  // leaving a request in flight with nobody to collect it.
  async function operation(args, work, capability = false, answer = false) {
    const controller = new AbortController();
    const op = { controller, answer, delivered: false, expired: false, proofKey: null, proofBinding: null };
    let rejectAbort;
    const aborted = new Promise((_resolve, reject) => { rejectAbort = () => reject(new Error('relay deadline')); });
    controller.signal.addEventListener('abort', rejectAbort, { once: true });
    op.active = () => !controller.signal.aborted;
    op.check = () => { if (!op.active()) throw new Error('relay deadline'); };
    op.wait = promise => Promise.race([promise, aborted]);
    const timer = setTimeout(() => { op.expired = true; controller.abort(); }, deadlineMs);
    try { return await Promise.race([Promise.resolve().then(() => work(op)), aborted]); }
    catch (_) {
      slotVerifier.invalidate(op.proofKey);
      if (op.answer && op.delivered && args.rid && typeof onUncertain === 'function') onUncertain(args);
      if (op.expired) return deadlineResult(op, args, capability);
      return capability
        ? { ownerId: args.ownerId, askId: args.askId, canReply: false, status: 'unreachable' }
        : { ok: false, code: 502, error: 'owner unreachable' };
    } finally {
      clearTimeout(timer); controller.signal.removeEventListener('abort', rejectAbort); controller.abort();
    }
  }

  // Owner resolution: an OUTBOUND peer (its own channel, as always) or a shared
  // INBOUND peer with the events+reply grants and an active reverse slot. For
  // inbound peers the slot port MUST be proven with the same probe the terminals
  // use: no fallback on localPort without proof.
  async function candidateOwner(ownerId, op) {
    let store = loadStore();
    if (!store) return null;
    let routed = null;
    if (typeof peers === 'function') {
      let inventory;
      try { inventory = await op.wait(peers()); } catch (_) { op.check(); return null; }
      op.check();
      const matches = (Array.isArray(inventory) ? inventory : [])
        .filter((p) => p && (p.nodeId === ownerId || p.instanceId === ownerId));
      if (matches.length !== 1 || matches[0].stale === true) return null;
      const route = matches[0].route;
      if (!Array.isArray(route) || !route.length || route.length > 4
        || route.some((name) => typeof name !== 'string' || !NODE_NAME_RE.test(name))
        || new Set(route).size !== route.length) return null;
      routed = [...route];
    }
    op.check();
    store = loadStore();
    if (!store) return null;
    slotVerifier.sync(store, proofScope);
    const nodes = store.nodes || [];
    const direct = nodes.filter((n) => n && n.nodeId === ownerId);
    if (direct.length > 1) return null;
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

  async function forward(candidate, path, { method = 'GET', body, expectedTs, op } = {}) {
    op.check();
    const st = loadStore();
    slotVerifier.sync(st, proofScope);
    if (candidate.kind === 'inbound' && !candidate.route) {
      const current = st && (st.nodes || []).find(node => node.name === candidate.node.name);
      const selected = binding(st, current);
      if (!selected || selected.fingerprint !== op.proofBinding) {
        slotVerifier.invalidate(op.proofKey);
        const error = new Error('reverse slot changed'); error.reason = 'reverse-slot-unverified'; throw error;
      }
    }
    const routed = candidate.route;
    const url = routed
      ? `http://127.0.0.1:${localPort()}/api/route/${routed.map(encodeURIComponent).join('/')}/_${path}`
      : ownerUrl(candidate.forwardPort, path);
    const headers = routed ? { authorization: `Bearer ${localToken()}` }
      : { authorization: `Bearer ${candidate.forwardToken}`, 'x-nexuscrew-visited': st && st.nodeId || '' };
    try {
      op.check(); op.delivered = true;
      const r = await op.wait(fetchImpl(url, { method, headers: { ...headers, 'content-type': 'application/json',
        ...(expectedTs === undefined ? {} : { 'x-nexuscrew-ask-ts': String(expectedTs) }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: op.controller.signal }));
      op.check();
      const payload = await op.wait(r.json().catch(error => {
        if ([403, 404, 501].includes(r.status)) return {};
        throw error;
      }));
      op.check();
      if (!r.ok) slotVerifier.invalidate(op.proofKey);
      return { r, body: { ...payload, reason: sanitizeReason(payload && payload.reason) } };
    } catch (error) { slotVerifier.invalidate(op.proofKey); throw error; }
  }

  // Preflight of the reverse channel for an inbound peer: a NET refusal when the
  // slot is not proven (not an uncertain outcome: the forward never left).
  async function verifyInboundChannel(candidate, op) {
    // REST routes prove the slot at their inbound proxy hop, never twice.
    if (candidate.route) return { ok: true };
    op.check();
    const st = loadStore();
    const proof = await op.wait(slotVerifier.verify({ store: st, peer: candidate.node, loadStore,
      scope: proofScope, signal: op.controller.signal, probeImpl: probeReverseSlotImpl }));
    op.check();
    if (proof && proof.owned === true) {
      op.proofKey = proof.key;
      const selected = binding(st, candidate.node);
      op.proofBinding = selected && selected.fingerprint;
      return { ok: true };
    }
    return { ok: false, code: 404, error: 'canale reverse non verificato: risposta non inoltrata', reason: 'reverse-slot-unverified' };
  }

  return { operation, candidateOwner, ownerUrl, forward, verifyInboundChannel, deadlineResult, RELAY_DEADLINE_MS: deadlineMs };
}

module.exports = { createOwnerChannel, RELAY_DEADLINE_MS };
