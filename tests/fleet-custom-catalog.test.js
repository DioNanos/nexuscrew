'use strict';

// D2: il ramo custom ora onora `models` (definizione engine, già validato da
// parseModel) derivando model_catalog_json e model_context_window, come gli
// altri provider. Test di customCatalogFor:
//  - senza `models` -> null (comportamento invariato, NESSUNA regressione);
//  - con `models` -> catalog scritto su disco con enum validi per lo schema
//    codex-vl e context_window preso dal descrittore del modello selezionato.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { customCatalogFor } = require('../lib/fleet/managed.js');

// Insiemi ammessi dallo schema codex-vl (stessi di fleet-catalog-schema).
const APPLY_PATCH = new Set([null, 'freeform']);
const WEB_SEARCH = new Set(['text', 'text_and_image']);
const EFFORT = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-custom-cat-'));
  fs.chmodSync(h, 0o700);
  return h;
}

test('D2: senza models -> null (comportamento invariato, no regressione)', () => {
  const h = home();
  assert.equal(customCatalogFor({ providerId: 'x' }, 'm', h), null);
  assert.equal(customCatalogFor({ providerId: 'x', models: [] }, 'm', h), null);
  assert.equal(customCatalogFor(null, 'm', h), null);
});

test('D2: con models -> catalog valido, context_window dal descrittore selezionato', () => {
  const h = home();
  const spec = {
    providerId: 'deepseek',
    models: [
      { id: 'deepseek-v4-pro', engine: 'deepseek', contextWindow: 1000000, maxTokens: 384000, reasoning: true },
      { id: 'other', engine: 'deepseek', contextWindow: 128000, reasoning: false },
    ],
  };
  const res = customCatalogFor(spec, 'deepseek-v4-pro', h);
  assert.ok(res, 'deve ritornare metadati quando models è dichiarato');
  assert.equal(res.contextWindow, 1000000, 'context_window dal descrittore del modello selezionato (non fallback 272K)');
  assert.ok(fs.existsSync(res.catalogPath), 'catalog scritto su disco');
  const cat = JSON.parse(fs.readFileSync(res.catalogPath, 'utf8'));
  assert.equal(cat.models.length, 2);
  for (const m of cat.models) {
    assert.ok(APPLY_PATCH.has(m.apply_patch_tool_type), `${m.slug}: apply_patch_tool_type ammesso`);
    assert.ok(WEB_SEARCH.has(m.web_search_tool_type), `${m.slug}: web_search_tool_type ammesso`);
    assert.ok(EFFORT.has(m.default_reasoning_level), `${m.slug}: default_reasoning_level ammesso`);
    for (const l of m.supported_reasoning_levels) {
      assert.ok(EFFORT.has(l.effort), `${m.slug}: effort "${l.effort}" ammesso`);
    }
  }
  // reasoning true -> low/high/max; il modello selezionato ha context 1M.
  const pro = cat.models.find((m) => m.slug === 'deepseek-v4-pro');
  assert.deepEqual(pro.supported_reasoning_levels.map((l) => l.effort), ['low', 'high', 'max']);
  assert.equal(pro.context_window, 1000000);
});

test('D2: model selezionato non in lista -> fallback al primo descrittore (non null)', () => {
  const h = home();
  const spec = { providerId: 'deepseek', models: [{ id: 'a', engine: 'e', contextWindow: 200000 }] };
  const res = customCatalogFor(spec, 'nonexistent', h);
  assert.ok(res, 'con models dichiarato non ritorna null anche se il model non matcha');
  assert.equal(res.contextWindow, 200000, 'fallback al primo descrittore');
});
