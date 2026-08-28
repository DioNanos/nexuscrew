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


// ---------------------------------------------------------------------------
// D9 — GUARDIA inter-liste (2026-08-27). Un id dichiarato in una lista e
// assente dalla lista sorella e' la classe di guasto osservata per mesi:
// glm-5.3-flash era usato da celle vive senza voce in OLLAMA_CONTEXT — il
// launch ricadeva sul fallback 200000 IN SILENZIO. Il test prova il FENOMENO:
// elenca gli id fuori posto nominando ENTRAMBE le liste; rimuovere un id da
// UNA sola lista deve rendere il test rosso indicando quale.
const {
  OLLAMA_CLOUD_MODELS, OLLAMA_CONTEXT, OLLAMA_MODEL_CAPABILITIES,
  OPENCODE_GO_MESSAGES_MODELS, OPENCODE_GO_RESPONSES_MODELS, OPENCODE_GO_CHAT_MODELS,
  ALIBABA_TOKEN_PLAN_MODELS, ALIBABA_PI_MODELS,
} = require('../lib/fleet/managed.js');

test("D9a: OLLAMA_CLOUD_MODELS e OLLAMA_CONTEXT coprono gli stessi id, in entrambe le direzioni", () => {
  const inCtx = new Set(Object.keys(OLLAMA_CONTEXT));
  const problems = [
    ...OLLAMA_CLOUD_MODELS.filter((m) => !inCtx.has(m))
      .map((m) => `"${m}" e' in OLLAMA_CLOUD_MODELS ma NON in OLLAMA_CONTEXT (launch con finestra fallback 200000 silenziosa)`),
    ...Object.keys(OLLAMA_CONTEXT).filter((m) => !OLLAMA_CLOUD_MODELS.includes(m))
      .map((m) => `"${m}" e' in OLLAMA_CONTEXT ma NON in OLLAMA_CLOUD_MODELS (voce orfana)`),
  ];
  assert.deepEqual(problems, [], `divergenza OLLAMA_CLOUD_MODELS <-> OLLAMA_CONTEXT:\n  ${problems.join('\n  ')}`);
});

test("D9b: ogni id offerto su una wire OpenCode Go ha i suoi limiti, e LIMITS non ha voci morte", () => {
  // Le tre liste wire DIVERGONO legittimamente (grok risponde solo su
  // Responses: misurato). L'invariante vera e' sull'UNIONE delle wire.
  const limits = new Set(Object.keys(OPENCODE_GO_LIMITS));
  const union = new Set([
    ...OPENCODE_GO_MESSAGES_MODELS,
    ...OPENCODE_GO_RESPONSES_MODELS,
    ...OPENCODE_GO_CHAT_MODELS,
  ]);
  const problems = [
    ...[...union.difference(limits)].map((id) => `"${id}" e' offerto su una wire OpenCode Go ma NON e' in OPENCODE_GO_LIMITS (contesto omesso, il client ricade sul default suo)`),
    ...[...limits.difference(union)].map((id) => `"${id}" e' in OPENCODE_GO_LIMITS ma non e' offerto su nessuna wire (voce morta)`),
  ];
  assert.deepEqual(problems, [], `divergenza wire-union <-> OPENCODE_GO_LIMITS:\n  ${problems.join('\n  ')}`);
});

test("D9c: i descrittori ALIBABA_PI_MODELS coprono esattamente ALIBABA_TOKEN_PLAN_MODELS", () => {
  const plan = new Set(ALIBABA_TOKEN_PLAN_MODELS);
  const pi = new Set(ALIBABA_PI_MODELS.map((m) => m.id));
  const problems = [
    ...ALIBABA_TOKEN_PLAN_MODELS.filter((m) => !pi.has(m))
      .map((m) => `"${m}" e' in ALIBABA_TOKEN_PLAN_MODELS ma non ha descrittore in ALIBABA_PI_MODELS`),
    ...[...pi].filter((m) => !plan.has(m))
      .map((m) => `"${m}" ha descrittore PI ma non e' in ALIBABA_TOKEN_PLAN_MODELS`),
  ];
  assert.deepEqual(problems, [], `divergenza ALIBABA_TOKEN_PLAN_MODELS <-> ALIBABA_PI_MODELS:\n  ${problems.join('\n  ')}`);
});

test('D9d: le capacita dichiarate riguardano solo modelli effettivamente in lista', () => {
  const inList = new Set(OLLAMA_CLOUD_MODELS);
  const problems = Object.keys(OLLAMA_MODEL_CAPABILITIES)
    .filter((m) => !inList.has(m))
    .map((m) => `"${m}" ha capacita in OLLAMA_MODEL_CAPABILITIES ma non e in OLLAMA_CLOUD_MODELS`);
  assert.deepEqual(problems, [], problems.join('; '));
});
