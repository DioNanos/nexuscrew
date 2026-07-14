'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  CATALOG, OLLAMA_CONTEXT, normalizeManagedSpec, defaultDefinitions, describeManaged,
  resolveManagedEngine, parseEnvFile, parseProviderShellFile, discoverOllamaModels, discoverPiModels, needsExplicitNode,
  publicCatalog,
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

test('app defaults: quattro CLI base, provider separati e policy esplicite', () => {
  const d = defaultDefinitions();
  assert.deepEqual(d.engines.map((e) => e.id), ['claude.native', 'codex.native', 'codex-vl.native', 'pi.native']);
  assert.deepEqual(d.engines.map((e) => e.label), ['Claude Code', 'Codex', 'Codex-VL', 'Pi']);
  assert.equal(d.engines.find((e) => e.id === 'claude.native').managed.permissionPolicy, 'unsafe');
  assert.ok(d.engines.filter((e) => e.id !== 'claude.native').every((e) => e.managed.permissionPolicy === 'standard'));
  assert.deepEqual(d.cells, []);
  assert.ok(parseDefinitions(d));
  assert.equal(CATALOG.filter((p) => p.default).length, 4);
});

test('catalogo pubblico: provider base per CLI, nessun profilo credenziale A/P', () => {
  const catalog = publicCatalog();
  const ids = new Set(catalog.map((p) => p.id));
  for (const id of [
    'claude.native', 'claude.bedrock', 'claude.vertex', 'claude.foundry',
    'claude.ollama-cloud', 'claude.ollama', 'claude.zai', 'claude.custom',
    'codex.native', 'codex.openai-api', 'codex.ollama', 'codex.lmstudio',
    'codex.ollama-cloud', 'codex.custom',
    'codex-vl.native', 'codex-vl.openai-api', 'codex-vl.ollama',
    'codex-vl.lmstudio', 'codex-vl.ollama-cloud', 'codex-vl.custom',
    'pi.native', 'pi.anthropic', 'pi.openai', 'pi.openai-codex', 'pi.google',
    'pi.github-copilot', 'pi.ollama', 'pi.openrouter', 'pi.deepseek', 'pi.zai', 'pi.custom',
  ]) assert.equal(ids.has(id), true, `${id} deve essere nel catalogo base`);
  assert.equal(ids.has('claude.zai-a'), false);
  assert.equal(ids.has('claude.zai-p'), false);
  assert.equal(ids.has('pi.fireworks'), false, 'provider Pi avanzati restano fuori dalla lista base');
  assert.equal(catalog.find((p) => p.id === 'claude.zai').defaultEnvKey, 'ZAI_API_KEY');
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
      if (client === 'claude') {
        assert.equal(r.engine.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, String(OLLAMA_CONTEXT['glm-5.2']));
        assert.equal(r.engine.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, String(OLLAMA_CONTEXT['glm-5.2']));
      }
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

test('Claude enterprise providers usano solo i flag ambiente documentati', () => {
  const home = tmp();
  try {
    fakeClient(home, 'claude');
    for (const [provider, key] of [
      ['bedrock', 'CLAUDE_CODE_USE_BEDROCK'],
      ['vertex', 'CLAUDE_CODE_USE_VERTEX'],
      ['foundry', 'CLAUDE_CODE_USE_FOUNDRY'],
    ]) {
      const r = resolveManagedEngine({ id: `claude.${provider}`, label: provider, managed: { client: 'claude', provider, model: '' } }, { id: 'Dev' }, { home });
      assert.equal(r.ok, true);
      assert.deepEqual(r.engine.env, { [key]: '1' });
      assert.equal(r.engine.args.includes('--dangerously-skip-permissions'), true);
      assert.equal(Object.keys(r.engine.env).some((name) => name.startsWith('ANTHROPIC_')), false);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('OpenAI API usa OPENAI_API_KEY senza creare un provider compatibile', () => {
  const home = tmp();
  try {
    for (const client of ['codex', 'codex-vl']) {
      fakeClient(home, client);
      const r = resolveManagedEngine({ id: `${client}.openai-api`, label: 'OpenAI API', managed: { client, provider: 'openai-api', model: 'gpt-5.4' } }, { id: 'Dev' }, { home, env: { OPENAI_API_KEY: 'secret' } });
      assert.equal(r.ok, true);
      assert.deepEqual(r.engine.env, { OPENAI_API_KEY: 'secret' });
      assert.deepEqual(r.engine.args, ['-m', 'gpt-5.4']);
      assert.equal(JSON.stringify(r.info).includes('secret'), false);
    }
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

test('Z.AI generico: nome variabile configurabile, valore solo da environment', () => {
  const home = tmp();
  try {
    fakeClient(home, 'claude');
    const spec = normalizeManagedSpec({ client: 'claude', provider: 'zai', envKey: 'TEAM_ZAI_KEY', model: 'glm-5.2[1m]' });
    assert.equal(spec.envKey, 'TEAM_ZAI_KEY');
    const r = resolveManagedEngine({ id: 'claude.zai', label: 'Z.AI', managed: spec }, { id: 'Dev' }, { home, env: { TEAM_ZAI_KEY: 'secret' } });
    assert.equal(r.ok, true);
    assert.equal(r.engine.env.ANTHROPIC_AUTH_TOKEN, 'secret');
    assert.equal(JSON.stringify(r.info).includes('secret'), false);
    assert.equal(normalizeManagedSpec({ client: 'claude', provider: 'zai', envKey: 'bad-key', model: 'glm-5.2[1m]' }), null);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('provider shell: launchd risolve export esistenti senza eseguire il file o esporre valori', () => {
  const home = tmp();
  try {
    fakeClient(home, 'claude');
    const shellFile = path.join(home, 'providers.zsh');
    fs.writeFileSync(shellFile, "export TEAM_ZAI_KEY='secret-from-shell'\nIGNORED=$(touch /tmp/nc-must-not-run)\n", { mode: 0o644 });
    assert.deepEqual(parseProviderShellFile(shellFile), { TEAM_ZAI_KEY: 'secret-from-shell' });
    const managed = { client: 'claude', provider: 'zai', envKey: 'TEAM_ZAI_KEY', model: 'glm-5.2[1m]' };
    const info = describeManaged(managed, { home, providerShellPath: shellFile, env: {} });
    assert.equal(info.configured, true);
    assert.equal(JSON.stringify(info).includes('secret-from-shell'), false);
    const resolved = resolveManagedEngine({ id: 'claude.zai', label: 'Z.AI', managed }, { id: 'Dev' }, { home, providerShellPath: shellFile, env: {} });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.engine.env.ANTHROPIC_AUTH_TOKEN, 'secret-from-shell');
    assert.equal(fs.existsSync('/tmp/nc-must-not-run'), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('provider shell: symlink, owner diverso e file scrivibile da altri sono rifiutati', () => {
  const home = tmp();
  try {
    const real = path.join(home, 'real.zsh'); const link = path.join(home, 'providers.zsh');
    fs.writeFileSync(real, 'export ZAI_API_KEY=secret\n', { mode: 0o666 });
    fs.symlinkSync(real, link);
    assert.deepEqual(parseProviderShellFile(link), {});
    assert.deepEqual(parseProviderShellFile(real), {});
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

test('Termux: npm CLI con shebang /usr/bin/env node usa process.execPath esplicito', () => {
  const home = tmp();
  try {
    const bin = path.join(home, '.local', 'bin', 'codex-vl');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '#!/usr/bin/env node\nconsole.log("ok")\n', { mode: 0o755 });
    fs.chmodSync(bin, 0o755);
    const node = path.join(home, 'node');
    fs.writeFileSync(node, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.chmodSync(node, 0o755);
    assert.equal(needsExplicitNode(bin, 'android'), true);
    assert.equal(needsExplicitNode(bin, 'linux'), false);
    const r = resolveManagedEngine({
      id: 'codex-vl.native', label: 'Codex-VL',
      managed: { client: 'codex-vl', provider: 'native', model: '', permissionPolicy: 'standard' },
    }, { id: 'Dev', prompt: 'bootstrap' }, { home, platform: 'android', nodeExecPath: node });
    assert.equal(r.ok, true);
    assert.equal(r.engine.command, node);
    assert.deepEqual(r.engine.args, [bin, 'bootstrap']);
    assert.equal(r.engine.clientBinary, bin);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Termux: native or shell CLI remains direct exec', () => {
  const home = tmp();
  try {
    const bin = fakeClient(home, 'pi');
    assert.equal(needsExplicitNode(bin, 'android'), false);
    const r = resolveManagedEngine({ id: 'pi.native', label: 'Pi', managed: {
      client: 'pi', provider: 'native', model: '', permissionPolicy: 'standard',
    } }, { id: 'Dev' }, { home, platform: 'android', nodeExecPath: '/should/not/be/used' });
    assert.equal(r.engine.command, bin);
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

test('Pi native usa la configurazione propria senza forzare provider o modello', () => {
  const home = tmp();
  try {
    const bin = fakeClient(home, 'pi');
    const r = resolveManagedEngine({ id: 'pi.native', label: 'Pi', managed: { client: 'pi', provider: 'native', model: '' } }, { id: 'Dev', prompt: 'bootstrap' }, { home });
    assert.equal(r.ok, true);
    assert.equal(r.engine.command, bin);
    assert.deepEqual(r.engine.args, ['bootstrap']);
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

// --- Policy PER-CELL PER-ENGINE (override del default engine) -----------------
// Mai si mutationa engine.managed.permissionPolicy (globale): l'override vive nella
// cella. resolveManagedEngine usa l'override ricordato, col default dell'engine.

test('policy per-cell: Claude override standard NON mette --dangerously-skip-permissions', () => {
  const home = tmp();
  try {
    fakeClient(home, 'claude');
    const engine = { id: 'claude.native', label: 'Claude', managed: { client: 'claude', provider: 'native', model: '' } };
    // default engine (claude) = unsafe -> flag presente, info.policy = unsafe
    const def = resolveManagedEngine(engine, { id: 'Dev' }, { home });
    assert.equal(def.ok, true);
    assert.equal(def.engine.args.includes('--dangerously-skip-permissions'), true);
    assert.equal(def.info.permissionPolicy, 'unsafe');
    // override PER-CELL standard -> flag assente, policy effettiva standard
    const std = resolveManagedEngine(engine, { id: 'Dev', permissionPolicies: { 'claude.native': 'standard' } }, { home });
    assert.equal(std.engine.args.includes('--dangerously-skip-permissions'), false);
    assert.equal(std.info.permissionPolicy, 'standard');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('policy per-cell: Codex-VL override unsafe mette bypass; standard no', () => {
  const home = tmp();
  try {
    fakeClient(home, 'codex-vl');
    const engine = { id: 'codex-vl.native', label: 'Codex', managed: { client: 'codex-vl', provider: 'native', model: '' } };
    const unsafe = resolveManagedEngine(engine, { id: 'Dev', permissionPolicies: { 'codex-vl.native': 'unsafe' } }, { home });
    assert.equal(unsafe.engine.args.includes('--dangerously-bypass-approvals-and-sandbox'), true);
    const std = resolveManagedEngine(engine, { id: 'Dev', permissionPolicies: { 'codex-vl.native': 'standard' } }, { home });
    assert.equal(std.engine.args.includes('--dangerously-bypass-approvals-and-sandbox'), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('policy per-cell: Pi resta sempre standard anche con override unsafe', () => {
  const home = tmp();
  try {
    fakeClient(home, 'pi');
    const engine = { id: 'pi.openrouter', label: 'Pi', managed: { client: 'pi', provider: 'openrouter', model: 'x' } };
    const r = resolveManagedEngine(engine, { id: 'Dev', permissionPolicies: { 'pi.openrouter': 'unsafe' } }, { home, env: { OPENROUTER_API_KEY: 'k' } });
    assert.equal(r.ok, true);
    assert.equal(r.info.permissionPolicy, 'standard');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('parseDefinitions: permissionPolicies round-trip; valore non ammesso -> null', () => {
  const ok = parseDefinitions({
    schemaVersion: 1,
    engines: [
      { id: 'claude.native', label: 'C', managed: { client: 'claude', provider: 'native', model: '' } },
      { id: 'codex.native', label: 'X', managed: { client: 'codex', provider: 'native', model: '' } },
    ],
    cells: [{ id: 'Dev', cwd: '/home', engine: 'claude.native', permissionPolicies: { 'claude.native': 'standard', 'codex.native': 'unsafe' } }],
  });
  assert.deepEqual(ok.cells[0].permissionPolicies, { 'claude.native': 'standard', 'codex.native': 'unsafe' });
  // valore fuori standard|unsafe -> intero documento rifiutato (fail-closed)
  assert.equal(parseDefinitions({
    schemaVersion: 1,
    engines: [{ id: 'c', managed: { client: 'claude', provider: 'native', model: '' } }],
    cells: [{ id: 'D', cwd: '/h', engine: 'c', permissionPolicies: { c: 'yolo' } }],
  }), null);
});
