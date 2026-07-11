'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CATALOG, OLLAMA_CONTEXT, normalizeManagedSpec, defaultDefinitions, describeManaged,
  resolveManagedEngine, parseEnvFile, discoverOllamaModels,
} = require('../lib/fleet/managed.js');
const { parseDefinitions } = require('../lib/fleet/definitions.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ncmanaged-'));
function fakeClient(home, name) {
  const p = path.join(home, '.local', 'bin', name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(p, 0o755);
  return p;
}

test('app defaults: soltanto Claude Native e Codex-VL Native', () => {
  const d = defaultDefinitions();
  assert.deepEqual(d.engines.map((e) => e.id), ['claude.native', 'codex-vl.native']);
  assert.deepEqual(d.cells, []);
  assert.ok(parseDefinitions(d));
  assert.equal(CATALOG.filter((p) => p.default).length, 2);
});

test('managed matrix: Z.AI solo Claude; Ollama Cloud su entrambi', () => {
  assert.ok(normalizeManagedSpec({ client: 'claude', provider: 'zai-a' }));
  assert.ok(normalizeManagedSpec({ client: 'claude', provider: 'zai-p' }));
  assert.equal(normalizeManagedSpec({ client: 'codex-vl', provider: 'zai-a' }), null);
  assert.ok(normalizeManagedSpec({ client: 'claude', provider: 'ollama-cloud' }));
  assert.ok(normalizeManagedSpec({ client: 'codex-vl', provider: 'ollama-cloud' }));
  const ollama = CATALOG.find((p) => p.id === 'codex-vl.ollama-cloud');
  assert.equal(ollama.model, 'glm-5.2');
  assert.ok(ollama.models.includes('deepseek-v4-pro'));
});

test('Ollama Direct discovery: usa la shortlist TOP disponibile e filtra garbage', async () => {
  const models = await discoverOllamaModels({
    noCache: true,
    apiKey: 'test-key',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ models: [
        { name: 'glm-5.2' }, { name: 'deepseek-v4-pro' },
        { name: 'old-model' }, { name: '../bad' }, { name: 'glm-5.2' },
      ] }),
    }),
  });
  assert.deepEqual(models, ['glm-5.2', 'deepseek-v4-pro']);
});

test('Ollama Direct discovery: errore API usa la shortlist TOP di fallback', async () => {
  const models = await discoverOllamaModels({ noCache: true, fetchImpl: async () => { throw new Error('down'); } });
  assert.deepEqual(models, [
    'glm-5.2', 'kimi-k2.7-code', 'deepseek-v4-pro', 'minimax-m3',
    'qwen3.5:397b', 'deepseek-v4-flash', 'mistral-large-3:675b', 'gemma4:31b',
  ]);
});

