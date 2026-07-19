'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  ALIBABA_TOKEN_PLAN_MODELS, ALIBABA_CODEX_MODELS, ALIBABA_TOKEN_PLAN_CONTEXT,
  normalizeManagedSpec, describeManaged, describeCatalogCredential,
  publicCatalog, resolveManagedEngine,
} = require('../lib/fleet/managed.js');

const ANTHROPIC_ENDPOINT = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/apps/anthropic';
const COMPAT_ENDPOINT = 'https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1';

function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-alibaba-token-plan-'));
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

function parsePiDefinition(source) {
  const match = source.match(/pi\.registerProvider\("alibaba-token-plan",\s*([\s\S]+)\);\n}\n$/);
  assert.ok(match, 'generated Pi extension has one static provider definition');
  return JSON.parse(match[1]);
}

test('Alibaba Token Plan profiles are first-class, exact and fail closed on model allowlists', () => {
  const catalog = publicCatalog();
  const claude = catalog.find((entry) => entry.id === 'claude.alibaba-token-plan');
  const codex = catalog.find((entry) => entry.id === 'codex-vl.alibaba-token-plan');
  const pi = catalog.find((entry) => entry.id === 'pi.alibaba-token-plan');
  assert.ok(claude && codex && pi);
  for (const profile of [claude, codex, pi]) {
    assert.equal(profile.model, 'qwen3.8-max-preview');
    assert.equal(profile.credentialEnv, 'ALIBABA_CODE_API_KEY');
  }
  assert.equal(claude.endpoint, ANTHROPIC_ENDPOINT);
  assert.equal(codex.endpoint, COMPAT_ENDPOINT);
  assert.equal(pi.endpoint, COMPAT_ENDPOINT);
  assert.deepEqual(claude.models, [...ALIBABA_TOKEN_PLAN_MODELS]);
  assert.deepEqual(pi.models, [...ALIBABA_TOKEN_PLAN_MODELS]);
  assert.deepEqual(codex.models, [...ALIBABA_CODEX_MODELS]);
  for (const client of ['claude', 'pi']) {
    for (const model of ALIBABA_TOKEN_PLAN_MODELS) {
      assert.ok(normalizeManagedSpec({ client, provider: 'alibaba-token-plan', model }));
    }
  }
  for (const model of ALIBABA_CODEX_MODELS) {
    assert.ok(normalizeManagedSpec({ client: 'codex-vl', provider: 'alibaba-token-plan', model }));
  }
  assert.equal(normalizeManagedSpec({ client: 'codex-vl', provider: 'alibaba-token-plan', model: 'glm-5.2' }), null);
  assert.equal(normalizeManagedSpec({ client: 'pi', provider: 'alibaba-token-plan', model: 'unlisted-model' }), null);
});

