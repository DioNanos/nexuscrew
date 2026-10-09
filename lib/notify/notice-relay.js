'use strict';
// lib/notify/notice-relay.js — the client-side relay that carries a notice
// dismissal to the node that OWNS the notice.
//
// The channel (resolution from the authorized store, deadline, hop proof) is the
// shared one the ask answers use (./owner-channel.js): this module adds only what
// is specific to notices — the two routes it calls and the outcome contract:
//
//   DELETE /event-feed/notices/<eventId>     one notice
//   POST   /event-feed/notices/dismiss-all   the whole visible set
//
//   2xx            → cleared (idempotent when the owner says so)
//   404 (no route) → the owner does not have this surface at all: `unsupported`,
//                    declared, never retried in a loop
//   404 otherwise  → the notice is already gone (expired): the GOAL is reached,
//                    so it counts as confirmed — never as a failure to retry

const { createOwnerChannel } = require('./owner-channel.js');

const OWNER_ID_RE = /^[a-f0-9]{32}$/;
const EVENT_ID_RE = /^[0-9a-f-]{36}$/;
const RELAY_DEADLINE_MS = 8000;

const OWNER_REASONS = new Set([
  'reverse-slot-unverified', 'peer-unknown', 'events-disabled', 'grant-required:ask-action',
  'peer-visibility', 'origin-visibility', 'federated-origin-required', 'hop-chain',
  'store-unavailable', 'unknown-peer', 'unknown-trust', 'no-delivering-peer',
  'no-node-identity', 'bad-visited', 'bad-hop', 'self-hop', 'origin-mismatch',
  'notify-unknown', 'dismissals-unavailable', 'unsupported', 'dismiss-rate',
  'resource-not-classified', 'owner-unknown', 'federation-peer-unreachable',
  'federation-peer-timeout', 'federation-body-consumed', 'owner-unreachable',
]);
function safeReason(reason) { return OWNER_REASONS.has(reason) ? reason : undefined; }

// Reasons that mean "the owner is not reachable NOW": the caller queues the
// intent and its drainer retries. Everything else is a decision.
const TRANSIENT_REASONS = new Set([
  'relay-deadline', 'owner-unreachable', 'unknown', 'reverse-slot-unverified',
  'federation-peer-unreachable', 'federation-peer-timeout', 'federation-body-consumed',
]);

