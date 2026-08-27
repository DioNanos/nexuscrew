'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  CATALOG, OLLAMA_CONTEXT, OLLAMA_CLOUD_MODELS, normalizeManagedSpec, defaultDefinitions, describeManaged,
  resolveManagedEngine, parseEnvFile, parseProviderShellFile, discoverOllamaModels, discoverPiModels, EXTERNAL_DISCOVERY_TIMEOUT_MS, needsExplicitNode,
  publicCatalog, parseProviderKeyFiles, describeCatalogCredential, findBinary,
  shellConfiguredCommandArgs,
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

// Fetta A: il seed cambia ORDINE (non insieme) rispetto a 0.8.55 perche' il
// dropdown client e il seed derivano entrambi dall'ordine dell'array CATALOG
// (publicCatalog preserva la prima apparizione; defaultDefinitions filtra
// `default:true` in ordine di array). Invariante vero: (1) stesso insieme dei
// 5 default, (2) claude.native primo (preselezione), (3) shell.local ultimo,
// (4) codex-vl prima di codex.
test('app defaults: seed invariato come INTENTO (claude primo, shell ultimo, codex-vl prima di codex)', () => {
  const d = defaultDefinitions();
  const ids = d.engines.map((e) => e.id);
  assert.equal(ids.length, 5);
  assert.equal(ids[0], 'claude.native', 'claude.native e la preselezione (primo default)');
  assert.equal(ids[ids.length - 1], 'shell.local', 'shell.local resta ultimo default');
  assert.deepEqual([...ids].sort(), ['claude.native', 'codex-vl.native', 'codex.native', 'pi.native', 'shell.local'], 'insieme dei 5 default invariato');
  assert.ok(ids.indexOf('codex-vl.native') < ids.indexOf('codex.native'), 'codex-vl precede codex nel seed');
  assert.deepEqual(d.engines.map((e) => e.label), ['Claude Code', 'Codex-VL', 'Codex', 'Pi', 'Shell']);
  assert.equal(d.engines.find((e) => e.id === 'claude.native').managed.permissionPolicy, 'unsafe');
  assert.ok(d.engines.filter((e) => e.id !== 'claude.native').every((e) => e.managed.permissionPolicy === 'standard'));
  assert.deepEqual(d.cells, []);
  assert.ok(parseDefinitions(d));
  assert.equal(CATALOG.filter((p) => p.default).length, 5);
});

