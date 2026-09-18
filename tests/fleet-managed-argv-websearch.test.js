'use strict';
// Regressione argv web_search (): il tool built-in web_search deve essere
// disabilitato SOLO per codex/codex-vl su ollama-cloud (l'endpoint Responses
// di Ollama lo rifiuta prima del primo turno); per ogni altro provider il
// argv resta identico a prima della patch. Snapshot dei pair `-c` preso
// PRIMA della patch: dopo la patch l'unica differenza ammessa e' la coppia
// `web_search="disabled"` in piu' per ollama-cloud.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveManagedEngine, extraModelsFrom } = require('../lib/fleet/managed.js');
const { parseDefinitions } = require('../lib/fleet/definitions.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ncargvws-'));
function withBinary(home, client) {
  const bin = path.join(home, '.local', 'bin', client);
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return home;
}

// Pair `-c` dell'argv (valori in ordine di comparsa).
function cPairs(args) {
  const pairs = [];
  for (let i = 0; i < args.length; i++) if (args[i] === '-c') pairs.push(args[i + 1]);
  return pairs;
}

function ollamaCloudEngine(home, client) {
  withBinary(home, client);
  const r = resolveManagedEngine(
    { id: `${client}.ollama-cloud`, label: 'Ollama Cloud', managed: { client, provider: 'ollama-cloud', model: 'glm-5.3-flash' } },
    { id: 'Dev' },
    { home, env: { OLLAMA_API_KEY: 'synthetic-ollama-token' } },
  );
  assert.equal(r.ok, true, r.ok ? '' : r.reason);
  return r.engine;
}

// SNAPSHOT pre-patch (misurato su fae9c9d prima della modifica): i pair `-c`
// di codex-vl.ollama-cloud, con il percorso di home mascherato perche' il
// catalogo custom vive sotto la home di test.
const OLLAMA_CLOUD_C_PAIRS = [
  'model_provider="ollama_cloud"',
  'model_providers.ollama_cloud.name="Ollama Cloud"',
  'model_providers.ollama_cloud.base_url="https://ollama.com/v1"',
  'model_providers.ollama_cloud.env_key="OPENAI_API_KEY"',
  'model_providers.ollama_cloud.wire_api="responses"',
  'model_providers.ollama_cloud.stream_idle_timeout_ms=600000',
  'model_context_window=1000000',
  'model_catalog_json="<HOME>/.nexuscrew/custom-catalogs/codex-vl.ollama-cloud.json"',
  'model_context_window=1000000',
];

