'use strict';
// lib/audio/routes.js — route audio locali: /speak, /stop, /capability, /status.
//
// Due invarianti reggono tutto il resto.
//
// 1) L'origine e' verificata, non dichiarata. `originResolver` e' obbligatorio e
//    autoritativo: nessun header, campo del body o parametro di query concorre a
//    stabilire chi sta parlando. Senza un'origine verificabile la richiesta
//    muore con 401, non con un default permissivo.
//
// 2) Ogni decisione di suonare la prende il nodo che possiede l'altoparlante. Se
//    il target e' remoto questo server non decide per lui: instrada e riporta
//    l'esito per endpoint cosi' com'e', incluso `unknown`.
//
// Il corpo grezzo viene conservato (`req.rawBody`) perche' la firma del bridge
// copre i BYTE trasmessi: ri-serializzare il JSON per verificarlo produrrebbe
// una stringa diversa a parita' di significato.
const express = require('express');
const { handleSpeak, handleStop, isValidInstance } = require('./speak.js');
const { describeCapability } = require('./capability.js');
const { createReceiptStore } = require('./receipt.js');
const { createSpeakRateLimiter } = require('./rate-limit.js');
const { createGroupReceiptStore } = require('./group-receipt.js');
const { createGroupSpeaker } = require('./group-speak.js');

const UTTERANCE_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;
const LANG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,34})$/;
const VOICE_RE = /^[^\u0000-\u001f\u007f]{1,64}$/;
const URGENCIES = new Set(['normal', 'high']);

function plainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value, allowed) {
  return plainObject(value) && Object.keys(value).every((key) => allowed.has(key));
}

function optionalBounded(value, re) {
  return value === undefined || (typeof value === 'string' && re.test(value));
}

// Il server non deve diventare tollerante verso campi futuri/non documentati:
// testo, route o identita' inattesi non vengono mai ignorati in silenzio.
// `originCell`/`originNode` sono gli unici campi aggiunti dal dispatcher sul
// percorso federato; il target li ricontrolla nel resolver, non li usa mai
// come fonte primaria dell'identita'.
function parseSpeakBody(body, { federated = false } = {}) {
  const allowed = new Set(['target', 'text', 'lang', 'voice', 'urgency', 'utteranceId']);
  if (federated) { allowed.add('originCell'); allowed.add('originNode'); }
  if (!onlyKeys(body, allowed)) return { error: 'invalid-request' };
  const target = typeof body.target === 'string' ? body.target : '';
  if (!isValidInstance(target)) return { error: 'invalid-target' };
  if (typeof body.text !== 'string' || body.text.length < 1 || body.text.length > 320) return { error: 'invalid-text' };
  if (!optionalBounded(body.lang, LANG_RE) || !optionalBounded(body.voice, VOICE_RE)) return { error: 'invalid-request' };
  if (body.urgency !== undefined && !URGENCIES.has(body.urgency)) return { error: 'invalid-request' };
  if (body.utteranceId !== undefined && (typeof body.utteranceId !== 'string' || !UTTERANCE_ID_RE.test(body.utteranceId))) {
    return { error: 'invalid-utterance' };
  }
  return {
    target, text: body.text,
    ...(body.lang !== undefined ? { lang: body.lang } : {}),
    ...(body.voice !== undefined ? { voice: body.voice } : {}),
    urgency: body.urgency || 'normal',
    ...(body.utteranceId ? { utteranceId: body.utteranceId } : {}),
  };
}

function parseStopBody(body, { federated = false } = {}) {
  const allowed = new Set(['target', 'utteranceId']);
  if (federated) { allowed.add('originCell'); allowed.add('originNode'); }
  if (!onlyKeys(body, allowed)) return { error: 'invalid-request' };
  const target = typeof body.target === 'string' ? body.target : '';
  if (!isValidInstance(target)) return { error: 'invalid-target' };
  if (body.utteranceId !== undefined && (typeof body.utteranceId !== 'string' || !UTTERANCE_ID_RE.test(body.utteranceId))) {
    return { error: 'invalid-utterance' };
  }
  return { target, ...(body.utteranceId ? { utteranceId: body.utteranceId } : {}) };
}

