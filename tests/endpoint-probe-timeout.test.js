'use strict';
// tests/endpoint-probe-timeout.test.js — la sonda si RISOLVE sempre.
// Con il timer di abort `unref`, e nessun altro handle nell'event loop, il
// timer non scadeva: un fetch che non risponde lasciava la promise appesa per
// sempre (su Node 20: «Promise resolution is still pending but the event loop
// has already resolved»). Il timer resta ref per la durata della sonda.
const { test } = require('node:test');
const assert = require('node:assert');
const { createEndpointProbe } = require('../lib/fleet/endpoint-probe.js');

test('fetch che non risponde: la sonda si risolve col verdetto di timeout', async () => {
  const probe = createEndpointProbe({ timeoutMs: 50, fetchImpl: (_url, opts = {}) => new Promise((_res, rej) => {
    // come il fetch reale: si sblocca SOLO all'abort
    if (opts.signal) opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  }) });
  const v = await probe.refresh('http://127.0.0.1:9/v1');
  assert.equal(v.state, 'unreachable');
  assert.match(v.reason, /timeout/);
});

test('la sonda non trattiene il processo oltre il proprio timeout', async () => {
  const probe = createEndpointProbe({
    timeoutMs: 50,
    fetchImpl: (_url, opts = {}) => new Promise((_res, rej) => {
      if (opts.signal) opts.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
    }),
  });
  const t0 = Date.now();
  const v = await probe.refresh('http://127.0.0.1:9/v1');
  assert.equal(v.state, 'unreachable');
  assert.ok(Date.now() - t0 < 1000, 'la sonda chiude col timeout, non appende');
});
