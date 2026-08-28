'use strict';

// Profili OpenCode Go. Gli elenchi modello di questi test non sono una copia
// della documentazione: sono la matrice misurata il 2026-08-11 (25 ID live x 3
// wire), con deepseek-v4-pro refreshato al 2026-08-13 (DeepSeek ha aggiunto la
// Responses API il 13/08: ora 200 su tutti e tre i wire). Il valore dei test sta nei controlli negativi — una coppia
// wire/modello che il gateway rifiuta deve fallire QUI, non al primo avvio.

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  OPENCODE_GO_MESSAGES_MODELS, OPENCODE_GO_RESPONSES_MODELS, OPENCODE_GO_CHAT_MODELS,
  OPENCODE_GO_ANTHROPIC_ROOT, OPENCODE_GO_API_BASE,
  normalizeManagedSpec, describeManaged, describeCatalogCredential,
  publicCatalog, resolveManagedEngine,
} = require('../lib/fleet/managed.js');

function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-opencode-go-'));
  fs.chmodSync(home, 0o700);
  for (const name of ['claude', 'codex-vl', 'pi']) {
    const target = path.join(home, '.local', 'bin', name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  return home;
}

function credentialValue() {
  return crypto.randomBytes(32).toString('hex');
}

test('i tre profili sono in catalogo con endpoint e credenziale esatti', () => {
  const catalog = publicCatalog();
  const claude = catalog.find((entry) => entry.id === 'claude.opencode-go');
  const codex = catalog.find((entry) => entry.id === 'codex-vl.opencode-go');
  const pi = catalog.find((entry) => entry.id === 'pi.opencode-go');
  assert.ok(claude && codex && pi, 'i tre profili sono esposti dal catalogo pubblico');
  for (const profile of [claude, codex, pi]) {
    assert.equal(profile.model, 'deepseek-v4-flash');
    assert.equal(profile.credentialEnv, 'OPENCODE_API_KEY');
    assert.equal(profile.label, 'OpenCode Go');
  }
  // La root Claude NON deve contenere /v1: e' il client ad aggiungere
  // /v1/messages. Un doppio /v1 e' 404, ed e' l'errore facile da fare qui.
  assert.equal(claude.endpoint, OPENCODE_GO_ANTHROPIC_ROOT);
  assert.doesNotMatch(claude.endpoint, /\/v1$/);
  assert.equal(codex.endpoint, OPENCODE_GO_API_BASE);
  assert.equal(pi.endpoint, OPENCODE_GO_API_BASE);
  assert.deepEqual(claude.models, [...OPENCODE_GO_MESSAGES_MODELS]);
  assert.deepEqual(codex.models, [...OPENCODE_GO_RESPONSES_MODELS]);
  assert.deepEqual(pi.models, [...OPENCODE_GO_CHAT_MODELS]);
});

test('ogni modello misurato passa e ogni coppia wire/modello rifiutata dal gateway fallisce chiusa', () => {
  for (const model of OPENCODE_GO_MESSAGES_MODELS) {
    assert.ok(normalizeManagedSpec({ client: 'claude', provider: 'opencode-go', model }), `messages/${model}`);
  }
  for (const model of OPENCODE_GO_RESPONSES_MODELS) {
    assert.ok(normalizeManagedSpec({ client: 'codex-vl', provider: 'opencode-go', model }), `responses/${model}`);
  }
  for (const model of OPENCODE_GO_CHAT_MODELS) {
    assert.ok(normalizeManagedSpec({ client: 'pi', provider: 'opencode-go', model }), `chat/${model}`);
  }
  // Controlli negativi presi uno per uno dalla matrice misurata.
  // deepseek-v4-pro: refresh 2026-08-13 (DeepSeek ha aggiunto la Responses API
  // il 13/08) -> ora 200 su tutti e tre i wire; entra in MESSAGES e RESPONSES.
  assert.ok(normalizeManagedSpec({ client: 'claude', provider: 'opencode-go', model: 'deepseek-v4-pro' }), 'deepseek-v4-pro passa su messages (refresh 13/08)');
  assert.ok(normalizeManagedSpec({ client: 'codex-vl', provider: 'opencode-go', model: 'deepseek-v4-pro' }), 'deepseek-v4-pro passa su responses (refresh 13/08)');
  // kimi-k3, mimo-v2.5, hy3: 200 su Chat, 400 payload vuoto sulle altre due.
  for (const model of ['kimi-k3', 'mimo-v2.5', 'hy3']) {
    assert.equal(normalizeManagedSpec({ client: 'claude', provider: 'opencode-go', model }), null, `messages rifiuta ${model}`);
    assert.equal(normalizeManagedSpec({ client: 'codex-vl', provider: 'opencode-go', model }), null, `responses rifiuta ${model}`);
  }
  // grok: 200 solo su Responses (Messages lo rifiuta, Chat risponde 503).
  // Misura wire storica fatta su grok-4.5; dal 2026-08-27 l'id in elenco e'
  // grok-4.6, e il gate lo tratta uguale (stessa wire, stessi limiti).
  assert.ok(normalizeManagedSpec({ client: 'codex-vl', provider: 'opencode-go', model: 'grok-4.6' }));
  assert.equal(normalizeManagedSpec({ client: 'claude', provider: 'opencode-go', model: 'grok-4.6' }), null);
  assert.equal(normalizeManagedSpec({ client: 'pi', provider: 'opencode-go', model: 'grok-4.6' }), null);
  // qwen e minimax: 200 su Messages, rifiuto esplicito "not supported for
  // format openai" su Responses.
  for (const model of ['qwen3.8-max', 'minimax-m3']) {
    assert.ok(normalizeManagedSpec({ client: 'claude', provider: 'opencode-go', model }));
    assert.equal(normalizeManagedSpec({ client: 'codex-vl', provider: 'opencode-go', model }), null);
  }
  // ID pubblicizzati dal catalogo live ma morti upstream: fuori da ogni wire.
  for (const model of ['mimo-v2-pro', 'mimo-v2-omni', 'hy3-preview']) {
    for (const client of ['claude', 'codex-vl', 'pi']) {
      assert.equal(normalizeManagedSpec({ client, provider: 'opencode-go', model }), null, `${client} rifiuta ${model}`);
    }
  }
});

test('un id nuovo resta usabile se dichiarato per quell engine, senza release', () => {
  const declared = new Map([['claude.opencode-go', new Set(['kimi-k3'])]]);
  assert.equal(normalizeManagedSpec({ client: 'claude', provider: 'opencode-go', model: 'kimi-k3' }), null);
  assert.ok(normalizeManagedSpec({ client: 'claude', provider: 'opencode-go', model: 'kimi-k3' }, { extraModels: declared }));
});

test('la credenziale e obbligatoria per i tre client e non torna mai nello stato', () => {
  const home = world();
  const value = credentialValue();
  try {
    for (const client of ['claude', 'codex-vl', 'pi']) {
      const missing = describeManaged({ client, provider: 'opencode-go' }, { home, env: {} });
      assert.equal(missing.configured, false);
      assert.match(missing.reason, /OPENCODE_API_KEY/);
      const ready = describeManaged({ client, provider: 'opencode-go' }, { home, env: { OPENCODE_API_KEY: value } });
      assert.equal(ready.configured, true);
      assert.equal(ready.auth, 'OPENCODE_API_KEY');
      assert.equal(JSON.stringify(ready).includes(value), false);
      assert.deepEqual(describeCatalogCredential(client, 'opencode-go', '', { home, env: { OPENCODE_API_KEY: value } }), {
        envKey: 'OPENCODE_API_KEY', authConfigured: true, credentialSource: 'environment',
      });
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Claude manda la chiave come x-api-key, non come token: e la differenza fra 200 e 401', () => {
  const home = world();
  const value = credentialValue();
  try {
    const result = resolveManagedEngine({
      id: 'claude.opencode-go', label: 'OpenCode Go',
      managed: { client: 'claude', provider: 'opencode-go', model: 'deepseek-v4-flash' },
    }, { id: 'Dev' }, { home, env: { OPENCODE_API_KEY: value } });
    assert.equal(result.ok, true);
    assert.equal(result.engine.env.ANTHROPIC_BASE_URL, OPENCODE_GO_ANTHROPIC_ROOT);
    // Il controllo che conta: ANTHROPIC_API_KEY valorizzata e nessun
    // ANTHROPIC_AUTH_TOKEN. La wire Messages di OpenCode Go risponde 401 al
    // Bearer, quindi la forma usata da Z.AI qui non deve comparire.
    assert.equal(result.engine.env.ANTHROPIC_API_KEY, value);
    assert.equal(Object.prototype.hasOwnProperty.call(result.engine.env, 'ANTHROPIC_AUTH_TOKEN'), false);
    for (const key of [
      'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL',
    ]) assert.equal(result.engine.env[key], 'deepseek-v4-flash', `${key} segue il modello`);
    // Il contesto viene dalla tabella dei limiti dichiarati, non da una
    // costante: deepseek-v4-flash e' 1M.
    assert.equal(result.engine.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '1000000');
    assert.equal(result.engine.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, '1000000');
    // `--model` non e' in testa: la policy Claude di default e' unsafe e
    // antepone --dangerously-skip-permissions. Si asserisce la coppia, non
    // la posizione.
    const modelAt = result.engine.args.indexOf('--model');
    assert.ok(modelAt >= 0, 'argv contiene --model');
    assert.equal(result.engine.args[modelAt + 1], 'deepseek-v4-flash');
    assert.equal(result.engine.args.join('\n').includes(value), false);
    assert.equal(JSON.stringify(result.info).includes(value), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Claude segue il modello scelto su tutti gli alias', () => {
  const home = world();
  const value = credentialValue();
  try {
    for (const model of OPENCODE_GO_MESSAGES_MODELS) {
      const result = resolveManagedEngine({
        id: 'claude.opencode-go', label: 'OpenCode Go',
        managed: { client: 'claude', provider: 'opencode-go', model },
      }, { id: 'Dev' }, { home, env: { OPENCODE_API_KEY: value } });
      assert.equal(result.ok, true, model);
      assert.equal(result.engine.env.ANTHROPIC_MODEL, model);
      assert.equal(result.engine.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, model);
      assert.equal(result.engine.env.CLAUDE_CODE_SUBAGENT_MODEL, model);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('il contesto segue il modello, e un id fuori tabella non eredita il numero di un altro', () => {
  const home = world();
  const value = credentialValue();
  try {
    // Ogni modello della wire Messages riceve il proprio limite dichiarato,
    // non quello del default: glm-5.1 non deve prendere il milione di flash.
    const atteso = { 'deepseek-v4-flash': '1000000', 'glm-5.1': '202752', 'minimax-m2.7': '204800', 'qwen3.5-plus': '262144' };
    for (const [model, context] of Object.entries(atteso)) {
      const result = resolveManagedEngine({
        id: 'claude.opencode-go', label: 'OpenCode Go',
        managed: { client: 'claude', provider: 'opencode-go', model },
      }, { id: 'Dev' }, { home, env: { OPENCODE_API_KEY: value } });
      assert.equal(result.ok, true, model);
      assert.equal(result.engine.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, context, `${model} riceve il proprio contesto`);
    }
    // Controllo negativo: un id ammesso perche' DICHIARATO per quell'engine ma
    // assente dalla tabella dei limiti non deve ricevere alcun contesto — se
    // lo ricevesse, sarebbe il numero di un altro modello.
    const declared = new Map([['claude.opencode-go', new Set(['kimi-k3-preview-inesistente'])]]);
    const fuori = resolveManagedEngine({
      id: 'claude.opencode-go', label: 'OpenCode Go',
      managed: { client: 'claude', provider: 'opencode-go', model: 'kimi-k3-preview-inesistente' },
    }, { id: 'Dev' }, { home, env: { OPENCODE_API_KEY: value }, extraModels: declared });
    assert.equal(fuori.ok, true, 'un id dichiarato resta avviabile');
    for (const key of ['CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW']) {
      assert.equal(Object.prototype.hasOwnProperty.call(fuori.engine.env, key), false, `${key} assente fuori tabella`);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Codex-VL riceve il catalogo modelli, senza il quale non ha i metadati di contesto', () => {
  const home = world();
  const value = credentialValue();
  try {
    const result = resolveManagedEngine({
      id: 'codex-vl.opencode-go', label: 'OpenCode Go',
      managed: { client: 'codex-vl', provider: 'opencode-go', model: 'gpt-5.6-luna' },
    }, { id: 'Dev' }, { home, env: { OPENCODE_API_KEY: value } });
    assert.equal(result.ok, true);
    const argv = result.engine.args.join('\n');
    assert.match(argv, /model_context_window=1050000/, 'il contesto e quello di luna, non del default');
    const catalogArg = result.engine.args.find((arg) => arg.startsWith('model_catalog_json='));
    assert.ok(catalogArg, 'argv porta il catalogo');
    const catalogPath = JSON.parse(catalogArg.slice('model_catalog_json='.length));
    const models = JSON.parse(fs.readFileSync(catalogPath, 'utf8')).models;
    // Il catalogo copre esattamente le coppie misurate sulla wire Responses.
    assert.deepEqual(models.map((m) => m.slug).sort(), [...OPENCODE_GO_RESPONSES_MODELS].sort());
    const luna = models.find((m) => m.slug === 'gpt-5.6-luna');
    assert.equal(luna.context_window, 1050000);
    assert.deepEqual(luna.truncation_policy, { mode: 'tokens', limit: 1050000 });
    // I campi che il consumatore reale pretende espliciti.
    for (const key of [
      'shell_type', 'visibility', 'supported_in_api', 'priority', 'availability_nux', 'upgrade',
      'supports_reasoning_summaries', 'support_verbosity', 'default_verbosity', 'apply_patch_tool_type',
      'truncation_policy', 'experimental_supported_tools',
    ]) assert.equal(Object.prototype.hasOwnProperty.call(luna, key), true, `campo ModelInfo ${key} esplicito`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Codex-VL usa la wire Responses su /v1 e non propaga credenziali ambientali', () => {
  const home = world();
  const value = credentialValue();
  try {
    const result = resolveManagedEngine({
      id: 'codex-vl.opencode-go', label: 'OpenCode Go',
      managed: { client: 'codex-vl', provider: 'opencode-go', model: 'deepseek-v4-flash' },
    }, { id: 'Dev' }, { home, env: { OPENCODE_API_KEY: value, OPENAI_API_KEY: 'must-not-propagate' } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.engine.env, { OPENCODE_API_KEY: value });
    const argv = result.engine.args.join('\n');
    assert.match(argv, /model_provider="opencode_go"/);
    assert.match(argv, /base_url="https:\/\/opencode\.ai\/zen\/go\/v1"/);
    assert.match(argv, /env_key="OPENCODE_API_KEY"/);
    assert.match(argv, /wire_api="responses"/);
    assert.doesNotMatch(argv, /OPENAI_API_KEY|must-not-propagate/);
    assert.equal(argv.includes(value), false);
    assert.deepEqual(result.engine.args.slice(-2), ['-m', 'deepseek-v4-flash']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Pi riceve una estensione che referenzia la variabile, mai il valore', () => {
  const home = world();
  const value = credentialValue();
  try {
    const result = resolveManagedEngine({
      id: 'pi.opencode-go', label: 'OpenCode Go',
      managed: { client: 'pi', provider: 'opencode-go', model: 'kimi-k3' },
    }, { id: 'Dev' }, { home, env: { OPENCODE_API_KEY: value } });
    assert.equal(result.ok, true);
    const extensionArg = result.engine.args[result.engine.args.indexOf('--extension') + 1];
    assert.ok(extensionArg, 'argv contiene il path dell estensione generata');
    const source = fs.readFileSync(extensionArg, 'utf8');
    assert.equal(source.includes(value), false, 'il file generato non contiene il segreto');
    assert.match(source, /\$OPENCODE_API_KEY/);
    const definition = JSON.parse(source.match(/pi\.registerProvider\("opencode-go",\s*([\s\S]+)\);\n}\n$/)[1]);
    assert.equal(definition.baseUrl, OPENCODE_GO_API_BASE);
    assert.equal(definition.api, 'openai-completions');
    // I descrittori portano i limiti dichiarati: senza, l'estensione ricadeva
    // sul default conservativo di 128k anche per un modello da 1M.
    assert.deepEqual(definition.models.map((m) => m.id).sort(), [...OPENCODE_GO_CHAT_MODELS].sort());
    const kimi = definition.models.find((m) => m.id === 'kimi-k3');
    assert.equal(kimi.contextWindow, 1048576);
    assert.equal(kimi.maxTokens, 131072);
    assert.equal(fs.statSync(extensionArg).mode & 0o777, 0o600);
    assert.deepEqual(result.engine.args.slice(-2), ['--model', 'kimi-k3']);
    assert.ok(result.engine.args.includes('opencode-go'), 'argv seleziona il provider Pi');
    assert.equal(result.engine.args.join('\n').includes(value), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
