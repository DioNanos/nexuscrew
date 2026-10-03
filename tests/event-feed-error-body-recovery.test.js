'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createEventFeedClient } = require('../lib/notify/event-feed-client.js');
const OWNER = 'b'.repeat(32);
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function pending(signal) {
  return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
}
function setup(t, stream) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 100000 });
  t.mock.method(Math, 'random', () => 0);
  const peers = [{ nodeId: OWNER, direction: 'outbound', eventsReceive: true, localPort: 41001, token: 'fixture-token' }];
  const client = createEventFeedClient({
    loadStore: () => ({ nodeId: 'a'.repeat(32), nodes: peers.map(p => ({ ...p })) }),
    minSnapshotIntervalMs: 0, pollMs: 100, eventsHub: { broadcast() {} },
    fetchImpl: async (url, opts) => {
      if (url.endsWith('/health')) return { ok: true, json: async () => ({ instanceId: OWNER, eventFeedV1: true }) };
      if (url.includes('/snapshot')) return { ok: true, text: async () => JSON.stringify({ ownerId: OWNER, cursor: '5:0', viewEpoch: 5, asks: [], notifications: [], askReplyAccess: true }) };
      return stream(url, opts);
    },
  });
  t.after(() => client.stop());
  return { client, peers };
}
test('a pending forbidden stream body has a deadline and releases the owner slot', async t => {
  let signal;
  let streams = 0;
  const { client } = setup(t, (_url, opts) => {
    streams++;
    if (streams === 1) {
      signal = opts.signal;
      return { ok: false, status: 403, json: () => pending(signal) };
    }
    return { ok: true, body: { getReader: () => ({ read: () => pending(opts.signal) }) } };
  });
  void client.poll(); await flush();
  assert.equal(streams, 1);
  t.mock.timers.tick(4999); await flush();
  assert.equal(signal.aborted, false, 'the body deadline does not fire early');
  t.mock.timers.tick(1); await flush();
  assert.equal(signal.aborted, true, 'the forbidden response body deadline aborts its slot');
  t.mock.timers.tick(2500); await flush();
  assert.equal(streams, 2, 'the next owner generation can acquire a stream');
  assert.equal(client.state().views[0].stale, false);
});
test('an obsolete forbidden response body cannot mark a fresh owner view stale', async t => {
  let resolveOld;
  let oldSignal;
  const { client, peers } = setup(t, (url, opts) => {
    if (new URL(url).port === '41001') {
      oldSignal = opts.signal;
      return { ok: false, status: 403, json: () => new Promise(resolve => { resolveOld = resolve; }) };
    }
    return { ok: true, body: { getReader: () => ({ read: () => pending(opts.signal) }) } };
  });
  void client.poll(); await flush();
  assert.equal(typeof resolveOld, 'function');
  peers[0].localPort = 41002;
  void client.poll(); await flush();
  assert.equal(oldSignal.aborted, true);
  assert.equal(client.state().views[0].stale, false, 'the replacement snapshot is healthy before the obsolete body resolves');
  resolveOld({ reason: 'events-disabled' }); await flush();
  assert.equal(client.state().views[0].stale, false, 'the obsolete forbidden body cannot stale the replacement view');
});
test('a forbidden body fulfilled just before cancellation still checks its generation', async t => {
  let resolveBody;
  let restart = false;
  let client;
  ({ client } = setup(t, (_url, opts) => {
    if (restart) return { ok: true, body: { getReader: () => ({ read: () => pending(opts.signal) }) } };
    return { ok: false, status: 403, json: () => new Promise(resolve => { resolveBody = resolve; }).then(body => {
      queueMicrotask(() => queueMicrotask(() => {
        restart = true;
        client.stop();
        client.start();
      }));
      return body;
    }) };
  }));
  void client.poll(); await flush();
  const writes = [];
  const view = client.viewFor(OWNER);
  let stale = view.stale;
  Object.defineProperty(view, 'stale', {
    configurable: true,
    get: () => stale,
    set: value => { if (restart) writes.push(value); stale = value; },
  });
  resolveBody({ reason: 'events-disabled' }); await flush();
  assert.equal(restart, true);
  assert.equal(writes.includes(true), false, 'a fulfilled obsolete body never writes stale into the retained replacement view');
  assert.equal(view.stale, false);
});
