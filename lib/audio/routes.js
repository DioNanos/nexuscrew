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

const UTTERANCE_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

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
  const now = deps.now || Date.now;

  const send = (res, code, body) => res.status(code).json(body);

  // Un solo messaggio per ogni fallimento di origine. Distinguere "firma
  // scaduta" da "nonce riusato" da "cella non attiva" darebbe a chi prova a
  // forgiare un oracolo gratuito su cosa manca per riuscire.
  async function originOr401(req, res) {
    const resolved = await originResolver.resolve(req);
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

  r.post('/speak', async (req, res) => {
    const resolved = await originOr401(req, res); if (!resolved) return undefined;
    const { origin, trust, visited } = resolved;
    const b = req.body || {};
    const target = typeof b.target === 'string' ? b.target : '';
    const utteranceId = typeof b.utteranceId === 'string' && b.utteranceId ? b.utteranceId : null;
    if (utteranceId && !UTTERANCE_ID_RE.test(utteranceId)) {
      return send(res, 400, { status: 'refused', reason: 'invalid-utterance' });
    }
    // Target remoto: questo nodo non decide e non parla. Instrada sulla
    // topologia autorizzata e restituisce l'esito del target senza addolcirlo.
    if (dispatcher && isValidInstance(target) && !dispatcher.isLocal(target)) {
      if (readonly()) return send(res, 403, { status: 'refused', reason: 'readonly' });
      const rl = rateLimiter.check({ origin, target, urgency: b.urgency });
      if (!rl.allowed) return send(res, 429, { status: 'refused', reason: 'rate-limit' });
      const local = receiptStore.record({
        origin, target, status: 'accepted', utteranceId, attested: trust === 'federated',
      });
      const out = await dispatcher.dispatch({
        resource: '/audio/speak', target, origin,
        payload: {
          text: b.text, lang: b.lang, voice: b.voice, urgency: b.urgency,
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
      target, text: b.text, lang: b.lang, voice: b.voice, urgency: b.urgency,
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
    const b = req.body || {};
    const target = typeof b.target === 'string' ? b.target : '';
    if (dispatcher && isValidInstance(target) && !dispatcher.isLocal(target)) {
      const out = await dispatcher.dispatch({
        resource: '/audio/stop', target, origin,
        payload: { utteranceId: b.utteranceId },
      });
      return send(res, out.status === 'accepted' ? 200 : out.status === 'unreachable' ? 503 : 422, out);
    }
    const out = handleStop({ target, utteranceId: b.utteranceId, origin }, gateDeps(origin, false));
    return send(res, out.status === 'accepted' || out.status === 'unknown' ? 200 : 422, out);
  });

  // Capability del SOLO nodo locale. Non e' una directory: un chiamante non puo'
  // usare questo endpoint per sondare la capability di un terzo nodo, che va
  // interrogato sulla propria route federata con la credenziale giusta.
  r.get('/capability', async (req, res) => {
    const resolved = await originOr401(req, res); if (!resolved) return undefined;
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

  r.use((err, _req, res, _next) => {
    if (err && (err.type === 'entity.too.large' || err.status === 413)) {
      return res.status(413).json({ error: 'body troppo grande' });
    }
    if (err instanceof SyntaxError) return res.status(400).json({ error: 'JSON non valido' });
    return res.status(err.status || 400).json({ error: 'richiesta audio non valida' });
  });

  return r;
}

module.exports = { audioRoutes, UTTERANCE_ID_RE };
