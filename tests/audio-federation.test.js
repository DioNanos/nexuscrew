'use strict';
// tests/audio-federation.test.js — WP2: federation whitelist (audio capability/
// speak/stop proxabili; consent mutation refused) + false-401 probe regression.
const { test } = require('node:test');
const assert = require('node:assert');
const federation = require('../lib/proxy/federation.js');

test('whitelist: audio capability/speak/status/stop sono risorse federate proxabili', () => {
  assert.equal(federation.knownResource('/audio/capability'), true);
  assert.equal(federation.knownResource('/audio/speak'), true);
  assert.equal(federation.knownResource('/audio/speak/status'), true);
  assert.equal(federation.knownResource('/audio/stop'), true);
  assert.equal(federation.allowedResource('/audio/capability', 'GET'), true);
  assert.equal(federation.allowedResource('/audio/speak', 'POST'), true);
  assert.equal(federation.allowedResource('/audio/speak/status', 'POST'), true);
  assert.equal(federation.allowedResource('/audio/stop', 'POST'), true);
});

test('whitelist: audio.consent e una mutation LOCAL-ONLY, federated unreachable/refused', () => {
  assert.equal(federation.knownResource('/audio/consent'), false, 'consent non e una risorsa proxyable federata');
  assert.equal(federation.allowedResource('/audio/consent', 'PATCH'), false);
  assert.equal(federation.allowedResource('/audio/consent', 'POST'), false);
  assert.equal(federation.allowedResource('/audio/consent', 'PUT'), false);
  // method sbagliati su routes audio permesse sono negati
  assert.equal(federation.allowedResource('/audio/speak', 'GET'), false);
  assert.equal(federation.allowedResource('/audio/speak/status', 'GET'), false);
  assert.equal(federation.allowedResource('/audio/capability', 'POST'), false);
});

test('READONLY federato: speak resta bloccato, status e Stop restano sicuri', () => {
  assert.equal(federation.readonlyBlocksFederated('/audio/speak', 'POST'), true);
  assert.equal(federation.readonlyBlocksFederated('/audio/speak/status', 'POST'), false,
    'status usa POST solo per l attestazione, non per una mutazione');
  assert.equal(federation.readonlyBlocksFederated('/audio/stop', 'POST'), false,
    'uno Stop remoto deve poter zittire una voce anche con READONLY');
  assert.equal(federation.readonlyBlocksFederated('/files', 'DELETE'), true);
});

test('probe false-401: acceptToken sbagliato => degraded/auth-failed (mai healthy); token giusto => healthy', async () => {
  const goodToken = 'good-accept-token';
  const goodInstance = 'a'.repeat(32);
  const fetchImpl = async (url, opts = {}) => {
    const auth = opts.headers && opts.headers.authorization;
    if (auth === `Bearer ${goodToken}`) return { ok: true, status: 200, json: async () => ({ ok: true, instanceId: goodInstance }) };
    return { ok: false, status: 401, json: async () => ({}) };
  };
  const ok = await federation.probeHealth({ port: 59999, token: goodToken, expectedInstanceId: goodInstance, fetchImpl, timeoutMs: 500 });
  assert.equal(ok.status, 'healthy');
  assert.equal(ok.auth, 'ok');
  const bad = await federation.probeHealth({ port: 59999, token: 'wrong-token', expectedInstanceId: goodInstance, fetchImpl, timeoutMs: 500 });
  assert.notEqual(bad.status, 'healthy', 'mai healthy con 401');
  assert.equal(bad.auth, 'failed');
  assert.match(bad.detail || '', /401/);
});

test('probe false-401: 200 ma instanceId diverso => degraded (tunnel punta al nodo sbagliato)', async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, instanceId: 'b'.repeat(32) }) });
  const r = await federation.probeHealth({ port: 59999, token: 't', expectedInstanceId: 'a'.repeat(32), fetchImpl, timeoutMs: 500 });
  assert.equal(r.status, 'degraded');
  assert.match(r.detail || '', /instanceId/);
});