test('Shell locale: path runtime, command via login interattivo -lic e policy standard', () => {
  const home = tmp();
  try {
    const shell = fakeClient(home, 'bash');
    const engine = { id: 'shell.local', label: 'Shell', managed: { client: 'shell', provider: 'local', model: '', permissionPolicy: 'standard' } };
    const interactive = resolveManagedEngine(engine, { id: 'Ops', commands: {} }, { home, env: { SHELL: shell } });
    assert.equal(interactive.ok, true);
    assert.equal(interactive.engine.command, shell);
    assert.deepEqual(interactive.engine.args, ['-l']);
    assert.equal(interactive.engine.shellOneShot, false);

    const raw = "printf '%s\\n' '$HOME' | sed 's/x/y/'";
    const oneShot = resolveManagedEngine(engine, {
      id: 'Ops', prompt: 'must-not-be-argv', commands: { 'shell.local': raw },
      permissionPolicies: { 'shell.local': 'unsafe' },
    }, { home, env: { SHELL: shell } });
    assert.equal(oneShot.ok, true);
    assert.deepEqual(oneShot.engine.args, ['-lic', raw]);
    assert.equal(oneShot.engine.args.includes('must-not-be-argv'), false);
    assert.equal(oneShot.engine.info, undefined);
    assert.equal(oneShot.info.permissionPolicy, 'standard');
    assert.equal(oneShot.engine.shellOneShot, true);
    assert.equal(normalizeManagedSpec({ client: 'shell', provider: 'local', model: 'fake' }), null);
    assert.equal(normalizeManagedSpec({ client: 'shell', provider: 'local', model: '', permissionPolicy: 'unsafe' }), null);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Shell command argv: shell POSIX note usano -lic; shell custom conserva -lc', () => {
  for (const shell of ['/bin/bash', '/usr/bin/zsh', '/bin/sh', '/usr/bin/dash']) {
    assert.deepEqual(shellConfiguredCommandArgs(shell, 'agy'), ['-lic', 'agy']);
  }
  assert.deepEqual(shellConfiguredCommandArgs('/usr/bin/fish', 'agy'), ['-lc', 'agy']);
});

test('catalogo pubblico: provider base per CLI, nessun profilo credenziale A/P', () => {
  const catalog = publicCatalog();
  const ids = new Set(catalog.map((p) => p.id));
  for (const id of [
    'claude.native', 'claude.bedrock', 'claude.vertex', 'claude.foundry',
    'claude.openrouter', 'claude.kimi-code', 'claude.ollama-cloud', 'claude.ollama', 'claude.zai', 'claude.custom',
    'codex.native', 'codex.openai-api', 'codex.ollama', 'codex.lmstudio',
    'codex.ollama-cloud', 'codex.custom',
    'codex-vl.native', 'codex-vl.openai-api', 'codex-vl.ollama',
    'codex-vl.openrouter', 'codex-vl.lmstudio', 'codex-vl.ollama-cloud', 'codex-vl.custom',
    'pi.native', 'pi.anthropic', 'pi.openai', 'pi.openai-codex', 'pi.google',
    'pi.github-copilot', 'pi.ollama', 'pi.openrouter', 'pi.deepseek', 'pi.zai', 'pi.custom',
    'agy.native', 'kimi.native',
    'shell.local',
  ]) assert.equal(ids.has(id), true, `${id} deve essere nel catalogo base`);
  assert.equal(ids.has('claude.zai-a'), false);
  assert.equal(ids.has('claude.zai-p'), false);
  assert.deepEqual(
    catalog.filter((p) => p.client === 'claude' && p.provider === 'zai').map((p) => p.id),
    ['claude.zai'],
    'la UI espone un solo profilo Claude Z.AI generico',
  );
  assert.deepEqual(
    CATALOG.filter((p) => p.id === 'claude.zai-a' || p.id === 'claude.zai-p')
      .map((p) => ({ id: p.id, legacy: p.legacy })),
    [{ id: 'claude.zai-a', legacy: true }, { id: 'claude.zai-p', legacy: true }],
    'gli alias A/P restano soltanto compatibilita legacy nascosta',
  );
  assert.equal(ids.has('pi.fireworks'), false, 'provider Pi avanzati restano fuori dalla lista base');
  assert.equal(catalog.find((p) => p.id === 'claude.zai').defaultEnvKey, 'ZAI_API_KEY');
  assert.equal(catalog.find((p) => p.id === 'claude.openrouter').credentialEnv, 'OPENROUTER_API_KEY');
  assert.equal(catalog.find((p) => p.id === 'codex-vl.openrouter').credentialEnv, 'OPENROUTER_API_KEY');
  assert.equal(catalog.find((p) => p.id === 'claude.kimi-code').credentialEnv, 'KIMI_API_KEY');
  assert.equal(catalog.filter((p) => p.default).length, 5, 'Shell e un engine standard senza cambiare il primo default');
});

// --- Fetta A: ordine semantico del CATALOG -----------------------------------
// L'ordine dell'array CATALOG guida due menu, entrambi via publicCatalog (che
// preserva l'ordine di prima apparizione): il menu client (prima apparizione di
// ogni client) e il menu provider dentro un client (ordine dell'array). Quindi
// l'ordine e' semantica contrattuale, non estetica.

test('CATALOG: client in ordine di prima apparizione', () => {
  const clients = [];
  for (const p of publicCatalog()) if (!clients.includes(p.client)) clients.push(p.client);
  assert.deepEqual(clients, ['claude', 'codex-vl', 'codex', 'grok', 'vl', 'pi', 'agy', 'kimi', 'shell']);
});

test('Fetta A: native primo e custom ultimo dentro ogni client', () => {
  const byClient = new Map();
  for (const p of publicCatalog()) {
    if (!byClient.has(p.client)) byClient.set(p.client, []);
    byClient.get(p.client).push(p.provider);
  }
  for (const [client, providers] of byClient) {
    if (providers.includes('native')) assert.equal(providers[0], 'native', `${client}: native deve essere il primo provider`);
    if (providers.includes('custom')) assert.equal(providers[providers.length - 1], 'custom', `${client}: custom deve essere l'ultimo provider`);
  }
});

test('Fetta A: provider raggruppati per categoria (subscription prima di cloud prima di local)', () => {
  const SUBSCRIPTION = new Set(['alibaba-token-plan', 'kimi-code', 'zai']);
  const LOCAL = new Set(['ollama', 'lmstudio']);
  const category = (provider) => {
    if (provider === 'native') return 0;
    if (SUBSCRIPTION.has(provider)) return 1;
    if (LOCAL.has(provider)) return 3;
    if (provider === 'custom') return 4;
    return 2; // cloud: openrouter, ollama-cloud, bedrock, vertex, foundry, openai-api, provider esterni Pi
  };
  for (const client of ['claude', 'codex-vl', 'codex', 'pi']) {
    const cats = publicCatalog().filter((p) => p.client === client).map((p) => category(p.provider));
    assert.deepEqual(cats, [...cats].sort((a, b) => a - b), `${client}: categorie provider non monotone (native > subscription > cloud > local > custom)`);
  }
});

// opencode-go entra nel blocco subscription (dopo zai, prima del blocco cloud
// che apre con openrouter): e' un abbonamento, non un provider a consumo.
test('Fetta A: ordine provider claude esplicito (native, alibaba, kimi-code, zai, opencode-go, openrouter, ollama-cloud, bedrock, vertex, foundry, ollama, custom)', () => {
  const providers = publicCatalog().filter((p) => p.client === 'claude').map((p) => p.provider);
  assert.deepEqual(providers, ['native', 'alibaba-token-plan', 'kimi-code', 'zai', 'opencode-go', 'openrouter', 'ollama-cloud', 'bedrock', 'vertex', 'foundry', 'ollama', 'custom']);
});

// DEC2: mcpManaged dice se NexusCrew gestisce i server MCP del client (solo
// claude, che riceve cellMcpArgs/sharedMcpArgs nel ramo claude di
// resolveManagedEngine). Per ogni altro client cell.mcp e' INERTE: la cella lo
// accetta ma non ha effetto, perche' i server li registra il client nel proprio
// config nativo. La vista lo espone cosi' l'editor avverte nel punto di scelta.
test('DEC2: mcpManaged true SOLO per claude (unico client con MCP gestito da NexusCrew)', () => {
  const cat = publicCatalog();
  assert.ok(cat.some((p) => p.client === 'claude'), 'claude presente');
  assert.ok(cat.some((p) => p.client !== 'claude'), 'ci sono client non-claude');
  for (const p of cat) {
    assert.equal(p.mcpManaged, p.client === 'claude',
      `${p.id}: mcpManaged deve essere true solo per claude (client=${p.client})`);
  }
});

test('Fetta A: niente prefisso "Pi · " nelle label; 6 provider Pi restano non-core', () => {
  for (const p of CATALOG) {
    assert.ok(!String(p.label || '').startsWith('Pi · '), `label "${p.label}" non deve iniziare con "Pi · "`);
  }
  for (const provider of ['fireworks', 'huggingface', 'minimax', 'kimi-coding', 'mistral', 'together']) {
    const entry = CATALOG.find((p) => p.client === 'pi' && p.provider === provider);
    assert.ok(entry, `pi.${provider} deve restare nel CATALOG`);
    assert.notEqual(entry.core, true, `pi.${provider} resta non-core (nascosto dalla UI)`);
  }
});

test('Fetta A: legacy claude.zai-a/p in coda al CATALOG, sezione separata', () => {
  const legacy = CATALOG.filter((p) => p.legacy);
  assert.deepEqual(legacy.map((p) => p.id), ['claude.zai-a', 'claude.zai-p']);
  const lastNonLegacy = Math.max(...CATALOG.map((p, i) => (p.legacy ? -1 : i)));
  const firstLegacy = CATALOG.findIndex((p) => p.legacy);
  assert.ok(firstLegacy > lastNonLegacy, 'le voci legacy devono chiudere l\'array, dopo ogni engine non-legacy');
});

test('OpenRouter richiede un modello; Kimi Code accetta solo gli slug documentati', () => {
  assert.equal(normalizeManagedSpec({ client: 'claude', provider: 'openrouter' }), null);
  assert.equal(normalizeManagedSpec({ client: 'codex-vl', provider: 'openrouter' }), null);
  assert.ok(normalizeManagedSpec({ client: 'claude', provider: 'openrouter', model: 'anthropic/claude-sonnet-4' }));
  assert.ok(normalizeManagedSpec({ client: 'codex-vl', provider: 'openrouter', model: 'moonshotai/kimi-k3' }));
  assert.equal(normalizeManagedSpec({ client: 'claude', provider: 'openrouter', model: `x${'y'.repeat(128)}` }), null);
  assert.equal(normalizeManagedSpec({ client: 'claude', provider: 'openrouter', model: 'bad\nmodel' }), null);
  for (const model of ['k3', 'k3[1m]', 'kimi-for-coding', 'kimi-for-coding-highspeed']) {
    assert.ok(normalizeManagedSpec({ client: 'claude', provider: 'kimi-code', model }));
  }
  assert.equal(normalizeManagedSpec({ client: 'claude', provider: 'kimi-code', model: 'unknown' }), null);
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
    'glm-5.3-flash',
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

test('Pi model discovery: cachea il fallimento del binario e resta sotto il budget MCP', async () => {
  const calls = [];
  const execFileImpl = (bin, args, opts, cb) => {
    calls.push({ bin, args, opts });
    cb(new Error('hung external discovery'));
  };
  const first = await discoverPiModels({ binary: '/trusted/pi-hung', ttlMs: 0, execFileImpl });
  const second = await discoverPiModels({ binary: '/trusted/pi-hung', ttlMs: 300000, execFileImpl });
  const third = await discoverPiModels({ binary: '/trusted/pi-hung', ttlMs: 300000, execFileImpl });
  assert.deepEqual(first, {});
  assert.deepEqual(second, {});
  assert.deepEqual(third, {});
  assert.equal(calls.length, 1, 'un failure esterno viene riusato durante il TTL');
  assert.equal(calls[0].opts.timeout, EXTERNAL_DISCOVERY_TIMEOUT_MS);
  assert.ok(calls[0].opts.timeout < 10000, 'la discovery lascia margine al bridge MCP');
});

test('Pi model discovery: un refresh noCache fallito non sovrascrive la cache condivisa', async () => {
  const binary = '/trusted/pi-no-cache';
  const cached = await discoverPiModels({
    binary, noCache: true,
    execFileImpl: (_bin, _args, _opts, cb) => cb(null, 'Provider Model\nopenai gpt-5.4\n'),
  });
  const refreshed = await discoverPiModels({
    binary, noCache: true,
    execFileImpl: (_bin, _args, _opts, cb) => cb(new Error('refresh fallito')),
  });
  const reused = await discoverPiModels({
    binary, ttlMs: 300000,
    execFileImpl: () => { throw new Error('la cache valida non deve rieseguire il binario'); },
  });
  assert.deepEqual(cached, { openai: ['gpt-5.4'] });
  assert.deepEqual(refreshed, {});
  assert.deepEqual(reused, { openai: ['gpt-5.4'] });
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
        // Dal 2026-08-27 il catalogo e' GENERATO dagli id dichiarati
        // dell'engine (custom-catalogs/<client>.<provider>.json); il file
        // utente ~/.codex/ollama_cloud_model_catalog.json resta solo fallback.
        const generated = r.engine.args.find((a) => a.startsWith('model_catalog_json='));
        assert.ok(generated && generated.includes('custom-catalogs'), `atteso catalogo generato, trovato: ${generated}`);
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

test('Claude OpenRouter usa il contratto Anthropic-skin dedicato senza finestre inventate', () => {
  const home = tmp();
  try {
    fakeClient(home, 'claude');
    const model = 'anthropic/claude-sonnet-4';
    const r = resolveManagedEngine({ id: 'claude.openrouter', label: 'OpenRouter', managed: { client: 'claude', provider: 'openrouter', model } }, { id: 'Dev' }, { home, env: { OPENROUTER_API_KEY: 'synthetic-openrouter-token' } });
    assert.equal(r.ok, true);
    assert.equal(r.engine.env.ANTHROPIC_BASE_URL, 'https://openrouter.ai/api');
    assert.equal(r.engine.env.ANTHROPIC_AUTH_TOKEN, 'synthetic-openrouter-token');
    assert.equal(r.engine.env.ANTHROPIC_API_KEY, '');
    assert.equal(r.engine.env.ANTHROPIC_MODEL, model);
    assert.equal(r.engine.env.CLAUDE_CODE_SUBAGENT_MODEL, model);
    assert.equal(r.engine.env.API_TIMEOUT_MS, '3000000');
    assert.equal(Object.prototype.hasOwnProperty.call(r.engine.env, 'CLAUDE_CODE_MAX_CONTEXT_TOKENS'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(r.engine.env, 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'), false);
    assert.deepEqual(r.engine.args.slice(-2), ['--model', model]);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Claude Kimi Code isola config, usa API_KEY child-only e applica il profilo per modello', () => {
  const home = tmp();
  try {
    fakeClient(home, 'claude');
    for (const [model, context, effort] of [
      ['k3', '262144', true], ['k3[1m]', '1048576', true],
      ['kimi-for-coding', '262144', false], ['kimi-for-coding-highspeed', '262144', false],
    ]) {
      const r = resolveManagedEngine({ id: `claude.kimi-${model}`, label: 'Kimi Code', managed: { client: 'claude', provider: 'kimi-code', model } }, { id: 'Dev' }, { home, env: { KIMI_API_KEY: 'synthetic-kimi-token' } });
      assert.equal(r.ok, true);
      assert.equal(r.engine.env.ANTHROPIC_BASE_URL, 'https://api.kimi.com/coding/');
      assert.equal(r.engine.env.ANTHROPIC_API_KEY, 'synthetic-kimi-token');
      assert.equal(Object.prototype.hasOwnProperty.call(r.engine.env, 'ANTHROPIC_AUTH_TOKEN'), false);
      assert.equal(r.engine.env.ANTHROPIC_DEFAULT_FABLE_MODEL, model);
      assert.equal(r.engine.env.CLAUDE_CODE_SUBAGENT_MODEL, model);
      assert.equal(r.engine.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, context);
      assert.equal(r.engine.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, context);
      assert.equal(r.engine.env.API_TIMEOUT_MS, '3000000');
      assert.equal(r.engine.env.CLAUDE_CODE_EFFORT_LEVEL, effort ? 'max' : undefined);
      assert.equal(r.engine.env.CLAUDE_CODE_ALWAYS_ENABLE_EFFORT, effort ? '1' : undefined);
      assert.equal(r.engine.env.CLAUDE_CONFIG_DIR, path.join(home, '.nexuscrew', 'claude-profiles', 'kimi-code'));
    }
    const file = path.join(home, '.nexuscrew', 'claude-profiles', 'kimi-code', '.claude.json');
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {
      hasCompletedOnboarding: true, penguinModeOrgEnabled: true,
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('Codex-VL OpenRouter usa Responses command-auth senza env_key e pinna Kimi K3 a 1M', () => {
  const home = tmp();
  try {
    fakeClient(home, 'codex-vl');
    const secret = 'synthetic-openrouter-token';
    const r = resolveManagedEngine({ id: 'codex-vl.openrouter', label: 'OpenRouter', managed: { client: 'codex-vl', provider: 'openrouter', model: 'moonshotai/kimi-k3' } }, { id: 'Dev' }, { home, env: { OPENROUTER_API_KEY: secret } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.engine.env, { OPENROUTER_API_KEY: secret });
    const joined = r.engine.args.join('\n');
    assert.match(joined, /model_provider="openrouter"/);
    assert.match(joined, /base_url="https:\/\/openrouter\.ai\/api\/v1"/);
    assert.match(joined, /wire_api="responses"/);
    assert.match(joined, /auth\.command=/);
    assert.match(joined, /OPENROUTER_API_KEY/);
    assert.match(joined, /stream_idle_timeout_ms=600000/);
    assert.match(joined, /model_context_window=1048576/);
    assert.match(joined, /openrouter-kimi-k3\.json/);
    assert.equal(joined.includes('.env_key='), false);
    assert.equal(joined.includes(secret), false);
    assert.deepEqual(r.engine.args.slice(-2), ['-m', 'moonshotai/kimi-k3']);
    const catalogArg = r.engine.args.find((arg) => arg.startsWith('model_catalog_json='));
    const catalog = JSON.parse(fs.readFileSync(JSON.parse(catalogArg.slice('model_catalog_json='.length)), 'utf8')).models[0];
    assert.equal(catalog.context_window, 1048576);
    assert.equal(catalog.max_context_window, 1048576);
    assert.equal(catalog.default_reasoning_level, 'max');
    assert.deepEqual(catalog.supported_reasoning_levels.map((entry) => entry.effort), ['max']);
    assert.equal(catalog.supports_reasoning_summaries, true);
    assert.equal(catalog.default_reasoning_summary, 'none');
    assert.deepEqual(catalog.input_modalities, ['text', 'image']);
    assert.equal(catalog.supports_parallel_tool_calls, false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('OpenRouter auth helper is no-shell, fixed-name and silent on invalid input', () => {
  const helper = require.resolve('../lib/fleet/openrouter-auth-helper.js');
  const ok = spawnSync(process.execPath, [helper, 'OPENROUTER_API_KEY'], {
    env: { OPENROUTER_API_KEY: 'synthetic-helper-token' }, encoding: 'utf8',
  });
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout, 'synthetic-helper-token');
  assert.equal(ok.stderr, '');
  for (const [name, value] of [
    ['OTHER_KEY', 'synthetic-helper-token'], ['OPENROUTER_API_KEY', ''],
    ['OPENROUTER_API_KEY', 'bad\nvalue'], ['OPENROUTER_API_KEY', 'x'.repeat((16 * 1024) + 1)],
  ]) {
    const result = spawnSync(process.execPath, [helper, name], { env: { [name]: value }, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});

test('catalog credential status is value-free and limited to fixed catalog keys', () => {
  const home = tmp();
  try {
    assert.deepEqual(describeCatalogCredential('claude', 'openrouter', '', { home, env: { OPENROUTER_API_KEY: 'synthetic-token' } }), {
      envKey: 'OPENROUTER_API_KEY', authConfigured: true, credentialSource: 'environment',
    });
    assert.deepEqual(describeCatalogCredential('claude', 'kimi-code', '', { home, env: {} }), {
      envKey: 'KIMI_API_KEY', authConfigured: false, credentialSource: 'missing',
    });
    assert.equal(describeCatalogCredential('claude', 'custom', '', { home, env: { ARBITRARY_KEY: 'value' } }), null);
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

test('provider canonico: Termux risolve ai.env senza eseguire source o esporre la key', () => {
  const home = tmp();
  try {
    fakeClient(home, 'codex-vl');
    const shellFile = path.join(home, '.config', 'ai-shell', 'providers.zsh');
    const keysFile = path.join(home, '.config', 'keys', 'ai.env');
    fs.mkdirSync(path.dirname(shellFile), { recursive: true });
    fs.mkdirSync(path.dirname(keysFile), { recursive: true });
    fs.writeFileSync(shellFile, 'source "$HOME/.config/keys/ai.env"\n', { mode: 0o644 });
    fs.writeFileSync(keysFile, "export OLLAMA_API_KEY='termux-secret'\n", { mode: 0o600 });
    fs.chmodSync(keysFile, 0o600);

    assert.deepEqual(parseProviderShellFile(shellFile), {});
    assert.deepEqual(parseProviderKeyFiles({}, home), { OLLAMA_API_KEY: 'termux-secret' });
    const managed = { client: 'codex-vl', provider: 'ollama-cloud', model: 'glm-5.2' };
    const info = describeManaged(managed, { home, env: {} });
    assert.equal(info.configured, true);
    assert.equal(JSON.stringify(info).includes('termux-secret'), false);
    const resolved = resolveManagedEngine({ id: 'codex-vl.ollama-cloud', label: 'Ollama', managed }, { id: 'Dev' }, { home, env: {}, platform: 'android' });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.engine.env.OPENAI_API_KEY, 'termux-secret');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('provider canonico: ai.env non privato o symlink viene rifiutato', () => {
  const home = tmp();
  try {
    fakeClient(home, 'codex-vl');
    const real = path.join(home, 'shared.env');
    const link = path.join(home, '.config', 'keys', 'ai.env');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.writeFileSync(real, 'OLLAMA_API_KEY=unsafe\n', { mode: 0o644 });
    fs.chmodSync(real, 0o644);
    fs.symlinkSync(real, link);
    assert.deepEqual(parseProviderKeyFiles({}, home), {});
    const info = describeManaged({ client: 'codex-vl', provider: 'ollama-cloud', model: 'glm-5.2' }, { home, env: {} });
    assert.equal(info.configured, false);
    assert.match(info.reason, /set it on this device/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('provider shell: symlink, owner diverso e file scrivibile da altri sono rifiutati', () => {
  const home = tmp();
  try {
    const real = path.join(home, 'real.zsh'); const link = path.join(home, 'providers.zsh');
    fs.writeFileSync(real, 'export ZAI_API_KEY=secret\n', { mode: 0o666 });
    // writeFile mode is filtered through the process umask. Force the intended
    // world-writable fixture so this security test behaves identically under
    // coordinator (typically 0002) and worker/CI (often 0022) environments.
    fs.chmodSync(real, 0o666);
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

test('needsExplicitNode: Termux runtime via PREFIX attiva il workaround anche con platform linux', () => {
  // A proot/custom Node build may report process.platform === 'linux' while
  // actually running under Termux. Detection must reuse termuxRuntimePaths
  // (PREFIX / files-home layout), not process.platform alone.
  const home = tmp();
  try {
    const bin = path.join(home, '.local', 'bin', 'codex-vl');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.writeFileSync(bin, '#!/usr/bin/env node\nconsole.log("ok")\n', { mode: 0o755 });
    fs.chmodSync(bin, 0o755);
    const termuxEnv = { PREFIX: '/data/data/com.termux/files/usr', HOME: '/data/data/com.termux/files/home' };
    assert.equal(needsExplicitNode(bin, 'linux', termuxEnv), true);
    // Same binary on a real Linux host (no Termux runtime) stays direct exec.
    assert.equal(needsExplicitNode(bin, 'linux', { HOME: '/home/tester' }), false);
    // Public two-argument form is unchanged on a non-Termux host.
    assert.equal(needsExplicitNode(bin, 'linux'), false);
    // resolveManagedEngine threads cfg.env: explicit nodeExecPath is honored.
    const node = path.join(home, 'node');
    fs.writeFileSync(node, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.chmodSync(node, 0o755);
    const r = resolveManagedEngine({
      id: 'codex-vl.native', label: 'Codex-VL',
      managed: { client: 'codex-vl', provider: 'native', model: '', permissionPolicy: 'standard' },
    }, { id: 'Dev' }, { home, platform: 'linux', env: termuxEnv, nodeExecPath: node });
    assert.equal(r.ok, true);
    assert.equal(r.engine.command, node);
    assert.deepEqual(r.engine.args, [bin]);
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

test('ogni modello Ollama Cloud riceve la sua finestra, anche quando porta un tag', () => {
  // Un modello si scrive con o senza tag: 'deepseek-v4-flash' e
  // 'deepseek-v4-flash:0731' sono lo stesso modello. Il lookup diretto sulla
  // mappa manca la variante non elencata e cade sul fallback generico, che
  // Codex poi clampa: la cella si ritrova con 180k invece di 1M senza che
  // nulla lo segnali. Vale per entrambi i versi, perche' nella mappa ci sono
  // gia' chiavi che il tag ce l'hanno per davvero ('qwen3.5:397b').
  const home = tmp();
  try {
    fakeClient(home, 'codex-vl');
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    const catalog = path.join(home, '.codex', 'ollama_cloud_model_catalog.json');
    fs.writeFileSync(catalog, '{"models":[{"slug":"glm-5.2"}]}\n');
    const secrets = path.join(home, 'providers.env');
    fs.writeFileSync(secrets, 'OLLAMA_API_KEY=ollama-secret\n', { mode: 0o600 });

    const contextOf = (model) => {
      const managed = { client: 'codex-vl', provider: 'ollama-cloud', model };
      const r = resolveManagedEngine(
        { id: 'codex-vl.ollama-cloud', label: 'Ollama', managed },
        { id: 'Dev' },
        { home, providerSecretsPath: secrets, env: {} },
      );
      assert.equal(r.ok, true, `resolve fallito per ${model}`);
      const arg = r.engine.args.find((a) => String(a).startsWith('model_context_window='));
      assert.ok(arg, `nessuna finestra dichiarata per ${model}`);
      return Number(String(arg).split('=')[1]);
    };

    // Ogni voce della lista dichiarata deve avere la sua finestra esplicita.
    for (const model of OLLAMA_CLOUD_MODELS) {
      assert.equal(contextOf(model), OLLAMA_CONTEXT[model], `finestra sbagliata per ${model}`);
    }

    // La variante con tag e' lo stesso modello e deve avere la stessa finestra.
    assert.equal(
      contextOf('deepseek-v4-flash:0731'),
      OLLAMA_CONTEXT['deepseek-v4-flash'],
      'una variante con tag non deve cadere sul fallback generico',
    );

    // Il controllo che tiene onesta la normalizzazione: una chiave il cui tag
    // fa parte del nome non deve essere troncata.
    assert.equal(contextOf('qwen3.5:397b'), OLLAMA_CONTEXT['qwen3.5:397b']);
    assert.equal(contextOf('mistral-large-3:675b'), OLLAMA_CONTEXT['mistral-large-3:675b']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ===========================================================================
// Collassi managed: il discriminante e' CHI ha fallito (ENOENT legittimo vs
// EACCES/ELOOP "non ho potuto guardare"). Verdetto invariato, messaggio distinto.
// Stesso principio gia' chiuso in checkTermuxExec (3134d2f).
// ===========================================================================

// Punto 1 — findBinary / resolveInteractiveShell: il loop sui candidati
// collassava ENOENT/EACCES/ELOOP in "prossimo", e il null finale veniva riportato
// come "client X not found". Misura (symlink circolare reale): un candidato che
// punta a se stesso fa fallire realpathSync con ELOOP, non ENOENT.
test('findBinary: un candidato non VERIFICABILE (symlink circolare) -> stesso null, ma out.blocked traccia ELOOP, non "prossimo"', () => {
  const home = tmp();
  try {
    const binDir = path.join(home, '.local', 'bin'); fs.mkdirSync(binDir, { recursive: true });
    const candidate = path.join(binDir, 'vl');
    fs.symlinkSync(candidate, candidate); // punta a se stesso: ELOOP su realpathSync
    const blocked = [];
    const bin = findBinary('vl', home, { blocked });
    assert.equal(bin, null, 'verdetto invariato: non possiamo confermare il binario');
    assert.ok(blocked.some((b) => b.path === candidate && /ELOOP/.test(b.code)),
      'il candidato esiste ma non verificabile va tracciato (ELOOP), non collassato in "prossimo"');
    // ENOENT resta legittimo "prossimo": un candidato assente NON finisce in blocked
    assert.ok(!blocked.some((b) => /ENOENT/.test(b.code)), 'ENOENT e" legittimo "non c\'e", non "non ho potuto guardare"');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('describeManaged: candidato binario non verificabile (ELOOP) -> stesso fail, ma reason dice "not confirmed", mai "not found"', () => {
  const home = tmp();
  try {
    const binDir = path.join(home, '.local', 'bin'); fs.mkdirSync(binDir, { recursive: true });
    const candidate = path.join(binDir, 'vl');
    fs.symlinkSync(candidate, candidate); // ELOOP: il client c'e' ma non raggiungibile cosi'
    // vl.native ha auth 'none' -> authConfigured true: il reason e' deciso SOLO dal
    // binario (null), isolando la superficie del collasso dal percorso credenziali.
    const info = describeManaged({ client: 'vl', provider: 'native', model: '' }, { home, env: {} });
    assert.equal(info.configured, false, 'verdetto invariato: niente binario confermato -> non configurato');
    // I messaggi di questo file sono in inglese (convenzione per-file: doctor.js
    // parla italiano, describeManaged no). L'asserzione vincola il SIGNIFICATO —
    // "non ho potuto verificare" — non una frase in particolare.
    assert.match(info.reason, /could not be verified/i, 'il messaggio dice che non ha potuto verificare');
    assert.doesNotMatch(info.reason, /not found/i, 'non deve dire "not found" quando in realta\' non ha potuto guardare');
    assert.match(info.reason, /ELOOP/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// Punto 2 — parseEnvFile / parseProviderShellFile: catch (_) -> {} ingoiava
// EACCES/ELOOP insieme ai rifiuti deliberati. Una credenziale presente ma
// illeggibile veniva riportata come mancante. Misura: il file c'e', ma la sua
// directory padre e' 0o600 (senza execute) -> lstatSync EACCES.
test('parseEnvFile: credenziale presente ma ILLEGGIBILE (EACCES) -> stesso {}, ma out.blocked traccia EACCES, non "missing"', () => {
  const home = tmp();
  try {
    const dir = path.join(home, 'secrets'); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'ai.env');
    fs.writeFileSync(file, 'ZAI_API_KEY_A=super-secret\n', { mode: 0o600 });
    fs.chmodSync(dir, 0o600); // directory senza execute: lstatSync del figlio -> EACCES
    try {
      const blocked = [];
      const out = parseEnvFile(file, {}, { blocked });
      assert.deepEqual(out, {}, 'verdetto invariato: niente valori estratti (come per assente)');
      assert.ok(blocked.some((b) => b.path === file && /EACCES/.test(b.code)),
        'il file presente ma illeggibile va tracciato (EACCES), non collassato in "assente"');
    } finally { fs.chmodSync(dir, 0o700); } // ripristino per permettere la pulizia
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('describeManaged: credenziale presente ma illeggibile -> stesso fail (authConfigured false), ma reason dice "not verifiable", mai "missing — set it"', () => {
  const home = tmp();
  try {
    fakeClient(home, 'claude'); // binario valido: il reason e' deciso dalla credenziale
    const dir = path.join(home, 'secrets'); fs.mkdirSync(dir, { recursive: true });
    const secrets = path.join(dir, 'providers.env');
    fs.writeFileSync(secrets, 'ZAI_API_KEY_A=super-secret\n', { mode: 0o600 });
    fs.chmodSync(dir, 0o600); // EACCES: la credenziale c'e' ma non la possiamo leggere
    try {
      const info = describeManaged({ client: 'claude', provider: 'zai-a', model: 'glm-5.2[1m]' },
        { home, providerSecretsPath: secrets, env: {} });
      assert.equal(info.configured, false, 'verdetto invariato: non possiamo confermare la credenziale');
      assert.equal(info.authConfigured, false);
      assert.equal(info.credentialSource, 'unreadable', 'la fonte e" "unreadable", non "missing"');
      assert.match(info.reason, /not verifiable/i, 'il messaggio dice che non e\' verificabile');
      assert.doesNotMatch(info.reason, /set it on this device/i, 'non deve dire "missing — set it" quando il file c\'e ma e\' illeggibile');
      assert.match(info.reason, /EACCES/);
    } finally { fs.chmodSync(dir, 0o700); }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// Il tracciamento segue la FONTE, non la lettura. Il file legacy viene letto
// sempre, ma vale come fonte solo per i profili con legacySecrets: per gli altri
// la sua illeggibilita' non dice nulla sulla chiave cercata, e dichiararla
// "non verificabile" manda l'operatore a sistemare un permesso irrilevante
// mentre la chiave e' davvero assente. Rilievo di un audit indipendente, con il
// caso ricostruito.
test('describeManaged: un file legacy illeggibile non rende "unreadable" un profilo che non lo usa come fonte', () => {
  const home = tmp();
  try {
    fakeClient(home, 'claude');
    const dir = path.join(home, 'secrets'); fs.mkdirSync(dir, { recursive: true });
    const secrets = path.join(dir, 'providers.env');
    fs.writeFileSync(secrets, 'OLLAMA_API_KEY=irrilevante-per-questo-profilo\n', { mode: 0o600 });
    fs.chmodSync(dir, 0o600); // EACCES sul file legacy
    try {
      // openrouter non ha legacySecrets: providers.env non e' una sua fonte.
      const info = describeManaged({ client: 'claude', provider: 'openrouter', model: 'x' },
        { home, providerSecretsPath: secrets, env: {} });
      assert.equal(info.authConfigured, false, 'verdetto invariato: la chiave non c\'e');
      assert.equal(info.credentialSource, 'missing',
        'la chiave e davvero assente: un file che non e sua fonte non la rende "non verificabile"');
      assert.match(info.reason, /missing/i);
      assert.doesNotMatch(info.reason, /not verifiable/i, 'non deve nominare un file irrilevante per questa chiave');
    } finally { fs.chmodSync(dir, 0o700); }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// Controllo negativo: una credenziale davvero ASSENTE (ENOENT) resta "missing" e
// "set it on this device" — il discriminante e' CHI ha fallito, non il fatto che
// ci sia stata un'eccezione. Questo fissa che la correzione non ha spostato il
// verdetto del caso legittimo.
test('describeManaged: credenziale ASSENTE (ENOENT) -> "missing" + "set it on this device" (il caso legittimo resta invariato)', () => {
  const home = tmp();
  try {
    fakeClient(home, 'claude');
    const info = describeManaged({ client: 'claude', provider: 'zai-a', model: 'glm-5.2[1m]' },
      { home, providerSecretsPath: path.join(home, 'non-esiste.env'), env: {} });
    assert.equal(info.configured, false);
    assert.equal(info.credentialSource, 'missing');
    assert.match(info.reason, /set it on this device/);
    assert.doesNotMatch(info.reason, /non verificabile/i);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('launch ollama-cloud genera il catalogo con le capacita dichiarate (niente fallback metadata)', async () => {
  // Il warning «Model metadata ... not found» nasce in codex-vl quando il
  // lookup del catalogo fallisce (used_fallback_model_metadata). La prova che
  // il ramo launch lo elimina: gli args portano un model_catalog_json il cui
  // JSON contiene la voce del modello con contesto e modalita' vere.
  const { resolveManagedEngine: resolve } = require('../lib/fleet/managed.js');
  const home = tmp();
  try {
    fakeClient(home, 'codex-vl');
    const secrets = path.join(home, 'providers.env');
    fs.writeFileSync(secrets, 'OLLAMA_API_KEY=ollama-secret\n', { mode: 0o600 });
    const r = await resolve(
      { id: 'codex-vl.ollama-cloud', label: 'Ollama', managed: { client: 'codex-vl', provider: 'ollama-cloud', model: 'glm-5.3-flash' } },
      { id: 'cella-ollama' },
      { home, providerSecretsPath: secrets, env: {} },
    );
    assert.equal(r.ok, true, `resolve fallito: ${r.reason}`);
    const catArg = r.engine.args.find((a) => a.startsWith('model_catalog_json='));
    assert.ok(catArg, 'catalogo generato assente dagli args');
    const catPath = JSON.parse(catArg.slice('model_catalog_json='.length));
    const cat = JSON.parse(fs.readFileSync(catPath, 'utf8'));
    const entry = cat.models.find((m) => m.slug === 'glm-5.3-flash');
    assert.ok(entry, 'voce glm-5.3-flash assente dal catalogo generato');
    assert.equal(entry.context_window, 1000000, 'finestra non 1M');
    assert.deepEqual(entry.input_modalities, ['text', 'image'], 'vision non dichiarata');
    // parallel NON dichiarato dalla scheda: default conservativo false
    // finche' non misurato su device (rilievo audit 0314517).
    assert.equal(entry.supports_parallel_tool_calls, false, 'parallel deve restare conservativo');
    assert.ok(r.engine.args.includes('model_context_window=1000000'));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('launch ollama-cloud: generazione impossibile ricade sul file utente (no launch failure)', () => {
  // Audit 0314517 R2: se il path del catalogo generato e' occupato (es. da
  // una directory), customCatalogFor lancia — il launch NON deve fallire:
  // ricade sul file utente ~/.codex/ollama_cloud_model_catalog.json.
  const home = tmp();
  try {
    fakeClient(home, 'codex-vl');
    const stuck = path.join(home, '.nexuscrew', 'custom-catalogs', 'codex-vl.ollama-cloud.json');
    fs.mkdirSync(stuck, { recursive: true });
    const userCatalog = path.join(home, '.codex', 'ollama_cloud_model_catalog.json');
    fs.mkdirSync(path.dirname(userCatalog), { recursive: true });
    fs.writeFileSync(userCatalog, '{"models":[{"slug":"glm-5.2"}]}\n');
    const secrets = path.join(home, 'providers.env');
    fs.writeFileSync(secrets, 'OLLAMA_API_KEY=ollama-secret\n', { mode: 0o600 });
    const r = resolveManagedEngine(
      { id: 'codex-vl.ollama-cloud', label: 'Ollama', managed: { client: 'codex-vl', provider: 'ollama-cloud', model: 'glm-5.2' } },
      { id: 'Dev' },
      { home, providerSecretsPath: secrets, env: {} },
    );
    assert.equal(r.ok, true, `launch non deve fallire: ${r && r.reason}`);
    const catArg = r.engine.args.find((a) => a.startsWith('model_catalog_json='));
    assert.ok(catArg && catArg.includes('ollama_cloud_model_catalog.json'), `atteso fallback utente, trovato: ${catArg}`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
