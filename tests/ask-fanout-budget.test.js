'use strict';
// ASK fan-out budgets. The caller must not wait for silent
// peers one after another: the question is already durable on this node when
// the fan-out starts, so the wait is bounded per peer AND for the whole phase.
// Router standalone with injected deps: fake dispatcher, fake notifier, no tmux.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createAsksStore } = require('../lib/notify/asks.js');
const { createNotifier } = require('../lib/notify/notifier.js');
const routes = require('../lib/notify/routes.js');
const accessPresets = require('../lib/nodes/access-presets.js');

// The contract values the caller is expected to live with (same numbers the
// module names). Hardcoded here on purpose: a test that reads the cap from the
// module cannot notice the cap growing.
const TOTAL_CAP_MS = 3000;

const PEERS = [
  '11111111111111111111111111111111',
  '22222222222222222222222222222222',
  '33333333333333333333333333333333',
  '44444444444444444444444444444444',
];

// A peer list in the shape resolveFanTargets expects: the first hop is a
// configured admin vector, so every entry is a legitimate ASK destination.
function peerTargets() {
  return PEERS.map((nodeId) => ({ nodeId, firstHop: { ...accessPresets.ADMIN_GRANTS, accessConfigured: true } }));
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function setup(t, { dispatcher, peerTargets: peerTargetsImpl, notifier: notifierImpl } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncask-fanout-'));
  const hub = { broadcast: () => 1, clientCount: () => 1 };
  const push = { sendToAll: async () => ({ sent: 0, removed: 0 }) };
  const asks = createAsksStore({ dir });
  const app = express();
  app.use('/api', routes.notifyRoutes({
    cfg: { readonlyDefault: false },
    notifier: notifierImpl || createNotifier({ hub, push }),
    push,
    asks,
    submit: async () => ({ outcome: 'submitted' }),
    sessionExists: (s) => typeof s === 'string' && s.startsWith('cell-'),
    dispatcher,
    peerTargets: peerTargetsImpl || (async () => peerTargets()),
    localNodeId: () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  }));
  return new Promise((resolve) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      t.after(() => { srv.closeAllConnections(); srv.close(); });
      resolve({
        j: (p, opts = {}) => fetch(`http://127.0.0.1:${srv.address().port}${p}`, {
          ...opts,
          headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) },
        }),
      });
    });
  });
}

async function createAsk(j) {
  const started = Date.now();
  const response = await j('/api/asks', {
    method: 'POST',
    body: JSON.stringify({ question: 'procedo?', session: 'cell-a' }),
  });
  return { response, elapsed: Date.now() - started };
}

test('fan-out caps are named constants with the contract values', () => {
  assert.equal(routes.ASK_FANOUT_PEER_MS, 2000);
  assert.equal(routes.ASK_FANOUT_TOTAL_MS, TOTAL_CAP_MS);
});

test('four slow peers: the ask is answered inside the total cap, one status each, in order', { timeout: 20000 }, async (t) => {
  const perPeerMs = 900; // what a peer with its own transport timeout costs
  let calls = 0;
  const dispatcher = {
    dispatch: async () => {
      calls += 1;
      await sleep(perPeerMs);
      return { status: 'unreachable', reason: 'transport' };
    },
  };
  const { j } = await setup(t, { dispatcher });
  const { response, elapsed } = await createAsk(j);
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.ok(elapsed < TOTAL_CAP_MS,
    `response after ${elapsed} ms, over the ${TOTAL_CAP_MS} ms total cap: peers are awaited one after another`);
  assert.equal(calls, 4, 'every peer is still attempted');
  assert.deepEqual((body.fanout || []).map((f) => f.target), PEERS, 'one entry per target, in target-list order');
  assert.deepEqual((body.fanout || []).map((f) => f.status), ['unreachable', 'unreachable', 'unreachable', 'unreachable']);
});

test('one peer answers and three stay mute: delivered + timeout inside the total cap', { timeout: 20000 }, async (t) => {
  const dispatcher = {
    dispatch: ({ target }) => (target === PEERS[1]
      ? Promise.resolve({ status: 'delivered', alertStatus: 'no-delivery' })
      : new Promise(() => {})), // mute: never answers, never rejects
  };
  const { j } = await setup(t, { dispatcher });
  const { response, elapsed } = await createAsk(j);
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.ok(elapsed < TOTAL_CAP_MS,
    `response after ${elapsed} ms, over the ${TOTAL_CAP_MS} ms total cap`);
  assert.deepEqual((body.fanout || []).map((f) => f.target), PEERS);
  assert.deepEqual((body.fanout || []).map((f) => f.status), ['timeout', 'delivered', 'timeout', 'timeout']);
  assert.equal(body.fanout[1].alertStatus, 'no-delivery', 'the delivered entry keeps its payload');
});

