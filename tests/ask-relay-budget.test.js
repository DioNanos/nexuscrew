'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAskRelay } = require('../lib/notify/ask-relay.js');
const nodes = require('../lib/nodes/store.js');
const ledger = require('../lib/nodes/reverse-pool.js');
const OWNER = 'b'.repeat(32);
const args = { ownerId: OWNER, askId: '11223344', text: 'Proceed', rid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', requestId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
const flush = () => new Promise(resolve => setImmediate(resolve));
function state() {
  let st = nodes.addNode(nodes.upgradeToReversePoolSchema(nodes.emptyStore('a'.repeat(32)), ledger.ledgerHead(ledger.emptyLedger('d'.repeat(32)))), {
    name: 'owner', nodeId: OWNER, token: 'proof-test-token', direction: 'inbound', shared: true,
    visibility: 'network', localPort: 44013, remotePort: 41999, ssh: 'demo@example.invalid',
    reversePool: nodes.reversePoolDefault(44012, { generation: 3, verification: 'verified' }),
  });
  return nodes.setPeerAccessPreset(st, 'owner', 'admin');
}
const methods = ['relayAnswer', 'relayDismiss', 'verifyStatus', 'replyCapability'];
for (const method of methods) test(`routed ${method} leaves the sole reverse proof to the proxy`, async () => {
  let probes = 0; let forwards = 0;
  const relay = createAskRelay({ loadStore: state,
    peers: async () => [{ nodeId: OWNER, route: ['owner'] }], localPort: () => 41999, localToken: () => 'local-test-token',
    probeReverseSlotImpl: async () => { probes++; return { owned: true }; },
    fetchImpl: async () => { forwards++; return { ok: true, status: 200, json: async () => ({ ownerId: OWNER, askId: args.askId, canReply: true, status: method === 'replyCapability' ? 'open' : 'committed', state: 'committed' }) }; },
  });
  const result = await relay[method](args);
  assert.equal(probes, 0, 'the route proxy owns the single challenge');
  assert.equal(forwards, 1);
  assert.equal(method === 'replyCapability' ? result.canReply : result.ok, true);
});
for (const method of methods) test(`${method} bounds a non-cooperative owner enumeration at eight seconds`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let forwards = 0; let result;
  const relay = createAskRelay({ loadStore: state, peers: () => new Promise(() => {}), fetchImpl: async () => { forwards++; } });
  void relay[method](args).then(value => { result = value; });
  await flush(); t.mock.timers.tick(7999); await flush(); assert.equal(result, undefined);
  t.mock.timers.tick(1); await flush();
  assert.ok(result, 'the call concludes at its total deadline');
  assert.equal(method === 'replyCapability' ? result.canReply : result.ok, false);
  assert.equal(forwards, 0);
});
for (const method of methods) test(`${method} includes owner enumeration and body reading in the same deadline`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let forwarded = false; let result;
  const relay = createAskRelay({ loadStore: state, peers: () => new Promise(resolve => setTimeout(() => resolve([{ nodeId: OWNER, route: ['owner'] }]), 3000)),
    probeReverseSlotImpl: async () => ({ owned: true }), localPort: () => 41999, localToken: () => 'local-test-token',
    fetchImpl: async () => { forwarded = true; return { ok: true, status: 200, json: () => new Promise(() => {}) }; },
  });
  void relay[method](args).then(value => { result = value; });
  await flush(); t.mock.timers.tick(3000); await flush(); assert.equal(forwarded, true);
  t.mock.timers.tick(4999); await flush(); assert.equal(result, undefined);
  t.mock.timers.tick(1); await flush(); assert.ok(result, 'body completion cannot get another budget');
  if (method === 'relayAnswer') assert.equal(result.uncertain, true, 'an action that may have left is verified, never resent');
  else assert.equal(method === 'replyCapability' ? result.canReply : result.ok, false);
});
for (const method of ['relayDismiss', 'verifyStatus', 'replyCapability']) test(`${method} preserves the allowlisted proxy refusal reason`, async () => {
  const relay = createAskRelay({ loadStore: state, peers: async () => [{ nodeId: OWNER, route: ['owner'] }],
    probeReverseSlotImpl: async () => ({ owned: true }), localPort: () => 41999, localToken: () => 'local-test-token',
    fetchImpl: async () => ({ ok: false, status: 404, json: async () => ({ reason: 'reverse-slot-unverified' }) }),
  });
  const result = await relay[method](args);
  assert.equal(result.reason, 'reverse-slot-unverified');
  if (method === 'replyCapability') assert.equal(result.status, 'unreachable', 'a failed slot proof is not an unsupported owner');
});

