'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { createBroker, PROTOCOL } = require('../lib/vl-nodes/broker.js');

const node = { nodeId: 'a'.repeat(32), label: 'N900', pairedAt: 1 };

function heartbeat(sessionId, seq, over = {}) {
  return {
    protocol: PROTOCOL,
    nodeId: node.nodeId,
    sessionId,
    seq,
    version: '0.1.0',
    capabilities: ['status', 'restart'],
    health: { state: 'running', uptimeSec: 10, rssBytes: 2_000_000, processCount: 2, brokerReachable: true },
    ...over,
  };
}

test('live poll receives exactly one bounded command and completion requires ack', async () => {
  let now = 10_000;
  const broker = createBroker({ now: () => now, randomBytes: (n) => Buffer.alloc(n, 9) });
  const firstPoll = broker.poll(node, heartbeat('1'.repeat(32), 0), { waitMs: 5_000 });
  const submitted = broker.dispatch(node.nodeId, { kind: 'status', args: {} });
  assert.deepEqual(submitted, { ok: true, id: '09'.repeat(16), status: 'submitted', generation: 1 });
  const delivered = await firstPoll;
  assert.equal(delivered.type, 'command');
  assert.equal(delivered.command.kind, 'status');
  assert.equal(broker.list([node])[0].inflight.status, 'submitted');

  now += 50;
  const secondPoll = broker.poll(node, heartbeat('1'.repeat(32), 1, {
    ack: { id: submitted.id, status: 'ok', result: { state: 'running' } },
  }), { waitMs: 5_000 });
  const state = broker.list([node])[0];
  assert.equal(state.inflight, null);
  assert.equal(state.lastAck.id, submitted.id);
  assert.equal(state.online, false, 'an acknowledged poll with no waiter is not online by process presence');
  assert.equal((await secondPoll).type, 'acknowledged');
  broker.forget(node.nodeId);
});

test('offline nodes reject commands instead of inventing a queue', () => {
  const broker = createBroker();
  assert.deepEqual(broker.dispatch(node.nodeId, { kind: 'health', args: {} }), {
    ok: false, code: 'node-offline',
  });
});

test('new device session supersedes stale poll and clears delivery-unknown command', async () => {
  const broker = createBroker({ randomBytes: (n) => Buffer.alloc(n, 4) });
  const oldPoll = broker.poll(node, heartbeat('2'.repeat(32), 0), { waitMs: 5_000 });
  const submitted = broker.dispatch(node.nodeId, { kind: 'restart', args: {} });
  assert.equal((await oldPoll).type, 'command');

  const newPoll = broker.poll(node, heartbeat('3'.repeat(32), 0), { waitMs: 5_000 });
  const current = broker.list([node])[0];
  assert.equal(current.generation, 2);
  assert.equal(current.inflight, null);
  assert.equal(current.lastAck.id, submitted.id);
  assert.equal(current.lastAck.result.code, 'stale-session');
  const next = broker.dispatch(node.nodeId, { kind: 'health', args: {} });
  assert.equal(next.ok, true, 'fresh live session accepts a new command');
  assert.equal((await newPoll).command.kind, 'health');
});

test('same session repoll without matching ack clears delivery-unknown command', async () => {
  let now = 20_000;
  const broker = createBroker({ now: () => now, randomBytes: (n) => Buffer.alloc(n, 5) });
  const firstPoll = broker.poll(node, heartbeat('5'.repeat(32), 0), { waitMs: 5_000 });
  const submitted = broker.dispatch(node.nodeId, { kind: 'restart', args: {} });
  assert.equal((await firstPoll).type, 'command');

  now += 50;
  const recoveryPoll = broker.poll(node, heartbeat('5'.repeat(32), 1), { waitMs: 5_000 });
  const recovered = broker.list([node])[0];
  assert.equal(recovered.inflight, null);
  assert.equal(recovered.lastAck.id, submitted.id);
  assert.equal(recovered.lastAck.status, 'error');
  assert.equal(recovered.lastAck.result.code, 'delivery-unknown');

  const next = broker.dispatch(node.nodeId, { kind: 'health', args: {} });
  assert.equal(next.ok, true, 'a fresh poll accepts a new bounded command');
  assert.equal((await recoveryPoll).command.kind, 'health');
});

test('same-session replayed sequence is rejected fail-closed', async () => {
  const broker = createBroker();
  const first = broker.poll(node, heartbeat('4'.repeat(32), 7), { waitMs: 5_000 });
  const replay = await broker.poll(node, heartbeat('4'.repeat(32), 7), { waitMs: 5_000 });
  assert.deepEqual(replay, { type: 'error', code: 'stale-sequence' });
  broker.forget(node.nodeId);
  assert.equal((await first).type, 'revoked');
});