function createNoticeRelay({
  loadStore, now = Date.now, fetchImpl = fetch, log = () => {},
  probeReverseSlotImpl = null, peers = null, localPort = () => 0, localToken = () => '',
  nodesPath = null, slotVerifier = undefined, deadlineMs = RELAY_DEADLINE_MS,
} = {}) {
  const channel = createOwnerChannel({
    loadStore, now, fetchImpl, peers, localPort, localToken, nodesPath, deadlineMs,
    sanitizeReason: safeReason,
    ...(probeReverseSlotImpl ? { probeReverseSlotImpl } : {}),
    ...(slotVerifier ? { slotVerifier } : {}),
  });

  // Same resolution as an ask answer: an outbound peer, a shared inbound peer
  // with a proven reverse slot, or a route of the authorized inventory.
  async function resolve(ownerId, op) {
    const candidate = await channel.candidateOwner(ownerId, op);
    if (!candidate) return { error: { ok: false, code: 404, reason: 'owner-unknown', error: 'owner non tra i peer autorizzati' } };
    if (candidate.kind === 'inbound-unverified') {
      return { error: { ok: false, code: 404, reason: 'reverse-slot-unverified', error: 'canale reverse non verificato: scarto non inoltrato' } };
    }
    if (candidate.kind === 'inbound') {
      const gate = await channel.verifyInboundChannel(candidate, op);
      if (!gate.ok) return { error: { ok: false, code: gate.code, reason: gate.reason, error: gate.error } };
    }
    return { candidate };
  }

  function transient(reason, code) {
    return TRANSIENT_REASONS.has(reason) || code === 408 || code === 429 || (typeof code === 'number' && code >= 500);
  }

  async function dismissOnce({ ownerId, eventId }, op) {
    if (!OWNER_ID_RE.test(String(ownerId || ''))) return { ok: false, code: 400, error: 'ownerId non valido' };
    if (!EVENT_ID_RE.test(String(eventId || ''))) return { ok: false, code: 400, error: 'eventId non valido' };
    const resolved = await resolve(ownerId, op);
    if (resolved.error) return resolved.error;
    const { r, body } = await channel.forward(resolved.candidate, `/event-feed/notices/${encodeURIComponent(eventId)}`, { method: 'DELETE', op });
    if (r.status === 200) return { ok: true, code: 200, ownerId, idempotent: body.idempotent === true };
    if (r.status === 404 && body.reason === 'resource-not-classified') return { ok: false, code: 404, reason: 'unsupported', error: 'owner senza la superficie di scarto' };
    // The entry expired on the owner: the dismissal is ALREADY true there.
    if (r.status === 404) return { ok: true, code: 404, ownerId, gone: true };
    const reason = body.reason || (r.status === 403 ? 'grant-required:ask-action' : 'unknown');
    return { ok: false, code: r.status, ownerId, reason: safeReason(reason) || 'unknown', error: body.error || `HTTP ${r.status}`,
      retryAfterMs: retryAfterMs(r, now), transient: transient(reason, r.status) };
  }

  async function dismissAllOnce({ ownerId }, op) {
    if (!OWNER_ID_RE.test(String(ownerId || ''))) return { ok: false, code: 400, error: 'ownerId non valido' };
    const resolved = await resolve(ownerId, op);
    if (resolved.error) return resolved.error;
    const { r, body } = await channel.forward(resolved.candidate, '/event-feed/notices/dismiss-all', { method: 'POST', body: {}, op });
    if (r.status === 200) {
      return { ok: true, code: 200, ownerId, dismissed: Number.isSafeInteger(body.dismissed) ? body.dismissed : 0 };
    }
    if (r.status === 404 && body.reason === 'resource-not-classified') return { ok: false, code: 404, reason: 'unsupported', error: 'owner senza la superficie di scarto' };
    if (r.status === 404) return { ok: true, code: 404, ownerId, gone: true, dismissed: 0 };
    const reason = body.reason || (r.status === 403 ? 'grant-required:ask-action' : 'unknown');
    return { ok: false, code: r.status, ownerId, reason: safeReason(reason) || 'unknown', error: body.error || `HTTP ${r.status}`,
      retryAfterMs: retryAfterMs(r, now), transient: transient(reason, r.status) };
  }

  function retryAfterMs(response, clock) {
    const value = response.headers?.get?.('retry-after');
    if (typeof value !== 'string') return 0;
    const seconds = /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : null;
    const delay = seconds === null ? Date.parse(value) - clock() : seconds * 1000;
    return Number.isFinite(delay) && delay > 0 ? delay : 0;
  }

  // Every failure carries the classification ONCE, here: `transient` is what the
  // queue reads to decide between "retry later" and "declare it and stop"
  // (a refusal or an owner without the surface is a decision, not an outage).
  function classified(out) {
    if (!out || out.ok === true || out.transient !== undefined) return out;
    return { ...out, transient: transient(out.reason, out.code) };
  }

  async function relayNoticeDismiss(args = {}) {
    return classified(await channel.operation(args, (op) => dismissOnce(args, op)));
  }
  async function relayNoticeDismissAll(args = {}) {
    return classified(await channel.operation(args, (op) => dismissAllOnce(args, op)));
  }
  return { relayNoticeDismiss, relayNoticeDismissAll };
}

module.exports = { createNoticeRelay, TRANSIENT_REASONS, OWNER_ID_RE, EVENT_ID_RE };