test('a slow discovery spends the same total budget as the dispatches', { timeout: 20000 }, async (t) => {
  // The destinations are resolved BEFORE the peers are dispatched, but the
  // caller waits on one clock: a discovery that takes 2,5 s leaves 0,5 s for
  // the peers, it does not restart the total budget.
  const discoveryMs = 2500;
  const dispatcher = { dispatch: () => new Promise(() => {}) }; // every peer mute
  const { j } = await setup(t, {
    dispatcher,
    peerTargets: async () => { await sleep(discoveryMs); return peerTargets(); },
  });
  const { response, elapsed } = await createAsk(j);
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.ok(elapsed < TOTAL_CAP_MS + 400,
    `response after ${elapsed} ms: the ${discoveryMs} ms discovery was added to the ${TOTAL_CAP_MS} ms cap instead of spending it`);
  assert.deepEqual((body.fanout || []).map((f) => f.status), ['timeout', 'timeout', 'timeout', 'timeout']);
});

test('a discovery past the deadline dispatches nothing and reports it', { timeout: 20000 }, async (t) => {
  // Nothing is dispatched on a guess when the deadline expires before the
  // destinations are known, and the caller can tell this apart from a peer
  // that went silent.
  let calls = 0;
  const dispatcher = { dispatch: () => { calls += 1; return Promise.resolve({ status: 'delivered' }); } };
  const { j } = await setup(t, { dispatcher, peerTargets: () => new Promise(() => {}) });
  const { response, elapsed } = await createAsk(j);
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.ok(elapsed < TOTAL_CAP_MS + 400, `response after ${elapsed} ms, over the ${TOTAL_CAP_MS} ms total cap`);
  assert.equal(calls, 0, 'no target was invented: nothing was dispatched');
  assert.equal(body.fanout, undefined);
  assert.equal(body.fanoutDiscovery, 'timeout', 'the discovery deadline is observable to the caller');
});

test('a dispatch that settles after the total deadline cannot rewrite the answer', { timeout: 20000 }, async (t) => {
  // The total backstop wins when the discovery nearly spends the budget and
  // the dispatch burns the rest synchronously (the limit is cooperative, so a
  // synchronous prefix is not preempted). The per-peer wrapper is then armed
  // past the deadline and settles while the local emission is still running:
  // its value must never reach the array the caller is about to be given.
  const discoveryMs = 2600;
  const syncBurnMs = 400;
  let calls = 0;
  const dispatcher = {
    dispatch: () => {
      calls += 1;
      const until = Date.now() + syncBurnMs;
      while (Date.now() < until) { /* synchronous work: no timer can interrupt it */ }
      return new Promise(() => {}); // the peer never answers
    },
  };
  // A slow emission keeps the serialization open across the late settlement.
  const notifier = {
    emitRaw: () => 1,
    emit: async () => { await sleep(800); return { ui: 1, push: 0, alertStatus: 'delivered' }; },
  };
  const { j } = await setup(t, {
    dispatcher,
    notifier,
    peerTargets: async () => { await sleep(discoveryMs); return [peerTargets()[0]]; },
  });
  const { response } = await createAsk(j);
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.equal(calls, 1, 'the peer was still attempted');
  assert.equal((body.fanout || []).length, 1);
  assert.equal(body.fanout[0].reason, 'fanout-total-timeout',
    'the closed phase ignored the per-peer settlement that arrived after the backstop');
});

test('a slow synchronous prefix in the first dispatch stops the later sends', { timeout: 20000 }, async (t) => {
  // The first target spends the budget inside its synchronous prefix, which no
  // timer can interrupt. The three others must not start past the deadline:
  // the budget is measured again before every send, not once for the map.
  const discoveryMs = 2600;
  const syncBurnMs = 500;
  const calls = [];
  const dispatcher = {
    dispatch: ({ target }) => {
      calls.push(target);
      if (calls.length === 1) {
        const until = performance.now() + syncBurnMs;
        while (performance.now() < until) { /* synchronous prefix */ }
      }
      return new Promise(() => {}); // no peer answers
    },
  };
  const { j } = await setup(t, {
    dispatcher,
    peerTargets: async () => { await sleep(discoveryMs); return peerTargets(); },
  });
  const { response } = await createAsk(j);
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.deepEqual(calls, [PEERS[0]], 'only the first target was invoked');
  assert.deepEqual((body.fanout || []).map((f) => f.reason),
    ['fanout-total-timeout', 'fanout-total-timeout', 'fanout-total-timeout', 'fanout-total-timeout']);
});

test('a discovery that resolves synchronously past the deadline still reports it', { timeout: 20000 }, async (t) => {
  // The deadline timer is armed only after the synchronous work returns: the
  // promise wins the race and the timeout branch would be skipped. The
  // deadline is measured again after the discovery.
  let calls = 0;
  const dispatcher = { dispatch: () => { calls += 1; return Promise.resolve({ status: 'delivered' }); } };
  const { j } = await setup(t, {
    dispatcher,
    peerTargets: () => {
      const until = performance.now() + TOTAL_CAP_MS;
      while (performance.now() < until) { /* synchronous discovery */ }
      return peerTargets();
    },
  });
  const { response } = await createAsk(j);
  const body = await response.json();
  assert.equal(response.status, 201, JSON.stringify(body));
  assert.equal(calls, 0, 'nothing was dispatched past the deadline');
  assert.equal(body.fanout, undefined);
  assert.equal(body.fanoutDiscovery, 'timeout');
});
