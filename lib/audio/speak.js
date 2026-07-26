'use strict';
// lib/audio/speak.js — WP2: speak/stop gate logic (pure, testable). The target
// independently gates ACL, consent, READONLY, rate limit, dedup. speak in
// READONLY is refused with reason 'readonly'. Target is an EXACT node
// instanceId; wildcards/all are rejected. The adapter is WP3: without a test
// fake this layer NEVER claims accepted/spoken — it returns refused/no-adapter
// (honest admission). No physical audio, no broadcast.
const { admitAudio } = require('./capability.js');

const INSTANCE_ID_RE = /^[a-f0-9]{32}$/i;

function isValidInstance(v) {
  return typeof v === 'string' && INSTANCE_ID_RE.test(v);
}

// handleSpeak: runs gates in order, then honest admission. Returns a redacted
// receipt (status/reason/utteranceId/origin/target/timestamp). Never returns
// text/lang/voice. Per-endpoint status: refused|unreachable|accepted|spoken|unknown.
function handleSpeak(input, deps) {
  const opts = input || {};
  const d = deps || {};
  const target = opts.target;
  // 1) exact target only; reject wildcards/all/invalid
  if (!isValidInstance(target)) {
    return { status: 'refused', reason: 'invalid-target' };
  }
  // 2) READONLY first: speak in READONLY => refused reason 'readonly'
  if (typeof d.readonly === 'function' && d.readonly()) {
    return d.receipt('refused', { reason: 'readonly', target, origin: opts.origin, utteranceId: opts.utteranceId });
  }
  // 3) ACL: target must allow the origin node (visibility ACL)
  if (typeof d.targetAllowsOrigin === 'function' && !d.targetAllowsOrigin(target, opts.origin && opts.origin.node)) {
    return d.receipt('refused', { reason: 'acl', target, origin: opts.origin, utteranceId: opts.utteranceId });
  }
  // 4) consent: target audio.consent must be true (default false)
  if (typeof d.targetConsent === 'function' && !d.targetConsent(target)) {
    return d.receipt('refused', { reason: 'consent', target, origin: opts.origin, utteranceId: opts.utteranceId });
  }
  // 5) rate limit (dedicated speak buckets; urgency never bypasses)
  if (d.rateLimiter) {
    const rl = d.rateLimiter.check({ originCell: opts.originCell, target, urgency: opts.urgency });
    if (!rl.allowed) {
      return d.receipt('refused', { reason: 'rate-limit', detail: rl.bucket, target, origin: opts.origin, utteranceId: opts.utteranceId });
    }
  }
  // 6) dedup: same caller utteranceId already terminal => idempotent return
  if (d.dedup && opts.utteranceId) {
    const existing = d.dedup(opts.utteranceId);
    if (existing && existing.status !== 'accepted') return existing;
  }
  // 7) reachable (federation/transport)
  if (typeof d.targetReachable === 'function' && !d.targetReachable(target)) {
    return d.receipt('unreachable', { reason: 'unreachable', target, origin: opts.origin, utteranceId: opts.utteranceId });
  }
  // 8) honest admission: adapter is WP3. No adapter => refused/no-adapter.
  const admit = admitAudio({ adapter: d.adapter });
  if (!admit.adapterDetected) {
    return d.receipt('refused', { reason: 'no-adapter', target, origin: opts.origin, utteranceId: opts.utteranceId });
  }
  // A test-fake adapter (WP3 pluggable) drives synthesis. WP2 does not ship one.
  if (d.adapter && typeof d.adapter.speak === 'function') {
    try {
      const r = d.adapter.speak({ target, text: opts.text, lang: opts.lang, voice: opts.voice });
      const status = r && r.spoken ? 'spoken' : 'accepted';
      return d.receipt(status, { target, origin: opts.origin, utteranceId: opts.utteranceId });
    } catch (_) {
      return d.receipt('refused', { reason: 'adapter-error', target, origin: opts.origin, utteranceId: opts.utteranceId });
    }
  }
  return d.receipt('refused', { reason: 'no-adapter', target, origin: opts.origin, utteranceId: opts.utteranceId });
}

// handleStop: local sovereign stop + remote stop by utteranceId. Stop is a
// control command (not synthesis): an honest ack is 'accepted' even with no
// adapter; 'unknown' when an utteranceId is given but not found for the caller.
function handleStop(input, deps) {
  const opts = input || {};
  const d = deps || {};
  const target = opts.target;
  if (!isValidInstance(target)) {
    return d.receipt ? d.receipt('refused', { reason: 'invalid-target', target, origin: opts.origin, utteranceId: opts.utteranceId }) : { status: 'refused', reason: 'invalid-target' };
  }
  if (typeof d.readonly === 'function' && d.readonly()) {
    return d.receipt('refused', { reason: 'readonly', target, origin: opts.origin, utteranceId: opts.utteranceId });
  }
  if (opts.utteranceId && d.dedup) {
    const existing = d.dedup(opts.utteranceId);
    if (!existing) return d.receipt('unknown', { reason: 'utterance-not-found', target, origin: opts.origin, utteranceId: opts.utteranceId });
  }
  return d.receipt('accepted', { target, origin: opts.origin, utteranceId: opts.utteranceId });
}

module.exports = { handleSpeak, handleStop, isValidInstance, INSTANCE_ID_RE };