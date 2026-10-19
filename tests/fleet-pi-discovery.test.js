'use strict';
// Discovery and catalog defaults for engines that expose no listing endpoint.
// The proposal still carries the ids the operator knows (declared models and
// the profile backup), and the public catalog completes their fields by id.
// Nothing here may claim an API answer: `inApi` is absent, not false, and the
// authentication diagnosis reports no attempt.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');
const { PUBLIC_CATALOG_URL } = require('../lib/fleet/model-discovery.js');

function mondo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pi-disc-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const defsPath = path.join(root, 'fleet.json');
  fs.writeFileSync(defsPath, JSON.stringify({ schemaVersion: 1, engines: [], cells: [], models: [] }));
  const tmuxBin = path.join(home, 'tmux-finto');
  fs.writeFileSync(tmuxBin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(tmuxBin, 0o755);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { home, defsPath, tmuxBin };
}

const fleetDi = (w) => createBuiltinFleet({
  home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin, env: {},
  providerSecretsPath: path.join(w.home, '.nexuscrew', 'providers.env'),
  providerShellPath: path.join(w.home, '.config', 'ai-shell', 'providers.zsh'),
  providerKeysPath: path.join(w.home, '.config', 'keys', 'ai.env'),
  providerSecurePath: path.join(w.home, '.config', 'secure', '.env'),
  credentialsPath: path.join(w.home, '.nexuscrew', 'credentials.json'),
});

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const SNAPSHOT = {
  zai: { id: 'zai', name: 'Z.AI', models: { 'glm-5.3': { limit: { context: 1000000, output: 128000 }, tool_call: true, reasoning: true } } },
};

function catalogFetch(snapshot = SNAPSHOT) {
  const calls = [];
  const fn = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u === PUBLIC_CATALOG_URL) {
      return typeof snapshot === 'function' ? snapshot() : reply(200, snapshot);
    }
    throw new Error(`unexpected request: ${u}`);
  };
  fn.calls = calls;
  return fn;
}

test('an engine without a listing still carries its known ids and their catalog defaults', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await fleet.defineModel({ id: 'glm-5.3', engine: 'pi.native', tools: false });
  const fetchImpl = catalogFetch();
  const out = await fleet.discoverEngineModels('pi.native', { fetchImpl });

  assert.equal(out.supported, false);
  assert.equal(out.source, 'unsupported');
  const row = out.models.find((m) => m.id === 'glm-5.3');
  assert.ok(row, 'the declared id stays in the proposal');
  assert.equal(row.contextWindow, 1000000);
  assert.equal(row.maxTokens, 128000);
  assert.equal(row.tools, false, 'an explicit user false wins over the catalog true');
  assert.equal(row.fieldSources.contextWindow, 'public');
  assert.equal(row.fieldSources.tools, 'user');
  assert.ok(!Object.hasOwn(row, 'inApi'), 'no API answer means no inApi claim');
  assert.equal(out.auth.attempted, false);
  assert.ok(!Object.hasOwn(out.auth, 'cause'));
  assert.equal(out.publicCatalog.status, 'api');
  assert.deepEqual(fetchImpl.calls, [PUBLIC_CATALOG_URL], 'only the fixed public snapshot is read');
});

test('with no known id the catalog is not fetched at all', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  const fetchImpl = catalogFetch();
  const out = await fleet.discoverEngineModels('pi.native', { fetchImpl });
  assert.equal(out.supported, false);
  assert.deepEqual(out.models, []);
  assert.deepEqual(fetchImpl.calls, []);
  assert.equal(out.publicCatalog.status, 'skipped');
});

test('a forced refresh re-reads the snapshot; the normal answer uses its cache', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await fleet.defineModel({ id: 'glm-5.3', engine: 'pi.native' });
  const fetchImpl = catalogFetch();
  await fleet.discoverEngineModels('pi.native', { fetchImpl });
  await fleet.discoverEngineModels('pi.native', { fetchImpl });
  assert.equal(fetchImpl.calls.length, 1, 'the second call answers from the cached snapshot');
  await fleet.discoverEngineModels('pi.native', { fetchImpl, refresh: true });
  assert.equal(fetchImpl.calls.length, 2, 'refresh forces a fresh snapshot');
});

