'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const nodes = require('../lib/nodes/store.js');
const { createEventFeedAsksRoutes } = require('../lib/notify/event-feed-asks-routes.js');
const { createAskRelay } = require('../lib/notify/ask-relay.js');
const OWNER = 'a'.repeat(32), PEER = 'b'.repeat(32), ID = '12345678';
async function fixture(t, { ask = {}, refuse, beforeGate, persisted = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dismissal-owner-'));
  const nodesPath = path.join(dir, 'nodes.json');
  nodes.initStore(nodesPath);
  let st = nodes.addNode(nodes.loadStoreStrict(nodesPath), { name: 'peer', nodeId: PEER, direction: 'inbound', token: 'fixture', localPort: 42001, remotePort: 42002, ssh: 'demo@example.invalid', shared: true, visibility: 'network' });
  st = nodes.setPeerAccessPreset(st, 'peer', 'admin'); nodes.atomicWriteStore(nodesPath, st);
  const current = { id: ID, ts: 100, question: 'Review?', options: ['Yes'], session: 'reviewer', answered: false, dismissed: false, revision: 0, ...ask };
  const askFile = path.join(dir, 'asks.json'), receiptFile = path.join(dir, 'ask-receipts.json');
  let persistedStore, persistedService;
  if (persisted) {
    fs.writeFileSync(askFile, JSON.stringify({ asks: [current] }), { mode: 0o600 });
    persistedStore = require('../lib/notify/asks.js').createAsksStore({ dir });
    const receipts = require('../lib/notify/ask-receipts.js').createAskReceipts({ filePath: receiptFile });
    assert.equal(receipts.attempt({ peerId: PEER, askId: ID, requestId: 'receipt-one', text: 'Done' }).ok, true);
    receipts.finalize(PEER, ID, 'receipt-one', 'committed', 'delivered');
    persistedService = require('../lib/notify/ask-answer-service.js').createAskAnswerService({ asks: persistedStore, receipts, submit: async () => { throw new Error('no new submission allowed'); } });
  }
  let calls = 0;
  const app = express();
  app.use('/asks', createEventFeedAsksRoutes({ nodesPath, localNodeId: () => OWNER, eventsEnabled: () => true,
    originResolver: { resolve: async () => { if (beforeGate) beforeGate(current); return { ok: true, trust: 'federated', origin: { node: PEER }, visited: [PEER, OWNER] }; } },
    cellForSession: () => 'reviewer', asks: persistedStore || { get: () => current },
    answerService: { dismiss(id) { calls++; if (persistedService) return persistedService.dismiss(id); if (refuse) return { ok: false, ...refuse }; current.dismissed = true; current.revision++; return { ok: true }; } },
  }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); });
  async function request(method = 'DELETE', expected = '100') {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/asks/${ID}${method === 'GET' ? '/capability' : ''}`, { method,
      headers: expected === undefined ? {} : { 'x-nexuscrew-ask-ts': expected } });
    return { code: response.status, body: await response.json() };
  }
  return { request, current: persistedStore ? persistedStore.get(ID) : current, calls: () => calls, askFile, receiptFile };
}
test('owner capability proves the canonical generation and precondition support', async t => {
  const f = await fixture(t); const result = await f.request('GET');
  assert.equal(result.body.generationPrecondition, true); assert.deepEqual(result.body.ask, { id: ID, ts: 100, question: 'Review?', options: ['Yes'], session: 'reviewer' });
});
test('an answer completed during authorization wins without dismiss mutation', async t => {
  const f = await fixture(t, { beforeGate: ask => { ask.answered = true; ask.revision = 7; } });
  const result = await f.request(); assert.equal(result.code, 200); assert.equal(result.body.outcome, 'answered');
  assert.equal(f.calls(), 0); assert.equal(f.current.revision, 7); assert.equal(f.current.dismissed, false);
});
test('an owner already dismissed returns a structured idempotent outcome', async t => {
  const f = await fixture(t, { ask: { dismissed: true, revision: 4 } });
  const result = await f.request(); assert.equal(result.body.outcome, 'dismissed'); assert.equal(result.body.idempotent, true);
  assert.equal(f.calls(), 0); assert.equal(f.current.revision, 4);
});
test('a replaced generation is refused atomically before the dismiss service', async t => {
  const f = await fixture(t, { beforeGate: ask => { ask.ts = 101; } });
  const result = await f.request(); assert.equal(result.code, 409); assert.equal(result.body.reason, 'generation-mismatch');
  assert.equal(f.calls(), 0); assert.equal(f.current.dismissed, false);
});
test('malformed generation headers cannot silently become legacy deletes', async t => {
  const f = await fixture(t); const result = await f.request('DELETE', '100,101');
  assert.equal(result.code, 400); assert.equal(result.body.reason, 'invalid-generation'); assert.equal(f.calls(), 0);
});
for (const reason of ['answering', 'delivery-unknown-block']) test(`owner preserves ${reason} as a structured conflict`, async t => {
  const f = await fixture(t, { refuse: { code: 409, reason } }); const result = await f.request();
  assert.equal(result.code, 409); assert.equal(result.body.reason, reason); assert.equal(f.current.dismissed, false);
});
test('relay forwards the generation header and returns the owner outcome', async () => {
  let sent;
  const relay = createAskRelay({ loadStore: () => ({ nodeId: PEER, nodes: [{ nodeId: OWNER, direction: 'outbound', localPort: 12345, token: 'fixture' }] }),
    fetchImpl: async (_url, options) => { sent = options; return { ok: true, status: 200, json: async () => ({ outcome: 'answered' }) }; } });
  const result = await relay.relayDismiss({ ownerId: OWNER, askId: ID, expectedTs: 100 });
  assert.equal(sent.headers['x-nexuscrew-ask-ts'], '100'); assert.equal(result.outcome, 'answered');
});
test('dismissal inspection rejects an owner response with a different canonical pair', async () => {
  const relay = createAskRelay({ loadStore: () => ({ nodeId: PEER, nodes: [{ nodeId: OWNER, direction: 'outbound', localPort: 12345, token: 'fixture' }] }),
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ownerId: PEER, askId: ID, generationPrecondition: true, status: 'open', ask: { id: ID, ts: 100, question: 'Review?', session: 'reviewer' } }) }) });
  assert.equal(typeof relay.inspectDismissal, 'function');
  assert.equal((await relay.inspectDismissal({ ownerId: OWNER, askId: ID })).ok, false);
});
test('generation inspection exposes only question identity without answer or receipt payloads', async t => {
  const f = await fixture(t, { ask: { answered: true, answer: 'Private answer', receipts: ['private receipt'], revision: 9 } });
  const result = await f.request('GET');
  assert.deepEqual(Object.keys(result.body.ask).sort(), ['id', 'options', 'question', 'session', 'ts']);
});
for (const operation of ['inspectDismissal', 'relayDismiss']) test(`dismissal ${operation} preserves Retry-After from a rate-limited owner`, async () => {
  const relay = createAskRelay({ loadStore: () => ({ nodeId: PEER, nodes: [{ nodeId: OWNER, direction: 'outbound', localPort: 12345, token: 'fixture' }] }),
    fetchImpl: async () => ({ ok: false, status: 429, headers: new Headers({ 'retry-after': '120' }), json: async () => ({ reason: 'answer-rate' }) }) });
  const result = await relay[operation]({ ownerId: OWNER, askId: ID, expectedTs: 100 });
  assert.equal(result.retryAfterMs, 120000);
});

test('deleting an already answered owner ask preserves its revision and receipt', async t => {
  const receipt = { requestId: 'receipt-one', state: 'delivered', answer: 'Done', revision: 9 };
  const f = await fixture(t, { persisted: true, ask: { answered: true, answer: 'Done', answeredTs: 321, revision: 9, receipts: [receipt] } });
  const beforeAskFile = fs.readFileSync(f.askFile, 'utf8');
  const beforeReceiptFile = fs.readFileSync(f.receiptFile, 'utf8');
  const before = structuredClone(f.current);
  const beforeReceipt = structuredClone(f.current.receipts);
  const result = await f.request();
  assert.equal(result.code, 200);
  assert.deepEqual(result.body, { dismissed: false, id: ID, outcome: 'answered', idempotent: true });
  assert.equal(f.calls(), 0, 'the dismiss service never runs on an answered ask');
  assert.deepEqual(f.current, before, 'the complete owner ask remains unchanged');
  assert.equal(f.current.revision, 9);
  assert.deepEqual(f.current.receipts, beforeReceipt);
  assert.equal(fs.readFileSync(f.askFile, 'utf8'), beforeAskFile);
  assert.equal(fs.readFileSync(f.receiptFile, 'utf8'), beforeReceiptFile);
});
