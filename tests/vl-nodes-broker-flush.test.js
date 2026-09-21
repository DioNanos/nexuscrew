'use strict';
// tests/vl-nodes-broker-flush.test.js — alla chiusura i waiter pendenti del
// broker si risolvono SUBITO (idle): il processo termina senza aspettare i
// boundedWait residui. Prima della correzione il timer era unref e la promise
// del poll non si risolveva mai se l'event loop era vuoto (Node 20: i 9 rossi).
const { test } = require('node:test');
const assert = require('node:assert');
const { createBroker, PROTOCOL } = require('../lib/vl-nodes/broker.js');

const node = { nodeId: 'a'.repeat(32), label: 'N900', pairedAt: 1 };
const SESSION = '1'.repeat(32);

function heartbeat(seq, over = {}) {
  return {
    protocol: PROTOCOL,
    nodeId: node.nodeId,
    sessionId: SESSION,
    seq,
    version: '0.1.0',
    capabilities: ['status'],
    health: { state: 'running', uptimeSec: 10, rssBytes: 2_000_000, processCount: 2, brokerReachable: true },
    ...over,
  };
}

test('flushPendingWaiters risolve i poll pendenti entro 100 ms', async (t) => {
  const broker = createBroker();
  const NODE = node.nodeId;
  let resolved = false;
  const pollPromise = broker.poll(NODE, heartbeat(0), { waitMs: 20000 }).then((v) => { resolved = true; return v; });
  await Promise.resolve(); // lascia avviare il waiter
  assert.equal(resolved, false, 'il poll deve restare pendente finche non c’e flush');

  const t0 = Date.now();
  const flushed = broker.flushPendingWaiters();
  const v = await pollPromise;
  const elapsed = Date.now() - t0;
  assert.equal(flushed, 1);
  assert.equal(v.type, 'idle');
  assert.equal(resolved, true);
  assert.ok(elapsed < 100, `flush entro 100 ms (misurato ${elapsed} ms)`);
});

test('server.close() con waiter pendente: flush esplicito chiude entro 100 ms', async (t) => {
  const broker = createBroker();
  const http = require('node:http');
  const srv = http.createServer((_req, res) => {
    void broker.poll(node.nodeId, heartbeat(0), { waitMs: 20000 }).catch(() => {});
    res.end();
  });
  await new Promise((res) => srv.listen(0, '127.0.0.1', res));
  const pollPromise = broker.poll(node.nodeId, heartbeat(0), { waitMs: 20000 });
  const t0 = Date.now();
  srv.close(() => broker.flushPendingWaiters());
  await pollPromise;
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 100, `chiusura entro 100 ms (misurato ${elapsed} ms)`);
  void http;
});
