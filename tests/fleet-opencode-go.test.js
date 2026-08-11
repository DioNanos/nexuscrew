'use strict';

// Profili OpenCode Go. Gli elenchi modello di questi test non sono una copia
// della documentazione: sono la matrice misurata il 2026-08-11 (25 ID live x 3
// wire). Il valore dei test sta nei controlli negativi — una coppia
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
  // kimi-k3 e deepseek-v4-pro: 200 su Chat, 400 payload vuoto sulle altre due.
  for (const model of ['kimi-k3', 'deepseek-v4-pro', 'mimo-v2.5', 'hy3']) {
    assert.equal(normalizeManagedSpec({ client: 'claude', provider: 'opencode-go', model }), null, `messages rifiuta ${model}`);
    assert.equal(normalizeManagedSpec({ client: 'codex-vl', provider: 'opencode-go', model }), null, `responses rifiuta ${model}`);
  }
  // grok-4.5: 200 solo su Responses (Messages lo rifiuta, Chat risponde 503).
  assert.ok(normalizeManagedSpec({ client: 'codex-vl', provider: 'opencode-go', model: 'grok-4.5' }));
  assert.equal(normalizeManagedSpec({ client: 'claude', provider: 'opencode-go', model: 'grok-4.5' }), null);
  assert.equal(normalizeManagedSpec({ client: 'pi', provider: 'opencode-go', model: 'grok-4.5' }), null);
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
    // Nessun context window inventato: non e' misurato su questo provider.
    for (const key of ['CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_AUTO_COMPACT_WINDOW']) {
      assert.equal(Object.prototype.hasOwnProperty.call(result.engine.env, key), false, `${key} assente`);
    }
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
    assert.equal(fs.statSync(extensionArg).mode & 0o777, 0o600);
    assert.deepEqual(result.engine.args.slice(-2), ['--model', 'kimi-k3']);
    assert.ok(result.engine.args.includes('opencode-go'), 'argv seleziona il provider Pi');
    assert.equal(result.engine.args.join('\n').includes(value), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
