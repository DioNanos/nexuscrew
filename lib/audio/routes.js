'use strict';
// lib/audio/routes.js — WP2: local/federated audio routes (capability, speak,
// stop, speak/status). Thin wrapper over the pure gate logic in speak.js. The
// target independently gates ACL/consent/READONLY/rate/dedup; speak in READONLY
// => refused reason 'readonly'. Exact target (instanceId) only; wildcards/all
// rejected. No broadcast SSE. Adapter is WP3: honest unavailable/refused.
const express = require('express');
const { handleSpeak, handleStop, isValidInstance } = require('./speak.js');
const { describeCapability, admitAudio } = require('./capability.js');
const { createReceiptStore } = require('./receipt.js');
const { createSpeakRateLimiter } = require('./rate-limit.js');

function audioRoutes(deps = {}) {
  const r = express.Router();
  r.use(express.json({ limit: '16kb' }));

  const receiptStore = deps.receiptStore || createReceiptStore();
  const rateLimiter = deps.rateLimiter || createSpeakRateLimiter();
  const readonly = deps.readonly || (() => false);
  const adapter = deps.adapter || null;
  const localNodeId = deps.localNodeId || null;
  const resolveCaller = deps.resolveCaller || ((req) => ({ cell: String(req.headers['x-nexuscrew-cell'] || 'local'), node: localNodeId }));
  // ACL/consent/reachability are injectable; defaults keep the contract honest
  // (consent defaults false; a federated/local integrator wires the node store).
  const targetAllowsOrigin = deps.targetAllowsOrigin || (() => true);
  const targetConsent = deps.targetConsent || (() => false);
  const targetReachable = deps.targetReachable || (() => true);

  const send = (res, code, body) => res.status(code).json(body);

  function gateDeps(req) {
    const caller = resolveCaller(req);
    return {
      readonly, rateLimiter, adapter,
      targetAllowsOrigin, targetConsent, targetReachable,
      receipt: (status, o) => receiptStore.record({ caller: caller.cell, origin: caller, target: o.target, status, reason: o.reason, utteranceId: o.utteranceId }),
      dedup: (id) => receiptStore.get(caller.cell, id),
    };
  }

  r.post('/speak', (req, res) => {
    const b = req.body || {};
    const caller = resolveCaller(req);
    const out = handleSpeak({
      target: b.target, text: b.text, lang: b.lang, voice: b.voice,
      urgency: b.urgency, utteranceId: b.utteranceId, origin: caller, originCell: caller.cell,
    }, gateDeps(req));
    const code = out.status === 'spoken' || out.status === 'accepted' ? 200
      : (out.reason === 'invalid-target' ? 400 : (out.status === 'unreachable' ? 503 : 422));
    return send(res, code, out);
  });

  r.post('/stop', (req, res) => {
    const b = req.body || {};
    const caller = resolveCaller(req);
    const out = handleStop({ target: b.target, utteranceId: b.utteranceId, origin: caller }, gateDeps(req));
    return send(res, out.status === 'accepted' ? 200 : 422, out);
  });

  r.get('/capability', (req, res) => {
    const target = String(req.query.target || '');
    if (!isValidInstance(target)) return send(res, 400, { error: 'target non valido (instanceId 32 hex)' });
    const admit = admitAudio({ adapter });
    const cap = describeCapability({
      adapter, installed: !!adapter, liveness: admit.adapterDetected ? 'available' : 'unavailable',
    });
    return send(res, 200, cap);
  });

  r.get('/speak/status/:utteranceId', (req, res) => {
    const caller = resolveCaller(req);
    const rc = receiptStore.get(caller.cell, String(req.params.utteranceId || ''));
    if (!rc) return send(res, 404, { status: 'unknown', reason: 'not-found' });
    return send(res, 200, rc);
  });

  return r;
}

module.exports = { audioRoutes };