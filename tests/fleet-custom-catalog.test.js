'use strict';

// D2 (audit del pacchetto, bocciatura fetta D): la versione precedente di
// questo test costruiva `spec.models` A MANO e chiamava customCatalogFor
// direttamente — verde su un percorso che in produzione non esiste mai. Lo
// spec che resolveManagedEngine passa a customCatalogFor viene SEMPRE da
// normalizeManagedSpec, che non ha mai portato `models` (non e' fra i
// MANAGED_KEYS: i descrittori sono proprieta' della definizione dell'ENGINE,
// non del profilo managed della cella — due soggetti diversi). Il test era
// verde, la feature non funzionava mai.
//
// Questi test ATTRAVERSANO il percorso vero: parseDefinitions -> extraModelsFrom
// -> resolveManagedEngine -> il catalogo/finestra di contesto negli argv reali.
// Le fixture sono l'OUTPUT di parseDefinitions su una definizione come la
// scriverebbe un operatore, mai un oggetto scritto a mano che imiti la forma
// interna: una fixture a mano nasconderebbe proprio il disallineamento che
// questo test deve rilevare.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseDefinitions } = require('../lib/fleet/definitions.js');
const {
  extraModelsFrom, declaredModelsFor, resolveManagedEngine, customCatalogFor, describeManaged,
} = require('../lib/fleet/managed.js');
const { requirePiComposer, loadPiExtensionFile } = require('./helpers/pi-real-consumer.js');

// Insiemi ammessi dallo schema codex-vl (stessi di fleet-catalog-schema).
const APPLY_PATCH = new Set([null, 'freeform']);
const WEB_SEARCH = new Set(['text', 'text_and_image']);
const EFFORT = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

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

// Una definizione COME LA SCRIVEREBBE UN OPERATORE: `d.models` porta il
// descrittore completo per l'engine `codex-vl.custom`; l'engine sceglie
// providerId/baseUrl/envKey per il SUO endpoint custom, e il modello che
// seleziona (deepseek-v4-pro) e' esattamente quello descritto.
function codexVlCustomDefs() {
  return parseDefinitions({
    schemaVersion: 1,
    models: [
      { id: 'deepseek-v4-pro', engine: 'codex-vl.custom', contextWindow: 1000000, maxTokens: 384000, reasoning: true },
      { id: 'deepseek-v4-flash', engine: 'codex-vl.custom', contextWindow: 128000, maxTokens: 32000, reasoning: false },
    ],
    engines: [{
      id: 'my-deepseek', label: 'My Deepseek', managed: {
        client: 'codex-vl', provider: 'custom', providerId: 'deepseek',
        displayName: 'Deepseek', baseUrl: 'https://api.deepseek.example/v1',
        envKey: 'DEEPSEEK_API_KEY', model: 'deepseek-v4-pro',
      },
    }],
    cells: [],
  });
}

