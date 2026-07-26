'use strict';
// lib/audio/group-speak.js — orchestrazione origin-side di gruppi nominati.
//
// Il gruppo NON e' un'autorizzazione: espande una lista locale di instanceId e
// interroga ogni nodo. Primary/failover e' sequenziale; fanout e' esplicito e
// parallelo. Ogni esito resta per-endpoint, inclusi gli endpoint non tentati.
const { TEXT_MAX } = require('./speak.js');
const { validName, MODES } = require('./groups.js');
const { callerKey } = require('./receipt.js');
// Duplicato intenzionale del contratto di routes: importare routes qui
// creerebbe un ciclo (routes monta il group speaker) e renderebbe la regex
// `undefined` durante il caricamento CommonJS.
const UTTERANCE_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

const ACK_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 250;

function validText(text) { return typeof text === 'string' && text.length >= 1 && text.length <= TEXT_MAX; }

function createGroupSpeaker(deps = {}) {
  const getGroup = deps.getGroup || (() => null);
  const receipts = deps.receipts;
  const capability = deps.capability || (async () => ({ status: 'unreachable', reason: 'capability-unavailable' }));
  const speak = deps.speak || (async () => ({ status: 'unreachable', reason: 'dispatch-unavailable' }));
  const status = deps.status || (async () => ({ status: 'unknown', reason: 'status-unavailable' }));
  const stop = deps.stop || (async () => ({ status: 'unknown', reason: 'stop-unavailable' }));
  const now = deps.now || Date.now;
  const sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const ackTimeoutMs = Number.isFinite(deps.ackTimeoutMs) ? deps.ackTimeoutMs : ACK_TIMEOUT_MS;
  const pollIntervalMs = Number.isFinite(deps.pollIntervalMs) ? deps.pollIntervalMs : POLL_INTERVAL_MS;
  const running = new Set();

  if (!receipts || typeof receipts.begin !== 'function') throw new Error('group speaker: receipt store obbligatorio');

  async function awaitStart({ target, origin, utteranceId }) {
    const deadline = now() + ackTimeoutMs;
    while (now() < deadline) {
      await sleep(Math.max(1, Math.min(pollIntervalMs, deadline - now())));
      const current = await status({ target, origin, utteranceId });
      if (!current || typeof current.status !== 'string') return { status: 'unknown', reason: 'status-unreadable' };
      if (current.status !== 'accepted') return current;
    }
    return { status: 'unknown', reason: 'ack-timeout' };
  }

  async function runEndpoint({ target, origin, utteranceId, text, lang, voice, urgency, onAdmitted = null }) {
    if (receipts.isStopped(origin, utteranceId)) return { status: 'refused', reason: 'stopped', admitted: false };
    const cap = await capability({ target, origin });
    if (!cap || cap.status !== 'ready') {
      return {
        status: cap && ['refused', 'unreachable', 'unknown'].includes(cap.status) ? cap.status : 'unknown',
        ...(cap && cap.reason ? { reason: cap.reason } : { reason: 'capability-unavailable' }),
        admitted: false,
      };
    }
    if (receipts.isStopped(origin, utteranceId)) return { status: 'refused', reason: 'stopped', admitted: false };
    const initial = await speak({ target, origin, utteranceId, text, lang, voice, urgency });
    if (!initial || typeof initial.status !== 'string') return { status: 'unknown', reason: 'speak-unreadable', admitted: false };
    if (initial.status !== 'accepted') {
      // Anche uno `spoken` sincrono e' gia' ammesso: registra prima questo
      // fatto minimo cosi' uno Stop concorrente non perde una finestra di un
      // microtask fra la risposta dell'adapter e l'update finale del receipt.
      if (initial.status === 'spoken' && typeof onAdmitted === 'function') onAdmitted();
      return { status: initial.status, reason: initial.reason, admitted: initial.status === 'spoken' };
    }
    // L'endpoint ha ammesso l'enunciato: registrarlo PRIMA di aspettare l'ack
    // permette a Stop di raggiungerlo anche se il polling resta appeso. Non e'
    // ancora `spoken`, quindi il receipt non promette udibilita'.
    if (typeof onAdmitted === 'function') onAdmitted();
    const final = await awaitStart({ target, origin, utteranceId });
    return { status: final.status, reason: final.reason, admitted: true };
  }

  function runKey(origin, utteranceId) { return `${callerKey(origin) || ''}\u0000${utteranceId}`; }

  async function orchestrate({ origin, spec, utteranceId, text, lang, voice, urgency }) {
    const one = async (target) => {
      if (receipts.isStopped(origin, utteranceId)) return { status: 'refused', reason: 'stopped', admitted: false };
      let result;
      try {
        result = await runEndpoint({
          target, origin, utteranceId, text, lang, voice, urgency,
          onAdmitted: () => receipts.update(origin, utteranceId, target, 'accepted', undefined, true),
        });
      }
      catch (_) { result = { status: 'unknown', reason: 'endpoint-error', admitted: false }; }
      receipts.update(origin, utteranceId, target, result.status, result.reason, result.admitted);
      return result;
    };
    if (spec.mode === 'fanout') {
      await Promise.all(spec.targets.map(one));
      return;
    }
    for (const target of spec.targets) {
      if (receipts.isStopped(origin, utteranceId)) return;
      const result = await one(target);
      if (result.status === 'spoken') return;
    }
  }

  async function speakGroup({ origin, group, text, lang = '', voice = '', urgency = 'normal', utteranceId } = {}) {
    if (!validName(group)) return { status: 'refused', reason: 'invalid-group' };
    if (!validText(text)) return { status: 'refused', reason: 'invalid-text' };
    if (utteranceId && !UTTERANCE_ID_RE.test(utteranceId)) return { status: 'refused', reason: 'invalid-utterance' };
    const spec = getGroup(group);
    if (!spec || !Array.isArray(spec.targets) || !MODES.includes(spec.mode)) return { status: 'refused', reason: 'unknown-group' };
    let begun;
    try { begun = receipts.begin({ origin, group, mode: spec.mode, targets: spec.targets, utteranceId }); }
    catch (_) { return { status: 'refused', reason: 'utterance-collision' }; }
    if (!begun.created) return begun.receipt; // retry idempotente: non risuona
    const id = begun.receipt.utteranceId;
    const key = runKey(origin, id);
    // Il comando non aspetta fino a 8 × 5s: conserva subito un receipt
    // interrogabile e completa in background. In questo modo la semantica
    // resta asincrona come `nc_speak`; `not-attempted` non e' un falso esito,
    // indica precisamente che il candidato non e' ancora stato provato.
    running.add(key);
    Promise.resolve().then(() => orchestrate({ origin, spec, utteranceId: id, text, lang, voice, urgency }))
      .catch(() => {})
      .finally(() => running.delete(key));
    return begun.receipt;
  }

  async function stopGroup({ origin, utteranceId } = {}) {
    if (!utteranceId || !UTTERANCE_ID_RE.test(utteranceId)) return { status: 'refused', reason: 'invalid-utterance' };
    const existing = receipts.get(origin, utteranceId);
    if (!existing) return { status: 'unknown', reason: 'not-found', utteranceId };
    // Stop prima la pipeline locale: i candidati non ancora tentati non devono
    // partire mentre la rete sta ricevendo gli stop degli endpoint gia' ammessi.
    const admitted = receipts.admittedTargets(origin, utteranceId);
    receipts.stop(origin, utteranceId);
    await Promise.all(admitted.map(async (target) => {
      try { await stop({ target, origin, utteranceId }); } catch (_) { /* receipt resta ultimo stato onesto */ }
    }));
    return receipts.get(origin, utteranceId);
  }

  return {
    speakGroup, stopGroup,
    getStatus: ({ origin, utteranceId }) => receipts.get(origin, utteranceId),
    // Solo seam di test/diagnostica locale: non e' esposto dalle route.
    isRunning: ({ origin, utteranceId }) => running.has(runKey(origin, utteranceId)),
  };
}

module.exports = { createGroupSpeaker, ACK_TIMEOUT_MS, POLL_INTERVAL_MS };