test('a late owner enumeration cannot forward or create an attempt after expiry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release; let result; let forwards = 0;
  const relay = createAskRelay({ loadStore: state, peers: () => new Promise(resolve => { release = resolve; }),
    fetchImpl: async () => { forwards++; return { ok: true, status: 200, json: async () => ({ status: 'committed' }) }; },
  });
  void relay.relayAnswer(args).then(value => { result = value; });
  await flush(); t.mock.timers.tick(8000); await flush();
  assert.equal(result?.reason, 'relay-deadline');
  release([{ nodeId: OWNER, route: ['owner'] }]); await flush();
  assert.equal(forwards, 0); assert.deepEqual(relay.state(), []);
});
test('a late delivered answer stays uncertain and a second request never pastes again', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let release; let result; let forwards = 0;
  const relay = createAskRelay({ loadStore: state, peers: async () => [{ nodeId: OWNER, route: ['owner'] }], localPort: () => 41999,
    fetchImpl: () => { forwards++; return new Promise(resolve => { release = resolve; }); },
  });
  void relay.relayAnswer(args).then(value => { result = value; });
  await flush(); t.mock.timers.tick(8000); await flush();
  assert.equal(result?.uncertain, true); assert.equal(relay.state()[0].state, 'uncertain');
  release({ ok: true, status: 200, json: async () => ({ status: 'committed' }) }); await flush();
  assert.equal(relay.state()[0].state, 'uncertain', 'a completed deadline cannot be rewritten by a late reply');
  const another = await relay.relayAnswer({ ...args, rid: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' });
  assert.equal(another.reason, 'uncertain'); assert.equal(forwards, 1);
});
test('the compatible direct inbound path retains its proof and shares a positive cache', async () => {
  const st = state(); st.nodeId = 'f'.repeat(32);
  let probes = 0; let forwards = 0;
  const relay = createAskRelay({ loadStore: () => st,
    probeReverseSlotImpl: async ({ timeoutMs, signal }) => { assert.equal(timeoutMs, 6000); assert.ok(signal); probes++; return { owned: true }; },
    fetchImpl: async () => { forwards++; return { ok: true, status: 200, json: async () => ({ state: 'committed' }) }; },
  });
  assert.equal((await relay.relayDismiss(args)).ok, true);
  assert.equal((await relay.verifyStatus(args)).ok, true);
  assert.equal(probes, 1); assert.equal(forwards, 2);
});
test('a failed compatible forward invalidates its warm proof', async () => {
  const st = state(); st.nodeId = 'e'.repeat(32);
  let probes = 0; let status = 200;
  const relay = createAskRelay({ loadStore: () => st, probeReverseSlotImpl: async () => { probes++; return { owned: true }; },
    fetchImpl: async () => ({ ok: status === 200, status, json: async () => ({ state: 'committed', reason: 'peer-unknown' }) }),
  });
  assert.equal((await relay.relayDismiss(args)).ok, true);
  status = 403; assert.equal((await relay.relayDismiss(args)).reason, 'peer-unknown');
  assert.equal(probes, 1);
  status = 200; assert.equal((await relay.relayDismiss(args)).ok, true); assert.equal(probes, 2);
});
