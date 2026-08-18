'use strict';
// R31-A3 (seguito dell'audit su 44d4f62): il legame fra etichetta e misura
// nella risposta FEDERATA. L'e2e (notify-federation-e2e.test.js) non puo'
// asserirlo: il dispatcher propaga solo lo status — i conteggi muoiono in
// forward() (R1/rc.14) — quindi `out.delivered` oltre il dispatcher e'
// undefined. L'invariante vive nella risposta che il TARGET costruisce
// (lib/notify/routes.js deriva lo status da `delivered` nello stesso punto),
// e qui si vede intera: l'etichetta va provata GIUSTIFICATA dai conteggi,
// non solo corretta per coincidenza.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { notifyRoutes } = require('../lib/notify/routes.js');

const SELF = 'b'.repeat(32);

// Mount della sola via federata: notifier con conteggi CONFIGURABILI (la
// misura che deve giustificare l'etichetta), originResolver/acl/rate finti
// che approvano, header hop presente (la route guarda la presenza; la prova
// crittografica e' dell'originResolver, qui mockato). Tutto in loopback.
function setup(t, { ui = 0, push = 0 } = {}) {
  const emitted = [];
  const notifier = {
    emit: async (frame) => { emitted.push(frame); return { ui, push }; },
    emitRaw: () => 0,
  };
  const app = express();
  app.use('/api', notifyRoutes({
    cfg: {},
    notifier,
    push: {},
    asks: {}, // route /asks mai esercitate qui
    paste: async () => true,
    sessionExists: () => true,
    localNodeId: () => SELF,
    originResolver: { resolve: async () => ({ ok: true, origin: { node: 'a'.repeat(32), cell: 'Dev' } }) },
    acl: { allows: () => ({ allowed: true }) },
    federatedRate: { check: () => ({ allowed: true }) },
  }));
  return new Promise((res) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      t.after(() => srv.close());
      res({
        emitted,
        post: () => fetch(`http://127.0.0.1:${srv.address().port}/api/notify`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-nexuscrew-hop': 'test-harness' },
          body: JSON.stringify({ title: 'unit', target: SELF }),
        }),
      });
    });
  });
}

test('federata zero consegne: no-delivery CON la misura che lo giustifica', async (t) => {
  const { post } = await setup(t, { ui: 0, push: 0 });
  const res = await post();
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.status, 'no-delivery', JSON.stringify(out));
  // L'etichetta e' legata alla misura (rilievo audit): 'no-delivery' vale
  // solo se i conteggi che lo giustificano sono davvero zero.
  assert.strictEqual(out.delivered.ui, 0, JSON.stringify(out));
  assert.strictEqual(out.delivered.push, 0, JSON.stringify(out));
});

test('federata con una UI raggiunta: delivered — la misura comanda', async (t) => {
  const { post } = await setup(t, { ui: 1, push: 0 });
  const res = await post();
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.status, 'delivered', JSON.stringify(out));
  // Il legame nell'altra direzione: se un domani la derivazione producesse
  // 'no-delivery' CON conteggi non-zero (etichetta slegata dal fatto), questo
  // assert va rosso insieme allo status.
  assert.strictEqual(out.delivered.ui, 1, JSON.stringify(out));
});

test('federata solo push: delivered — un solo canale basta', async (t) => {
  const { post } = await setup(t, { ui: 0, push: 1 });
  const res = await post();
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.status, 'delivered', JSON.stringify(out));
  assert.strictEqual(out.delivered.push, 1, JSON.stringify(out));
});
