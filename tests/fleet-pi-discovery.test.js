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