function parseRemoteStatusBody(body) {
  if (!onlyKeys(body, new Set(['target', 'utteranceId', 'originCell', 'originNode']))) return { error: 'invalid-request' };
  if (!isValidInstance(body.target)) return { error: 'invalid-target' };
  if (typeof body.utteranceId !== 'string' || !UTTERANCE_ID_RE.test(body.utteranceId)) return { error: 'invalid-utterance' };
  return { target: body.target, utteranceId: body.utteranceId };
}

function parseGroupSpeakBody(body) {
  if (!onlyKeys(body, new Set(['group', 'text', 'lang', 'voice', 'urgency', 'utteranceId']))) return { error: 'invalid-request' };
  if (typeof body.group !== 'string') return { error: 'invalid-group' };
  if (typeof body.text !== 'string' || body.text.length < 1 || body.text.length > 320) return { error: 'invalid-text' };
  if (!optionalBounded(body.lang, LANG_RE) || !optionalBounded(body.voice, VOICE_RE)) return { error: 'invalid-request' };
  if (body.urgency !== undefined && !URGENCIES.has(body.urgency)) return { error: 'invalid-request' };
  if (body.utteranceId !== undefined && (typeof body.utteranceId !== 'string' || !UTTERANCE_ID_RE.test(body.utteranceId))) {
    return { error: 'invalid-utterance' };
  }
  return {
    group: body.group, text: body.text, urgency: body.urgency || 'normal',
    ...(body.lang !== undefined ? { lang: body.lang } : {}),
    ...(body.voice !== undefined ? { voice: body.voice } : {}),
    ...(body.utteranceId ? { utteranceId: body.utteranceId } : {}),
  };
}