test('fixed credential is required for all clients and status never returns its value', () => {
  const home = world();
  const value = credentialValue();
  try {
    for (const client of ['claude', 'codex-vl', 'pi']) {
      const missing = describeManaged({ client, provider: 'alibaba-token-plan' }, { home, env: {} });
      assert.equal(missing.configured, false);
      assert.match(missing.reason, /ALIBABA_CODE_API_KEY/);
      const ready = describeManaged({ client, provider: 'alibaba-token-plan' }, { home, env: { ALIBABA_CODE_API_KEY: value } });
      assert.equal(ready.configured, true);
      assert.equal(ready.auth, 'ALIBABA_CODE_API_KEY');
      assert.equal(JSON.stringify(ready).includes(value), false);
      assert.deepEqual(describeCatalogCredential(client, 'alibaba-token-plan', '', { home, env: { ALIBABA_CODE_API_KEY: value } }), {
        envKey: 'ALIBABA_CODE_API_KEY', authConfigured: true, credentialSource: 'environment',
      });
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Claude profile uses isolated config, official aliases and exact xhigh effort', () => {
  const home = world();
  const value = credentialValue();
  try {
    const result = resolveManagedEngine({
      id: 'claude.alibaba-token-plan', label: 'Alibaba Token Plan',
      managed: { client: 'claude', provider: 'alibaba-token-plan', model: 'qwen3.8-max-preview' },
    }, { id: 'Dev' }, { home, env: { ALIBABA_CODE_API_KEY: value } });
    assert.equal(result.ok, true);
    assert.equal(result.engine.env.ANTHROPIC_BASE_URL, ANTHROPIC_ENDPOINT);
    assert.equal(result.engine.env.ANTHROPIC_AUTH_TOKEN, value);
    assert.equal(result.engine.env.ANTHROPIC_API_KEY, '');
    assert.equal(result.engine.env.ANTHROPIC_MODEL, 'qwen3.8-max-preview');
    assert.equal(result.engine.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'qwen3.8-max-preview');
    assert.equal(result.engine.env.ANTHROPIC_DEFAULT_OPUS_MODEL, 'qwen3.8-max-preview');
    assert.equal(result.engine.env.ANTHROPIC_DEFAULT_FABLE_MODEL, 'qwen3.8-max-preview');
    assert.equal(result.engine.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'qwen3.6-flash');
    assert.equal(result.engine.env.CLAUDE_CODE_SUBAGENT_MODEL, 'qwen3.7-max');
    assert.equal(result.engine.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, String(ALIBABA_TOKEN_PLAN_CONTEXT));
    assert.equal(Object.prototype.hasOwnProperty.call(result.engine.env, 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'), false);
    assert.equal(result.engine.env.CLAUDE_CODE_EFFORT_LEVEL, 'xhigh');
    assert.equal(Object.prototype.hasOwnProperty.call(result.engine.env, 'CLAUDE_CODE_ALWAYS_ENABLE_EFFORT'), false);
    assert.deepEqual(result.engine.args.slice(-2), ['--model', 'qwen3.8-max-preview']);
    assert.equal(result.engine.args.join('\n').includes(value), false);
    assert.equal(JSON.stringify(result.info).includes(value), false);
    const configDir = path.join(home, '.nexuscrew', 'claude-profiles', 'alibaba-token-plan');
    const configFile = path.join(configDir, '.claude.json');
    assert.equal(result.engine.env.CLAUDE_CONFIG_DIR, configDir);
    assert.equal(fs.statSync(configDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(configFile).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), { hasCompletedOnboarding: true });
    assert.equal(fs.readFileSync(configFile, 'utf8').includes(value), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Codex-VL 0.144.7 profile is Responses-only with local qwen3.8 metadata and dedicated env key', () => {
  const home = world();
  const value = credentialValue();
  try {
    const result = resolveManagedEngine({
      id: 'codex-vl.alibaba-token-plan', label: 'Alibaba Token Plan',
      managed: { client: 'codex-vl', provider: 'alibaba-token-plan', model: 'qwen3.8-max-preview' },
    }, { id: 'Dev' }, { home, env: { ALIBABA_CODE_API_KEY: value, OPENAI_API_KEY: 'must-not-propagate' } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.engine.env, { ALIBABA_CODE_API_KEY: value });
    const argv = result.engine.args.join('\n');
    assert.match(argv, /model_provider="alibaba_token_plan"/);
    assert.match(argv, /base_url="https:\/\/token-plan\.ap-southeast-1\.maas\.aliyuncs\.com\/compatible-mode\/v1"/);
    assert.match(argv, /env_key="ALIBABA_CODE_API_KEY"/);
    assert.match(argv, /wire_api="responses"/);
    assert.match(argv, /model_context_window=983616/);
    assert.doesNotMatch(argv, /OPENAI_API_KEY|must-not-propagate/);
    assert.equal(argv.includes(value), false);
    assert.deepEqual(result.engine.args.slice(-2), ['-m', 'qwen3.8-max-preview']);
    const catalogArg = result.engine.args.find((arg) => arg.startsWith('model_catalog_json='));
    const catalogPath = JSON.parse(catalogArg.slice('model_catalog_json='.length));
    const model = JSON.parse(fs.readFileSync(catalogPath, 'utf8')).models[0];
    assert.equal(model.slug, 'qwen3.8-max-preview');
    assert.equal(model.context_window, ALIBABA_TOKEN_PLAN_CONTEXT);
    assert.equal(Object.prototype.hasOwnProperty.call(model, 'max_context_window'), false);
    assert.equal(model.effective_context_window_percent, 95);
    assert.equal(model.default_reasoning_level, 'xhigh');
    assert.deepEqual(model.supported_reasoning_levels.map((entry) => entry.effort), ['low', 'high', 'xhigh']);
    assert.equal(model.supports_parallel_tool_calls, false);
    assert.equal(model.supports_image_detail_original, true);
    assert.deepEqual(model.input_modalities, ['text', 'image']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Pi 0.80.10 extension is secret-free, mixed-wire and pins qwen3.8 to xhigh', () => {
  const home = world();
  const value = credentialValue();
  try {
    const result = resolveManagedEngine({
      id: 'pi.alibaba-token-plan', label: 'Alibaba Token Plan',
      managed: { client: 'pi', provider: 'alibaba-token-plan', model: 'qwen3.8-max-preview', permissionPolicy: 'standard' },
    }, { id: 'Dev' }, { home, env: { ALIBABA_CODE_API_KEY: value } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.engine.env, { ALIBABA_CODE_API_KEY: value });
    assert.deepEqual(result.engine.args.slice(2), [
      '--provider', 'alibaba-token-plan', '--model', 'qwen3.8-max-preview', '--thinking', 'xhigh',
    ]);
    const extension = result.engine.args[1];
    assert.equal(fs.statSync(extension).mode & 0o777, 0o600);
    const source = fs.readFileSync(extension, 'utf8');
    assert.match(source, /\$ALIBABA_CODE_API_KEY/);
    assert.equal(source.includes(value), false);
    assert.equal(result.engine.args.join('\n').includes(value), false);
    const definition = parsePiDefinition(source);
    assert.equal(definition.baseUrl, COMPAT_ENDPOINT);
    assert.equal(definition.apiKey, '$ALIBABA_CODE_API_KEY');
    assert.equal(definition.authHeader, true);
    assert.equal(definition.models.length, 6);
    for (const id of ALIBABA_CODEX_MODELS) {
      assert.equal(definition.models.find((model) => model.id === id).api, 'openai-responses');
    }
    for (const id of ['glm-5.2', 'deepseek-v4-pro']) {
      const model = definition.models.find((entry) => entry.id === id);
      assert.equal(model.api, 'openai-completions');
      assert.equal(model.compat.requiresReasoningContentOnAssistantMessages, true);
    }
    const qwen = definition.models.find((model) => model.id === 'qwen3.8-max-preview');
    assert.equal(qwen.reasoning, true);
    assert.deepEqual(qwen.thinkingLevelMap, { low: 'low', high: 'high', xhigh: 'xhigh' });
    assert.deepEqual(qwen.input, ['text', 'image']);
    assert.equal(qwen.contextWindow, ALIBABA_TOKEN_PLAN_CONTEXT);
    assert.equal(qwen.maxTokens, 131072);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
