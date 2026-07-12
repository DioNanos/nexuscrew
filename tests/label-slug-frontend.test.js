'use strict';
// tests/label-slug-frontend.test.js — label/slug lato frontend (mirror del
// backend): toSlug deriva slug safe dalla label libera, suggestNodeName
// disambigua, isValidLabel valida (mirror store.js). La UI puo' far scrivere
// "Relay3" e produrre lo slug "relay3" senza errore confuso.
const { test } = require('node:test');
const assert = require('node:assert');
const sm = () => import('../frontend/src/lib/settings-model.js');

test('toSlug: Relay3 -> relay3, spazi/punteggiatura -> single dash, diacritici ASCII', async () => {
  const { toSlug } = await sm();
  assert.equal(toSlug('Relay3'), 'relay3');
  assert.equal(toSlug('My Server!'), 'my-server');
  assert.equal(toSlug('  multi   space  '), 'multi-space');
  assert.equal(toSlug('café'), 'cafe');
});

test('toSlug: input povero -> "node" (mai throw, mai vuoto); <= 32 char', async () => {
  const { toSlug } = await sm();
  assert.equal(toSlug(''), 'node');
  assert.equal(toSlug('---'), 'node');
  assert.equal(toSlug('!@#'), 'node');
  const long = toSlug('A'.repeat(50));
  assert.ok(long.length <= 32);
});

test('suggestNodeName: univoco, disambigua -2/-3 su collisione', async () => {
  const { suggestNodeName } = await sm();
  assert.equal(suggestNodeName('Relay3', []), 'relay3');
  assert.equal(suggestNodeName('Relay3', ['relay3']), 'relay3-2');
  assert.equal(suggestNodeName('Relay3', ['relay3', 'relay3-2']), 'relay3-3');
});

test('isValidLabel: ok per stringhe display; rifiuta control/empty/lunghe', async () => {
  const { isValidLabel } = await sm();
  assert.equal(isValidLabel('Relay Server'), true);
  assert.equal(isValidLabel('a'), true);
  assert.equal(isValidLabel(''), false);
  assert.equal(isValidLabel('   '), false);
  assert.equal(isValidLabel('a\nb'), false);
  assert.equal(isValidLabel('a'.repeat(65)), false);
  assert.equal(isValidLabel(42), false);
});

test('toSlug mirror backend: stessi risultati delle API (coerenza UI/server)', async () => {
  const { toSlug } = await sm();
  const store = require('../lib/nodes/store.js');
  for (const input of ['Relay3', 'Phone Pro', 'café', 'A.B/C', '42', '---', 'über']) {
    assert.equal(toSlug(input), store.toSlug(input), `mirror frontend/backend per "${input}"`);
  }
});
