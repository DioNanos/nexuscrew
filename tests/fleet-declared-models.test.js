'use strict';
// tests/fleet-declared-models.test.js — modelli dichiarati in configurazione.
//
// Il catalogo dei modelli vive nel pacchetto: un fornitore che pubblica un id
// nuovo lo rende inutilizzabile fino alla release successiva, perche' quattro
// engine hanno `strictModels` e un id fuori catalogo non e' un avviso — e' una
// cella che non parte.
//
// Un modello dichiarato estende il catalogo in modo esplicito. Non lo aggira:
// un id mai dichiarato resta rifiutato, ed e' cio' che impedisce di far partire
// una cella con un modello inesistente e scoprirlo dal fallimento.
const { test } = require('node:test');
const assert = require('node:assert');
const { parseDefinitions } = require('../lib/fleet/definitions.js');

const PROFILO = 'claude.alibaba-token-plan';
const engineCon = (model) => ({
  id: 'e1', label: 'E', managed: { client: 'claude', provider: 'alibaba-token-plan', model, permissionPolicy: 'unsafe' },
});
const defs = (extra = {}) => ({ schemaVersion: 1, engines: [], cells: [], ...extra });

test('una configurazione senza `models` resta valida e IDENTICA', () => {
  // Nessuna migrazione, nessun campo aggiunto: chi non dichiara modelli non
  // deve vedere il proprio file cambiare al primo salvataggio.
  const out = parseDefinitions(defs());
  assert.deepEqual(out, { schemaVersion: 1, engines: [], cells: [] });
  assert.ok(!Object.hasOwn(out, 'models'));
});

test('un id dichiarato rende usabile un engine che altrimenti sarebbe rifiutato', () => {
  const out = parseDefinitions(defs({
    models: [{ id: 'qwen9-nuovo', engine: PROFILO, contextWindow: 1000000 }],
    engines: [engineCon('qwen9-nuovo')],
  }));
  assert.ok(out, 'la configurazione deve essere accettata');
  assert.equal(out.engines[0].managed.model, 'qwen9-nuovo');
});

test('lo stesso id SENZA dichiarazione resta rifiutato', () => {
  // E' la protezione che non va persa: senza, un errore di battitura
  // diventerebbe una cella che non parte per una ragione invisibile.
  assert.equal(parseDefinitions(defs({ engines: [engineCon('qwen9-nuovo')] })), null);
});

test('i modelli sono PERSISTITI accanto agli engine', () => {
  // Requisito esplicito: una volta salvati devono restare, ed essere esportati
  // insieme agli engine — quindi vivono nella stessa struttura, non a lato.
  const out = parseDefinitions(defs({
    models: [{ id: 'm1', engine: PROFILO }],
    engines: [engineCon('m1')],
  }));
  assert.deepEqual(out.models, [{ id: 'm1', engine: PROFILO }]);
  // Il giro completo scrittura -> rilettura non perde nulla.
  const riletto = parseDefinitions(JSON.stringify(out));
  assert.deepEqual(riletto.models, out.models);
  assert.deepEqual(riletto.engines, out.engines);
});

test('la dichiarazione vale per UN profilo, non per il fornitore', () => {
  // Gli elenchi di Alibaba per Claude e per Codex differiscono davvero:
  // generalizzare creerebbe combinazioni che non esistono.
  const out = parseDefinitions(defs({
    models: [{ id: 'solo-per-claude', engine: PROFILO }],
    engines: [{
      id: 'e2', label: 'E2',
      managed: { client: 'codex-vl', provider: 'alibaba-token-plan', model: 'solo-per-claude', permissionPolicy: 'standard' },
    }],
  }));
  assert.equal(out, null, 'un altro client dello stesso fornitore non eredita la dichiarazione');
});

test('i dati del modello sono opzionali ma validati', () => {
  const ok = parseDefinitions(defs({
    models: [{ id: 'm1', engine: PROFILO, label: 'Nuovo', contextWindow: 262144, maxTokens: 32768, reasoning: true }],
  }));
  assert.equal(ok.models[0].contextWindow, 262144);
  assert.equal(ok.models[0].reasoning, true);
  // Una finestra fuori scala e' quasi sempre un errore di battitura, e
  // passerebbe fino al client come comportamento inspiegabile.
  assert.equal(parseDefinitions(defs({ models: [{ id: 'm1', engine: PROFILO, contextWindow: 12 }] })), null);
  assert.equal(parseDefinitions(defs({ models: [{ id: 'm1', engine: PROFILO, reasoning: 'si' }] })), null);
});

test('schema chiuso: un campo inatteso non entra in silenzio', () => {
  assert.equal(parseDefinitions(defs({ models: [{ id: 'm1', engine: PROFILO, prezzo: 3 }] })), null);
  assert.equal(parseDefinitions(defs({ models: [{ engine: PROFILO }] })), null);
  assert.equal(parseDefinitions(defs({ models: [{ id: 'm1' }] })), null);
  assert.equal(parseDefinitions(defs({ models: [{ id: 'con\x00nullo', engine: PROFILO }] })), null);
});

test('lo stesso id due volte per lo stesso profilo e\' un errore, non un duplicato silenzioso', () => {
  assert.equal(parseDefinitions(defs({
    models: [{ id: 'm1', engine: PROFILO }, { id: 'm1', engine: PROFILO, contextWindow: 2048 }],
  })), null);
  // Lo stesso id per DUE profili diversi e' invece legittimo.
  assert.ok(parseDefinitions(defs({
    models: [{ id: 'm1', engine: PROFILO }, { id: 'm1', engine: 'codex-vl.alibaba-token-plan' }],
  })));
});

test('`models` non e\' un array: si rifiuta invece di indovinare', () => {
  assert.equal(parseDefinitions(defs({ models: {} })), null);
  assert.equal(parseDefinitions(defs({ models: 'qwen' })), null);
});

test('tools e vision sono booleani tipizzati, e `false` e\' una risposta', () => {
  // `false` non e' un'assenza: e' la parola esplicita dell'operatore, e deve
  // sopravvivere al giro scrittura -> rilettura senza diventare «assente».
  const out = parseDefinitions(defs({
    models: [{ id: 'm1', engine: PROFILO, tools: false, vision: true }],
  }));
  assert.deepEqual(out.models[0], { id: 'm1', engine: PROFILO, tools: false, vision: true });
  // Il tipo e' chiuso: una stringa o un numero non sono un booleano.
  assert.equal(parseDefinitions(defs({ models: [{ id: 'm1', engine: PROFILO, tools: 'no' }] })), null);
  assert.equal(parseDefinitions(defs({ models: [{ id: 'm1', engine: PROFILO, vision: 1 }] })), null);
  // Assente resta assente: nessun valore inventato dal parser.
  const absent = parseDefinitions(defs({ models: [{ id: 'm1', engine: PROFILO }] }));
  assert.ok(!Object.hasOwn(absent.models[0], 'tools'));
  assert.ok(!Object.hasOwn(absent.models[0], 'vision'));
});
