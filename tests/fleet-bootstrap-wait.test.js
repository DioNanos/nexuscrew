'use strict';
// Un solo contratto per l'attesa di prontezza prima del primo prompt: default,
// minimo, massimo e regola di validazione. Non coercitivo: un valore che non e'
// un intero nel range non viene corretto, viene rifiutato (POST) o sostituito
// dal fallback diagnosticato (config legacy), e non esiste un clamp silenzioso.

const { test } = require('node:test');
const assert = require('node:assert');
const contratto = require('../lib/fleet/bootstrap-wait.js');

const { DEFAULT_MS, MIN_MS, MAX_MS, valida, normalizzaLegacy } = contratto;

test('costanti del contratto: 15000 di default, 1000 minimo, 120000 massimo', () => {
  assert.equal(DEFAULT_MS, 15000);
  assert.equal(MIN_MS, 1000);
  assert.equal(MAX_MS, 120000);
});

test('valori validi: i quattro punti della UI in ms, e i millisecondi ESATTI', () => {
  for (const v of [1000, 15000, 60000, 120000, 1234, 999, MIN_MS, MAX_MS]) {
    if (v < MIN_MS) continue;
    const r = valida(v);
    assert.equal(r.ok, true, `valore ${v}`);
    assert.equal(r.value, v, 'nessuna riscrittura: il valore passa esatto');
  }
  // 999 e' fuori range: qui sopra e' escluso, e sotto c'e' il caso esplicito.
  assert.equal(valida(999).ok, false);
  assert.equal(valida(999).motivo, 'range');
});

test('input invalidi rifiutati, senza coercizione', () => {
  const casi = [
    [999, 'range'], [120001, 'range'], [0, 'range'], [-1, 'range'],
    ['15000', 'tipo'], ['', 'tipo'], [null, 'tipo'], [true, 'tipo'], [{}, 'tipo'], [[], 'tipo'],
    [15.5, 'non-intero'], [0.5, 'non-intero'], [NaN, 'tipo'], [Infinity, 'tipo'],
  ];
  for (const [v, motivo] of casi) {
    const r = valida(v);
    assert.equal(r.ok, false, `valore ${JSON.stringify(v)}`);
    assert.equal(r.motivo, motivo, `valore ${JSON.stringify(v)}`);
    assert.equal('value' in r, false, 'un rifiuto non porta un valore corretto');
  }
});

test('legacy: assente o null -> default senza causa; invalido -> default con causa', () => {
  for (const v of [undefined, null]) {
    const r = normalizzaLegacy(v);
    assert.equal(r.value, DEFAULT_MS);
    assert.equal(r.causa, 'assente');
  }
  for (const v of [999, 120001, 'abc', 15.5, {}, -5]) {
    const r = normalizzaLegacy(v);
    assert.equal(r.value, DEFAULT_MS, `valore ${JSON.stringify(v)}`);
    assert.equal(r.causa, 'invalido');
  }
  for (const v of [1000, 15000, 60000, 120000, 1234]) {
    const r = normalizzaLegacy(v);
    assert.equal(r.value, v);
    assert.equal(r.causa, null);
  }
});
