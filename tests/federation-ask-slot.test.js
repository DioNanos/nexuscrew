'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const store = require('../lib/nodes/store.js');
const federation = require('../lib/proxy/federation.js');
const ledger = require('../lib/nodes/reverse-pool.js');
const { respondSlotProof } = require('../lib/nodes/reverse-slot-proof.js');
const OWNER = 'b'.repeat(32);
const CLIENT = 'c'.repeat(32);
const SECRET = 'slot-egress-fixture';
const BODY = { requestId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', text: 'Proceed with review' };
async function listen(t, app) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return server;
}
async function fixture(t, { transit = false, proof = 'valid', direction = 'inbound' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-slot-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const nodesPath = path.join(home, 'nodes.json');
  const actions = []; const leaks = []; const probes = [];
  let release; let replay;
  const target = express(); target.use(express.json());
  let port;
  target.post('/reverse-slot-proof', async (req, res) => {
    probes.push({ headers: req.headers, body: req.body });
    if (proof === 'timeout') return;
    if (proof === 'body-timeout') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); return; }
    if (proof === 'unavailable') return res.sendStatus(503);
    if (proof === 'deferred') await new Promise(resolve => { release = resolve; });
    let answer = respondSlotProof({ secret: SECRET,
      expected: { remotePort: port, generation: 3, instanceId: OWNER }, request: req.body });
    if (proof === 'mac') answer.mac = 'wrong';
    if (proof === 'instance') answer.instanceId = 'e'.repeat(32);
    if (proof === 'generation') answer.generation = 4;
    if (proof === 'nonce') answer.nonce = 'wrong-nonce-aaaaaaaa';
    if (proof === 'replay') { const old = replay; replay = answer; if (old) answer = old; }
    res.json(answer);
  });
  target.use((req, res) => { actions.push({ url: req.url, bearer: req.headers.authorization, body: req.body }); res.json({ ok: true, status: 'committed' }); });
  const slotServer = await listen(t, target); port = slotServer.address().port;
  const decoy = express(); decoy.use(express.json());
  decoy.use((req, res) => { leaks.push({ url: req.url, bearer: req.headers.authorization, body: req.body }); res.json({ decoy: true }); });
  const decoyServer = await listen(t, decoy);
  let st = store.addNode(store.upgradeToReversePoolSchema(store.emptyStore('a'.repeat(32)), ledger.ledgerHead(ledger.emptyLedger('d'.repeat(32)))), {
    name: 'owner', ssh: 'demo@example.invalid', nodeId: OWNER, token: SECRET, acceptToken: 'owner-ingress-fixture',
    remotePort: 41999, localPort: decoyServer.address().port, direction, shared: true, visibility: 'network',
    reversePool: store.reversePoolDefault(port, { verification: 'verified', generation: 3 }),
  });
  st = store.setPeerAccessPreset(st, 'owner', 'admin');
  if (transit) {
    st = store.addNode(st, { name: 'client', ssh: 'demo@example.invalid', nodeId: CLIENT, token: 'hub-client-fixture', acceptToken: 'client-ingress-fixture',
      remotePort: 41999, localPort: 41001, direction: 'outbound', shared: true, visibility: 'network' });
    st = store.setPeerAccessPreset(st, 'client', 'admin');
  }
  store.atomicWriteStore(nodesPath, st);
  assert.ok(store.loadStoreStrict(nodesPath), 'fixture obeys the real store parser');
  let readonly = false;
  let proofClock = 0;
  const hub = express();
  hub.use('/api/route', federation.localRouter({ nodesPath, localPort: 1, localCredential: () => 'local-fixture', readonly: () => readonly, askProofNow: () => proofClock }));
  hub.use('/federation', federation.peerRouter({ nodesPath, localPort: 1, localCredential: () => 'local-fixture', readonly: () => readonly, askProofNow: () => proofClock }));
  const hubServer = await listen(t, hub);
  const request = (resource = '/event-feed/asks/11223344/answer', method = 'POST', extra = {}, options = {}) => fetch(
    `http://127.0.0.1:${hubServer.address().port}${transit ? '/federation/route' : '/api/route'}/owner/_${resource}`,
    { ...options, method, headers: { 'content-type': 'application/json', ...(transit ? { authorization: 'Bearer client-ingress-fixture', 'x-nexuscrew-visited': CLIENT } : {}), ...extra }, ...(method === 'POST' ? { body: JSON.stringify(BODY) } : {}) });
  const edit = (name, patch) => store.atomicWriteStore(nodesPath, store.updateNode(store.loadStoreStrict(nodesPath), name, patch));
  return { request, actions, leaks, probes, edit, nodesPath, port, release: () => release?.(), setReadonly: value => { readonly = value; }, clock: value => { proofClock = value; } };
}
for (const transit of [false, true]) test(`a divergent inbound slot receives the action without leaking to localPort (${transit ? 'transit' : 'local'})`, async t => {
  const f = await fixture(t, { transit });
  const r = await f.request(); await r.text();
  assert.equal(f.leaks.length, 0, 'the decoy gets no request, bearer or ASK body');
  assert.equal(r.status, 200);
  assert.equal(f.actions.length, 1);
  assert.equal(f.actions[0].bearer, `Bearer ${SECRET}`);
  assert.deepEqual(f.actions[0].body, BODY);
  assert.equal(f.probes.length, 1);
  assert.equal(f.probes[0].headers.authorization, undefined);
  assert.equal(JSON.stringify(f.probes[0].body).includes(BODY.text), false);
});
for (const proof of ['timeout', 'body-timeout', 'unavailable', 'mac', 'instance', 'generation', 'nonce']) test(`an inbound ASK refuses ${proof} proof before forwarding any action`, async t => {
  const f = await fixture(t, { proof }); const r = await f.request();
  assert.equal(r.status, 404);
  assert.equal((await r.json()).reason, 'reverse-slot-unverified');
  assert.equal(f.actions.length + f.leaks.length, 0);
});
test('a replayed reverse proof cannot authorize the next action', async t => {
  const f = await fixture(t, { proof: 'replay' });
  const first = await f.request(); await first.text();
  // Positive caching is policy; replay protection is exercised with a cold cache.
  f.clock(10001);
  const second = await f.request(); const body = await second.json();
  assert.equal(second.status, 404); assert.equal(body.reason, 'reverse-slot-unverified');
  assert.equal(f.actions.length, 1); assert.equal(f.leaks.length, 0);
});
for (const change of ['token', 'identity', 'slot', 'shared', 'ingress', 'visibility', 'readonly']) test(`a ${change} change during the reverse proof prevents late forwarding`, async t => {
  const f = await fixture(t, { proof: 'deferred', transit: true });
  const result = f.request();
  for (let i = 0; i < 100 && !f.probes.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.probes.length, 1, 'the proof is pending before the independent configuration change');
  if (change === 'token') f.edit('owner', { token: 'replacement-fixture' });
  if (change === 'identity') f.edit('owner', { nodeId: 'e'.repeat(32) });
  if (change === 'slot') {
    const st = store.loadStoreStrict(f.nodesPath); const owner = store.getNode(st, 'owner');
    owner.reversePool.activeGeneration = 4; owner.reversePool.slots[0].generation = 4;
    owner.reversePool.rotation.generation = 4; store.atomicWriteStore(f.nodesPath, st);
  }
  if (change === 'shared') f.edit('owner', { shared: false });
  if (change === 'ingress') f.edit('client', { askReplyAccess: false });
  if (change === 'visibility') f.edit('client', { visibility: 'relay-only' });
  if (change === 'readonly') f.setReadonly(true);
  f.release(); const r = await result; await r.text();
  assert.ok([401, 403, 404].includes(r.status));
  assert.equal(f.actions.length + f.leaks.length, 0);
});
for (const deny of ['shared', 'visibility', 'events', 'reply', 'readonly']) test(`a ${deny} gate denies inbound actions before starting the proof`, async t => {
  const f = await fixture(t, { transit: true });
  if (deny === 'shared') f.edit('owner', { shared: false });
  if (deny === 'visibility') f.edit('client', { visibility: 'relay-only' });
  if (deny === 'events') f.edit('client', { eventsAccess: false });
  if (deny === 'reply') f.edit('client', { askReplyAccess: false });
  if (deny === 'readonly') f.setReadonly(true);
  const r = await f.request(); await r.text(); assert.equal(r.status, 403);
  assert.equal(f.probes.length + f.actions.length + f.leaks.length, 0);
});
test('an inbound ASK without a pool refuses a reachable localPort', async t => {
  const f = await fixture(t);
  const st = store.loadStoreStrict(f.nodesPath); delete store.getNode(st, 'owner').reversePool;
  store.atomicWriteStore(f.nodesPath, st);
  const r = await f.request(); const body = await r.json();
  assert.equal(r.status, 404); assert.equal(body.reason, 'reverse-slot-unverified');
  assert.equal(f.actions.length + f.leaks.length + f.probes.length, 0);
});
for (const resource of ['/sessions', '/fleet/status']) test(`inbound ${resource} preserves localPort forwarding without an ASK proof`, async t => {
  const f = await fixture(t, { transit: true }); const r = await f.request(resource, 'GET'); await r.text();
  assert.equal(r.status, 200); assert.equal(f.leaks.length, 1); assert.equal(f.probes.length, 0);
});
test('outbound ASK forwarding does not acquire an inbound slot proof', async t => {
  const f = await fixture(t, { direction: 'outbound' }); const r = await f.request(); await r.text();
  assert.equal(r.status, 200); assert.equal(f.leaks.length, 1); assert.equal(f.probes.length, 0);
});

