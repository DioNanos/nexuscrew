'use strict';
// lib/notify/ask-answer-service.js — ONE answer cycle for BOTH the local route
// and the federated one. There is no second path: claim (synchronous) ->
// paste to the session FROM THE STORE (never from a body) -> commit or a
// declared failure -> a qualified closure event (askId, revision, cell).
//
// Federated attempts additionally carry a durable receipt (written BEFORE the
// paste) and an idempotency contract: the same requestId with the same text
// after a timeout returns the stored state WITHOUT pasting again; the same id
// with a different text is a 409. A locked ask (delivery-unknown from a
// previous crash) refuses new pastes on EVERY path until the operator
// reconciles explicitly: no silent retries, no TTL.

const crypto = require('node:crypto');

const REQUEST_ID_RE = /^[0-9a-f-]{16,64}$/i;

function createAskAnswerService({ asks, paste, receipts, onClosure, labelPrefix = 'reply' } = {}) {
  if (!asks || !paste) throw new Error('createAskAnswerService: asks e paste richiesti');
  const emitClosure = typeof onClosure === 'function' ? onClosure : () => {};

  function pasteText(askId, text, label) {
    return `[${label} reply · ask#${askId}] ${text}`;
  }

  // The shared core. Returns {ok:true} or {ok:false, code, error, reason}.
  async function runAnswer({ askId, text, request = null }) {
    // A locked ask refuses new pastes on every path until reconciliation.
    if (receipts && receipts.isBlocked(askId)) {
      return { ok: false, code: 409, error: 'ask con esito incerto: richiede riconciliazione dell\'operatore', reason: 'delivery-unknown-block' };
    }
    const claim = asks.claim(askId);
    if (!claim.ok) {
      if (claim.reason === 'unknown') return { ok: false, code: 404, error: 'ask inesistente', reason: 'unknown' };
      if (claim.reason === 'dismissed') return { ok: false, code: 409, error: 'ask gia\' scartato (dismissed)', reason: 'dismissed' };
      if (claim.reason === 'answering') return { ok: false, code: 409, error: 'risposta gia\' in corso da un\'altra richiesta', reason: 'answering' };
      return { ok: false, code: 409, error: 'ask gia\' risposto', reason: 'answered' };
    }
    let pasted = false;
    try {
      pasted = await paste(claim.ask.session, pasteText(askId, text, labelPrefix));
    } catch (_) { pasted = false; }
    if (!pasted) {
      asks.release(askId); // rollback: the ask stays open and contestable
      if (request && receipts) receipts.finalize(request.peerId, askId, request.requestId, 'failed', 'paste-failed');
      return { ok: false, code: 502, error: `paste fallito: sessione "${claim.ask.session}" non raggiungibile`, reason: 'paste-failed' };
    }
    const committed = asks.commit(askId, text);
    if (request && receipts) receipts.finalize(request.peerId, askId, request.requestId, 'committed', null);
    const finalAsk = asks.get(askId);
    emitClosure('ask-answered', { askId, revision: (finalAsk && finalAsk.revision) || 1, cellSession: finalAsk && finalAsk.session });
    return { ok: true, committed };
  }

  // LOCAL answer: validation and binding already happened in the route.
  async function answerLocal({ askId, text }) {
    return runAnswer({ askId, text });
  }

  // FEDERATED answer: the receipt lifecycle wraps the same core.
  async function answerFederated({ askId, text, peerId, requestId }) {
    if (!requestId || !REQUEST_ID_RE.test(String(requestId))) {
      return { ok: false, code: 400, error: 'requestId non valido', reason: 'bad-request-id' };
    }
    if (!receipts) return { ok: false, code: 503, error: 'receipt store non disponibile', reason: 'no-receipts' };
    const existing = receipts.get(peerId, askId, requestId);
    const digest = receipts.digestOf(text);
    if (existing) {
      // Same id, same text: the stored state, never a second paste.
      if (existing.digest === digest) {
        return { ok: true, replay: true, state: existing.state };
      }
      // Same id, different text: never answer twice with diverging payloads.
      return { ok: false, code: 409, error: 'stesso requestId con testo diverso', reason: 'request-conflict' };
    }
    // Receipt BEFORE the paste: a failed receipt write means no paste at all.
    const receipt = receipts.attempt({ peerId, askId, requestId, text });
    if (!receipt.ok) {
      if (receipt.reason === 'blocked') {
        return { ok: false, code: 409, error: 'ask con esito incerto: richiede riconciliazione dell\'operatore', reason: 'delivery-unknown-block' };
      }
      if (receipt.reason === 'digest-conflict') {
        return { ok: false, code: 409, error: 'stesso requestId con testo diverso', reason: 'request-conflict' };
      }
      return { ok: false, code: 429, error: 'receipt store al cap', reason: 'receipt-cap' };
    }
    const out = await runAnswer({ askId, text, request: { peerId, requestId } });
    if (out.ok) return { ok: true, state: 'committed' };
    // 409-class failures are answered as they are (the attempt was marked
    // failed); transport failures keep the attempt failed too — the peer may
    // re-check the status instead of blindly retrying.
    return out;
  }

  // Dismiss: idempotent, refused while an answer is in flight.
  function dismiss(askId) {
    const out = asks.dismiss(askId);
    if (!out.ok) return out;
    emitClosure('ask-dismissed', { askId, revision: (out.ask && out.ask.revision) || 1, cellSession: out.ask && out.ask.session });
    return out;
  }

  return { answerLocal, answerFederated, dismiss, pasteText };
}

module.exports = { createAskAnswerService, REQUEST_ID_RE };
