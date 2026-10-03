'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const { once } = require('node:events');
const { routeHandler } = require('../lib/proxy/federation.js');
const nodes = require('../lib/nodes/store.js');
const ledger = require('../lib/nodes/reverse-pool.js');
const { respondSlotProof } = require('../lib/nodes/reverse-slot-proof.js');
const flush = () => new Promise(resolve => setImmediate(resolve));
async function fixture(t, { self = 'a'.repeat(32), sharedCache = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const nodesPath = path.join(dir, 'nodes.json');
  let st = nodes.addNode(nodes.upgradeToReversePoolSchema(nodes.emptyStore(self), ledger.ledgerHead(ledger.emptyLedger('d'.repeat(32)))), {
    name: 'owner', nodeId: 'b'.repeat(32), token: 'fixture-owner-token', direction: 'inbound', shared: true,
    visibility: 'network', localPort: 44013, remotePort: 41999, ssh: 'demo@example.invalid',
    reversePool: nodes.reversePoolDefault(44012, { generation: 3, verification: 'verified' }),
  });
  st = nodes.setPeerAccessPreset(st, 'owner', 'admin'); nodes.atomicWriteStore(nodesPath, st);
  let clock = 0; let probes = 0; let forwards = 0; let mode = 'valid'; let previous; let delay = 0; let responseStatus = 200; let readonly = false;
  t.mock.method(globalThis, 'fetch', async (_url, { body, signal, headers }) => {
    probes++;
    assert.equal(headers.authorization, undefined, 'ownership challenge contains no bearer');
    const request = JSON.parse(body);
    if (delay) await new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      setTimeout(resolve, delay);
    });
    const peer = nodes.loadStoreStrict(nodesPath).nodes.find(n => n.nodeId === request.instanceId);
    let answer = respondSlotProof({ secret: peer.token, expected: { remotePort: request.dialedPort, generation: request.generation, instanceId: request.instanceId }, request });
    if (mode === 'replay' && previous) answer = previous;
    if (mode === 'mac') answer.mac = 'invalid';
    previous = answer;
    return { status: 200, json: async () => answer };
  });
  t.mock.method(http, 'request', (_options, callback) => {
    forwards++;
    const up = new PassThrough(); up.setTimeout = () => up;
    up.once('finish', () => {
      const response = new PassThrough(); response.statusCode = responseStatus; response.headers = {}; response.complete = true;
      callback(response); response.end(JSON.stringify({ status: 'committed' }));
    });
    return up;
  });
  const handler = routeHandler({ nodesPath, localPort: 1, localCredential: () => 'local-fixture', readonly: () => readonly, askProofNow: sharedCache ? null : () => clock });
  const request = async (peerName = 'owner') => {
    const req = new PassThrough(); req.url = `/${peerName}/_/event-feed/asks/11223344/answer`; req.method = 'POST'; req.headers = {}; req.aborted = false;
    const res = new PassThrough(); res.resume(); res.headersSent = false;
    res.writeHead = (status) => { res.statusCode = status; res.headersSent = true; };
    res.status = status => { res.statusCode = status; return res; };
    res.json = value => { res.writeHead(res.statusCode); res.end(JSON.stringify(value)); return res; };
    const ended = once(res, 'finish');
    req.end(); await handler(req, res); await ended;
    return res.statusCode;
  };
  const edit = mutate => { const current = nodes.loadStoreStrict(nodesPath); mutate(current.nodes[0], current); nodes.atomicWriteStore(nodesPath, current); };
  return { request, edit, nodesPath, counts: () => ({ probes, forwards }), clock: value => { clock = value; }, mode: value => { mode = value; }, delay: value => { delay = value; }, status: value => { responseStatus = value; }, readonly: value => { readonly = value; } };
}
test('a positive slot proof expires ten seconds after completion without sliding on a hit', async t => {
  const f = await fixture(t);
  assert.equal(await f.request(), 200); assert.deepEqual(f.counts(), { probes: 1, forwards: 1 });
  f.clock(9999); assert.equal(await f.request(), 200); assert.equal(f.counts().probes, 1);
  f.clock(10000); assert.equal(await f.request(), 200); assert.equal(f.counts().probes, 2, 'a warm action does not renew the proof TTL');
});
test('a cold slow valid proof is admitted with a six second budget', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t); f.delay(3882);
  let result; const pending = f.request().then(value => { result = value; });
  await flush(); t.mock.timers.tick(3882); await flush();
  assert.equal(result, 200, 'a valid slow proof is not treated as an unowned port');
  await pending; assert.deepEqual(f.counts(), { probes: 1, forwards: 1 });
});
for (const component of ['token', 'generation', 'nodeId', 'port', 'localPort', 'pool', 'name']) test(`a warm proof is invalidated by a ${component} binding change`, async t => {
  const f = await fixture(t); assert.equal(await f.request(), 200);
  f.edit(peer => {
    if (component === 'token') peer.token = 'rotated-fixture-token';
    if (component === 'generation') { peer.reversePool.activeGeneration = 4; peer.reversePool.slots[0].generation = 4; peer.reversePool.rotation.generation = 4; }
    if (component === 'nodeId') peer.nodeId = 'e'.repeat(32);
    if (component === 'port') peer.reversePool = nodes.reversePoolDefault(44014, { generation: 3, verification: 'verified' });
    if (component === 'localPort') peer.localPort = 44015;
    if (component === 'pool') { peer.reversePool.verification = 'unverifiable'; peer.reversePool.verifiedSlots = []; }
    if (component === 'name') peer.name = 'renamed';
  });
  assert.equal(await f.request(component === 'name' ? 'renamed' : 'owner'), 200);
  assert.equal(f.counts().probes, 2, 'a changed binding cannot use the old positive proof');
});
test('a failed forward evicts the positive proof before another action', async t => {
  const f = await fixture(t); assert.equal(await f.request(), 200);
  f.status(500); assert.equal(await f.request(), 500); assert.equal(f.counts().probes, 1, 'the failed action used the warm proof');
  f.status(200); assert.equal(await f.request(), 200); assert.equal(f.counts().probes, 2, 'a failed forward invalidates its proof');
});
test('a replay at a cold cache never creates a positive entry', async t => {
  const f = await fixture(t); assert.equal(await f.request(), 200);
  f.clock(10001); f.mode('replay');
  assert.equal(await f.request(), 404); assert.equal(await f.request(), 404);
  assert.deepEqual(f.counts(), { probes: 3, forwards: 1 }, 'both replayed challenges stay cold and deliver nothing');
});
test('a bad MAC never creates a positive cache entry', async t => {
  const f = await fixture(t); f.mode('mac');
  assert.equal(await f.request(), 404); assert.equal(await f.request(), 404);
  assert.deepEqual(f.counts(), { probes: 2, forwards: 0 });
});