function audioRoutes(deps = {}) {
  if (!deps.originResolver || typeof deps.originResolver.resolve !== 'function') {
    throw new Error('audioRoutes: originResolver e obbligatorio (origine verificata)');
  }
  const r = express.Router();
  r.use(express.json({
    limit: '16kb',
    verify: (req, _res, buf) => { req.rawBody = Buffer.from(buf); },
  }));

  const originResolver = deps.originResolver;
  const receiptStore = deps.receiptStore || createReceiptStore();
  const rateLimiter = deps.rateLimiter || createSpeakRateLimiter();
  const readonly = deps.readonly || (() => false);
  const localNodeId = deps.localNodeId || (() => null);
  const consent = deps.consent || (() => false);
  const adapter = deps.adapter || null;
  const queue = deps.queue || null;
  const acl = deps.acl || null;
  const dispatcher = deps.dispatcher || null;
  const getGroup = deps.getGroup || (() => null);
  const groupReceipts = deps.groupReceipts || createGroupReceiptStore();
  const now = deps.now || Date.now;

  const send = (res, code, body) => res.status(code).json(body);

  // Un solo messaggio per ogni fallimento di origine. Distinguere "firma
  // scaduta" da "nonce riusato" da "cella non attiva" darebbe a chi prova a
  // forgiare un oracolo gratuito su cosa manca per riuscire.
  async function originOr401(req, res, opts = {}) {
    const resolved = await originResolver.resolve(req, opts);
    if (!resolved || resolved.ok !== true) {
      send(res, 401, { error: 'origine non verificabile' });
      return null;
    }
    return resolved;
  }

  function gateDeps(origin, attested) {
    return {
      readonly, rateLimiter, queue, localNodeId, consent, now,
      acl: acl ? acl.allows : null,
      receipt: (status, o) => receiptStore.record({
        origin: o.origin, target: o.target, status, reason: o.reason,
        utteranceId: o.utteranceId, attested,
      }),
      updateReceipt: (id, status, reason) => receiptStore.update(id, status, reason),
      readReceipt: (id, o) => receiptStore.get(o, id),
      findReceipt: (id, o, target) => receiptStore.find(id, o, target),
    };
  }

  function localCapability(target) {
    const self = localNodeId();
    if (!self || target !== self) return { status: 'refused', reason: 'invalid-target' };
    const described = describeCapability({ adapter, consent: consent() === true, nodeId: self });
    if (described.consent !== true) return { status: 'refused', reason: 'consent' };
    if (described.installed !== true) return { status: 'refused', reason: 'no-adapter' };
    if (described.liveness !== 'ready') return { status: 'unknown', reason: 'liveness-unknown' };
    return { status: 'ready', capability: described };
  }

  async function capabilityForGroup({ target }) {
    if (!isValidInstance(target)) return { status: 'refused', reason: 'invalid-target' };
    if (target === localNodeId()) return localCapability(target);
    if (!dispatcher || typeof dispatcher.probeCapability !== 'function') return { status: 'unreachable', reason: 'dispatch-unavailable' };
    return dispatcher.probeCapability(target);
  }

  async function speakForGroup({ target, origin, utteranceId, text, lang, voice, urgency }) {
    if (target === localNodeId()) {
      return handleSpeak({
        target, text, lang, voice, urgency, utteranceId, origin, trust: 'local-bridge', visited: [],
      }, gateDeps(origin, false));
    }
    if (!dispatcher || typeof dispatcher.dispatch !== 'function') return { status: 'unreachable', reason: 'dispatch-unavailable' };
    // Un gruppo non e' una scorciatoia attorno al budget `nc_speak`: prima del
    // dispatch remoto consuma gli stessi tre bucket sul nodo origine. Il target
    // li applichera' di nuovo in modo indipendente, perche' resta l'autorita'
    // finale sul proprio altoparlante.
    const rl = rateLimiter.check({ origin, target, urgency });
    if (!rl.allowed) return { status: 'refused', reason: 'rate-limit' };
    return dispatcher.dispatch({
      resource: '/audio/speak', target, origin,
      payload: { text, ...(lang ? { lang } : {}), ...(voice ? { voice } : {}), urgency, utteranceId },
    });
  }

  async function statusForGroup({ target, origin, utteranceId }) {
    if (target === localNodeId()) return receiptStore.get(origin, utteranceId) || { status: 'unknown', reason: 'not-found' };
    if (!dispatcher || typeof dispatcher.dispatch !== 'function') return { status: 'unknown', reason: 'dispatch-unavailable' };
    return dispatcher.dispatch({ resource: '/audio/speak/status', target, origin, payload: { utteranceId } });
  }

  async function stopForGroup({ target, origin, utteranceId }) {
    if (target === localNodeId()) return handleStop({ target, utteranceId, origin }, gateDeps(origin, false));
    if (!dispatcher || typeof dispatcher.dispatch !== 'function') return { status: 'unknown', reason: 'dispatch-unavailable' };
    return dispatcher.dispatch({ resource: '/audio/stop', target, origin, payload: { utteranceId } });
  }

  const groupSpeaker = deps.groupSpeaker || createGroupSpeaker({
    getGroup, receipts: groupReceipts,
    capability: capabilityForGroup, speak: speakForGroup,
    status: statusForGroup, stop: stopForGroup,
  });

  r.post('/speak', async (req, res) => {
    const resolved = await originOr401(req, res); if (!resolved) return undefined;
    const { origin, trust, visited } = resolved;
    const parsed = parseSpeakBody(req.body, { federated: trust === 'federated' });
    if (parsed.error) return send(res, 400, { status: 'refused', reason: parsed.error });
    const { target, utteranceId } = parsed;
    // Gruppo e speak singolo condividono il namespace dell'utteranceId per
    // origine. Senza questo gate un id riusato potrebbe far sembrare `spoken`
    // un endpoint che aveva pronunciato una richiesta precedente, diversa.
    if (utteranceId && groupReceipts.get(origin, utteranceId)) {
      return send(res, 422, { status: 'refused', reason: 'utterance-collision' });
    }
    // Target remoto: questo nodo non decide e non parla. Instrada sulla
    // topologia autorizzata e restituisce l'esito del target senza addolcirlo.
    if (dispatcher && isValidInstance(target) && !dispatcher.isLocal(target)) {
      if (readonly()) return send(res, 403, { status: 'refused', reason: 'readonly' });
      const rl = rateLimiter.check({ origin, target, urgency: parsed.urgency });
      if (!rl.allowed) return send(res, 429, { status: 'refused', reason: 'rate-limit' });
      const local = receiptStore.record({
        origin, target, status: 'accepted', utteranceId, attested: trust === 'federated',
      });
      const out = await dispatcher.dispatch({
        resource: '/audio/speak', target, origin,
        payload: {
          text: parsed.text, lang: parsed.lang, voice: parsed.voice, urgency: parsed.urgency,
          utteranceId: local.utteranceId,
        },
      });
      const merged = receiptStore.update(local.utteranceId, out.status, out.reason) || {
        ...local, status: out.status, ...(out.reason ? { reason: out.reason } : {}),
      };
      const code = out.status === 'spoken' || out.status === 'accepted' || out.status === 'unknown' ? 200
        : out.status === 'unreachable' ? 503 : 422;
      return send(res, code, merged);
    }

    const out = handleSpeak({
      target, text: parsed.text, lang: parsed.lang, voice: parsed.voice, urgency: parsed.urgency,
      utteranceId, origin, trust, visited,
    }, gateDeps(origin, trust === 'federated'));
    const code = out.status === 'spoken' || out.status === 'accepted' || out.status === 'unknown' ? 200
      : (out.reason === 'invalid-text' || out.reason === 'invalid-target' || out.reason === 'not-local-target') ? 400
        : out.status === 'unreachable' ? 503 : 422;
    return send(res, code, out);
  });

  r.post('/stop', async (req, res) => {
    const resolved = await originOr401(req, res); if (!resolved) return undefined;
    const { origin } = resolved;
    const parsed = parseStopBody(req.body, { federated: resolved.trust === 'federated' });
    if (parsed.error) return send(res, 400, { status: 'refused', reason: parsed.error });
    const { target } = parsed;
    if (dispatcher && isValidInstance(target) && !dispatcher.isLocal(target)) {
      const out = await dispatcher.dispatch({
        resource: '/audio/stop', target, origin,
        payload: { ...(parsed.utteranceId ? { utteranceId: parsed.utteranceId } : {}) },
      });
      return send(res, out.status === 'accepted' ? 200 : out.status === 'unreachable' ? 503 : 422, out);
    }
    const out = handleStop({ target, utteranceId: parsed.utteranceId, origin }, gateDeps(origin, false));
    return send(res, out.status === 'accepted' || out.status === 'unknown' ? 200 : 422, out);
  });

  // Capability del SOLO nodo locale. Non e' una directory: un chiamante non puo'
  // usare questo endpoint per sondare la capability di un terzo nodo, che va
  // interrogato sulla propria route federata con la credenziale giusta.
  r.get('/capability', async (req, res) => {
    const resolved = await originOr401(req, res, { requireCell: false }); if (!resolved) return undefined;
    if (resolved.trust === 'federated' && acl && typeof acl.allows === 'function') {
      const verdict = acl.allows({ trust: resolved.trust, origin: resolved.origin, visited: resolved.visited });
      if (!verdict || verdict.allowed !== true) return send(res, 403, { error: 'capability non autorizzata' });
    }
    if (Object.keys(req.query || {}).some((key) => key !== 'target') || Array.isArray(req.query && req.query.target)) {
      return send(res, 400, { error: 'query non valida' });
    }
    const self = localNodeId();
    const target = String(req.query.target || self || '');
    if (!isValidInstance(target)) return send(res, 400, { error: 'target non valido (instanceId 32 hex)' });
    if (!self || target !== self) return send(res, 403, { error: 'capability descrive solo il nodo locale' });
    return send(res, 200, describeCapability({ adapter, consent: consent() === true, nodeId: self }));
  });

  // Status per utteranceId, leggibile SOLO dalla stessa origine (nodo+cella).
  // Per chiunque altro l'enunciato non esiste: distinguere 404 da 403
  // permetterebbe di enumerare gli id altrui.
  r.get('/speak/status/:utteranceId', async (req, res) => {
    const resolved = await originOr401(req, res); if (!resolved) return undefined;
    const rc = receiptStore.get(resolved.origin, String(req.params.utteranceId || ''));
    if (!rc) return send(res, 404, { status: 'unknown', reason: 'not-found' });
    return send(res, 200, rc);
  });

  // Status federato: POST e non GET perche' la cella attestata del chiamante
  // viaggia nel body costruito dal dispatcher. Non e' una API per browser: la
  // whitelist Hydra e la prova hop rendono il percorso raggiungibile solo da un
  // origin node gia' autenticato. Il target riapplica l'ACL prima di rivelare
  // anche il receipt redatto.
  r.post('/speak/status', async (req, res) => {
    const resolved = await originOr401(req, res); if (!resolved) return undefined;
    if (resolved.trust !== 'federated') return send(res, 403, { status: 'refused', reason: 'federated-only' });
    const parsed = parseRemoteStatusBody(req.body);
    if (parsed.error) return send(res, 400, { status: 'refused', reason: parsed.error });
    if (parsed.target !== localNodeId()) return send(res, 403, { status: 'refused', reason: 'not-local-target' });
    if (acl && typeof acl.allows === 'function') {
      const verdict = acl.allows({ trust: resolved.trust, origin: resolved.origin, visited: resolved.visited });
      if (!verdict || verdict.allowed !== true) return send(res, 422, { status: 'refused', reason: 'acl' });
    }
    const rc = receiptStore.get(resolved.origin, parsed.utteranceId);
    if (!rc) return send(res, 404, { status: 'unknown', reason: 'not-found' });
    return send(res, 200, rc);
  });

  // I gruppi sono locali all'origine e non fanno parte della whitelist
  // federata: la loro espansione avviene qui, quindi ogni endpoint riceve un
  // comando /audio/speak esatto e applica autonomamente consenso/ACL/READONLY.
  r.post('/groups/speak', async (req, res) => {
    const resolved = await originOr401(req, res); if (!resolved) return undefined;
    if (resolved.trust !== 'local-bridge') return send(res, 403, { status: 'refused', reason: 'local-bridge-required' });
    const parsed = parseGroupSpeakBody(req.body);
    if (parsed.error) return send(res, 400, { status: 'refused', reason: parsed.error });
    if (readonly()) return send(res, 422, { status: 'refused', reason: 'readonly' });
    if (parsed.utteranceId && receiptStore.get(resolved.origin, parsed.utteranceId)) {
      return send(res, 422, { status: 'refused', reason: 'utterance-collision' });
    }
    const out = await groupSpeaker.speakGroup({ origin: resolved.origin, ...parsed });
    const code = out.status === 'refused' ? 422 : 200;
    return send(res, code, out);
  });

  r.get('/groups/status/:utteranceId', async (req, res) => {
    const resolved = await originOr401(req, res); if (!resolved) return undefined;
    if (resolved.trust !== 'local-bridge') return send(res, 403, { status: 'refused', reason: 'local-bridge-required' });
    const utteranceId = String(req.params.utteranceId || '');
    if (!UTTERANCE_ID_RE.test(utteranceId)) return send(res, 400, { status: 'refused', reason: 'invalid-utterance' });
    const receipt = groupSpeaker.getStatus({ origin: resolved.origin, utteranceId });
    if (!receipt) return send(res, 404, { status: 'unknown', reason: 'not-found' });
    return send(res, 200, receipt);
  });

  r.post('/groups/stop', async (req, res) => {
    const resolved = await originOr401(req, res); if (!resolved) return undefined;
    if (resolved.trust !== 'local-bridge') return send(res, 403, { status: 'refused', reason: 'local-bridge-required' });
    if (!onlyKeys(req.body, new Set(['utteranceId'])) || typeof req.body.utteranceId !== 'string' || !UTTERANCE_ID_RE.test(req.body.utteranceId)) {
      return send(res, 400, { status: 'refused', reason: 'invalid-utterance' });
    }
    const out = await groupSpeaker.stopGroup({ origin: resolved.origin, utteranceId: req.body.utteranceId });
    return send(res, out.status === 'refused' ? 422 : 200, out);
  });

  r.use((err, _req, res, _next) => {
    if (err && (err.type === 'entity.too.large' || err.status === 413)) {
      return res.status(413).json({ error: 'body troppo grande' });
    }
    if (err instanceof SyntaxError) return res.status(400).json({ error: 'JSON non valido' });
    return res.status(err.status || 400).json({ error: 'richiesta audio non valida' });
  });

  return r;
}

module.exports = {
  audioRoutes, UTTERANCE_ID_RE, LANG_RE, VOICE_RE,
  parseSpeakBody, parseStopBody, parseGroupSpeakBody,
};
