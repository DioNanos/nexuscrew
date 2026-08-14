'use strict';

// D7 (metà 1 — build check): valida gli enum dei cataloghi che NexusCrew spedisce
// a Codex-VL contro lo schema Rust di codex-vl (codex-rs/protocol/src/openai_models.rs).
// JSON sintatticamente valido non implica accettato: un valore di enum non
// ammesso (es. apply_patch_tool_type: "custom", dove l'enum codex-vl ammette solo
// Freeform) fa uscire il client con `unknown variant` / exit 1, e la cella non
// parte sembrando un guasto della cella stessa. Questo test previene quella
// classe di guasto a build, per i cataloghi che spediamo NOI.
//
// SCOPO E LIMITE — dichiarati: questa e' una validazione PARZIALE. Gli insiemi
// ammessi sono hardcodati dallo schema codex-vl e coprono gli enum piu' probabili
// di errore (apply_patch_tool_type, web_search_tool_type, reasoning effort). Non
// cattura altri vincoli schema (tipi, campi obbligatori, range). La validazione
// COMPLETA — quella che il doc D7 indica come ideale — e' far parsare ogni
// catalogo dal client stesso (`codex-vl -c model_catalog_json=<path> doctor`) in
// CI e fallire la build sul rifiuto. Questo test e' il sottoinsieme eseguibile
// senza il binario codex-vl; va affiancato dal doctor in CI quando disponibile.
//
// Se codex-vl evolve gli enum, questi insiemi vanno aggiornati di conseguenza:
// la fonte di verita' e' codex-rs/protocol/src/openai_models.rs, non questo file.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CATALOG_DIR = path.join(__dirname, '..', 'lib', 'fleet', 'catalogs');

// Insiemi ammessi dallo schema codex-vl (codex-rs/protocol/src/openai_models.rs):
//   #[serde(rename_all = "snake_case")] pub enum ApplyPatchToolType { Freeform }
//   #[serde(rename_all = "snake_case")] pub enum WebSearchToolType { Text, TextAndImage }
//   pub enum ReasoningEffort { None, Minimal, Low, Medium, High, XHigh, Max, Ultra }  // lowercase
const APPLY_PATCH_TOOL_TYPES = new Set([null, 'freeform']);
const WEB_SEARCH_TOOL_TYPES = new Set(['text', 'text_and_image']);
const REASONING_EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

function loadCatalogs() {
  return fs.readdirSync(CATALOG_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const p = path.join(CATALOG_DIR, f);
      return { name: f, data: JSON.parse(fs.readFileSync(p, 'utf8')) };
    });
}

test('ogni catalogo spedito ha modelli con enum validi per lo schema codex-vl', () => {
  const catalogs = loadCatalogs();
  assert.ok(catalogs.length, 'nessun catalogo trovato in lib/fleet/catalogs');
  const failures = [];
  for (const cat of catalogs) {
    assert.ok(Array.isArray(cat.data.models) && cat.data.models.length, `${cat.name}: manca models[]`);
    for (const m of cat.data.models) {
      const where = `${cat.name}/${m.slug || '?'}`;
      if (m.apply_patch_tool_type !== undefined && !APPLY_PATCH_TOOL_TYPES.has(m.apply_patch_tool_type)) {
        failures.push(`${where}: apply_patch_tool_type=${JSON.stringify(m.apply_patch_tool_type)} (ammessi: null|freeform)`);
      }
      if (m.web_search_tool_type !== undefined && !WEB_SEARCH_TOOL_TYPES.has(m.web_search_tool_type)) {
        failures.push(`${where}: web_search_tool_type=${JSON.stringify(m.web_search_tool_type)} (ammessi: text|text_and_image)`);
      }
      if (m.default_reasoning_level !== undefined && !REASONING_EFFORTS.has(m.default_reasoning_level)) {
        failures.push(`${where}: default_reasoning_level=${JSON.stringify(m.default_reasoning_level)}`);
      }
      if (Array.isArray(m.supported_reasoning_levels)) {
        for (const lvl of m.supported_reasoning_levels) {
          if (!lvl || typeof lvl.effort !== 'string' || !REASONING_EFFORTS.has(lvl.effort)) {
            failures.push(`${where}: supported_reasoning_levels effort=${JSON.stringify(lvl && lvl.effort)}`);
          }
        }
      }
    }
  }
  assert.deepEqual(failures, [], `enum catalog invalidi per lo schema codex-vl:\n  ${failures.join('\n  ')}`);
});

// Negative smoke: il caso D7 (apply_patch_tool_type: "custom") DEVE essere
// rifiutato. Pinna il gate: se qualcuno indebolisce la validazione (es. accetta
// qualsiasi stringa), questo fallisce.
test('D7 negative: apply_patch_tool_type="custom" (enum ammette solo Freeform) viene rifiutato', () => {
  const badValue = 'custom';
  assert.ok(!APPLY_PATCH_TOOL_TYPES.has(badValue), 'la validazione deve rifiutare apply_patch_tool_type="custom"');
  // E il caso reale: parse di un catalogo sintatticamente valido ma con enum
  // invalido deve produrre un failure (non passare silenziosamente).
  const bad = { models: [{ slug: 'evil', apply_patch_tool_type: badValue, supported_reasoning_levels: [{ effort: 'custom-too' }] }] };
  const rejects = bad.models.some((m) => !APPLY_PATCH_TOOL_TYPES.has(m.apply_patch_tool_type)
    || m.supported_reasoning_levels.some((l) => !REASONING_EFFORTS.has(l.effort)));
  assert.ok(rejects, 'il validatore deve marcare il catalogo malformato come non accettabile');
});
