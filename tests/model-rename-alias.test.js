'use strict';
// tests/model-rename-alias.test.js — rinominare un modello non deve fermare le
// celle gia' configurate.
//
// Un fornitore che promuove un preview a stabile cambia l'id. Con
// `strictModels: true` un id non piu' in catalogo non produce un avviso:
// produce una cella che NON PARTE. Al momento del rinomino di
// `qwen3.8-max-preview` due celle reali erano configurate con quel nome, e si
// sarebbero fermate al primo avvio successivo senza che nulla dicesse perche'.
//
// L'alias risolve il nome vecchio e restituisce quello NUOVO: la
// configurazione converge da sola alla prima riscrittura, invece di restare
// indietro per sempre dietro una compatibilita' silenziosa.
const { test } = require('node:test');
const assert = require('node:assert');
const managed = require('../lib/fleet/managed.js');

const spec = (model) => ({
  client: 'claude', provider: 'alibaba-token-plan', model, permissionPolicy: 'unsafe',
});

test('una cella configurata col nome VECCHIO continua a risolvere', () => {
  const out = managed.normalizeManagedSpec(spec('qwen3.8-max-preview'));
  assert.ok(out, 'il nome legacy deve passare il gate strictModels');
});

test('e risolve al nome NUOVO, cosi\' la configurazione converge', () => {
  // Se restituisse il nome vecchio, la compatibilita' diventerebbe un debito
  // permanente: ogni riscrittura lo riscriverebbe.
  const out = managed.normalizeManagedSpec(spec('qwen3.8-max-preview'));
  assert.equal(out.model, 'qwen3.8-max');
});

test('il nome nuovo risolve direttamente', () => {
  const out = managed.normalizeManagedSpec(spec('qwen3.8-max'));
  assert.equal(out.model, 'qwen3.8-max');
});

test('l\'alias non apre la porta a un modello qualsiasi', () => {
  // La compatibilita' vale per i rinomini DICHIARATI, non come scappatoia al
  // catalogo: un id inventato resta rifiutato.
  assert.equal(managed.normalizeManagedSpec(spec('qwen9-inventato')), null);
});

test('senza modello dichiarato si usa il default, che e\' il nome nuovo', () => {
  const out = managed.normalizeManagedSpec({
    client: 'claude', provider: 'alibaba-token-plan', permissionPolicy: 'unsafe',
  });
  assert.equal(out.model, 'qwen3.8-max');
});

test('l\'alias vale anche per gli altri client dello stesso fornitore', () => {
  // Il rinomino e' del MODELLO, non di un engine: se valesse solo per Claude,
  // le celle Codex-VL e Pi resterebbero ferme.
  for (const client of ['codex-vl', 'pi']) {
    const out = managed.normalizeManagedSpec({
      client, provider: 'alibaba-token-plan', model: 'qwen3.8-max-preview',
      permissionPolicy: 'standard',
    });
    assert.ok(out, `${client}: il nome legacy deve passare`);
    assert.equal(out.model, 'qwen3.8-max', `${client}: deve convergere al nome nuovo`);
  }
});
