'use strict';

// lib/notify/event-feed-client.js — an ask the owner closed must stop coming
// back. The view used to keep its copy and hand it to the UI at the next read,
// which is the card that reappears after the X.
//
// The tombstone is bounded: an id reused after an owner reset (new view epoch)
// or after the TTL must NOT stay suppressed, or a genuinely new ask would be
// invisible.

const { test } = require('node:test');
const assert = require('node:assert');

const { createEventFeedClient } = require('../lib/notify/event-feed-client.js');

const OWNER = 'b'.repeat(32);
const SELF = 'a'.repeat(32);
const ASK = 'ask-1';

function ask() {
  return { id: ASK, ownerAskId: ASK, question: 'resto in attesa?', session: 'cloud-Research', answered: false, dismissed: false };
}

function stubClient({ now = () => 1000, epoch = () => 1, asks = () => [ask()] } = {}) {
  const store = {
    nodeId: SELF,
    nodes: [{ name: 'owner', nodeId: OWNER, token: 'TOK', direction: 'outbound', eventsReceive: true, localPort: 46001 }],
  };
  const fetchImpl = async (url, opts = {}) => {
    if (url.includes('/federation/health')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, instanceId: OWNER, eventFeedV1: true }) };
    }
    if (url.includes('/event-feed/snapshot')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({
        ownerId: OWNER, cursor: '1:0', viewEpoch: epoch(), asks: asks(), notifications: [],
      }) };
    }
    if (url.includes('/event-feed')) {
      return { ok: true, status: 200, json: async () => ({}), text: async () => '',
        body: { getReader: () => ({ read: () => new Promise((_resolve, reject) => {
          if (opts.signal.aborted) reject(new Error('client stopped'));
          else opts.signal.addEventListener('abort', () => reject(new Error('client stopped')), { once: true });
        }), cancel: async () => {} }) } };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  const client = createEventFeedClient({
    loadStore: () => store, fetchImpl, pollMs: 50, now,
    // I round qui sono deterministici (round/resnapshot a mano): la finestra
    // minima non è ciò che questi test provano.
    minSnapshotIntervalMs: 0,
    eventsHub: { broadcast() {} }, log: () => {},
  });
  return { client };
}

// Deterministic: one explicit round instead of racing the poll interval.
async function round(client) {
  client.start();
  await new Promise((resolve) => setImmediate(resolve));
  const beforeStop = client.state().views[0];
  client.stop();
  assert.deepEqual(client.state().views[0], beforeStop, 'intentional stop preserves the view, epoch and asks');
  return (client.state().views[0] || {}).asks || [];
}
async function resnapshot(client) {
  client.viewFor(OWNER).cursor = null;   // makes the next round fetch a snapshot
  return round(client);
}
function closedEnvelope(outcome) {
  return { ownerId: OWNER, eventId: `e-${outcome}`, hop: 1, frame: { type: 'ask-closed', outcome, askId: ASK } };
}
function stop(t, client) { t.after(() => { try { client.stop(); } catch (_) { /* */ } }); }

test('an ask the owner dismissed stops coming back at the next snapshot', async (t) => {
  const { client } = stubClient();
  stop(t, client);
  assert.deepEqual((await round(client)).map((a) => a.id), [ASK], 'the snapshot carries the ask');

  client.reemit(closedEnvelope('dismissed'));
  assert.deepEqual(await round(client), [], 'ask-closed drops it from the VIEW, not only the UI');

  // A snapshot taken before the owner processed the dismiss still carries it.
  assert.deepEqual(await resnapshot(client), [], 'the tombstone keeps the dismissed ask out');
});

test('an answered ask also leaves the view', async (t) => {
  const { client } = stubClient();
  stop(t, client);
  await round(client);
  client.reemit(closedEnvelope('answered'));
  assert.deepEqual(await round(client), [], 'answered asks are closed too');
});

test('a confirmed dismiss drops the ask; nothing is hidden without confirmation', async (t) => {
  const { client } = stubClient();
  stop(t, client);
  assert.deepEqual((await round(client)).map((a) => a.id), [ASK]);
  assert.equal(client.dismissConfirmed(OWNER, ASK), true);
  assert.deepEqual(await round(client), [], 'a confirmed dismiss hides the ask');
});

test('an id reused after an owner reset is not suppressed (epoch)', async (t) => {
  let viewEpoch = 1;
  const { client } = stubClient({ epoch: () => viewEpoch });
  stop(t, client);
  await round(client);
  client.dismissConfirmed(OWNER, ASK);
  assert.deepEqual(await resnapshot(client), [], 'hidden within the same epoch');

  // The owner reset: the same id now belongs to a NEW ask, in a new epoch.
  viewEpoch = 2;
  assert.deepEqual(
    (await resnapshot(client)).map((a) => a.id), [ASK],
    'a new epoch must not inherit the old tombstone',
  );
});

test('after the tombstone TTL the ask is visible again', async (t) => {
  let clock = 1000;
  const { client } = stubClient({ now: () => clock });
  stop(t, client);
  await round(client);
  client.dismissConfirmed(OWNER, ASK);
  assert.deepEqual(await round(client), [], 'hidden right after the confirm');

  clock += 11 * 60 * 1000;   // past the TTL: a reused id must be visible
  assert.deepEqual((await resnapshot(client)).map((a) => a.id), [ASK], 'the TTL expires');
});
