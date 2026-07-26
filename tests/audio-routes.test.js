'use strict';
// tests/audio-routes.test.js — WP2: audio routes (capability/speak/stop/status)
// via mini-app with injected gates, + MCP nc_speak/nc_speak_status shape.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');
const { audioRoutes } = require('../lib/audio/routes.js');
const { TOOLS } = require('../lib/mcp/tools.js');

const TARGET = 'a'.repeat(32);

function startApp(deps) {
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  app.use('/audio', audioRoutes(deps));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({ base, close: () => server.close() });
    });
  });
}

async function speak(base, body) {
  return (await fetch(`${base}/audio/speak`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nexuscrew-cell': 'cellA' }, body: JSON.stringify(body) })).json();
}

test('routes: speak READONLY => refused reason readonly', async () => {
  const app = await startApp({ readonly: () => true, targetConsent: () => true, targetAllowsOrigin: () => true });
  try {
    const r = await speak(app.base, { target: TARGET, text: 'hi' });
    assert.equal(r.status, 'refused');
    assert.equal(r.reason, 'readonly');
  } finally { app.close(); }
});

test('routes: speak consent false (default off) => refused consent; no SSE broadcast (JSON response)', async () => {
  const app = await startApp({ targetConsent: () => false, targetAllowsOrigin: () => true });
  try {
    const res = await fetch(`${app.base}/audio/speak`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nexuscrew-cell': 'cellA' }, body: JSON.stringify({ target: TARGET, text: 'hi' }) });
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8', 'no SSE broadcast');
    const r = await res.json();
    assert.equal(r.status, 'refused');
    assert.equal(r.reason, 'consent');
  } finally { app.close(); }
});

test('routes: speak no adapter => refused no-adapter; receipt redacted (no text/lang/voice)', async () => {
  const app = await startApp({ targetConsent: () => true, targetAllowsOrigin: () => true, adapter: null });
  try {
    const r = await speak(app.base, { target: TARGET, text: 'SECRET', lang: 'it', voice: 'alloy' });
    assert.equal(r.status, 'refused');
    assert.equal(r.reason, 'no-adapter');
    const json = JSON.stringify(r);
    assert.ok(!json.includes('SECRET') && !json.includes('alloy'));
    assert.ok(r.utteranceId);
  } finally { app.close(); }
});

test('routes: speak target non-instanceId/wildcard => 400 invalid-target', async () => {
  const app = await startApp({ targetConsent: () => true });
  try {
    const res1 = await fetch(`${app.base}/audio/speak`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: '*', text: 'hi' }) });
    assert.equal(res1.status, 400);
    assert.equal((await res1.json()).reason, 'invalid-target');
  } finally { app.close(); }
});

test('routes: capability bounded metadata; status endpoint returns redacted receipt / unknown', async () => {
  const app = await startApp({ targetConsent: () => true, adapter: null });
  try {
    const cap = await (await fetch(`${app.base}/audio/capability?target=${TARGET}`)).json();
    assert.deepEqual(Object.keys(cap).sort(), ['adapter', 'installed', 'languages', 'liveness', 'voices'].sort());
    assert.equal(cap.liveness, 'unavailable');
    // speak then status by utteranceId
    const r = await speak(app.base, { target: TARGET, text: 'hi' });
    const st = await (await fetch(`${app.base}/audio/speak/status/${r.utteranceId}`, { headers: { 'x-nexuscrew-cell': 'cellA' } })).json();
    assert.equal(st.utteranceId, r.utteranceId);
    assert.equal(st.status, 'refused');
    // status caller-scoped: cellB non vede receipt di cellA
    const stB = await (await fetch(`${app.base}/audio/speak/status/${r.utteranceId}`, { headers: { 'x-nexuscrew-cell': 'cellB' } })).json();
    assert.equal(stB.status, 'unknown');
  } finally { app.close(); }
});

test('routes: stop accepted (local sovereign); readonly refused', async () => {
  const app = await startApp({ targetConsent: () => true });
  try {
    const ok = await (await fetch(`${app.base}/audio/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: TARGET }) })).json();
    assert.equal(ok.status, 'accepted');
  } finally { app.close(); }
  const appRo = await startApp({ readonly: () => true });
  try {
    const r = await (await fetch(`${appRo.base}/audio/stop`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ target: TARGET }) })).json();
    assert.equal(r.status, 'refused');
    assert.equal(r.reason, 'readonly');
  } finally { appRo.close(); }
});

// --- MCP nc_speak / nc_speak_status shape ------------------------------------
test('MCP: nc_speak/nc_speak_status registrati; handler chiama /api/audio/speak e ritorna receipt (no aggregate success)', async () => {
  const speak = TOOLS.find((t) => t.name === 'nc_speak');
  const status = TOOLS.find((t) => t.name === 'nc_speak_status');
  assert.ok(speak && status);
  assert.equal(status.annotations && status.annotations.readOnlyHint, true);
  const seen = [];
  const ctx = {
    identity: async () => ({ session: 'sessA', code: 'OK', source: 'env' }),
    api: async (method, path, payload) => { seen.push({ method, path, payload }); return { utteranceId: 'u-1', status: 'refused', reason: 'no-adapter', origin: { node: 'n', cell: 'sessA' }, target: TARGET, timestamp: 1 }; },
  };
  const out = await speak.handler({ target: TARGET, text: 'SECRET', lang: 'it' }, ctx);
  assert.equal(seen[0].method, 'POST');
  assert.equal(seen[0].path, '/api/audio/speak');
  assert.equal(seen[0].payload.session, 'sessA');
  assert.equal(out.receipt.status, 'refused');
  assert.equal(out.receipt.utteranceId, 'u-1');
  assert.equal(JSON.stringify(out).includes('SECRET'), false, 'nessun testo nel receipt MCP');
  assert.equal(JSON.stringify(out).includes('"success"'), false, 'no aggregate success boolean');
  // nc_speak_status
  const out2 = await status.handler({ utteranceId: 'u-1' }, ctx);
  assert.equal(seen[seen.length - 1].method, 'GET');
  assert.match(seen[seen.length - 1].path, /\/api\/audio\/speak\/status\/u-1/);
  assert.equal(out2.receipt.utteranceId, 'u-1');
});