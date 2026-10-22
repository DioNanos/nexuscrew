'use strict';
// F4 (piano 2026-10-22_DEVAUDITOR_PIANO_VL_STRATO3) — submit opt-in `enter`
// per gli engine custom con promptMode 'send-keys'.
//
// Due superfici, due blocchi:
//  1. VALIDAZIONE: `submit` e' un opt-in stretto ('enter', solo send-keys, mai
//     su engine managed) e sopravvive al roundtrip della definizione. Un valore
//     diverso rifiuta la definizione, non viene scartato in silenzio.
//  2. CONSEGNA: un solo paste delimitato, UN solo Enter sullo stesso %N,
//     nessun retry dopo un paste tentato, nessun degrado a testo grezzo.
const { test } = require('node:test');
const assert = require('node:assert');

const { parseDefinitions } = require('../lib/fleet/definitions.js');
const {
  submitPromptWithEnter, DELIVERY_STATES,
} = require('../lib/fleet/prompt-delivery.js');

const MIN = () => ({
  schemaVersion: 1,
  engines: [{ id: 'sh', command: '/bin/sh', promptMode: 'send-keys' }],
  cells: [{ id: 'C', cwd: '/tmp', engine: 'sh' }],
});
const withEngine = (engine) => {
  const d = MIN();
  d.engines = [engine];
  return d;
};
const CUSTOM = (extra = {}) => ({ id: 'sh', command: '/bin/sh', promptMode: 'send-keys', ...extra });

// --- 1. validazione ---------------------------------------------------------

test('validazione: default storico invariato — nessun submit, nessuna chiave aggiunta', () => {
  const d = parseDefinitions(MIN());
  assert.ok(d);
  assert.equal('submit' in d.engines[0], false, 'assente = paste senza Invio (storico)');
});

test('validazione: opt-in valido accettato e conservato nel roundtrip', () => {
  const d = parseDefinitions(withEngine(CUSTOM({ submit: 'enter' })));
  assert.ok(d, 'submit enter con send-keys e valido');
  assert.equal(d.engines[0].submit, 'enter');
  // roundtrip: la definizione ri-parsata conserva il campo (schema stabile)
  const again = parseDefinitions(d);
  assert.ok(again);
  assert.equal(again.engines[0].submit, 'enter');
});

test('validazione: campo incompatibile rifiutato (mai scartato in silenzio)', () => {
  const casi = [
    ['valore diverso', CUSTOM({ submit: 'Enter' })],
    ['valore booleano', CUSTOM({ submit: true })],
    ['valore vuoto', CUSTOM({ submit: '' })],
    ['null', CUSTOM({ submit: null })],
    ['con promptMode flag', { id: 'sh', command: '/bin/sh', promptMode: 'flag', promptFlag: '-p', submit: 'enter' }],
    ['su engine managed', {
      id: 'claude.x', managed: { client: 'claude', provider: 'zai', model: 'glm-5.2' }, submit: 'enter',
    }],
  ];
  for (const [nome, engine] of casi) {
    assert.equal(parseDefinitions(withEngine(engine)), null, `deve rifiutare: ${nome}`);
  }
});

test('validazione: DELIVERY_STATES resta un enum chiuso e include transport-unsupported', () => {
  assert.ok(Array.isArray(DELIVERY_STATES));
  assert.ok(DELIVERY_STATES.includes('submitted'));
  assert.ok(DELIVERY_STATES.includes('staged-not-submitted'));
  assert.ok(DELIVERY_STATES.includes('delivery-unknown'));
  assert.ok(DELIVERY_STATES.includes('transport-unsupported'));
  assert.equal(new Set(DELIVERY_STATES).size, DELIVERY_STATES.length, 'nessun duplicato');
});

