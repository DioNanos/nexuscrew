'use strict';
// lib/notify/ask-receipts.js — durable receipts for FEDERATED answer attempts.
//
// The receipt is the answer's paper trail: a federated attempt gets a UUID
// (requestId), a digest of the text and a state that is WRITTEN BEFORE the
// paste happens (a failed receipt write means no paste — the owner never fires
// blind). Terminal states are final: replaying the same requestId with the
// same digest returns the stored state without pasting again; the same id with
// a different digest is a conflict. A process crash leaves `pending` behind:
// at recovery it becomes `delivery-unknown` and BLOCKS every new paste for
// that ask — local ones too — until the operator reconciles explicitly (
// no silent retries, no TTL).
//
// Cap 1000 attempts; terminal receipts age out after 24 h; at cap, NEW
// attempts are refused rather than evicting pending/unknown ones.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { atomicWriteJson } = require('./persist.js');

const SCHEMA = 'nexuscrew-ask-receipts-v1';
const CAP_ATTEMPTS = 1000;
const TERMINAL_RETENTION_MS = 24 * 60 * 60 * 1000;

function keyOf(peerId, askId, requestId) { return `${peerId}|${askId}|${requestId}`; }
function digestOf(text) { return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex'); }

function createAskReceipts({ filePath, now = Date.now } = {}) {
  if (!filePath) throw new Error('createAskReceipts: filePath richiesta');

  function loadRaw() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (parsed && parsed.schema === SCHEMA && parsed.attempts && typeof parsed.attempts === 'object') return parsed;
    } catch (_) { /* fresh */ }
    return { schema: SCHEMA, attempts: {}, blockedAsks: {} };
  }

  function persist(state) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  }

  // Recovery at construction: a `pending` attempt did not observe its own
  // paste, so its outcome is unknown and the ask is locked.
  const state = loadRaw();
  for (const entry of Object.values(state.attempts)) {
    if (entry.state === 'pending') {
      entry.state = 'delivery-unknown';
      entry.updatedAt = now();
      state.blockedAsks[entry.askId] = true;
    }
  }
  // Terminal retention: old terminal receipts age out (pending/unknown NEVER).
  const cutoff = now() - TERMINAL_RETENTION_MS;
  for (const [key, entry] of Object.entries(state.attempts)) {
    const terminal = entry.state === 'committed' || entry.state === 'failed';
    if (terminal && (entry.updatedAt || 0) < cutoff) delete state.attempts[key];
  }
  if (Object.keys(state.attempts).length > 0) persist(state);

  function isBlocked(askId) { return state.blockedAsks[askId] === true; }

  function get(peerId, askId, requestId) {
    return state.attempts[keyOf(peerId, askId, requestId)] || null;
  }

  // Create the pending receipt. Refuses when the ask is blocked, or at cap —
  // NEVER evicts a pending/unknown attempt to make room.
  function attempt({ peerId, askId, requestId, text }) {
    if (isBlocked(askId)) return { ok: false, reason: 'blocked' };
    const key = keyOf(peerId, askId, requestId);
    const existing = state.attempts[key];
    if (existing) {
      if (existing.digest !== digestOf(text)) return { ok: false, reason: 'digest-conflict', entry: existing };
      return { ok: true, replay: true, entry: existing };
    }
    const terminalCount = Object.values(state.attempts)
      .filter((e) => e.state !== 'pending' && e.state !== 'delivery-unknown').length;
    if (Object.keys(state.attempts).length >= CAP_ATTEMPTS && terminalCount === 0) {
      return { ok: false, reason: 'cap' };
    }
    const entry = {
      peerId, askId, requestId,
      digest: digestOf(text),
      state: 'pending',
      createdAt: now(), updatedAt: now(),
    };
    state.attempts[key] = entry;
    persist(state);
    return { ok: true, replay: false, entry };
  }

  function finalize(peerId, askId, requestId, finalState, receipt) {
    const entry = state.attempts[keyOf(peerId, askId, requestId)];
    if (!entry) return false;
    if (entry.state !== 'pending') { entry.replayedAt = now(); return true; }
    entry.state = finalState;
    entry.receipt = receipt === undefined ? null : receipt;
    entry.updatedAt = now();
    persist(state);
    return true;
  }

  // Explicit operator reconciliation (local, authenticated, never federated):
  // every delivery-unknown attempt of the ask gets the decided outcome and the
  // ask is unlocked for new pastes.
  function reconcile(askId, decision, expect = null) {
    const finalState = decision === 'mark-delivered' ? 'committed'
      : decision === 'allow-new-attempt' ? 'failed' : null;
    if (!finalState) return { ok: false, reason: 'bad-decision' };
    // The decision is bound to the GENERATION it was taken on: the exact set of
    // unresolved outcomes that was visible when the operator decided. If that
    // set moved (or is empty), this reconciliation is refused instead of
    // unlocking a generation nobody decided about.
    const current = reconcilableFor(askId);
    if (current.count === 0) return { ok: false, reason: 'nothing-to-reconcile' };
    if (expect && (expect.count !== current.count || expect.generation !== current.generation)) {
      return { ok: false, reason: 'generation-changed' };
    }
    // The unlock is exposed ONLY after the durable write succeeded: the fields
    // this decision touches are snapshotted first, so a failed write leaves the
    // ask exactly as blocked as it was (no half-reconciled state in memory).
    const touched = [];
    let changed = 0;
    for (const [key, entry] of Object.entries(state.attempts)) {
      if (entry.askId === askId && entry.state === 'delivery-unknown') {
        touched.push([key, { ...entry }]);
        entry.state = finalState;
        entry.receipt = 'reconciled';
        entry.updatedAt = now();
        changed += 1;
      }
    }
    const wasBlocked = state.blockedAsks[askId] === true;
    delete state.blockedAsks[askId];
    try {
      persist(state);
    } catch (_) {
      for (const [key, prev] of touched) state.attempts[key] = prev;
      if (wasBlocked) state.blockedAsks[askId] = true;
      return { ok: false, reason: 'persist-failed' };
    }
    return { ok: true, changed };
  }

  // The authoritative answer state of an ask, as the durable receipts know it:
  // a terminal write (`committed` after a paste, `delivered` after an operator
  // reconciliation) means the ask already produced its answer — whatever store
  // the caller went through. `unknown` marks an outcome that is still unresolved.
  function answerStateFor(askId) {
    let unfinished = false;
    for (const entry of Object.values(state.attempts)) {
      if (entry.askId !== askId) continue;
      if (entry.state === 'committed' || entry.state === 'delivered') return entry.state;
      if (entry.state === 'pending' || entry.state === 'delivery-unknown') unfinished = true;
    }
    return unfinished ? 'unknown' : null;
  }

  // The outcomes an operator can reconcile right now: the delivery-unknown
  // attempts of this ask, with a short digest of their identity set. `pending`
  // attempts are a paste still in flight — they are NOT reconcilable and are
  // reported separately, so nobody can decide on an outcome that is still open.
  function reconcilableFor(askId) {
    const ids = [];
    let live = 0;
    for (const entry of Object.values(state.attempts)) {
      if (entry.askId !== askId) continue;
      if (entry.state === 'delivery-unknown') ids.push(String(entry.requestId));
      else if (entry.state === 'pending') live += 1;
    }
    ids.sort();
    return {
      count: ids.length,
      live,
      generation: crypto.createHash('sha256').update(ids.join('|'), 'utf8').digest('hex').slice(0, 16),
    };
  }

  function statusFor(askId) {
    const attempts = Object.values(state.attempts).filter((e) => e.askId === askId);
    return {
      blocked: isBlocked(askId),
      attempts: attempts.length,
      unknown: attempts.filter((e) => e.state === 'delivery-unknown').length,
    };
  }

  return { attempt, get, finalize, isBlocked, reconcile, reconcilableFor, statusFor, answerStateFor, digestOf };
}

module.exports = { createAskReceipts, digestOf, keyOf, CAP_ATTEMPTS };
