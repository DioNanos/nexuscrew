'use strict';
// lib/audio/routes.js — WP2R: local audio routes. Security/contract hardening:
// the caller (origin) is NEVER derived from client-controllable headers/body —
// deps.resolveCaller is REQUIRED and is wired by the server to a verified
// identity (MCP session / active Fleet cell). A request without a verifiable
// origin fails closed (401). Receipts/status are readable only by the SAME
// authenticated caller. No default permissive: targetAllowsOrigin/targetReachable
// default false and are wired to real routing/visibility. Capability describes
// the LOCAL node only (exact-self). No broadcast SSE. Adapter is WP3.
const express = require('express');
const { handleSpeak, handleStop, isValidInstance } = require('./speak.js');
const { describeCapability, admitAudio } = require('./capability.js');
const { createReceiptStore } = require('./receipt.js');
const { createSpeakRateLimiter } = require('./rate-limit.js');

function audioRoutes(deps = {}) {
  if (typeof deps.resolveCaller !== 'function') {
    throw new Error('audioRoutes: resolveCaller e obbligatorio (origine autenticata)');
  }
  const r = express.Router();
  r.use(express.json({ limit: '16kb' }));

  const resolveCaller = deps.resolveCaller;
  const receiptStore = deps.receiptStore || createReceiptStore();
  const rateLimiter = deps.rateLimiter || createSpeakRateLimiter();
  const readonly = deps.readonly || (() => false);
  const adapter = deps.adapter || null;
  const localNodeId = deps.localNodeId || null;
  // NO default permissive: fail-closed unless the server wires the real policy.
  const targetAllowsOrigin = deps.targetAllowsOrigin || (() => false);
  const targetConsent = deps.targetConsent || (() => false);
  const targetReachable = deps.targetReachable || (() => false);

  const send = (res, code, body) => res.status(code).json(body);

  function callerOr401(req, res) {
    const caller = resolveCaller(req);
    if (!caller || typeof caller.cell !== 'string' || !caller.cell || typeof caller.node !== 'string') {
      send(res, 401, { error: 'origine non verificabile' });
      return null;
    }
    return caller;
  }

  function gateDeps(caller) {
    return {
      readonly, rateLimiter, adapter, now: Date.now,
      targetAllowsOrigin, targetConsent, targetReachable,
      receipt: (status, o) => receiptStore.record({ caller: caller.cell, origin: caller, target: o.target, status, reason: o.reason, utteranceId: o.utteranceId }),
      findReceipt: (id, c, target) => receiptStore.find(id, c, target),
    };
  }

  r.post('/speak', (req, res) => {
    const caller = callerOr401(req, res); if (!caller) return;
    const b = req.body || {};
    const out = handleSpeak({
      target: b.target, text: b.text, lang: b.lang, voice: b.voice,
      urgency: b.urgency, utteranceId: b.utteranceId, origin: caller, originCell: caller.cell,
    }, gateDeps(caller));
    const code = out.status === 'spoken' || out.status === 'accepted' ? 200
      : ((out.reason === 'invalid-text' || out.reason === 'invalid-target') ? 400 : (out.status === 'unreachable' ? 503 : 422));
    return send(res, code, out);
  });

  r.post('/stop', (req, res) => {
    const caller = callerOr401(req, res); if (!caller) return;
    const b = req.body || {};
    const out = handleStop({ target: b.target, utteranceId: b.utteranceId, origin: caller }, gateDeps(caller));
    return send(res, out.status === 'accepted' ? 200 : 422, out);
  });

  // Capability describes ONLY the local node (exact-self): a caller may not
  // probe another nodeId's capability through this endpoint.
  r.get('/capability', (req, res) => {
    const target = String(req.query.target || '');
    if (!isValidInstance(target)) return send(res, 400, { error: 'target non valido (instanceId 32 hex)' });
    if (!localNodeId || target !== localNodeId) return send(res, 403, { error: 'capability descrive solo il nodo locale' });
    const admit = admitAudio({ adapter });
    return send(res, 200, describeCapability({
      adapter, installed: !!adapter, liveness: admit.adapterDetected ? 'available' : 'unavailable',
    }));
  });

  // Status is caller-scoped: only the SAME authenticated caller reads its receipt.
  r.get('/speak/status/:utteranceId', (req, res) => {
    const caller = callerOr401(req, res); if (!caller) return;
    const rc = receiptStore.get(caller.cell, String(req.params.utteranceId || ''));
    if (!rc) return send(res, 404, { status: 'unknown', reason: 'not-found' });
    return send(res, 200, rc);
  });

  return r;
}

module.exports = { audioRoutes };