test('a catalog failure leaves the known ids present without invented fields', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await fleet.defineModel({ id: 'glm-5.3', engine: 'pi.native', contextWindow: 200000 });
  const fetchImpl = catalogFetch(() => reply(500, {}));
  const out = await fleet.discoverEngineModels('pi.native', { fetchImpl });
  const row = out.models.find((m) => m.id === 'glm-5.3');
  assert.ok(row);
  assert.equal(row.contextWindow, 200000);
  assert.equal(row.maxTokens, undefined);
  assert.ok(!Object.hasOwn(row, 'inApi'));
  assert.equal(out.publicCatalog.status, 'none');
});

// --- Resolved transports: the collector follows the profile's endpoint/wire --

function routedFetch() {
  const calls = [];
  const fn = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u === PUBLIC_CATALOG_URL) return reply(200, SNAPSHOT);
    if (u.includes('token-plan.ap-southeast-1.maas.aliyuncs.com')) return reply(200, { data: [{ id: 'qwen3.8-max' }] });
    if (u.includes('opencode.ai')) return reply(200, { data: [{ id: 'deepseek-v4-flash' }] });
    if (u.includes('127.0.0.1:11434') && u.endsWith('/api/tags')) return reply(200, { models: [{ name: 'llama-local' }] });
    if (u.includes('gw.example.test')) return reply(200, { data: [{ id: 'gw-model' }] });
    throw new Error(`unexpected request: ${u}`);
  };
  fn.calls = calls;
  return fn;
}

test('pi profiles with an explicit OpenAI-compatible endpoint use that collector', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  const fetchImpl = routedFetch();
  const alibaba = await fleet.discoverEngineModels('pi.alibaba-token-plan', { fetchImpl });
  assert.equal(alibaba.supported, true);
  assert.equal(alibaba.source, 'api');
  assert.ok(fetchImpl.calls.some((u) => u.includes('token-plan.ap-southeast-1.maas.aliyuncs.com') && u.endsWith('/models')));

  const opencode = await fleet.discoverEngineModels('pi.opencode-go', { fetchImpl });
  assert.equal(opencode.supported, true);
  assert.ok(fetchImpl.calls.some((u) => u.includes('opencode.ai') && u.endsWith('/models')));
});

test('pi Ollama uses the native collector, not the OpenAI-compatible one', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  const fetchImpl = routedFetch();
  const out = await fleet.discoverEngineModels('pi.ollama', { fetchImpl });
  assert.equal(out.supported, true);
  assert.ok(fetchImpl.calls.some((u) => u.includes('127.0.0.1:11434') && u.endsWith('/api/tags')));
  assert.ok(!fetchImpl.calls.some((u) => u.endsWith('/v1/models')));
});

test('a custom pi engine maps its hyphenated wire name and its own base URL', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await fleet.defineEngine({
    id: 'pi-gw', label: 'Pi gateway',
    managed: {
      client: 'pi', provider: 'custom', protocol: 'openai-completions',
      baseUrl: 'http://gw.example.test/v1', model: 'gw-model', permissionPolicy: 'standard',
      displayName: 'Gateway', envKey: 'GW_KEY', providerId: 'gw',
    },
  });
  const fetchImpl = routedFetch();
  const out = await fleet.discoverEngineModels('pi-gw', { fetchImpl });
  assert.equal(out.supported, true);
  assert.equal(out.models[0].id, 'gw-model');
  assert.ok(fetchImpl.calls.some((u) => u.startsWith('http://gw.example.test/v1/models')));
});

test('a native or login pi profile stays unsupported and is never probed', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await fleet.defineModel({ id: 'glm-5.3', engine: 'pi.zai' });
  const fetchImpl = routedFetch();
  const out = await fleet.discoverEngineModels('pi.zai', { fetchImpl });
  assert.equal(out.supported, false);
  assert.equal(out.models[0].id, 'glm-5.3');
  assert.equal(out.models[0].contextWindow, 1000000, 'the catalog still fills the known id');
  assert.deepEqual(fetchImpl.calls, [PUBLIC_CATALOG_URL], 'no listing probe for a native provider');
});