test('disconnecting the requester during proof does not forward a late ASK', async t => {
  const f = await fixture(t, { proof: 'deferred', transit: true });
  const controller = new AbortController();
  const response = f.request(undefined, undefined, {}, { signal: controller.signal }).catch(error => error);
  for (let i = 0; i < 100 && !f.probes.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.probes.length, 1);
  controller.abort();
  const aborted = await response;
  assert.equal(aborted.name, 'AbortError');
  await new Promise(resolve => setTimeout(resolve, 20));
  f.release(); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.actions.length + f.leaks.length, 0);
});
test('a cyclic visited chain is rejected before the reverse proof', async t => {
  const f = await fixture(t, { transit: true });
  const r = await f.request(undefined, undefined, { 'x-nexuscrew-visited': `${CLIENT},${'a'.repeat(32)}` });
  assert.equal(r.status, 409); await r.text();
  assert.equal(f.probes.length + f.actions.length + f.leaks.length, 0);
});
test('an unauthorized method on an ASK resource cannot start a reverse proof', async t => {
  const f = await fixture(t, { transit: true });
  const r = await f.request('/event-feed/asks/11223344/answer', 'GET');
  assert.equal(r.status, 404); await r.text();
  assert.equal(f.probes.length + f.actions.length + f.leaks.length, 0);
});