test('the positive cache evicts the least recently used binding above 256 entries', async t => {
  const fixtures = [];
  for (let i = 0; i < 5; i++) fixtures.push(await fixture(t, { self: (i + 1).toString(16).padStart(32, '0'), sharedCache: true }));
  for (const f of fixtures.slice(0, 4)) {
    const st = nodes.loadStoreStrict(f.nodesPath);
    for (let i = 0; i < 63; i++) st.nodes.push({ ...st.nodes[0], name: `peer-${i}`, localPort: 20000 + i * 10, nodeId: (i + 10).toString(16).padStart(32, '0'), reversePool: nodes.reversePoolDefault(10000 + i * 10, { generation: 3, verification: 'verified' }) });
    nodes.atomicWriteStore(f.nodesPath, st);
  }
  let probes = 0;
  t.mock.method(globalThis, 'fetch', async (_url, { body }) => {
    probes++;
    const request = JSON.parse(body);
    return { status: 200, json: async () => respondSlotProof({ secret: 'fixture-owner-token', expected: { remotePort: request.dialedPort, generation: request.generation, instanceId: request.instanceId }, request }) };
  });
  assert.equal(await fixtures[0].request(), 200); assert.equal(await fixtures[0].request(), 200);
  assert.equal(probes, 1, 'the initial binding is warm before eviction');
  for (let j = 0; j < 4; j++) {
    if (j) assert.equal(await fixtures[j].request(), 200);
    for (let i = 0; i < 63; i++) assert.equal(await fixtures[j].request(`peer-${i}`), 200);
  }
  assert.equal(probes, 256);
  assert.equal(await fixtures[4].request(), 200); assert.equal(probes, 257);
  assert.equal(await fixtures[0].request(), 200);
  assert.equal(probes, 258, 'capacity does not keep the oldest binding');
});

test('a readonly revocation during proof cannot leave a usable positive entry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = await fixture(t); f.delay(100);
  const pending = f.request(); await flush(); f.readonly(true);
  t.mock.timers.tick(100); await flush(); assert.equal(await pending, 403);
  assert.deepEqual(f.counts(), { probes: 1, forwards: 0 });
  f.readonly(false); f.delay(0); assert.equal(await f.request(), 200);
  assert.equal(f.counts().probes, 2, 'a denied late forward did not retain the proof');
});

test('a readonly refusal invalidates an already warm proof', async t => {
  const f = await fixture(t); assert.equal(await f.request(), 200);
  f.readonly(true); assert.equal(await f.request(), 403);
  assert.deepEqual(f.counts(), { probes: 1, forwards: 1 });
  f.readonly(false); assert.equal(await f.request(), 200);
  assert.equal(f.counts().probes, 2);
});