// The active model of an engine is part of what the operator already knows:
// when it is the ONLY known id, it must receive the catalog defaults too.
test('the active model alone is a known id and gets the catalog defaults', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await fleet.defineEngine({
    id: 'active-only', label: 'Active only',
    managed: { client: 'pi', provider: 'native', model: 'glm-5.3', permissionPolicy: 'standard' },
  });
  const fetchImpl = catalogFetch();
  const out = await fleet.discoverEngineModels('active-only', { fetchImpl });

  assert.equal(out.supported, false);
  assert.deepEqual(out.models.map((m) => m.id), ['glm-5.3']);
  const row = out.models[0];
  assert.equal(row.contextWindow, 1000000);
  assert.equal(row.maxTokens, 128000);
  assert.equal(row.fieldSources.contextWindow, 'public');
  assert.ok(!Object.hasOwn(row, 'inApi'));
  assert.deepEqual(fetchImpl.calls, [PUBLIC_CATALOG_URL], 'one snapshot fetch, no listing probe');
});

test('with another known id the active model is neither added nor reordered', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await fleet.defineEngine({
    id: 'active-plus', label: 'Active plus',
    managed: { client: 'pi', provider: 'native', model: 'glm-5.3', permissionPolicy: 'standard' },
  });
  await fleet.defineModel({ id: 'other-model', engine: 'active-plus' });
  const out = await fleet.discoverEngineModels('active-plus', { fetchImpl: catalogFetch() });
  assert.deepEqual(out.models.map((m) => m.id), ['other-model']);
});

test('no known id and no active model means no catalog fetch', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  const fetchImpl = catalogFetch();
  const out = await fleet.discoverEngineModels('pi.native', { fetchImpl });
  assert.deepEqual(out.models, []);
  assert.deepEqual(fetchImpl.calls, []);
});

// Model ids that the fleet file accepts may carry a marker such as `[1m]`.
// Discovery must keep them intact: never strip the marker, never drop the row.
const MARKED_SNAPSHOT = {
  zai: { id: 'zai', name: 'Z.AI', models: { 'sonnet[1m]': { limit: { context: 1000000, output: 64000 } } } },
};

test('an active model with a bracketed marker keeps the row and gets exact-match defaults', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await fleet.defineEngine({
    id: 'marked', label: 'Marker',
    managed: { client: 'claude', provider: 'native', model: 'sonnet[1m]', permissionPolicy: 'standard' },
  });
  const fetchImpl = catalogFetch(MARKED_SNAPSHOT);
  const out = await fleet.discoverEngineModels('marked', { fetchImpl });
  assert.deepEqual(out.models.map((m) => m.id), ['sonnet[1m]']);
  assert.equal(out.models[0].contextWindow, 1000000);
  assert.equal(out.models[0].maxTokens, 64000);
  assert.equal(out.models[0].fieldSources.contextWindow, 'public');
  assert.ok(!Object.hasOwn(out.models[0], 'inApi'));
});

test('the same marked id without a catalog match stays as a row without fields', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await fleet.defineEngine({
    id: 'marked-miss', label: 'Marker miss',
    managed: { client: 'claude', provider: 'native', model: 'sonnet[1m]', permissionPolicy: 'standard' },
  });
  const before = fs.readFileSync(w.defsPath, 'utf8');
  const out = await fleet.discoverEngineModels('marked-miss', { fetchImpl: catalogFetch() });
  assert.deepEqual(out.models.map((m) => m.id), ['sonnet[1m]']);
  assert.equal(out.models[0].contextWindow, undefined);
  assert.equal(fs.readFileSync(w.defsPath, 'utf8'), before, 'discovery writes nothing');
});

test('a declared model with a bracketed marker survives the merge', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await fleet.defineModel({ id: 'glm-5.3[1m]', engine: 'pi.native', tools: false });
  const out = await fleet.discoverEngineModels('pi.native', { fetchImpl: catalogFetch() });
  const row = out.models.find((m) => m.id === 'glm-5.3[1m]');
  assert.ok(row, 'the declared marked id is in the proposal');
  assert.equal(row.tools, false);
});

test('an API id with a space or a control byte is still rejected', async () => {
  const { mergeModelRecords } = require('../lib/fleet/model-discovery.js');
  const rows = mergeModelRecords({ apiModels: [{ id: 'bad id' }, { id: 'bad\u0001id' }, { id: 'good-id' }] });
  assert.deepEqual(rows.map((m) => m.id), ['good-id']);
});
