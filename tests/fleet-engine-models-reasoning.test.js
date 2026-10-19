'use strict';
// tests/fleet-engine-models-reasoning.test.js — the discovery view must keep
// the operator's explicit `reasoning` answer, both true and false.
//
// definitions.js parses `reasoning` as a real boolean: `false` is an ANSWER,
// not an absence. The builtin adapter was rebuilding the user layer with
// `=== true` only, so `reasoning: false` declared for a model vanished before
// the merge and a provider answering `reasoning: true` overrode the operator's
// choice. Red/green: with the old adapter the view below answers `true` with
// `api` provenance; with the fix it answers `false` with `user` provenance.
//
// No provider is contacted: the HTTP layer is a fake fetch. The fake hostnames
// are RFC 2606 reserved (.test) and never resolved.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');

// A fleet whose only engine is a custom openai-compat one, with one model
// declared by the user. `reasoning` is whatever the caller wants to declare
// (or nothing at all, to check nothing gets invented).
async function fleetWithDeclaredModel(t, declaration) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-reasoning-'));
  fs.chmodSync(root, 0o700);
  const defsPath = path.join(root, 'fleet.json');
  fs.writeFileSync(defsPath, JSON.stringify({
    schemaVersion: 1,
    engines: [{
      id: 'api-a', label: 'api-a', managed: {
        client: 'codex-vl', provider: 'custom', model: 'm1', permissionPolicy: 'standard',
        displayName: 'api-a', baseUrl: 'https://api-a.example.test', protocol: 'openai_responses',
        envKey: 'REASONING_PROBE_KEY', providerId: 'api-a',
      },
    }],
    models: [{ id: 'm1', engine: 'api-a', ...declaration }],
    cells: [],
  }), { mode: 0o600 });
  const fleet = await createBuiltinFleet({
    home: root, fleetDefsPath: defsPath, protectSharedTmuxServer: false,
  });
  t.after(async () => {
    await fleet.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return fleet;
}

// The provider's own word for the same model, possibly contradicting the user.
const providerAnswers = (reasoning) => async () => ({
  ok: true, status: 200,
  json: async () => ({ data: [{ id: 'm1', ...(reasoning === undefined ? {} : { reasoning }) }] }),
});

const modelNamed = (view, id) => {
  const m = view.models.find((x) => x.id === id);
  assert.ok(m, `${id} must be in the discovery proposal`);
  return m;
};

test('user reasoning:false beats the provider answering true', async (t) => {
  const fleet = await fleetWithDeclaredModel(t, { reasoning: false });
  const view = await fleet.discoverEngineModels('api-a', { fetchImpl: providerAnswers(true) });
  const m = modelNamed(view, 'm1');
  assert.equal(m.reasoning, false, 'the explicit user answer is kept, not dropped');
  assert.equal(m.fieldSources?.reasoning, 'user', 'provenance must stay with the user layer');
});

test('user reasoning:true beats the provider answering false', async (t) => {
  const fleet = await fleetWithDeclaredModel(t, { reasoning: true });
  const view = await fleet.discoverEngineModels('api-a', { fetchImpl: providerAnswers(false) });
  const m = modelNamed(view, 'm1');
  assert.equal(m.reasoning, true);
  assert.equal(m.fieldSources?.reasoning, 'user');
});

test('a declaration without reasoning does not invent one: the provider fills it', async (t) => {
  // Keeping `false` must not turn into inventing values the user never chose:
  // an absent field still falls through to the lower layers.
  const fleet = await fleetWithDeclaredModel(t, {});
  const view = await fleet.discoverEngineModels('api-a', { fetchImpl: providerAnswers(true) });
  const m = modelNamed(view, 'm1');
  assert.equal(m.reasoning, true, 'absent user field: the provider word stands');
  assert.equal(m.fieldSources?.reasoning, 'api');
});
