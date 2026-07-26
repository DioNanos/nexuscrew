'use strict';
// lib/audio/speak.js — catena di gate LATO TARGET: la decisione di emettere
// suono la prende il nodo che possiede l'altoparlante, sempre, anche quando la
// richiesta e' gia' passata da una route federata autorizzata.
//
// Ordine dei gate, deliberato:
//   0. testo valido (1..320)                    — nessun effetto collaterale
//   1. target esatto e uguale a QUESTO nodo     — un nodo parla solo per se'
//   2. READONLY                                 — `speak` e' una mutazione: ha
//      un effetto fisico osservabile, quindi in sola lettura si rifiuta
//   3. ACL sull'origine
//   4. consenso audio locale (default OFF)
//   5. idempotenza per utteranceId              — PRIMA del rate limit, cosi' un
//      retry identico non consuma budget e non produce una seconda voce
//   6. rate limit dedicato
//   7. adapter/coda presenti                    — senza adapter si dice no, non
//      si finge un `accepted`
//   8. accodamento
//
// I gate 3 e 4 stanno prima dell'idempotenza di proposito: un rifiuto per ACL o
// consenso deve restare un rifiuto anche al secondo tentativo, non trasformarsi
// in un receipt riusato.
const INSTANCE_ID_RE = /^[a-f0-9]{32}$/i;
const TEXT_MAX = 320;

function isValidInstance(v) {
  return typeof v === 'string' && INSTANCE_ID_RE.test(v);
}

// handleSpeak(): ritorna SEMPRE uno stato per endpoint, mai un booleano.
// `deps.receipt(status, opts)` registra e ritorna il receipt redatto.
function handleSpeak(input, deps) {
  const opts = input || {};
  const d = deps || {};
  const { target, origin } = opts;

  if (typeof opts.text !== 'string' || opts.text.length < 1 || opts.text.length > TEXT_MAX) {
    return { status: 'refused', reason: 'invalid-text' };
  }
  if (!isValidInstance(target)) return { status: 'refused', reason: 'invalid-target' };
  // Un target diverso da questo nodo non e' affar suo: il nodo non ritrasmette
  // e non fa da relay applicativo per la voce di un altro.
  if (typeof d.localNodeId === 'function' && target !== d.localNodeId()) {
    return { status: 'refused', reason: 'not-local-target' };
  }
  if (typeof d.readonly === 'function' && d.readonly()) {
    return d.receipt('refused', { reason: 'readonly', target, origin, utteranceId: opts.utteranceId });
  }
  if (typeof d.acl === 'function') {
    const verdict = d.acl({ trust: opts.trust, origin, visited: opts.visited });
    if (!verdict || verdict.allowed !== true) {
      // La reason resta generica verso l'esterno: la ragione precisa del rifiuto
      // descriverebbe la topologia del nodo a chi non e' autorizzato a vederla.
      return d.receipt('refused', { reason: 'acl', target, origin, utteranceId: opts.utteranceId });
    }
  }
  if (typeof d.consent === 'function' && d.consent() !== true) {
    return d.receipt('refused', { reason: 'consent', target, origin, utteranceId: opts.utteranceId });
  }
  if (opts.utteranceId && typeof d.findReceipt === 'function') {
    const found = d.findReceipt(opts.utteranceId, origin, target);
    if (found === 'collision') {
      const ts = typeof d.now === 'function' ? d.now() : Date.now();
      return {
        status: 'refused', reason: 'utterance-collision', utteranceId: opts.utteranceId,
        origin: { node: origin && origin.node, cell: origin && origin.cell }, target, timestamp: ts,
      };
    }
    if (found) return found;
  }
  if (d.rateLimiter) {
    const rl = d.rateLimiter.check({ origin, target, urgency: opts.urgency });
    if (!rl.allowed) {
      return d.receipt('refused', { reason: 'rate-limit', target, origin, utteranceId: opts.utteranceId });
    }
  }
  if (!d.queue || typeof d.queue.enqueue !== 'function') {
    return d.receipt('refused', { reason: 'no-adapter', target, origin, utteranceId: opts.utteranceId });
  }
  // Il receipt nasce PRIMA dell'accodamento: la coda aggiornera' questo stesso
  // utteranceId quando l'adapter conferma l'avvio, fallisce o va in timeout.
  const receipt = d.receipt('accepted', { target, origin, utteranceId: opts.utteranceId });
  const admitted = d.queue.enqueue({
    utteranceId: receipt.utteranceId,
    text: opts.text, lang: opts.lang, voice: opts.voice, urgency: opts.urgency,
  });
  if (admitted.status !== 'accepted') {
    return (d.updateReceipt && d.updateReceipt(receipt.utteranceId, admitted.status, admitted.reason))
      || { ...receipt, status: admitted.status, ...(admitted.reason ? { reason: admitted.reason } : {}) };
  }
  // La coda puo' aver gia' concluso in modo sincrono (adapter fake nei test,
  // fallimento immediato di spawn): si rilegge il receipt invece di riportare
  // uno stato ormai superato.
  return (d.readReceipt && d.readReceipt(receipt.utteranceId, origin)) || receipt;
}

// handleStop(): comando di controllo, non sintesi. Lo stop LOCALE e' sovrano e
// non dipende dalla rete: un endpoint deve poter tacere anche offline. Uno stop
// remoto per utteranceId vale solo per gli enunciati del chiamante.
function handleStop(input, deps) {
  const opts = input || {};
  const d = deps || {};
  const { target, origin } = opts;
  if (!isValidInstance(target)) return { status: 'refused', reason: 'invalid-target' };
  if (typeof d.localNodeId === 'function' && target !== d.localNodeId()) {
    return { status: 'refused', reason: 'not-local-target' };
  }
  // READONLY non blocca lo stop: fermare una voce e' sempre permesso. Impedirlo
  // significherebbe che un nodo in sola lettura non puo' zittirsi.
  if (opts.utteranceId) {
    if (typeof d.findReceipt === 'function') {
      const found = d.findReceipt(opts.utteranceId, origin, target);
      if (!found || found === 'collision') {
        return { status: 'unknown', reason: 'utterance-not-found', utteranceId: opts.utteranceId };
      }
    }
    const acted = d.queue && typeof d.queue.stop === 'function' ? d.queue.stop(opts.utteranceId) : false;
    if (d.updateReceipt && acted) d.updateReceipt(opts.utteranceId, 'refused', 'stopped');
    return { status: 'accepted', utteranceId: opts.utteranceId, stopped: acted === true };
  }
  const acted = d.queue && typeof d.queue.stopAll === 'function' ? d.queue.stopAll() : false;
  return { status: 'accepted', stopped: acted === true };
}

module.exports = { handleSpeak, handleStop, isValidInstance, INSTANCE_ID_RE, TEXT_MAX };
