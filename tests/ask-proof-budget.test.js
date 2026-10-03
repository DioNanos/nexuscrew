'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { probeReverseSlot, respondSlotProof } = require('../lib/nodes/reverse-slot-proof.js');
const expected = { remotePort: 44012, generation: 3, instanceId: 'b'.repeat(32) };
const secret = 'test-proof-secret';
const flush = () => new Promise(resolve => setImmediate(resolve));
for (const delay of [3882, 5600]) test(`the explicit proof budget admits a valid ${delay} ms reply`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fetchImpl = async (_url, { body, signal, headers }) => {
    assert.equal(headers.authorization, undefined);
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      setTimeout(() => resolve({ status: 200, json: async () => respondSlotProof({ secret, expected, request: JSON.parse(body) }) }), delay);
    });
  };
  let result;
  const probe = probeReverseSlot({ port: expected.remotePort, secret, expected, fetchImpl, timeoutMs: 6000 }).then(value => { result = value; });
  await flush(); t.mock.timers.tick(delay); await flush();
  assert.equal(result?.owned, true);
  await probe;
});
for (const stage of ['fetch', 'body']) test(`caller abort settles a non-cooperative ${stage} proof`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const controller = new AbortController();
  const fetchImpl = stage === 'fetch' ? () => new Promise(() => {}) : async () => ({ status: 200, json: () => new Promise(() => {}) });
  let result;
  void probeReverseSlot({ port: expected.remotePort, secret, expected, fetchImpl, timeoutMs: 6000, signal: controller.signal }).then(value => { result = value; });
  await flush(); controller.abort(); await flush();
  assert.equal(result?.owned, false, 'abort bounds the non-cooperative dependency');
});
for (const stage of ['fetch', 'body']) test(`the proof deadline settles a non-cooperative ${stage}`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const fetchImpl = stage === 'fetch' ? () => new Promise(() => {}) : async () => ({ status: 200, json: () => new Promise(() => {}) });
  let result;
  void probeReverseSlot({ port: expected.remotePort, secret, expected, fetchImpl, timeoutMs: 6000 }).then(value => { result = value; });
  await flush(); t.mock.timers.tick(5999); await flush();
  assert.equal(result, undefined);
  t.mock.timers.tick(1); await flush();
  assert.equal(result?.owned, false, 'the hard deadline covers headers and body');
});
