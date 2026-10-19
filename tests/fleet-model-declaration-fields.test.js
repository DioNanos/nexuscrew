'use strict';
// tests/fleet-model-declaration-fields.test.js — the five model parameters the
// editor shows are the five the declaration stores: contextWindow, maxTokens,
// tools, vision, reasoning. Booleans are tri-state in the declaration file:
// true, false and absent are three different answers, and `false` must never
// collapse into "absent" (a catalog or API `true` would win over the operator).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');

const PROFILO = 'claude.alibaba-token-plan';
const FIVE = ['contextWindow', 'maxTokens', 'tools', 'vision', 'reasoning'];

function mondo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-model-fields-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const cwd = path.join(home, 'Dev');
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, 'bin'));
  const command = path.join(home, 'bin', 'finto-client');
  fs.writeFileSync(command, '#!/bin/sh\necho ok\n');
  fs.chmodSync(command, 0o755);
  const defsPath = path.join(root, 'fleet.json');
  fs.writeFileSync(defsPath, JSON.stringify({
    schemaVersion: 1,
    engines: [{
      id: 'myapi', label: 'My API', managed: {
        client: 'codex-vl', provider: 'custom', model: 'm-1', permissionPolicy: 'standard',
        displayName: 'My API', baseUrl: 'http://endpoint.example/v1', protocol: 'openai_responses',
        envKey: 'MY_API_KEY', providerId: 'my-api',
      },
    }],
    cells: [],
  }));
  const tmuxBin = path.join(home, 'bin', 'tmux-finto');
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
const letto = (w) => JSON.parse(fs.readFileSync(w.defsPath, 'utf8'));
const dichiarato = (w, id) => letto(w).models.find((m) => m.id === id);

test('define: the five parameters are written as declared, `false` included', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await fleet.defineModel({
    id: 'm-all', engine: PROFILO,
    contextWindow: 131072, maxTokens: 8192, tools: false, vision: true, reasoning: false,
  });
  assert.deepEqual(dichiarato(w, 'm-all'), {
    id: 'm-all', engine: PROFILO,
    contextWindow: 131072, maxTokens: 8192, tools: false, vision: true, reasoning: false,
  });
  // The exported view is the round-trip the backup writes: `false` must be
  // there, or a restore would silently turn it back into "absent".
  const view = fleet.definitions();
  assert.deepEqual(view.models.find((m) => m.id === 'm-all'), dichiarato(w, 'm-all'));
});

test('edit: each of the five parameters is patchable, and `false` survives a re-read', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await fleet.defineModel({ id: 'm-edit', engine: PROFILO, contextWindow: 131072 });
  await fleet.editModel('m-edit', PROFILO, { maxTokens: 16384, tools: true, vision: false, reasoning: false });
  let m = dichiarato(w, 'm-edit');
  assert.equal(m.maxTokens, 16384);
  assert.equal(m.tools, true);
  assert.equal(m.vision, false);
  assert.equal(m.reasoning, false);
  // Another write re-parses the whole file: the explicit `false` stays.
  await fleet.editModel('m-edit', PROFILO, { label: 'kept' });
  m = dichiarato(w, 'm-edit');
  assert.equal(m.vision, false);
  assert.equal(m.reasoning, false);
  assert.equal(m.contextWindow, 131072, 'a patch does not drop the other fields');
});

test('edit: tools and vision reject non-booleans, and accept an explicit false', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await fleet.defineModel({ id: 'm-bool', engine: PROFILO, tools: true });
  for (const [key, value] of [['tools', 'no'], ['vision', 1], ['reasoning', 'yes']]) {
    await assert.rejects(() => fleet.editModel('m-bool', PROFILO, { [key]: value }), (e) => e.status === 400);
  }
  await fleet.editModel('m-bool', PROFILO, { tools: false });
  assert.equal(dichiarato(w, 'm-bool').tools, false);
});

test('limits: edit-model rejects exactly what the parser rejects', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await fleet.defineModel({ id: 'm-lim', engine: PROFILO, contextWindow: 131072 });
  // The parser accepts 1024..100000000. The editor used to accept 1..∞, so a
  // value that passed the dialog failed the whole file on save.
  await assert.rejects(() => fleet.editModel('m-lim', PROFILO, { contextWindow: 1023 }), (e) => e.status === 400);
  await assert.rejects(() => fleet.editModel('m-lim', PROFILO, { maxTokens: 100000001 }), (e) => e.status === 400);
  await fleet.editModel('m-lim', PROFILO, { contextWindow: 1024, maxTokens: 100000000 });
  assert.equal(dichiarato(w, 'm-lim').contextWindow, 1024);
  assert.equal(dichiarato(w, 'm-lim').maxTokens, 100000000);
});

test('restore: a backup carrying `false` restores `false`, not "absent"', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  const portableEngine = {
    id: 'restored', label: 'Restored', rc: true,
    command: path.join(w.home, 'bin', 'finto-client'), args: [], envKeys: [],
    promptMode: 'flag', promptFlag: '--sp',
  };
  await fleet.restoreEngines([portableEngine], {
    models: [{
      id: 'm-restored', engine: PROFILO,
      contextWindow: 65536, maxTokens: 4096, tools: false, vision: true, reasoning: false,
    }],
  });
  const m = dichiarato(w, 'm-restored');
  assert.equal(m.tools, false);
  assert.equal(m.vision, true);
  assert.equal(m.reasoning, false);
  assert.deepEqual(fleet.definitions().models.find((x) => x.id === 'm-restored'), m);
});

test('discovery: the user layer projects all five fields, so a user `false` wins', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await fleet.defineModel({
    id: 'm-1', engine: 'myapi',
    contextWindow: 200000, maxTokens: 8192, tools: false, vision: true, reasoning: false,
  });
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const out = await fleet.discoverEngineModels('myapi', { fetchImpl });
  const row = out.models.find((m) => m.id === 'm-1');
  assert.ok(row, 'the declared model is in the proposal');
  for (const field of FIVE) {
    assert.ok(Object.hasOwn(row, field), `the user layer carries ${field}`);
    assert.equal(row.fieldSources[field], 'user', `${field} comes from the user`);
  }
  assert.equal(row.tools, false);
  assert.equal(row.reasoning, false);
});
