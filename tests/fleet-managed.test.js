'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CATALOG, OLLAMA_CONTEXT, normalizeManagedSpec, defaultDefinitions, describeManaged,
  resolveManagedEngine, parseEnvFile, discoverOllamaModels, discoverPiModels,
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

test('app defaults: Claude unsafe opt-out, Codex e Codex-VL standard opt-in', () => {
  const d = defaultDefinitions();
  assert.deepEqual(d.engines.map((e) => e.id), ['claude.native', 'codex.native', 'codex-vl.native']);
  assert.equal(d.engines.find((e) => e.id === 'claude.native').managed.permissionPolicy, 'unsafe');
  assert.ok(d.engines.filter((e) => e.id !== 'claude.native').every((e) => e.managed.permissionPolicy === 'standard'));
  assert.deepEqual(d.cells, []);
  assert.ok(parseDefinitions(d));
  assert.equal(CATALOG.filter((p) => p.default).length, 3);
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

test('Pi model discovery: usa il comando documentato --list-models e raggruppa per provider', async () => {
  const calls = [];
  const models = await discoverPiModels({
    noCache: true, binary: '/trusted/pi',
    execFileImpl: (bin, args, _opts, cb) => {
      calls.push([bin, args]);
      cb(null, 'provider  model  context  max-out  thinking  images\nopenai  gpt-5.4  1M  16K  yes  yes\nopenai  gpt-5.4  1M  16K  yes  yes\nollama  deepseek-v4-pro:cloud  1M  16K  yes  no\nbad!  ../../secret  1  1  no  no\n');
    },
  });
  assert.deepEqual(calls, [['/trusted/pi', ['--list-models']]]);
  assert.deepEqual(models, { openai: ['gpt-5.4'], ollama: ['deepseek-v4-pro:cloud'] });
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
      const r = resolveManagedEngine({ id: `${client}.ollama-cloud`, label: 'Ollama', managed }, { id: 'Dev' }, { home, providerSecretsPath: secrets, env: {} });
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
    assert.equal(r.engine.args.includes('--dangerously-skip-permissions'), true);
    const standard = resolveManagedEngine({ id: 'claude.native', label: 'Claude', rc: false, managed: { client: 'claude', provider: 'native', model: '', permissionPolicy: 'standard' } }, { id: 'Dev' }, { home });
    assert.equal(standard.engine.args.includes('--dangerously-skip-permissions'), false);
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
    const info = describeManaged(managed, { home, providerSecretsPath: secrets, env: {} });
    assert.equal(info.configured, true);
    assert.equal(info.auth, 'ZAI_API_KEY_A');
    assert.equal(JSON.stringify(info).includes('super-secret'), false);
    const r = resolveManagedEngine({ id: 'claude.zai-a', label: 'z', managed }, { id: 'Dev' }, { home, providerSecretsPath: secrets, env: {} });
    assert.equal(r.ok, true);
    assert.equal(r.engine.env.ANTHROPIC_AUTH_TOKEN, 'super-secret');
    assert.equal(r.engine.args.includes('--dangerously-skip-permissions'), true);
    assert.deepEqual(r.engine.args.slice(-2), ['--model', 'glm-5.2[1m]']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Codex-VL Native: standard non forza bypass; unsafe e opt-in', () => {
  const home = tmp();
  try {
    const bin = fakeClient(home, 'codex-vl');
    const managed = { client: 'codex-vl', provider: 'native', model: '' };
    const r = resolveManagedEngine({ id: 'codex-vl.native', label: 'Codex', managed }, { id: 'Dev', prompt: 'bootstrap' }, { home });
    assert.equal(r.ok, true);
    assert.equal(r.engine.command, bin);
    assert.deepEqual(r.engine.env, {});
    assert.deepEqual(r.engine.args, ['bootstrap']);
    assert.equal(r.engine.promptMode, 'managed-argv');
    const unsafe = resolveManagedEngine({ id: 'codex-vl.native', label: 'Codex', managed: { ...managed, permissionPolicy: 'unsafe' } }, { id: 'Dev', prompt: 'bootstrap' }, { home });
    assert.deepEqual(unsafe.engine.args, ['--dangerously-bypass-approvals-and-sandbox', 'bootstrap']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('adapter separati: codex, codex-vl e pi risolvono binari distinti', () => {
  const home = tmp();
  try {
    const bins = Object.fromEntries(['codex', 'codex-vl', 'pi'].map((name) => [name, fakeClient(home, name)]));
    for (const client of Object.keys(bins)) {
      const provider = client === 'pi' ? 'ollama' : 'native';
      const r = resolveManagedEngine({ id: `${client}.${provider}`, label: client, managed: { client, provider, model: client === 'pi' ? 'qwen3:8b' : '' } }, { id: 'Dev' }, { home });
      assert.equal(r.ok, true);
      assert.equal(r.engine.command, bins[client]);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Pi Ollama locale: adapter documentato generato da NexusCrew, modello obbligatorio', () => {
  const home = tmp();
  try {
    fakeClient(home, 'pi');
    assert.equal(normalizeManagedSpec({ client: 'pi', provider: 'ollama', model: '' }), null);
    const r = resolveManagedEngine({ id: 'pi.ollama', label: 'Ollama', managed: { client: 'pi', provider: 'ollama', model: 'qwen3:8b' } }, { id: 'Dev' }, { home });
    assert.equal(r.ok, true);
    assert.deepEqual(r.engine.args.slice(2), ['--provider', 'ollama', '--model', 'qwen3:8b']);
    const source = fs.readFileSync(r.engine.args[1], 'utf8');
    assert.match(source, /http:\/\/127\.0\.0\.1:11434\/v1/);
    assert.match(source, /"apiKey": "ollama"/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Custom Codex: env-only, Responses obbligatoria, mai Chat Completions', () => {
  const home = tmp();
  try {
    fakeClient(home, 'codex');
    const managed = { client: 'codex', provider: 'custom', displayName: 'Fireworks', protocol: 'openai_responses', baseUrl: 'https://api.fireworks.ai/inference/v1', envKey: 'FIREWORKS_API_KEY', providerId: 'fireworks', model: 'model-x' };
    const r = resolveManagedEngine({ id: 'codex.fireworks', label: 'Fireworks', managed }, { id: 'Dev' }, { home, env: { FIREWORKS_API_KEY: 'secret' } });
    assert.equal(r.ok, true);
    assert.equal(r.engine.env.FIREWORKS_API_KEY, 'secret');
    const argv = JSON.stringify(r.engine.args);
    assert.match(argv, /wire_api=\\"responses\\"/);
    assert.doesNotMatch(argv, /chat|completions/i);
    assert.equal(JSON.stringify(r.info).includes('secret'), false);
    assert.equal(normalizeManagedSpec({ ...managed, protocol: 'openai_chat' }), null);
    assert.equal(normalizeManagedSpec({ ...managed, baseUrl: 'https://user:secret@example.com/v1' }), null);
    const quoted = resolveManagedEngine({ id: 'codex.quoted', label: 'Quoted', managed: { ...managed, displayName: 'Lab "quoted"' } }, { id: 'Dev' }, { home, env: { FIREWORKS_API_KEY: 'secret' } });
    assert.ok(quoted.engine.args.includes('model_providers.fireworks.name="Lab \\"quoted\\""'));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Pi provider: argv diretto e API key solo da environment', () => {
  const home = tmp();
  try {
    fakeClient(home, 'pi');
    const managed = { client: 'pi', provider: 'openrouter', model: 'openai/gpt-oss-120b' };
    const r = resolveManagedEngine({ id: 'pi.openrouter', label: 'Pi', managed }, { id: 'Dev', prompt: 'boot' }, { home, env: { OPENROUTER_API_KEY: 'secret' } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.engine.args, ['--provider', 'openrouter', '--model', 'openai/gpt-oss-120b', 'boot']);
    assert.deepEqual(r.engine.env, { OPENROUTER_API_KEY: 'secret' });
    assert.equal(JSON.stringify(r.info).includes('secret'), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Pi Custom: estensione documentata, base URL/protocollo reali, nessun segreto su disco', () => {
  const home = tmp();
  try {
    fakeClient(home, 'pi');
    const managed = {
      client: 'pi', provider: 'custom', displayName: 'Lab Responses',
      protocol: 'openai-responses', baseUrl: 'https://lab.example/v1',
      envKey: 'LAB_API_KEY', providerId: 'lab-responses', model: 'model-r1',
    };
    const r = resolveManagedEngine({ id: 'pi.lab', label: 'Pi Lab', managed }, { id: 'Dev' }, { home, env: { LAB_API_KEY: 'top-secret' } });
    assert.equal(r.ok, true);
    assert.equal(r.engine.env.LAB_API_KEY, 'top-secret');
    assert.deepEqual(r.engine.args.slice(0, 2), ['--extension', path.join(home, '.nexuscrew', 'pi-providers', 'lab-responses.ts')]);
    assert.deepEqual(r.engine.args.slice(2), ['--provider', 'lab-responses', '--model', 'model-r1']);
    const source = fs.readFileSync(r.engine.args[1], 'utf8');
    assert.match(source, /openai-responses/);
    assert.match(source, /https:\/\/lab\.example\/v1/);
    assert.match(source, /\$LAB_API_KEY/);
    assert.doesNotMatch(source, /top-secret/);
    assert.equal(fs.statSync(r.engine.args[1]).mode & 0o777, 0o600);
    assert.equal(normalizeManagedSpec({ ...managed, protocol: 'unsupported-api' }), null);
    assert.equal(normalizeManagedSpec({ ...managed, permissionPolicy: 'unsafe' }), null);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('legacy Z.AI provider migra a provider+credentialProfile senza perdere compatibilita', () => {
  assert.deepEqual(normalizeManagedSpec({ client: 'claude', provider: 'zai-a', model: 'glm-5.2[1m]' }), {
    client: 'claude', provider: 'zai', model: 'glm-5.2[1m]', permissionPolicy: 'unsafe', credentialProfile: 'a',
  });
});

test('providers.env symlink rifiutato e credenziale risulta mancante', () => {
  const home = tmp();
  try {
    fakeClient(home, 'claude');
    const real = path.join(home, 'real.env'); const link = path.join(home, 'providers.env');
    fs.writeFileSync(real, 'ZAI_API_KEY_A=secret\n'); fs.symlinkSync(real, link);
    assert.deepEqual(parseEnvFile(link), {});
    const info = describeManaged({ client: 'claude', provider: 'zai-a', model: '' }, { home, providerSecretsPath: link, env: {} });
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
    const info = describeManaged({ client: 'claude', provider: 'ollama-cloud', model: 'glm-5.2' }, { home, providerSecretsPath: p, env: {} });
    assert.equal(info.configured, false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
