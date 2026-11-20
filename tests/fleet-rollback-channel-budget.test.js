'use strict';
// R5 — la lettura del canale e la pulizia posseduta del tempo 2 portano il
// RESIDUO della fase: una has-session che parte a budget esaurito non apre una
// finestra da cinque secondi, e un ignoto non si promuove ad assenza.
const { test } = require('node:test');
const assert = require('node:assert');
const { attestazioneAssenzaCanale } = require('../lib/fleet/runtime.js');

function canale(has) {
  const chiamate = [];
  return {
    chiamate,
    morto: () => false,
    hasSession: async (id, timeoutMs) => { chiamate.push({ id, timeoutMs }); return has; },
  };
}

test('R5: il timeout della lettura e\' il residuo, mai il default di cinque secondi', async () => {
  const c = canale({ ok: false, assente: true });
  const r = await attestazioneAssenzaCanale(c, '$7', 250);
  assert.equal(r, true);
  assert.deepEqual(c.chiamate, [{ id: '$7', timeoutMs: 250 }]);
});

test('R5: budget esaurito o negativo: nessuna chiamata, nessuna promozione', async () => {
  for (const t of [0, -1, -100]) {
    const c = canale({ ok: false, assente: true });
    const r = await attestazioneAssenzaCanale(c, '$7', t);
    assert.equal(r, false, `budget ${t} promosso ad assenza`);
    assert.deepEqual(c.chiamate, [], `chiamata a budget ${t}`);
  }
});

test('R5: il residuo non supera mai il tetto di cinque secondi', async () => {
  const c = canale({ ok: false, assente: true });
  await attestazioneAssenzaCanale(c, '$7', 60000);
  assert.equal(c.chiamate[0].timeoutMs, 5000);
});

test('R5: senza budget la primitiva non parte affatto (niente default di cinque secondi)', async () => {
  const d = canale({ ok: false, assente: true });
  assert.equal(await attestazioneAssenzaCanale(d, '$7'), false);
  assert.deepEqual(d.chiamate, [], 'la lettura e\' partita col default senza budget');
  const e = canale({ ok: false, assente: true });
  assert.equal(await attestazioneAssenzaCanale(e, '$7', undefined), false);
  assert.deepEqual(e.chiamate, []);
});

test('R5: un esito non qualificato resta ignoto, mai assenza', async () => {
  for (const has of [{ ok: false }, { ok: true }, { morto: true }, null]) {
    const c = canale(has);
    assert.equal(await attestazioneAssenzaCanale(c, '$7', 100), false, JSON.stringify(has));
  }
});