test('D2 end-to-end: parseDefinitions -> extraModelsFrom -> resolveManagedEngine, la finestra di contesto arriva in fondo agli argv', () => {
  const defs = codexVlCustomDefs();
  assert.ok(defs, 'la definizione e\' valida (controllo del setup, non del difetto)');
  const extraModels = extraModelsFrom(defs);
  const home = withBinary(tempHome('nc-d2-e2e-'), 'codex-vl');
  try {
    const r = resolveManagedEngine(defs.engines[0], { id: 'Dev' },
      { home, env: { DEEPSEEK_API_KEY: 'secret' }, extraModels });
    assert.equal(r.ok, true, r.ok ? '' : r.reason);
    const argv = r.engine.args.join('\n');
    // Il descrittore selezionato (deepseek-v4-pro, 1M) deve arrivare, non il
    // fallback conservativo (272K) che il difetto D2 lasciava sempre attivo.
    assert.match(argv, /model_context_window=1000000/,
      'la finestra di contesto del modello dichiarato arriva agli argv reali');
    const catalogArg = r.engine.args.find((a) => a.startsWith('model_catalog_json='));
    assert.ok(catalogArg, 'model_catalog_json e\' negli argv');
    const catalogPath = JSON.parse(catalogArg.slice('model_catalog_json='.length));
    const models = JSON.parse(fs.readFileSync(catalogPath, 'utf8')).models;
    // ENTRAMBI i descrittori dichiarati finiscono nel catalogo (come per gli
    // altri provider gestiti: il catalogo copre le opzioni, non solo la scelta).
    assert.deepEqual(models.map((m) => m.slug).sort(), ['deepseek-v4-flash', 'deepseek-v4-pro']);
    for (const m of models) {
      assert.ok(APPLY_PATCH.has(m.apply_patch_tool_type), `${m.slug}: apply_patch_tool_type ammesso`);
      assert.ok(WEB_SEARCH.has(m.web_search_tool_type), `${m.slug}: web_search_tool_type ammesso`);
      assert.ok(EFFORT.has(m.default_reasoning_level), `${m.slug}: default_reasoning_level ammesso`);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// D2 (correzione dopo revisione): il consumatore vero di questo file non
// e' il test — e' Pi. Il test precedente leggeva solo il file .ts generato e
// restava verde su un'estensione che Pi 0.80.10 rifiuta a runtime, perche' i
// descrittori grezzi (id/engine/contextWindow/maxTokens/reasoning) non hanno
// i campi che il contratto di Pi richiede (name/input/cost — misurato:
// `model.input.includes("image")` in core/tools/read.js lancia TypeError su
// input undefined). Questo test attraversa OGNI stadio reale: genera la
// definizione, produce il file .ts, lo ESEGUE con Node (import dinamico nativo
// di file .ts), cattura la config con cui Pi chiamerebbe registerProvider,
// la passa a composeModelProvider REALE (il pacchetto Pi installato sulla
// macchina, non una copia), e verifica sul modello che Pi produce la stessa
// operazione che il suo consumatore (read.js) esegue davvero.
test('D2 end-to-end: Pi custom — Pi VERO carica l\'estensione e il modello supera il consumo reale (read.js)', async (t) => {
  // requirePiComposer distingue "Pi non installato" (skip legittimo, motivato)
  // da "Pi c'e' ma la guardia non riesce a caricarlo" (throw: il test FALLISCE,
  // mai un pass/skip silenzioso su una guardia rotta).
  const composer = await requirePiComposer(t);
  if (!composer) return; // skip legittimo gia' registrato da requirePiComposer
  const defs = parseDefinitions({
    schemaVersion: 1,
    models: [{ id: 'deepseek-v4-pro', engine: 'pi.custom', contextWindow: 500000, maxTokens: 100000, reasoning: false }],
    engines: [{
      id: 'my-pi', label: 'My Pi', managed: {
        client: 'pi', provider: 'custom', providerId: 'deepseek', protocol: 'openai-completions',
        displayName: 'Deepseek', baseUrl: 'https://api.deepseek.example/v1',
        envKey: 'DEEPSEEK_API_KEY', model: 'deepseek-v4-pro',
      },
    }],
    cells: [],
  });
  assert.ok(defs);
  const extraModels = extraModelsFrom(defs);
  const home = withBinary(tempHome('nc-d2-pi-'), 'pi');
  try {
    const r = resolveManagedEngine(defs.engines[0], { id: 'Dev' },
      { home, env: { DEEPSEEK_API_KEY: 'secret' }, extraModels });
    assert.equal(r.ok, true, r.ok ? '' : r.reason);
    const extIdx = r.engine.args.indexOf('--extension');
    assert.ok(extIdx >= 0, '--extension negli argv');
    const tsPath = r.engine.args[extIdx + 1];
    // Stadio 1: il file .ts generato viene ESEGUITO (non solo letto) — cattura
    // la config con cui NexusCrew chiamerebbe pi.registerProvider davvero.
    const registered = await loadPiExtensionFile(tsPath);
    assert.ok(registered, 'il file .ts esegue e chiama registerProvider');
    assert.equal(registered.id, 'deepseek');
    // Stadio 2: quella config viene composta da Pi REALE (composeModelProvider,
    // la stessa funzione che il runtime di Pi chiama quando avvia il provider).
    const provider = composer.composeModelProvider('deepseek', undefined, { getProvider: () => undefined }, registered.config);
    const models = provider.getModels(); // getModels() e' gia' EAGER-validated da Pi stesso
    const model = models.find((m) => m.id === 'deepseek-v4-pro');
    assert.ok(model, 'il modello dichiarato e\' nel catalogo che Pi produce');
    assert.equal(model.contextWindow, 500000, 'il descrittore dichiarato arriva, non il fallback 128000');
    // Stadio 3: il consumo REALE che core/tools/read.js fa sul modello
    // selezionato (getNonVisionImageNote: `model.input.includes("image")`).
    // Senza il fix questa riga lancia TypeError — qui non deve.
    assert.doesNotThrow(() => model.input.includes('image'),
      'il consumo reale di Pi (read.js) non deve piu\' lanciare su input mancante');
    assert.equal(model.input.includes('image'), false);
    // Il resto del contratto documentato (ProviderModelConfig), tutto presente.
    assert.equal(typeof model.name, 'string');
    assert.ok(model.name.length > 0);
    assert.equal(typeof model.reasoning, 'boolean');
    assert.equal(typeof model.cost, 'object');
    for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) assert.equal(typeof model.cost[k], 'number');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('D2 end-to-end negativo: nessun `models` dichiarato -> nessun catalogo negli argv (comportamento invariato, no regressione)', () => {
  const defs = parseDefinitions({
    schemaVersion: 1,
    engines: [{
      id: 'my-deepseek', label: 'My Deepseek', managed: {
        client: 'codex-vl', provider: 'custom', providerId: 'deepseek',
        displayName: 'Deepseek', baseUrl: 'https://api.deepseek.example/v1',
        envKey: 'DEEPSEEK_API_KEY', model: 'deepseek-v4-pro',
      },
    }],
    cells: [],
  });
  assert.ok(defs);
  const extraModels = extraModelsFrom(defs);
  const home = withBinary(tempHome('nc-d2-none-'), 'codex-vl');
  try {
    const r = resolveManagedEngine(defs.engines[0], { id: 'Dev' },
      { home, env: { DEEPSEEK_API_KEY: 'secret' }, extraModels });
    assert.equal(r.ok, true, r.ok ? '' : r.reason);
    const argv = r.engine.args.join('\n');
    assert.doesNotMatch(argv, /model_catalog_json=/, 'nessun models dichiarato -> nessun catalogo (invariato)');
    assert.doesNotMatch(argv, /model_context_window=/, 'nessun models dichiarato -> nessuna context window custom (invariato)');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// --- Il fallimento oscuro reso parlante -------------------------------------

test('D2: `models` nel PROFILO managed (non nella definizione engine) e\' rifiutato, e il messaggio dice dove i descrittori vanno davvero', () => {
  // Il rifiuto STRUTTURALE resta (i descrittori sono dell'ENGINE, non della
  // cella): questo test lo conferma, non lo aggira. Verifica solo che il
  // messaggio, oggi generico ("invalid managed profile"), dica la causa.
  const raw = {
    client: 'codex-vl', provider: 'custom', providerId: 'x', displayName: 'D',
    baseUrl: 'https://x.example/v1', envKey: 'X_KEY', model: 'm',
    models: [{ id: 'm', engine: 'x' }], // <- qui, nel profilo: NON ammesso
  };
  const info = describeManaged(raw, { home: '/tmp' });
  assert.equal(info.configured, false, 'il rifiuto resta: models non appartiene al profilo managed');
  assert.match(info.reason, /models.*non.*profilo managed/i);
  assert.match(info.reason, /definizione dell.?ENGINE|d\.models|array.*models/i,
    'il messaggio dice DOVE i descrittori vanno davvero, non solo che sono rifiutati');
  // E lo stesso, attraverso parseDefinitions (il percorso reale di
  // salvataggio): l'intero documento e' rifiutato se un engine porta `models`
  // nel proprio managed — il rifiuto strutturale e' verificato qui una volta
  // per tutte, cosi' non lo si riscopre per caso in un altro test.
  const defs = parseDefinitions({
    schemaVersion: 1,
    engines: [{ id: 'x', label: 'X', managed: raw }],
    cells: [],
  });
  assert.equal(defs, null, 'parseDefinitions rifiuta un engine con models nel profilo managed');
});

// --- declaredModelsFor / extraModelsFrom: la struttura che porta il ponte --

test('D2: declaredModelsFor ricava i descrittori COMPLETI (non solo gli id) dall\'output reale di parseDefinitions', () => {
  const defs = codexVlCustomDefs();
  const extraModels = extraModelsFrom(defs);
  // Chi ha bisogno solo degli id li ricava dalle CHIAVI (stesso .has() di
  // prima): nessun consumatore esistente (declaredFor) e' toccato da questo.
  assert.ok(extraModels.get('codex-vl.custom').has('deepseek-v4-pro'));
  const declared = declaredModelsFor(extraModels, 'codex-vl.custom');
  assert.equal(declared.length, 2);
  const pro = declared.find((m) => m.id === 'deepseek-v4-pro');
  assert.equal(pro.contextWindow, 1000000, 'il descrittore COMPLETO (non solo l\'id) sopravvive');
  assert.equal(pro.maxTokens, 384000);
  assert.equal(pro.reasoning, true);
});

test('D2: declaredModelsFor su un profilo non dichiarato -> array vuoto (mai throw, mai regressione)', () => {
  const defs = codexVlCustomDefs();
  const extraModels = extraModelsFrom(defs);
  assert.deepEqual(declaredModelsFor(extraModels, 'pi.custom'), []);
  assert.deepEqual(declaredModelsFor(null, 'codex-vl.custom'), []);
  assert.deepEqual(declaredModelsFor(new Map(), 'codex-vl.custom'), []);
});

// --- customCatalogFor: unita', con descrittori dall'output vero -----------

test('customCatalogFor: senza descrittori -> null (comportamento invariato)', () => {
  const h = tempHome('nc-custom-cat-');
  assert.equal(customCatalogFor({ providerId: 'x' }, 'm', [], h), null);
  assert.equal(customCatalogFor({ providerId: 'x' }, 'm', null, h), null);
  // Nessun descrittore dichiarato: il ramo "vuoto" ritorna null PRIMA di
  // leggere spec (che in produzione non e' mai null quando ci sono
  // descrittori — resolveManagedEngine passa sempre uno spec valido).
  assert.equal(customCatalogFor(null, 'm', [], h), null);
});

test('customCatalogFor: con descrittori (dall\'output reale) -> catalog valido, context_window dal descrittore selezionato', () => {
  const defs = codexVlCustomDefs();
  const declared = declaredModelsFor(extraModelsFrom(defs), 'codex-vl.custom');
  const h = tempHome('nc-custom-cat-');
  const res = customCatalogFor({ providerId: 'deepseek' }, 'deepseek-v4-pro', declared, h);
  assert.ok(res, 'deve ritornare metadati quando ci sono descrittori dichiarati');
  assert.equal(res.contextWindow, 1000000, 'context_window dal descrittore del modello selezionato (non fallback 272K)');
  assert.ok(fs.existsSync(res.catalogPath), 'catalog scritto su disco');
  const cat = JSON.parse(fs.readFileSync(res.catalogPath, 'utf8'));
  assert.equal(cat.models.length, 2);
  const pro = cat.models.find((m) => m.slug === 'deepseek-v4-pro');
  assert.deepEqual(pro.supported_reasoning_levels.map((l) => l.effort), ['low', 'high', 'max']);
  assert.equal(pro.context_window, 1000000);
});

test('customCatalogFor: model selezionato non in lista -> fallback al primo descrittore (non null)', () => {
  const h = tempHome('nc-custom-cat-');
  const res = customCatalogFor({ providerId: 'deepseek' }, 'nonexistent', [{ id: 'a', engine: 'e', contextWindow: 200000 }], h);
  assert.ok(res, 'con descrittori dichiarati non ritorna null anche se il model non matcha');
  assert.equal(res.contextWindow, 200000, 'fallback al primo descrittore');
});
