'use strict';
// tests/audio-routes.test.js — WP2R: audio routes, verified-origin contract.
// caller is NEVER derived from client headers/body; resolveCaller is required
// and authoritative. fail-closed without verifiable origin; receipts caller-
// scoped; capability exact-self; no default allow; text 1..320.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { audioRoutes } = require('../lib/audio/routes.js');
const { createReceiptStore } = require('../lib/audio/receipt.js');
const { TOOLS } = require('../lib/mcp/tools.js');

const SELF = 'a'.repeat(32);
const ORIGIN = { cell: 'cellA', node: 'b'.repeat(32) };

function startApp(deps) {
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  app.use('/audio', audioRoutes(deps));
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({ base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }));
  });
}

const POST = (base, path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('routes: resolveCaller required; nessun default header; senza origine verificabile => 401 fail closed', async () => {
  const app = await startApp({ resolveCaller: () => null, localNodeId: SELF });
  try {
    const res = await POST(app.base, '/audio/speak', { target: SELF, text: 'hi' }, { 'x-nexuscrew-cell': 'evil' });
    assert.equal(res.status, 401, 'header client-controllabile NON costituisce origine');
  } finally { app.close(); }
});

test('routes A) header/body falsi non cambiano caller: resolveCaller autorevole; receipt resta dell origine verificata', async () => {
  const store = createReceiptStore({ now: () => 0 });
  const app = await startApp({
    resolveCaller: () => ORIGIN, receiptStore: store,
    localNodeId: SELF, targetConsent: () => true, targetAllowsOrigin: () => true, targetReachable: () => true,
  });
  try {
    const r = await (await POST(app.base, '/audio/speak', { target: SELF, text: 'hi' }, { 'x-nexuscrew-cell': 'evil', cell: 'spoofed' })).json();
    // header/body falsi ignorati: il receipt è associato a ORIGIN.cell 'cellA'
    const status = await (await fetch(`${app.base}/audio/speak/status/${r.utteranceId}`)).json();
    assert.notEqual(status.status, 'unknown', 'la stessa origine verificata legge il receipt (header falso ignorato)');
    assert.equal(status.origin.cell, 'cellA', 'caller = origine verificata, non header falso');
  } finally { app.close(); }
});

test('routes A) status di altra origine negato (404 unknown); receipt caller-scoped', async () => {
  const store = createReceiptStore({ now: () => 0 });
  let caller = ORIGIN;
  const app = await startApp({
    resolveCaller: () => caller, receiptStore: store,
    localNodeId: SELF, targetConsent: () => true, targetAllowsOrigin: () => true, targetReachable: () => true,
  });
  try {
    const r = await (await POST(app.base, '/audio/speak', { target: SELF, text: 'hi' })).json();
    caller = { cell: 'cellB', node: 'b'.repeat(32) };
    const other = await (await fetch(`${app.base}/audio/speak/status/${r.utteranceId}`)).json();
    assert.equal(other.status, 'unknown', 'altra origine non legge il receipt altrui');
  } finally { app.close(); }
});

test('routes D) text 321 char rifiutato REST (invalid-text); 320 ok', async () => {
  const app = await startApp({ resolveCaller: () => ORIGIN, localNodeId: SELF, targetConsent: () => true, targetAllowsOrigin: () => true, targetReachable: () => true });
  try {
    const long = await (await POST(app.base, '/audio/speak', { target: SELF, text: 'x'.repeat(321) })).json();
    assert.equal(long.status, 'refused'); assert.equal(long.reason, 'invalid-text');
  } finally { app.close(); }
});

test('routes F) no default allow: targetAllowsOrigin default false => refused acl anche con consent ON', async () => {
  const app = await startApp({ resolveCaller: () => ORIGIN, localNodeId: SELF, targetConsent: () => true });
  try {
    const r = await (await POST(app.base, '/audio/speak', { target: SELF, text: 'hi' })).json();
    assert.equal(r.status, 'refused');
    assert.equal(r.reason, 'acl', 'fail-closed: ACL non permissiva di default');
  } finally { app.close(); }
});

test('routes F) capability exact-self: target !== localNodeId => 403', async () => {
  const app = await startApp({ resolveCaller: () => ORIGIN, localNodeId: SELF });
  try {
    const res = await fetch(`${app.base}/audio/capability?target=${'c'.repeat(32)}`);
    assert.equal(res.status, 403, 'capability descrive solo il nodo locale');
    const self = await (await fetch(`${app.base}/audio/capability?target=${SELF}`)).json();
    assert.equal(self.liveness, 'unavailable');
  } finally { app.close(); }
});

test('routes: speak no-adapter => refused no-adapter (honest, no false ack/accepted)', async () => {
  const app = await startApp({ resolveCaller: () => ORIGIN, localNodeId: SELF, targetConsent: () => true, targetAllowsOrigin: () => true, targetReachable: () => true });
  try {
    const r = await (await POST(app.base, '/audio/speak', { target: SELF, text: 'hi' })).json();
    assert.equal(r.status, 'refused'); assert.equal(r.reason, 'no-adapter');
  } finally { app.close(); }
});

test('MCP D) nc_speak text 321 char rifiutato (argString max 320)', async () => {
  const speak = TOOLS.find((t) => t.name === 'nc_speak');
  await assert.rejects(() => speak.handler({ target: SELF, text: 'x'.repeat(321) }, { identity: async () => ({ session: 's', code: 'OK' }), api: async () => ({}) }), /troppo lungo|text|max/i);
});
