'use strict';
// tests/fleet-custom-engine-model-listing.test.js — models declared for a
// custom engine must appear in the list the UI pickers are built from.
//
// WHY: `status()` and `definitions()` built `models` from the builtin catalog
// of the profile only (`profile.models`). A custom profile has no catalog, so
// the list stayed `[]` (or the bare pin for `pi`) even with models declared in
// `definitions.models[]`: the launcher accepted them, the picker never showed
// them. The right helper already existed (`declaredModelsFor`); the views did
// not call it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');

const DECLARED = ['model-b', 'model-a'];
const BASE_URL = 'http://127.0.0.1:1234';

function world(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-custom-listing-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.chmodSync(home, 0o700);
  fs.mkdirSync(path.join(home, 'Dev'));
  fs.mkdirSync(path.join(home, 'bin'));
  const defsPath = path.join(root, 'fleet.json');
  fs.writeFileSync(defsPath, JSON.stringify({ schemaVersion: 1, engines: [], cells: [] }));
  const tmuxBin = path.join(home, 'bin', 'tmux-fake');
  fs.writeFileSync(tmuxBin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(tmuxBin, 0o755);
  // The client binary must be found under the home, otherwise the engine is
  // not described as configured; the subject here is the LIST, not the boot.
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  for (const client of ['claude', 'pi']) {
    const bin = path.join(home, '.local', 'bin', client);
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(bin, 0o755);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { home, defsPath, tmuxBin };
}

const fleetFor = (w) => createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });

async function defineCustomEngine(fleet, { id, client, protocol, baseUrl, declare = DECLARED }) {
  await fleet.defineEngine({
    id, label: id,
    managed: {
      client, provider: 'custom', model: DECLARED[1], permissionPolicy: 'standard',
      displayName: `${client} local`, baseUrl, protocol, providerId: id.replace('.', '-'),
      envKey: 'LOCAL_API_KEY',
    },
  });
  for (const m of declare) await fleet.defineModel({ id: m, engine: id, contextWindow: 262144, maxTokens: 8192 });
}

const engineIn = (view, id) => view.engines.find((e) => e.id === id);

test('custom engine (claude): status() lists the declared models, not []', async (t) => {
  const w = world(t);
  const fleet = await fleetFor(w);
  await defineCustomEngine(fleet, { id: 'claude.local', client: 'claude', protocol: 'anthropic_messages', baseUrl: BASE_URL });

  const engine = engineIn(await fleet.status(), 'claude.local');
  assert.ok(engine, 'the engine must appear in the status');
  assert.equal(engine.kind, 'managed');
  assert.deepEqual(engine.models, DECLARED, 'the models declared for the engine are the picker list, in declaration order');
});

test('custom engine (claude): definitions().managedInfo.models lists the declared models', async (t) => {
  const w = world(t);
  const fleet = await fleetFor(w);
  await defineCustomEngine(fleet, { id: 'claude.local', client: 'claude', protocol: 'anthropic_messages', baseUrl: BASE_URL });

  const engine = engineIn(await fleet.definitions(), 'claude.local');
  assert.ok(engine && engine.managedInfo, 'the view must describe the managed engine');
  assert.deepEqual(engine.managedInfo.models, DECLARED);
});

test('custom engine (pi): status() lists the pin first, then the declared models', async (t) => {
  const w = world(t);
  const fleet = await fleetFor(w);
  await defineCustomEngine(fleet, { id: 'pi.local', client: 'pi', protocol: 'openai-completions', baseUrl: `${BASE_URL}/v1` });

  const engine = engineIn(await fleet.status(), 'pi.local');
  assert.ok(engine, 'the engine must appear in the status');
  assert.equal(engine.model, DECLARED[1]);
  assert.deepEqual(engine.models, [DECLARED[1], DECLARED[0]], 'pin first, declared models after, no duplicate');
});

test('custom engine (pi): the pin stays in the list even without declarations', async (t) => {
  const w = world(t);
  const fleet = await fleetFor(w);
  await defineCustomEngine(fleet, { id: 'pi.local', client: 'pi', protocol: 'openai-completions', baseUrl: `${BASE_URL}/v1`, declare: [] });

  const engine = engineIn(await fleet.status(), 'pi.local');
  assert.deepEqual(engine.models, [DECLARED[1]]);
});

test('custom engine without declarations: the list stays empty (nothing is invented)', async (t) => {
  const w = world(t);
  const fleet = await fleetFor(w);
  await fleet.defineEngine({
    id: 'claude.bare', label: 'bare',
    managed: {
      client: 'claude', provider: 'custom', model: 'anything', permissionPolicy: 'standard',
      displayName: 'bare', baseUrl: BASE_URL, protocol: 'anthropic_messages',
      providerId: 'claude-bare', envKey: 'LOCAL_API_KEY',
    },
  });

  assert.deepEqual(engineIn(await fleet.status(), 'claude.bare').models, []);
});

test('custom engine: legacy declarations on the profile are joined after the engine ones, once', async (t) => {
  const w = world(t);
  const fleet = await fleetFor(w);
  await defineCustomEngine(fleet, { id: 'claude.local', client: 'claude', protocol: 'anthropic_messages', baseUrl: BASE_URL });
  // Same id declared on the profile too (must not duplicate) plus a profile-only id.
  await fleet.defineModel({ id: DECLARED[0], engine: 'claude.custom', contextWindow: 262144, maxTokens: 8192 });
  await fleet.defineModel({ id: 'legacy-only', engine: 'claude.custom', contextWindow: 262144, maxTokens: 8192 });

  const expected = [...DECLARED, 'legacy-only'];
  assert.deepEqual(engineIn(await fleet.status(), 'claude.local').models, expected);
  assert.deepEqual(engineIn(await fleet.definitions(), 'claude.local').managedInfo.models, expected);
});

test('two custom engines of the same profile do not see each other\'s declarations', async (t) => {
  const w = world(t);
  const fleet = await fleetFor(w);
  await defineCustomEngine(fleet, { id: 'claude.local', client: 'claude', protocol: 'anthropic_messages', baseUrl: BASE_URL });
  await defineCustomEngine(fleet, { id: 'claude.other', client: 'claude', protocol: 'anthropic_messages', baseUrl: BASE_URL, declare: ['model-z'] });

  const status = await fleet.status();
  assert.deepEqual(engineIn(status, 'claude.local').models, DECLARED);
  assert.deepEqual(engineIn(status, 'claude.other').models, ['model-z']);
});