test('(a) ollama-cloud: web_search="disabled" presente ESATTAMENTE una volta (codex-vl e codex)', () => {
  for (const client of ['codex-vl', 'codex']) {
    const home = tmp();
    try {
      const engine = ollamaCloudEngine(home, client);
      const occurrences = engine.args.filter((a) => a === 'web_search="disabled"').length;
      assert.equal(occurrences, 1, `${client}: web_search="disabled" esattamente una volta`);
      const pairs = cPairs(engine.args);
      const wsPairs = pairs.filter((v) => v === 'web_search="disabled"');
      assert.equal(wsPairs.length, 1, `${client}: una sola coppia -c web_search`);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
});

test('(b) altri provider: NESSUN web_search negli argv (native, zai-a, zai-p, openrouter, custom)', () => {
  const home = tmp();
  try {
    withBinary(home, 'codex-vl');
    withBinary(home, 'codex');
    const cases = [
      ['codex-vl.native', { client: 'codex-vl', provider: 'native', model: 'gpt-5' }, {}],
      ['codex.native', { client: 'codex', provider: 'native', model: 'gpt-5' }, {}],
      ['codex-vl.zai-a', { client: 'codex-vl', provider: 'zai-a', model: 'glm-5.3' }, { ZAI_API_KEY_A: 'synthetic-a' }],
      ['codex-vl.zai-p', { client: 'codex-vl', provider: 'zai-p', model: 'glm-5.3' }, { ZAI_API_KEY_P: 'synthetic-p' }],
      ['codex-vl.openrouter', { client: 'codex-vl', provider: 'openrouter', model: 'moonshotai/kimi-k3' }, { OPENROUTER_API_KEY: 'synthetic-or' }],
    ];
    for (const [id, managed, env] of cases) {
      const r = resolveManagedEngine({ id, label: id, managed }, { id: 'Dev' }, { home, env: { ...env, OPENAI_API_KEY: 'synthetic-openai' } });
      assert.equal(r.ok, true, `${id}: ${r.ok ? '' : r.reason}`);
      assert.equal(r.engine.args.join('\n').includes('web_search='), false, `${id}: argv senza web_search=`);
    }
    // custom: serve una definizione dichiarata (stesso schema di fleet-custom-catalog)
    const defs = parseDefinitions({
      schemaVersion: 1,
      models: [{ id: 'deepseek-v4-pro', engine: 'codex-vl.custom', contextWindow: 1000000, maxTokens: 384000, reasoning: true }],
      engines: [{
        id: 'my-deepseek', label: 'My Deepseek', managed: {
          client: 'codex-vl', provider: 'custom', providerId: 'deepseek',
          displayName: 'Deepseek', baseUrl: 'https://api.deepseek.example/v1',
          envKey: 'DEEPSEEK_API_KEY', model: 'deepseek-v4-pro',
        },
      }],
      cells: [],
    });
    assert.ok(defs, 'definizioni custom valide');
    const r = resolveManagedEngine(defs.engines[0], { id: 'Dev' }, { home, env: { DEEPSEEK_API_KEY: 'synthetic-deepseek' }, extraModels: extraModelsFrom(defs) });
    assert.equal(r.ok, true, r.ok ? '' : r.reason);
    assert.equal(r.engine.args.join('\n').includes('web_search='), false, 'custom: argv senza web_search=');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('(c) snapshot: il resto dell argv ollama-cloud e INVARIATO (solo pair in piu ammesso: web_search)', () => {
  const home = tmp();
  try {
    const engine = ollamaCloudEngine(home, 'codex-vl');
    const masked = cPairs(engine.args).map((v) => v.replaceAll(home, '<HOME>'));
    // La SNAPSHOT pre-patch e i pair attuali devono coincidere a parte l'eventuale
    // `web_search="disabled"` aggiunto dalla patch.
    const expected = OLLAMA_CLOUD_C_PAIRS.slice();
    const actual = masked.filter((v) => v !== 'web_search="disabled"');
    assert.deepEqual(actual, expected, 'argv ollama-cloud invariato a parte la coppia web_search');
    // La coppia aggiunta, se presente, sta subito dopo stream_idle/context del provider.
    if (masked.includes('web_search="disabled"')) {
      assert.equal(masked.length, expected.length + 1, 'esattamente UNA coppia in piu');
      assert.equal(masked[5], 'web_search="disabled"', 'la coppia sta dopo il provider (wire_api), prima di stream_idle');
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

const IDENTITY_REQUIRED_ENV = 'CODEX_APP_SERVER_IDENTITY_REQUIRED';

test('(d) codex-vl Fleet: identity-required presente nell env, non negli argv', () => {
  const home = tmp();
  try {
    withBinary(home, 'codex-vl');
    const r = resolveManagedEngine(
      { id: 'codex-vl.native', label: 'Codex-VL', managed: { client: 'codex-vl', provider: 'native', model: '' } },
      { id: 'Dev' },
      { home, env: {} },
    );
    assert.equal(r.ok, true, r.ok ? '' : r.reason);
    assert.equal(r.engine.env[IDENTITY_REQUIRED_ENV], '0', 'default: legacy mode -> REQUIRED=0');
    assert.equal(r.engine.args.includes(IDENTITY_REQUIRED_ENV), false);
    assert.equal(r.engine.args.some((arg) => arg.includes(IDENTITY_REQUIRED_ENV)), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('(e) engine non codex-vl: identity-required assente', () => {
  const home = tmp();
  try {
    withBinary(home, 'codex');
    const r = resolveManagedEngine(
      { id: 'codex.native', label: 'Codex', managed: { client: 'codex', provider: 'native', model: '' } },
      { id: 'Dev' },
      { home, env: { [IDENTITY_REQUIRED_ENV]: '1' } },
    );
    assert.equal(r.ok, true, r.ok ? '' : r.reason);
    assert.equal(Object.prototype.hasOwnProperty.call(r.engine.env, IDENTITY_REQUIRED_ENV), false);
    assert.equal(r.engine.args.some((arg) => arg.includes(IDENTITY_REQUIRED_ENV)), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('(f) override utente nella definizione Fleet: identity-required rispettato', () => {
  const home = tmp();
  try {
    withBinary(home, 'codex-vl');
    const defs = parseDefinitions({
      schemaVersion: 1,
      engines: [{
        id: 'codex-vl.native', label: 'Codex-VL',
        managed: { client: 'codex-vl', provider: 'native', model: '' },
        env: { [IDENTITY_REQUIRED_ENV]: '0' },
      }],
      cells: [],
    });
    assert.ok(defs, 'definizione managed con override env valida');
    const r = resolveManagedEngine(
      defs.engines[0],
      { id: 'Dev' },
      { home, env: { [IDENTITY_REQUIRED_ENV]: '1' } },
    );
    assert.equal(r.ok, true, r.ok ? '' : r.reason);
    assert.equal(r.engine.env[IDENTITY_REQUIRED_ENV], '0');
    assert.equal(r.engine.args.some((arg) => arg.includes(IDENTITY_REQUIRED_ENV)), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
