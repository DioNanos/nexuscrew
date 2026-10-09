'use strict';
// tests/notice-relay.test.js — the outcome contract of the notice relay.
//
// The relay resolves the owner from the authorized store and forwards one
// request. What must be exact is the mapping: 2xx = cleared, 404 from an owner
// WITHOUT the surface = unsupported (declared, no loop), any other 404 = the
// notice is already gone and the goal is reached, a refusal is a decision, a
// closed port is transient. Ids are validated BEFORE anything leaves the node.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { createNoticeRelay } = require('../lib/notify/notice-relay.js');

const PEER = 'b'.repeat(32);
const OWNER = 'a'.repeat(32);
const E1 = '0f8fad5b-d9cb-469f-a165-70867728950e';

async function ownerStub(t, handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  return { port: server.address().port, seen };
}

function relayFor(port, extra = {}) {
  return createNoticeRelay({
    loadStore: () => ({ nodeId: PEER, nodes: [{ name: 'owner', nodeId: OWNER, direction: 'outbound', token: 'pair-token', localPort: port }] }),
    deadlineMs: 1500,
    ...extra,
  });
}

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

test('a 2xx clears the notice and keeps the idempotent flag', async (t) => {
  const stub = await ownerStub(t, (req, res) => json(res, 200, { dismissed: true, idempotent: true }));
  const out = await relayFor(stub.port).relayNoticeDismiss({ ownerId: OWNER, eventId: E1 });
  assert.deepStrictEqual(out, { ok: true, code: 200, ownerId: OWNER, idempotent: true });
  assert.equal(stub.seen.length, 1);
  assert.equal(stub.seen[0].method, 'DELETE');
  assert.equal(stub.seen[0].url, `/federation/route/_/event-feed/notices/${E1}`);
  assert.equal(stub.seen[0].headers.authorization, 'Bearer pair-token');
  assert.equal(stub.seen[0].headers['x-nexuscrew-visited'], PEER);
});

test('an owner without the surface is unsupported, never a silent success', async (t) => {
  const stub = await ownerStub(t, (req, res) => json(res, 404, { error: 'forbidden', reason: 'resource-not-classified' }));
  const out = await relayFor(stub.port).relayNoticeDismiss({ ownerId: OWNER, eventId: E1 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'unsupported');
});

test('an opaque 404 means the notice is already gone: the goal is reached', async (t) => {
  const stub = await ownerStub(t, (req, res) => json(res, 404, { error: 'notify inesistente' }));
  const out = await relayFor(stub.port).relayNoticeDismiss({ ownerId: OWNER, eventId: E1 });
  assert.equal(out.ok, true);
  assert.equal(out.gone, true);
});

test('a refusal is a decision, with its own reason', async (t) => {
  const stub = await ownerStub(t, (req, res) => json(res, 403, { error: 'risorsa non concessa a questo nodo', reason: 'grant-required:ask-action' }));
  const out = await relayFor(stub.port).relayNoticeDismiss({ ownerId: OWNER, eventId: E1 });
  assert.equal(out.ok, false);
  assert.equal(out.code, 403);
  assert.equal(out.reason, 'grant-required:ask-action');
  assert.notEqual(out.transient, true, 'a refusal is not retried as if it were an outage');
});

test('an unreachable owner is transient, so the caller can queue the intent', async (t) => {
  const stub = await ownerStub(t, (req, res) => json(res, 200, {}));
  const port = stub.port;
  await new Promise((r) => stub.seen.length >= 0 && r());
  const closed = await (async () => { const s = http.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const p = s.address().port; s.close(); await new Promise((r) => s.close(r)); return p; })();
  const out = await relayFor(closed).relayNoticeDismiss({ ownerId: OWNER, eventId: E1 });
  assert.equal(out.ok, false);
  assert.equal(out.code, 502);
  assert.equal(out.transient, true, 'a dead channel is retried, not declared');
  assert.ok(port > 0);
});

test('a hung owner hits the relay deadline instead of hanging the caller', async (t) => {
  const stub = await ownerStub(t, () => { /* never answers */ });
  const started = Date.now();
  const out = await relayFor(stub.port).relayNoticeDismiss({ ownerId: OWNER, eventId: E1 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'relay-deadline');
  assert.ok(Date.now() - started < 2500, 'the deadline is the relay one, not the stub');
});

test('invalid ids are refused before anything leaves the node', async (t) => {
  const stub = await ownerStub(t, (req, res) => json(res, 200, {}));
  const relay = relayFor(stub.port);
  assert.equal((await relay.relayNoticeDismiss({ ownerId: 'nope', eventId: E1 })).code, 400);
  assert.equal((await relay.relayNoticeDismiss({ ownerId: OWNER, eventId: '../etc/passwd' })).code, 400);
  assert.equal(stub.seen.length, 0, 'not one request');
});

test('a non-paired owner is refused locally, without a forward', async (t) => {
  const stub = await ownerStub(t, (req, res) => json(res, 200, {}));
  const out = await relayFor(stub.port).relayNoticeDismiss({ ownerId: 'c'.repeat(32), eventId: E1 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'owner-unknown');
  assert.equal(stub.seen.length, 0);
});

test('dismiss-all is ONE request with a closed body', async (t) => {
  const stub = await ownerStub(t, (req, res) => json(res, 200, { dismissed: 7 }));
  const out = await relayFor(stub.port).relayNoticeDismissAll({ ownerId: OWNER });
  assert.deepStrictEqual(out, { ok: true, code: 200, ownerId: OWNER, dismissed: 7 });
  assert.equal(stub.seen.length, 1);
  assert.equal(stub.seen[0].method, 'POST');
  assert.equal(stub.seen[0].url, '/federation/route/_/event-feed/notices/dismiss-all');
  assert.deepStrictEqual(JSON.parse(stub.seen[0].body), {});
});