test('Ollama Direct: usa ollama.com + OLLAMA_API_KEY, mai localhost', () => {
  const home = tmp();
  try {
    fakeClient(home, 'claude'); fakeClient(home, 'codex-vl');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const catalog = path.join(home, '.codex', 'ollama_cloud_model_catalog.json');
    fs.writeFileSync(catalog, '{"models":[{"slug":"glm-5.2"}]}\n');
    const secrets = path.join(home, 'providers.env');
    fs.writeFileSync(secrets, 'OLLAMA_API_KEY=ollama-secret\n', { mode: 0o600 });
    for (const client of ['claude', 'codex-vl']) {
      const managed = { client, provider: 'ollama-cloud', model: 'glm-5.2' };
      const r = resolveManagedEngine({ id: `${client}.ollama-cloud`, label: 'Ollama', managed }, { id: 'Dev' }, { home, providerSecretsPath: secrets });
      assert.equal(r.ok, true);
      assert.equal(JSON.stringify(r).includes('127.0.0.1'), false);
      assert.equal(JSON.stringify(r).includes('localhost'), false);
      assert.equal(client === 'claude' ? r.engine.env.ANTHROPIC_AUTH_TOKEN : r.engine.env.OPENAI_API_KEY, 'ollama-secret');
      assert.ok(JSON.stringify(r.engine).includes('https://ollama.com'));
      if (client === 'claude') assert.equal(r.engine.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, String(OLLAMA_CONTEXT['glm-5.2']));
      else {
        assert.ok(r.engine.args.includes(`model_context_window=${OLLAMA_CONTEXT['glm-5.2']}`));
        assert.ok(r.engine.args.includes(`model_catalog_json="${catalog}"`));
      }
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Claude native onora rc:false', () => {
  const home = tmp();
  try {
    fakeClient(home, 'claude');
    const r = resolveManagedEngine({ id: 'claude.native', label: 'Claude', rc: false, managed: { client: 'claude', provider: 'native', model: '' } }, { id: 'Dev' }, { home });
    assert.equal(r.ok, true);
    assert.equal(r.engine.args.includes('--remote-control'), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Z.AI: config visibile, secret redatto, launch env interno', () => {
  const home = tmp();
  try {
    fakeClient(home, 'claude');
    const secrets = path.join(home, 'providers.env');
    fs.writeFileSync(secrets, "ZAI_API_KEY_A='super-secret'\n", { mode: 0o600 });
    assert.deepEqual(parseEnvFile(secrets), { ZAI_API_KEY_A: 'super-secret' });
    const managed = { client: 'claude', provider: 'zai-a', model: 'glm-5.2[1m]' };
    const info = describeManaged(managed, { home, providerSecretsPath: secrets });
    assert.equal(info.configured, true);
    assert.equal(info.auth, 'ZAI_API_KEY_A');
    assert.equal(JSON.stringify(info).includes('super-secret'), false);
    const r = resolveManagedEngine({ id: 'claude.zai-a', label: 'z', managed }, { id: 'Dev' }, { home, providerSecretsPath: secrets });
    assert.equal(r.ok, true);
    assert.equal(r.engine.env.ANTHROPIC_AUTH_TOKEN, 'super-secret');
    assert.deepEqual(r.engine.args.slice(-2), ['--model', 'glm-5.2[1m]']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Codex-VL Native: usa login nativo, senza provider/env esterni', () => {
  const home = tmp();
  try {
    const bin = fakeClient(home, 'codex-vl');
    const managed = { client: 'codex-vl', provider: 'native', model: '' };
    const r = resolveManagedEngine({ id: 'codex-vl.native', label: 'Codex', managed }, { id: 'Dev', prompt: 'bootstrap' }, { home });
    assert.equal(r.ok, true);
    assert.equal(r.engine.command, bin);
    assert.deepEqual(r.engine.env, {});
    assert.deepEqual(r.engine.args, ['--dangerously-bypass-approvals-and-sandbox', 'bootstrap']);
    assert.equal(r.engine.promptMode, 'managed-argv');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('providers.env symlink rifiutato e credenziale risulta mancante', () => {
  const home = tmp();
  try {
    fakeClient(home, 'claude');
    const real = path.join(home, 'real.env'); const link = path.join(home, 'providers.env');
    fs.writeFileSync(real, 'ZAI_API_KEY_A=secret\n'); fs.symlinkSync(real, link);
    assert.deepEqual(parseEnvFile(link), {});
    const info = describeManaged({ client: 'claude', provider: 'zai-a', model: '' }, { home, providerSecretsPath: link });
    assert.equal(info.configured, false);
    assert.match(info.reason, /ZAI_API_KEY_A/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('providers.env con permessi group/world viene rifiutato', () => {
  const home = tmp();
  try {
    fakeClient(home, 'claude');
    const p = path.join(home, 'providers.env');
    fs.writeFileSync(p, 'OLLAMA_API_KEY=secret\n', { mode: 0o644 }); fs.chmodSync(p, 0o644);
    assert.deepEqual(parseEnvFile(p), {});
    const info = describeManaged({ client: 'claude', provider: 'ollama-cloud', model: 'glm-5.2' }, { home, providerSecretsPath: p });
    assert.equal(info.configured, false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
