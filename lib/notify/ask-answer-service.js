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
    // The receipt is authoritative AT THE POINT OF PASTE: an ask whose durable
    // answer state is already terminal cannot produce a second paste, whichever
    // path got here — the ask store alone is not enough, because a reconciliation
    // can land on the receipt without closing the ask.
    const answerState = receipts && typeof receipts.answerStateFor === 'function'
      ? receipts.answerStateFor(askId) : null;
    if (answerState === 'committed' || answerState === 'delivered') {
      return { ok: false, code: 409, error: 'ask gia\' consegnato: nessun nuovo paste', reason: 'already-delivered' };
    }
    const claim = asks.claim(askId);
    if (!claim.ok) {
      // Refused BEFORE any paste: the attempt is closed here. Left `pending`, it
      // would come back as delivery-unknown after a restart and block the ask
      // for a paste that never happened.
      if (request && receipts) receipts.finalize(request.peerId, askId, request.requestId, 'failed', `refused:${claim.reason}`);
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
    // Every refusal is answered as it is: a rejection BEFORE the paste (claim
    // lost, ask closed, locked) finalizes the attempt as failed, and a transport
    // failure does the same — the peer re-checks the status instead of blindly
    // retrying.
    return out;
  }

  // Dismiss: idempotent, refused while an answer is in flight, and refused on an
  // ask whose delivery is still unknown — dismissing the card would hide an
  // outcome the operator still has to reconcile.
  function dismiss(askId) {
    if (receipts && receipts.isBlocked(askId)) {
      return { ok: false, code: 409, error: 'ask con esito incerto: richiede riconciliazione dell\'operatore', reason: 'delivery-unknown-block' };
    }
    const out = asks.dismiss(askId);
    if (!out.ok) return out;
    emitClosure('ask-dismissed', { askId, revision: (out.ask && out.ask.revision) || 1, cellSession: out.ask && out.ask.session });
    return out;
  }

  // Operator reconciliation of a delivery-unknown attempt. The revision is a
  // MANDATORY compare-and-set: a reconciliation decided on a generation that is
  // already gone must not unlock anything, and the transition itself advances
  // the revision so the same token cannot be replayed.
  function reconcile({ askId, decision, expectedRevision }) {
    if (decision !== 'mark-delivered' && decision !== 'allow-new-attempt') {
      return { ok: false, code: 400, error: 'decision deve essere mark-delivered|allow-new-attempt', reason: 'bad-decision' };
    }
    if (!receipts) return { ok: false, code: 503, error: 'receipt store non disponibile', reason: 'no-receipts' };
    const ask = asks.get(askId);
    if (!ask) return { ok: false, code: 404, error: 'ask inesistente', reason: 'unknown' };
    if (expectedRevision === undefined || expectedRevision === null || expectedRevision === '') {
      return { ok: false, code: 400, error: 'expectedRevision obbligatoria', reason: 'revision-required' };
    }
    if (Number(expectedRevision) !== (ask.revision || 0)) {
      return { ok: false, code: 409, error: 'revision stantia', reason: 'revision-conflict' };
    }
    // A paste that is still in flight is not an outcome to reconcile: its claim
    // is HERS, and deciding here would release a claim mid-paste and let a
    // second paste through. Refused without touching the claim.
    // The window between this check and markReconciled is SYNCHRONOUS (there is
    // no await in between), so no new claim can appear once the refusal is not
    // taken: that is what makes the guard sufficient, not the receipt alone.
    const live = receipts.reconcilableFor(askId);
    if ((typeof asks.isAnswering === 'function' && asks.isAnswering(askId)) || live.live > 0) {
      return {
        ok: false, code: 409, reason: 'answering',
        error: 'paste in corso su questa ask: riconciliazione rifiutata, il claim non si tocca',
      };
    }
    // Nothing unresolved: `ok:true, changed:0` would be a false success.
    if (live.count === 0) {
      return { ok: false, code: 409, reason: 'nothing-to-reconcile', error: 'nessun esito incerto da riconciliare' };
    }
    const expect = { count: live.count, generation: live.generation };

    // Restrictive write FIRST, permissive one last: the ask-store transition
    // closes the ask (mark-delivered) or just advances the revision
    // (allow-new-attempt), while the receipt keeps blocking the paste until its
    // own durable write lands. A partial failure therefore never leaves a state
    // where a paste is possible: the residue is "ask closed" or "receipt still
    // blocked", never more permissive than the decision.
    const moved = asks.markReconciled(askId, decision);
    if (!moved.ok) {
      return { ok: false, code: 500, error: 'transizione non scritta: stato invariato', reason: 'ask-transition-failed' };
    }
    const out = receipts.reconcile(askId, decision, expect);
    if (!out.ok) {
      return {
        ok: false, code: out.reason === 'nothing-to-reconcile' || out.reason === 'generation-changed' ? 409 : 500,
        reason: out.reason,
        error: decision === 'mark-delivered'
          ? 'ricevuta non riconciliata: ask comunque chiuso (nessun paste possibile)'
          : 'ricevuta non riconciliata: blocco ancora attivo (nessun paste possibile)',
      };
    }
    return { ok: true, changed: out.changed, revision: (moved.ask && moved.ask.revision) || 0 };
  }

  return { answerLocal, answerFederated, dismiss, reconcile, pasteText };
}

module.exports = { createAskAnswerService, REQUEST_ID_RE };
