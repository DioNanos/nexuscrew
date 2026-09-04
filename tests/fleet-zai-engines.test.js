'use strict';

// Engines codex-vl.zai-a / codex-vl.zai-p use the native Responses wire for
// Z.AI su https://api.z.ai/api/v1 (niente AnthMorph). Gli argv generati devono
// portare base_url/env_key/wire_api corretti, il catalogo con i metadata reali
// del server e la finestra di contesto misurata (1M). I valori attesi vengono
// dalla misura su /api/v1 (catalogo Codex-style, 2026-09-04), non da assunzioni.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseDefinitions } = require('../lib/fleet/definitions.js');
const { extraModelsFrom, resolveManagedEngine, CATALOG, declaredFor } = require('../lib/fleet/managed.js');

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

function zaiDefs(provider) {
  return parseDefinitions({
    schemaVersion: 1,
    engines: [{ id: `codex-vl.${provider}`, label: `ZAI ${provider}`, managed: {
      client: 'codex-vl', provider, model: 'glm-5.3',
    } }],
    cells: [],
  });
}

test('catalog entries are distinct and expose the expected endpoint and models', () => {
  for (const key of ['A', 'P']) {
    const entry = CATALOG.find((p) => p.id === `codex-vl.zai-${key.toLowerCase()}`);
    assert.ok(entry, `codex-vl.zai-${key.toLowerCase()} e' nel catalogo`);
    assert.equal(entry.auth, `ZAI_API_KEY_${key}`);
    assert.equal(entry.endpoint, 'https://api.z.ai/api/v1');
    assert.equal(entry.protocol, 'openai_responses');
    assert.equal(entry.model, 'glm-5.3');
    assert.deepEqual(entry.models, ['glm-5.3', 'glm-5.3-flash']);
  }
});

test('zai-p argv contain the endpoint, credentials, wire, catalog, and context', () => {
  const defs = zaiDefs('zai-p');
  assert.ok(defs, 'la definizione con l\'engine di catalogo e\' valida');
  const extraModels = extraModelsFrom(defs);
  const home = withBinary(tempHome('nc-d142-zai-'), 'codex-vl');
  try {
    const r = resolveManagedEngine(defs.engines[0], { id: 'Dev' },
      { home, env: { ZAI_API_KEY_P: 'secret-p' }, extraModels });
    assert.equal(r.ok, true, r.ok ? '' : r.reason);
    const argv = r.engine.args.join('\n');
    assert.match(argv, /model_provider="zai_p"/);
    assert.match(argv, /model_providers\.zai_p\.base_url="https:\/\/api\.z\.ai\/api\/v1"/);
    assert.match(argv, /model_providers\.zai_p\.env_key="ZAI_API_KEY_P"/);
    assert.match(argv, /model_providers\.zai_p\.wire_api="responses"/);
    assert.match(argv, /model_context_window=1048576/, 'la finestra misurata su \/api\/v1');
    assert.match(argv, /model_providers\.zai_p\.stream_idle_timeout_ms=300000/);
    const catalogArg = r.engine.args.find((a) => a.startsWith('model_catalog_json='));
    assert.ok(catalogArg, 'model_catalog_json e\' negli argv');
    const catalogPath = JSON.parse(catalogArg.slice('model_catalog_json='.length));
    const slugs = JSON.parse(fs.readFileSync(catalogPath, 'utf8')).models.map((m) => m.slug);
    assert.deepEqual(slugs, ['glm-5.3', 'glm-5.3-flash'], 'il catalogo porta i modelli dichiarati');
    const envSent = r.engine.env || {};
    assert.equal(envSent.ZAI_API_KEY_P, 'secret-p', 'la chiave arriva nel processo figlio con il NOME giusto');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('zai-a uses the same wire with the A credential', () => {
  const defs = zaiDefs('zai-a');
  const extraModels = extraModelsFrom(defs);
  const home = withBinary(tempHome('nc-d142-zai-'), 'codex-vl');
  try {
    const r = resolveManagedEngine(defs.engines[0], { id: 'Dev' },
      { home, env: { ZAI_API_KEY_A: 'secret-a' }, extraModels });
    assert.equal(r.ok, true, r.ok ? '' : r.reason);
    const argv = r.engine.args.join('\n');
    assert.match(argv, /model_providers\.zai_a\.env_key="ZAI_API_KEY_A"/);
    assert.match(argv, /model_provider="zai_a"/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('rejects an undeclared model with a named cause and accepts a declared one', () => {
  const issues = [];
  const bad = parseDefinitions({
    schemaVersion: 1,
    engines: [{ id: 'codex-vl.zai-p', label: 'Zai P', managed: {
      client: 'codex-vl', provider: 'zai-p', model: 'glm-5.2',
    } }],
    cells: [],
  }, { onIssue: (i) => issues.push(i) });
  assert.equal(bad, null, 'glm-5.2 non e\' tra i modelli Responses dichiarati');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, 'model');
  assert.equal(issues[0].value, 'glm-5.2');

  const good = parseDefinitions({
    schemaVersion: 1,
    models: [{ id: 'glm-5.4-prossimo', engine: 'codex-vl.zai-p', contextWindow: 1048576, maxTokens: 128000, reasoning: true }],
    engines: [{ id: 'codex-vl.zai-p', label: 'Zai P', managed: {
      client: 'codex-vl', provider: 'zai-p', model: 'glm-5.4-prossimo',
    } }],
    cells: [],
  });
  assert.ok(good, 'un modello dichiarato in config passa il gate strictModels (via dichiarata a release)');
  const em = extraModelsFrom(good);
  assert.equal(declaredFor(em, 'codex-vl.custom', 'glm-5.4-prossimo', 'codex-vl.zai-p'), true,
    'la dichiarazione si trova con la chiave ENGINE');
});
