'use strict';

// `extraModels` e' indicizzata per ENGINE ID, ma `declaredFor` e
// `declaredModelsFor` cercavano con la chiave del PROFILO (`profile.id`, per i
// custom la condivisa `codex-vl.custom`): un engine custom che dichiara i
// PROPRI modelli non li vedeva mai — il catalogo generato conteneva i modelli
// di un altro engine (o niente), e il modello legittimo dell'engine veniva
// rifiutato dal gate strictModels. Fix: prima la chiave dell'engine, poi il
// fallback sul profilo (unione deduplicata).
//
// Il test rosso/verde e' il test 1: con il codice vecchio la stessa chiamata a
// quattro argomenti ritorna false (il quarto argomento veniva ignorato), con
// il fix ritorna true. Il test end-to-end attraversa il percorso reale
// parseDefinitions -> extraModelsFrom -> resolveManagedEngine -> argv.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseDefinitions } = require('../lib/fleet/definitions.js');
const { extraModelsFrom, declaredFor, declaredModelsFor, resolveManagedEngine } = require('../lib/fleet/managed.js');

function tempHome(prefix) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(h, 0o700);
  return h;
}

function withBinary(home, client) {
  const bin = path.join(home, '.local', 'bin', client);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return home;
}

// Due engine custom codex-vl con dichiarazioni DISTINTE: `x.zai-p` dichiara i
// propri modelli; il profilo condiviso `codex-vl.custom` ne dichiara altri.
// Con la chiave sbagliata (solo profilo) i due mondi si mescolavano.
function engineDeclaredDefs() {
  return parseDefinitions({
    schemaVersion: 1,
    models: [
      { id: 'modello-x', engine: 'x.zai-p', contextWindow: 777777, maxTokens: 32000, reasoning: true },
      { id: 'modello-x-flash', engine: 'x.zai-p', contextWindow: 256000, maxTokens: 16000, reasoning: false },
      { id: 'modello-profilo', engine: 'codex-vl.custom', contextWindow: 1000000, maxTokens: 384000, reasoning: true },
    ],
    engines: [
      {
        id: 'x.zai-p', label: 'X Zai P', managed: {
          client: 'codex-vl', provider: 'custom', providerId: 'zai_p_test',
          displayName: 'Zai P Test', baseUrl: 'https://api.x-zai-p.example/v1',
          envKey: 'X_ZAI_P_API_KEY', model: 'modello-x',
        },
      },
    ],
    cells: [],
  });
}

test('declaredFor uses the engine id before the profile fallback', () => {
  const defs = engineDeclaredDefs();
  assert.ok(defs, 'la definizione e\' valida (controllo del setup)');
  const em = extraModelsFrom(defs);
  // Fix: la chiave engine passa, con o senza fallback profilo.
  assert.equal(declaredFor(em, 'codex-vl.custom', 'modello-x', 'x.zai-p'), true,
    'il modello dichiarato per l\'engine si trova con la chiave engine');
  // Vecchio comportamento (solo chiave profilo): NON trova il modello
  // dell'engine — questo assert e' ROSSO sul codice precedente.
  assert.equal(declaredFor(em, 'codex-vl.custom', 'modello-x'), false,
    'senza la chiave engine la ricerca per solo profilo non vede il modello');
  // Il fallback profilo resta: una dichiarazione legacy sul profilo vale.
  assert.equal(declaredFor(em, 'codex-vl.custom', 'modello-profilo', 'x.zai-p'), true,
    'il modello dichiarato sul profilo passa anche quando si cerca per engine');
});

test('declaredModelsFor merges engine and profile models without duplicates', () => {
  const defs = engineDeclaredDefs();
  const em = extraModelsFrom(defs);
  const declared = declaredModelsFor(em, 'codex-vl.custom', 'x.zai-p');
  const ids = declared.map((m) => m.id);
  assert.deepEqual(ids, ['modello-x', 'modello-x-flash', 'modello-profilo'],
    'i modelli dell\'engine prima, poi il profilo; niente duplicati');
  // Sola chiave profilo (vecchio comportamento): solo il modello del profilo.
  assert.deepEqual(declaredModelsFor(em, 'codex-vl.custom').map((m) => m.id), ['modello-profilo']);
  // Stesso id dichiarato due volte (engine e profilo): una sola voce.
  em.get('codex-vl.custom').set('modello-x', { id: 'modello-x', contextWindow: 1 });
  const dedup = declaredModelsFor(em, 'codex-vl.custom', 'x.zai-p').map((m) => m.id);
  assert.equal(dedup.filter((id) => id === 'modello-x').length, 1, 'dedup per id');
});

test('end-to-end catalog uses engine models before the shared profile fallback', () => {
  const defs = engineDeclaredDefs();
  const extraModels = extraModelsFrom(defs);
  const home = withBinary(tempHome('nc-d145-e2e-'), 'codex-vl');
  try {
    const r = resolveManagedEngine(defs.engines[0], { id: 'Dev' },
      { home, env: { X_ZAI_P_API_KEY: 'secret' }, extraModels });
    assert.equal(r.ok, true, r.ok ? '' : r.reason);
    const argv = r.engine.args.join('\n');
    assert.match(argv, /model_context_window=777777/,
      'la finestra del modello dichiarato per l\'ENGINE arriva agli argv');
    const catalogArg = r.engine.args.find((a) => a.startsWith('model_catalog_json='));
    assert.ok(catalogArg, 'model_catalog_json e\' negli argv');
    const catalogPath = JSON.parse(catalogArg.slice('model_catalog_json='.length));
    const slugs = JSON.parse(fs.readFileSync(catalogPath, 'utf8')).models.map((m) => m.slug);
    // Unione senza duplicati: PRIMA i modelli dell'engine
    // (la dichiarazione specifica), poi il fallback del profilo condiviso —
    // il difetto era l'inverso: solo i modelli del profilo, mai quelli dell'engine.
    assert.deepEqual(slugs, ['modello-x', 'modello-x-flash', 'modello-profilo'],
      'i modelli dell\'engine aprono il catalogo; il profilo condiviso arriva come fallback');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
