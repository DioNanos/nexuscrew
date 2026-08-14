'use strict';

// D7 (metà 1 — build check): valida gli enum dei cataloghi che NexusCrew spedisce
// a Codex-VL contro lo schema Rust di codex-vl (codex-rs/protocol/src/openai_models.rs).
// JSON sintatticamente valido non implica accettato: un valore di enum non
// ammesso (es. apply_patch_tool_type: "custom", dove l'enum codex-vl ammette solo
// Freeform) fa uscire il client con `unknown variant` / exit 1, e la cella non
// parte sembrando un guasto della cella stessa. Questo test previene quella
// classe di guasto a build, per i cataloghi che spediamo NOI.
//
// D8 (valutazione → test di congruenza, NON refactor): lo stesso context_window
// è dichiarato due volte (OPENCODE_GO_LIMITS in managed.js e context_window nel
// catalog) senza un vincolo che le tenga allineate — due copie divergono sempre.
// Il rimedio economico è questo test: per ogni modello presente in entrambi,
// il context della mappa deve essere uguale al context_window del catalogo.
//
// SCOPO E LIMITE — dichiarati: la validazione enum è PARZIALE (insiemi hardcodati
// dallo schema codex-vl; la validazione completa richiede `codex-vl doctor` in
// CI). La fonte di verità per gli enum è codex-rs/protocol/src/openai_models.rs.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { OPENCODE_GO_LIMITS } = require('../lib/fleet/managed.js');

const CATALOG_DIR = path.join(__dirname, '..', 'lib', 'fleet', 'catalogs');

// Insiemi ammessi dallo schema codex-vl (codex-rs/protocol/src/openai_models.rs):
//   #[serde(rename_all = "snake_case")] pub enum ApplyPatchToolType { Freeform }
//   #[serde(rename_all = "snake_case")] pub enum WebSearchToolType { Text, TextAndImage }
//   pub enum ReasoningEffort { None, Minimal, Low, Medium, High, XHigh, Max, Ultra }  // lowercase
const APPLY_PATCH_TOOL_TYPES = new Set([null, 'freeform']);
const WEB_SEARCH_TOOL_TYPES = new Set(['text', 'text_and_image']);
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

// Logica di validazione di UN modello (estratta: il test negativo la richiama
// invece di duplicarla inline — pinna la logica reale, non una sua copia).
// Ritorna l'array (vuoto se OK) dei failure descritti come stringa.
function validateCatalogModel(m) {
  const failures = [];
  if (m.apply_patch_tool_type !== undefined && !APPLY_PATCH_TOOL_TYPES.has(m.apply_patch_tool_type)) {
    failures.push(`apply_patch_tool_type=${JSON.stringify(m.apply_patch_tool_type)}`);
  }
  if (m.web_search_tool_type !== undefined && !WEB_SEARCH_TOOL_TYPES.has(m.web_search_tool_type)) {
    failures.push(`web_search_tool_type=${JSON.stringify(m.web_search_tool_type)}`);
  }
  if (m.default_reasoning_level !== undefined && !REASONING_EFFORTS.has(m.default_reasoning_level)) {
    failures.push(`default_reasoning_level=${JSON.stringify(m.default_reasoning_level)}`);
  }
  if (Array.isArray(m.supported_reasoning_levels)) {
    for (const lvl of m.supported_reasoning_levels) {
      if (!lvl || typeof lvl.effort !== 'string' || !REASONING_EFFORTS.has(lvl.effort)) {
        failures.push(`supported_reasoning_levels effort=${JSON.stringify(lvl && lvl.effort)}`);
      }
    }
  }
  return failures;
}

function loadCatalogs() {
  return fs.readdirSync(CATALOG_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ name: f, data: JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, f), 'utf8')) }));
}

test('ogni catalogo spedito ha modelli con enum validi per lo schema codex-vl', () => {
  const catalogs = loadCatalogs();
  assert.ok(catalogs.length, 'nessun catalogo trovato in lib/fleet/catalogs');
  const failures = [];
  for (const cat of catalogs) {
    assert.ok(Array.isArray(cat.data.models) && cat.data.models.length, `${cat.name}: manca models[]`);
    for (const m of cat.data.models) {
      for (const f of validateCatalogModel(m)) failures.push(`${cat.name}/${m.slug || '?'}: ${f} (ammessi: ${f.startsWith('apply_patch') ? 'null|freeform' : f.startsWith('web_search') ? 'text|text_and_image' : 'enum effort'})`);
    }
  }
  assert.deepEqual(failures, [], `enum catalog invalidi per lo schema codex-vl:\n  ${failures.join('\n  ')}`);
});

// D7 negative smoke: il caso D7 (apply_patch_tool_type: "custom") DEVE essere
// rifiutato. Richiama validateCatalogModel (la logica reale del test sopra),
// non una sua copia inline: se qualcuno indebolisce la validazione, questo e
// quello sopra falliscono insieme.
test('D7 negative: apply_patch_tool_type="custom" rifiutato dal validatore reale', () => {
  const bad = { slug: 'evil', apply_patch_tool_type: 'custom', supported_reasoning_levels: [{ effort: 'custom-too' }] };
  const failures = validateCatalogModel(bad);
  assert.ok(failures.length >= 2, `il validatore deve marcare apply_patch "custom" e effort "custom-too" (trovati: ${failures.join(', ')})`);
  assert.ok(failures.some((f) => f.includes('apply_patch_tool_type')), 'deve segnalare apply_patch_tool_type="custom"');
});

// D8: per ogni modello presente sia in OPENCODE_GO_LIMITS (managed.js) sia nel
// catalog opencode-go, il context della mappa deve essere uguale al
// context_window del catalogo. Due copie dello stesso valore non possono divergere.
test('D8: context concorda tra OPENCODE_GO_LIMITS e catalog opencode-go', () => {
  const cat = JSON.parse(fs.readFileSync(path.join(CATALOG_DIR, 'opencode-go.json'), 'utf8'));
  const bySlug = new Map(cat.models.map((m) => [m.slug, m]));
  const mismatches = [];
  for (const [model, info] of Object.entries(OPENCODE_GO_LIMITS)) {
    const c = bySlug.get(model);
    if (c && c.context_window !== info.context) {
      mismatches.push(`${model}: OPENCODE_GO_LIMITS.context=${info.context} vs catalog context_window=${c.context_window}`);
    }
  }
  assert.deepEqual(mismatches, [], `context window divergente tra OPENCODE_GO_LIMITS e catalog (due copie dello stesso valore):\n  ${mismatches.join('\n  ')}`);
});
