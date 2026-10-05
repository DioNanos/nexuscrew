'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAskRelay } = require('../lib/notify/ask-relay.js');
const OWNER = 'a'.repeat(32), SELF = 'b'.repeat(32), ID = '12345678';
function fixture(fetchImpl) {
  let clock = 1000;
  const node = { name: 'owner', nodeId: OWNER, direction: 'outbound', localPort: 42001, token: 'fixture' };
  const relay = createAskRelay({ now: () => clock, loadStore: () => ({ nodeId: SELF, nodes: [node] }), fetchImpl });
  return { relay, node, advance() { clock += 31000; } };
}
test('local availability uses a fresh transport failure without probing in the dismiss request', async () => {
  let calls = 0; const f = fixture(async () => { calls++; throw new Error('offline'); });
  assert.equal(typeof f.relay.channelState, 'function'); assert.equal(f.relay.channelState(OWNER).unavailable, false);
  await f.relay.replyCapability({ ownerId: OWNER, askId: ID }); assert.equal(f.relay.channelState(OWNER).unavailable, true); assert.equal(calls, 1);
  f.advance(); assert.equal(f.relay.channelState(OWNER).unavailable, false);
});
test('a reachable permission denial is never classified as a channel outage', async () => {
  const f = fixture(async () => ({ ok: false, status: 403, json: async () => ({ reason: 'grant-required:ask-action' }) }));
  assert.equal(typeof f.relay.channelState, 'function'); await f.relay.replyCapability({ ownerId: OWNER, askId: ID });
  assert.equal(f.relay.channelState(OWNER).unavailable, false);
});
test('an availability observation is invalidated when the current route binding changes', async () => {
  const f = fixture(async () => { throw new Error('offline'); }); assert.equal(typeof f.relay.channelState, 'function');
  await f.relay.replyCapability({ ownerId: OWNER, askId: ID }); assert.equal(f.relay.channelState(OWNER).unavailable, true);
  f.node.localPort++; assert.equal(f.relay.channelState(OWNER).unavailable, false);
});
test('a cached multihop route change invalidates an old channel outage observation', async () => {
  let routeBinding = 'hub/source';
  const relay = createAskRelay({ loadStore: () => ({ nodeId: SELF, nodes: [{ nodeId: OWNER, direction: 'outbound', localPort: 42001, token: 'fixture' }] }),
    availabilityBinding: () => routeBinding, fetchImpl: async () => { throw new Error('offline'); } });
  await relay.replyCapability({ ownerId: OWNER, askId: ID }); assert.equal(relay.channelState(OWNER).unavailable, true);
  routeBinding = 'other/source'; assert.equal(relay.channelState(OWNER).unavailable, false);
});
