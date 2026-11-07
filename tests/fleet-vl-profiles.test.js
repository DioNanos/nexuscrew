'use strict';
// The model of a `vl.native` cell is chosen among the profiles of the node
// that runs it, and a profile name goes in VL_MODEL only when the binary that
// will run declares it reads one.
//
// The binaries here are fakes with real processes: they answer `--version`,
// `status` and `models --json` from files next to them, and log argv and the
// variables they were started with, so the tests prove WHICH binary was asked,
// with WHICH environment, and what came out. The profile inventory never
// reaches a parser of the vl configuration inside NexusCrew: the documents are
// the ones the binary prints. Every secret here is a fabricated canary.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describeManaged, resolveManagedEngine, normalizeManagedSpec } = require('../lib/fleet/managed.js');
const vlProfiles = require('../lib/fleet/vl-profiles.js');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');
const { atomicWrite } = require('../lib/fleet/definitions.js');

const CANARY = 'CANARY-KEY-9f3a1c-NOT-A-REAL-KEY';

const FAKE_VL = `#!/bin/sh
D="$(dirname "$0")"
echo "$* | XDG_CONFIG_HOME=$XDG_CONFIG_HOME VL_MODEL=\${VL_MODEL-unset} VL_PROVIDER=\${VL_PROVIDER-unset} FAKE_PASS_KEY=\${FAKE_PASS_KEY-unset}" >> "$D/calls.log"
case "$1" in
  --version) echo "vl 0.4.0" ;;
  status) if [ -f "$D/status.json" ]; then cat "$D/status.json"; else exit 1; fi ;;
  models) if [ -f "$D/models.json" ]; then cat "$D/models.json"; else exit 1; fi ;;
  *) exit 0 ;;
esac
`;

const profile = (id, model, extra = {}) => ({
  id, provider: 'anthropic-bearer', model, context_window: 1000000, max_output_tokens: 131072,
  supported_efforts: [], source: 'config', key: 'present', auth_surface: null, ...extra,
});

// The eight profiles of the fleet, as `vl models --json` lists them: accounts A
// and P share the model of two profiles.
function eight(over = {}) {
  return {
    schema_version: 1,
    inventory: 'config',
    active: { profile: 'zai-P-glm53', source: 'config_default' },
    active_error: null,
    preset_names_resolvable: true,
    excluded: { not_assembled: 0, invalid_identifier: 0 },
    profiles: [
      profile('a-opus', 'claude-opus-5-5', { provider: 'anthropic' }),
      profile('a-sonnet', 'claude-sonnet-5-5', { provider: 'anthropic' }),
      profile('a-haiku', 'claude-haiku-5-5', { provider: 'anthropic' }),
      profile('o-ds41flash', 'deepseek-v4.1-flash:1017', { provider: 'openai-compat' }),
      profile('zai-A-glm53', 'glm-5.3', { key: 'present' }),
      profile('zai-P-glm53', 'glm-5.3', { key: 'absent' }),
      profile('zai-A-glm53f', 'glm-5.3-flash'),
      profile('zai-P-glm53f', 'glm-5.3-flash'),
    ],
    ...over,
  };
}

const NEW_STATUS = { schema_version: 1, capabilities: { model_selector: 'profile' } };
const OLD_STATUS = { schema_version: 1, capabilities: {} };

function world({ status = NEW_STATUS, models = eight(), catalog = '[profiles.zai-P-glm53]\nmodel = "glm-5.3"\n[profiles.zai-A-glm53]\nmodel = "glm-5.3"\n' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlprof-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const operatorConfig = path.join(home, '.config');
  fs.mkdirSync(path.join(operatorConfig, 'vl'), { recursive: true });
  fs.writeFileSync(path.join(operatorConfig, 'vl', 'config.toml'), catalog);
  const bin = fake(path.join(root, 'bin-a'), status, models);
  // the PATH binary only lets `configured` hold; the declared vlBinary is what runs
  const pathBin = path.join(home, '.local', 'bin', 'vl');
  fs.writeFileSync(pathBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(pathBin, 0o755);
  return { root, home, bin, dir: path.dirname(bin) };
}

function fake(dir, status, models) {
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'vl');
  fs.writeFileSync(bin, FAKE_VL, { mode: 0o755 });
  fs.chmodSync(bin, 0o755);
  setDoc(dir, 'status.json', status);
  setDoc(dir, 'models.json', models);
  return bin;
}

function setDoc(dir, name, doc) {
  const file = path.join(dir, name);
  if (doc === null || doc === undefined) { fs.rmSync(file, { force: true }); return; }
  fs.writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc));
}

const calls = (dir) => {
  try { return fs.readFileSync(path.join(dir, 'calls.log'), 'utf8').trim().split('\n').filter(Boolean); } catch (_) { return []; }
};

const vlNative = (extra = {}) => ({ client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard', ...extra });

function launch(w, managed, { cell = { id: 'CellaProva' }, env = {}, cfg = {} } = {}) {
  return resolveManagedEngine({ id: 'vl.native', managed },
    cell, { home: w.home, platform: 'linux', env: { XDG_CONFIG_HOME: path.join(w.home, '.config'), ...env }, ...cfg });
}

function describe(w, managed = vlNative({ vlBinary: w.bin }), cfg = {}) {
  return describeManaged(managed, {
    home: w.home, platform: 'linux', env: { XDG_CONFIG_HOME: path.join(w.home, '.config') },
    withVlProfiles: true, vlProfilesNoCache: true, ...cfg,
  });
}

const cleanup = (w) => fs.rmSync(w.root, { recursive: true, force: true });
const argsOf = (r) => r.engine.args || [];

// ---- capability gate -------------------------------------------------------

test('a binary that declares the selector gets the profile id in VL_MODEL', () => {
  const w = world();
  try {
    const r = launch(w, vlNative({ vlBinary: w.bin, model: 'zai-P-glm53' }));
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.engine.env.VL_MODEL, 'zai-P-glm53');
    assert.ok(!argsOf(r).includes('-p'), 'no bridge when the binary reads the name');
    assert.equal(r.info.vlRuntime.selector.mode, 'profile');
    assert.equal(r.info.vlRuntime.selector.profile, 'zai-P-glm53');
    assert.ok(calls(w.dir).some((c) => c.startsWith('status')), 'the capability was asked of the real binary');
  } finally { cleanup(w); }
});

test('an old binary never gets a profile name in VL_MODEL: the bridge -p carries it', () => {
  const w = world({ status: OLD_STATUS });
  try {
    const r = launch(w, vlNative({ vlBinary: w.bin, model: 'zai-P-glm53' }));
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.engine.env.VL_MODEL, undefined, 'the name would be read as a model id');
    assert.deepEqual(argsOf(r).slice(argsOf(r).indexOf('-p'), argsOf(r).indexOf('-p') + 2), ['-p', 'zai-P-glm53']);
    assert.equal(r.info.vlRuntime.selector.mode, 'bridge');
    assert.ok(!calls(w.dir).some((c) => c.startsWith('models')), 'no inventory is read from a binary without the capability');
  } finally { cleanup(w); }
});

test('a vl status that does not answer is an old binary, whatever its version says', () => {
  for (const status of [null, 'not json', '[]', '{"capabilities":{"model_selector":"model"}}', '{"capabilities":{"model_selector":true}}', '{}']) {
    const w = world({ status });
    try {
      const r = launch(w, vlNative({ vlBinary: w.bin, model: 'zai-P-glm53' }));
      assert.equal(r.ok, true, `${status}: ${r.reason}`);
      assert.equal(r.engine.env.VL_MODEL, undefined, `${status}`);
      assert.equal(r.info.vlRuntime.selector.mode, 'bridge', `${status}`);
    } finally { cleanup(w); }
  }
});

test('an old binary with a value that is not a profile of the catalog keeps today\'s raw model', () => {
  const w = world({ status: null });
  try {
    const r = launch(w, vlNative({ vlBinary: w.bin, model: 'claude-opus-5-5' }));
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.engine.env.VL_MODEL, 'claude-opus-5-5');
    assert.ok(!argsOf(r).includes('-p'));
    assert.equal(r.info.vlRuntime.selector.mode, 'raw');
  } finally { cleanup(w); }
});

test('the version is never consulted: a high version without the capability is old', () => {
  const w = world({ status: { schema_version: 1, version: '9.9.9', capabilities: {} } });
  try {
    const r = launch(w, vlNative({ vlBinary: w.bin, model: 'zai-A-glm53' }), { cfg: { vlVersionProbe: () => 'vl 9.9.9\n' } });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.engine.env.VL_MODEL, undefined);
    assert.equal(r.info.vlRuntime.selector.mode, 'bridge');
  } finally { cleanup(w); }
});

test('the per-cell model override goes through the same gate', () => {
  const w = world();
  try {
    const r = launch(w, vlNative({ vlBinary: w.bin }), { cell: { id: 'CellaProva', model: 'zai-A-glm53' } });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.engine.env.VL_MODEL, 'zai-A-glm53');
    const bad = launch(w, vlNative({ vlBinary: w.bin }), { cell: { id: 'CellaProva', model: 'no-such-profile' } });
    assert.equal(bad.ok, false);
  } finally { cleanup(w); }
});

// ---- the inventory of the right node ---------------------------------------

test('the list is the one of the binary that will run, not another node\'s', () => {
  const w = world();
  try {
    const other = fake(path.join(w.root, 'bin-b'), NEW_STATUS, eight({ profiles: [profile('only-here', 'node-b-model')] }));
    const a = describe(w, vlNative({ vlBinary: w.bin }));
    const b = describe(w, vlNative({ vlBinary: other }));
    assert.equal(a.vlProfiles.state, 'ready');
    assert.equal(a.vlProfiles.options.length, 8);
    assert.deepEqual(b.vlProfiles.options.map((o) => o.value), ['only-here']);
    // each binary was asked, and only that one
    assert.ok(calls(path.dirname(other)).some((c) => c.startsWith('models --json')));
    assert.ok(calls(w.dir).some((c) => c.startsWith('models --json')));
    // a profile of node A is not selectable on node B
    const r = launch(w, vlNative({ vlBinary: other, model: 'zai-A-glm53' }));
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /non e' fra i profili del nodo \(only-here\)/);
  } finally { cleanup(w); }
});

test('the preflight asks the binary with the cell\'s own environment', () => {
  const w = world();
  try {
    const r = launch(w, vlNative({ vlBinary: w.bin, model: 'a-opus' }));
    assert.equal(r.ok, true, r.reason);
    const cellConfig = r.engine.env.XDG_CONFIG_HOME;
    assert.ok(cellConfig && cellConfig.includes('nexuscrew') || cellConfig, 'the cell has its own config home');
    const models = calls(w.dir).find((c) => c.startsWith('models --json'));
    assert.ok(models.includes(`XDG_CONFIG_HOME=${cellConfig}`), `inventory read with the cell's environment: ${models}`);
    // the variables that decide WHAT is chosen are not part of the probe
    assert.ok(models.includes('VL_MODEL=unset') && models.includes('VL_PROVIDER=unset'), models);
  } finally { cleanup(w); }
});

test('the names an engine passes through reach the probe, by name, as the cell gets them', () => {
  const w = world();
  try {
    const r = launch(w, vlNative({ vlBinary: w.bin, model: 'a-opus', envPassthrough: ['FAKE_PASS_KEY'] }), { env: { FAKE_PASS_KEY: CANARY } });
    assert.equal(r.ok, true, r.reason);
    const models = calls(w.dir).find((c) => c.startsWith('models --json'));
    assert.ok(models.includes(`FAKE_PASS_KEY=${CANARY}`), 'the probe sees what the cell sees');
  } finally { cleanup(w); }
});

// ---- A and P, key state, listing -------------------------------------------

test('accounts A and P of one model stay two options, labelled `<model> · <id>`', () => {
  const w = world();
  try {
    const info = describe(w);
    assert.equal(info.vlProfiles.state, 'ready');
    const glm = info.vlProfiles.options.filter((o) => o.model === 'glm-5.3');
    assert.deepEqual(glm.map((o) => o.value).sort(), ['zai-A-glm53', 'zai-P-glm53']);
    assert.deepEqual(glm.map((o) => o.label).sort(), ['glm-5.3 · zai-A-glm53', 'glm-5.3 · zai-P-glm53']);
    assert.equal(info.vlProfiles.options.length, 8, 'only the declared profiles, no preset added');
    assert.equal(new Set(info.vlProfiles.options.map((o) => o.value)).size, 8);
  } finally { cleanup(w); }
});

test('a profile with no key is listed, marked, and the launch is not refused for it', () => {
  const w = world();
  try {
    const info = describe(w);
    assert.equal(info.vlProfiles.options.find((o) => o.value === 'zai-P-glm53').key, 'absent');
    assert.equal(info.vlProfiles.options.find((o) => o.value === 'zai-A-glm53').key, 'present');
    const r = launch(w, vlNative({ vlBinary: w.bin, model: 'zai-P-glm53' }));
    assert.equal(r.ok, true, 'the runtime says what is missing; this preflight only reports it');
    assert.equal(r.info.vlRuntime.selector.key, 'absent');
  } finally { cleanup(w); }
});

test('the declared exclusions are carried to the UI, and presets are not added', () => {
  const w = world({ models: eight({ excluded: { not_assembled: 1, invalid_identifier: 2 } }) });
  try {
    const info = describe(w);
    assert.deepEqual(info.vlProfiles.excluded, { notAssembled: 1, invalidIdentifier: 2 });
    assert.equal(info.vlProfiles.presetNamesResolvable, true);
    assert.ok(!info.vlProfiles.options.some((o) => o.value === 'zai' || o.source === 'preset'));
    // a preset name the runtime resolves by name is not offered, and the preflight
    // does not accept what the inventory does not hold
    const r = launch(w, vlNative({ vlBinary: w.bin, model: 'zai' }));
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /non e' fra i profili del nodo/);
  } finally { cleanup(w); }
});

// ---- the preflight ----------------------------------------------------------

test('a selector the inventory does not hold refuses the launch, clearly', () => {
  const w = world();
  try {
    const r = launch(w, vlNative({ vlBinary: w.bin, model: 'ghost-profile' }));
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /"ghost-profile" non e' fra i profili del nodo \(a-opus, a-sonnet/);
    assert.match(String(r.reason), /avvio rifiutato/);
  } finally { cleanup(w); }
});

test('an ambiguous model refuses the launch and names the profiles; the profile name passes', () => {
  const w = world();
  try {
    const r = launch(w, vlNative({ vlBinary: w.bin, model: 'glm-5.3' }));
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /"glm-5.3" e' ambiguo: zai-A-glm53, zai-P-glm53/);
    const ok = launch(w, vlNative({ vlBinary: w.bin, model: 'zai-A-glm53' }));
    assert.equal(ok.ok, true, ok.reason);
  } finally { cleanup(w); }
});

test('the model of exactly one profile selects it, as the runtime does', () => {
  const w = world();
  try {
    const r = launch(w, vlNative({ vlBinary: w.bin, model: 'claude-opus-5-5' }));
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.engine.env.VL_MODEL, 'claude-opus-5-5');
    assert.equal(r.info.vlRuntime.selector.by, 'model');
    assert.equal(r.info.vlRuntime.selector.profile, 'a-opus');
  } finally { cleanup(w); }
});

test('a name that is not shaped like an identifier is never echoed in the refusal', () => {
  const w = world();
  try {
    const hostile = 'x'.repeat(60) + ' https://user:' + CANARY + '@host.invalid/p';
    const r = launch(w, vlNative({ vlBinary: w.bin, model: hostile }));
    assert.equal(r.ok, false);
    assert.ok(!String(r.reason).includes(CANARY), r.reason);
    assert.ok(!String(r.reason).includes('host.invalid'), r.reason);
  } finally { cleanup(w); }
});

test('an unknown schema is refused whole: no list, and the launch says it cannot verify', () => {
  const w = world({ models: { ...eight(), schema_version: 2 } });
  try {
    const info = describe(w);
    assert.equal(info.vlProfiles.state, 'invalid');
    assert.deepEqual(info.vlProfiles.options, []);
    assert.match(info.vlProfiles.reason, /schema_version is not 1/);
    const r = launch(w, vlNative({ vlBinary: w.bin, model: 'a-opus' }));
    assert.equal(r.ok, false);
    assert.match(String(r.reason), /inventario dei profili di vl non utilizzabile/);
  } finally { cleanup(w); }
});

test('an inventory outside its vocabulary is refused by field, without echoing the value', () => {
  const hostile = `https://u:${CANARY}@h.invalid`;
  const bad = [
    ['key', { ...eight(), profiles: [profile('a', 'm', { key: hostile })] }, /profiles\[0\]\.key/],
    ['source', { ...eight(), profiles: [profile('a', 'm', { source: hostile })] }, /profiles\[0\]\.source/],
    ['provider', { ...eight(), profiles: [profile('a', 'm', { provider: hostile })] }, /profiles\[0\]\.provider/],
    ['model', { ...eight(), profiles: [profile('a', hostile)] }, /profiles\[0\]\.model/],
    ['id', { ...eight(), profiles: [profile(hostile, 'm')] }, /profiles\[0\]\.id/],
    ['surface', { ...eight(), profiles: [profile('a', 'm', { auth_surface: hostile })] }, /profiles\[0\]\.auth_surface/],
    ['inventory', { ...eight(), inventory: hostile }, /inventory is outside/],
    ['active', { ...eight(), active: { profile: hostile, source: 'flag' } }, /active\.profile/],
    ['active source', { ...eight(), active: { profile: 'a', source: hostile } }, /active\.source/],
    ['active_error', { ...eight(), active_error: hostile }, /active_error/],
    ['contract field', (() => { const d = eight(); delete d.preset_names_resolvable; return d; })(), /preset_names_resolvable/],
    ['excluded', (() => { const d = eight(); delete d.excluded; return d; })(), /excluded/],
    ['duplicate id', { ...eight(), profiles: [profile('a', 'm'), profile('a', 'n')] }, /profiles\[1\]\.id is repeated/],
    ['too many', { ...eight(), profiles: Array.from({ length: 300 }, (_, i) => profile(`p${i}`, 'm')) }, /bounded list/],
    ['context', { ...eight(), profiles: [profile('a', 'm', { context_window: -1 })] }, /context_window/],
    ['path model', { ...eight(), profiles: [profile('a', '/home/someone/secret-model')] }, /profiles\[0\]\.model/],
  ];
  for (const [name, doc, expected] of bad) {
    const out = vlProfiles.validateInventory(doc);
    assert.equal(out.ok, false, name);
    assert.match(out.reason, expected, name);
    assert.ok(!out.reason.includes(CANARY), `${name}: the value is not echoed`);
  }
});

// ---- nothing of the key leaves ----------------------------------------------

test('no key value reaches the answer: extra fields of the document are dropped', () => {
  const doc = eight();
  doc.profiles[0] = { ...doc.profiles[0], api_key: CANARY, base_url: `https://u:${CANARY}@h.invalid`, api_key_env: 'CANARY_VAR', system: CANARY };
  doc.secrets = { ZAI_API_KEY: CANARY };
  doc.env = { HOME: '/home/someone', K: CANARY };
  const w = world({ models: doc });
  try {
    const info = describe(w, vlNative({ vlBinary: w.bin, envPassthrough: ['FAKE_PASS_KEY'] }), { env: { XDG_CONFIG_HOME: path.join(w.home, '.config'), FAKE_PASS_KEY: CANARY } });
    assert.equal(info.vlProfiles.state, 'ready');
    const wire = JSON.stringify(info);
    assert.ok(!wire.includes(CANARY), 'canary in the answer');
    assert.ok(!wire.includes('h.invalid') && !wire.includes('/home/someone'), wire);
    // the validated inventory itself is already value-free: it is rebuilt from a
    // whitelist, not filtered afterwards
    const validated = vlProfiles.validateInventory(doc);
    assert.equal(validated.ok, true);
    assert.deepEqual(Object.keys(validated.inventory.profiles[0]).sort(), ['contextWindow', 'id', 'key', 'maxOutputTokens', 'model', 'provider', 'source']);
    assert.ok(!JSON.stringify(validated).includes(CANARY));
    const keys = Object.keys(info.vlProfiles.options[0]).sort();
    assert.deepEqual(keys, ['contextWindow', 'key', 'label', 'maxOutputTokens', 'model', 'provider', 'source', 'value']);
    // and the launch diagnostic carries a state, never a value
    const r = launch(w, vlNative({ vlBinary: w.bin, model: 'a-opus', envPassthrough: ['FAKE_PASS_KEY'] }), { env: { FAKE_PASS_KEY: CANARY } });
    assert.equal(r.ok, true, r.reason);
    assert.ok(!JSON.stringify(r.info).includes(CANARY), 'canary in the diagnostics');
  } finally { cleanup(w); }
});

// ---- the variants that are not vl.native stay as they are -------------------

test('a remote variant keeps the raw model and never asks the binary', () => {
  const w = world();
  try {
    const r = launch(w, { client: 'vl', provider: 'anthropic', model: 'claude-opus-5-5', permissionPolicy: 'standard', vlBinary: w.bin }, { env: { VL_API_KEY: CANARY } });
    assert.ok(!JSON.stringify(r.info || {}).includes(CANARY));
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.engine.env.VL_MODEL, 'claude-opus-5-5');
    assert.ok(r.engine.env.VL_PROVIDER, 'the pair of the variant stays authoritative');
    assert.deepEqual(calls(w.dir).filter((c) => c.startsWith('status') || c.startsWith('models')), []);
    const info = describe(w, { client: 'vl', provider: 'anthropic', model: '', permissionPolicy: 'standard', vlBinary: w.bin });
    assert.equal(info.vlProfiles, undefined, 'no list for a remote variant');
  } finally { cleanup(w); }
});

test('a fixed vlProfile keeps its path and never asks the binary', () => {
  const w = world();
  try {
    const r = launch(w, vlNative({ vlBinary: w.bin, vlProfile: 'zai-A-glm53', model: 'whatever-raw' }));
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.engine.env.VL_MODEL, 'whatever-raw');
    assert.deepEqual(calls(w.dir).filter((c) => c.startsWith('status') || c.startsWith('models')), []);
    const info = describe(w, vlNative({ vlBinary: w.bin, vlProfile: 'zai-A-glm53' }));
    assert.equal(info.vlProfiles.state, 'unsupported');
  } finally { cleanup(w); }
});

test('with no model chosen nothing is asked: profile, selected.toml or default decide', () => {
  const w = world();
  try {
    const r = launch(w, vlNative({ vlBinary: w.bin }));
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.engine.env.VL_MODEL, undefined);
    assert.deepEqual(calls(w.dir).filter((c) => c.startsWith('status') || c.startsWith('models')), []);
  } finally { cleanup(w); }
});

test('without the opt-in the description never spawns the binary', () => {
  const w = world();
  try {
    const info = describeManaged(vlNative({ vlBinary: w.bin }), { home: w.home, platform: 'linux', env: {} });
    assert.equal(info.vlProfiles, undefined);
    assert.deepEqual(calls(w.dir), []);
  } finally { cleanup(w); }
});

test('a binary that does not answer is described as old, with a reason, not as an error', () => {
  const w = world({ status: null });
  try {
    const info = describe(w);
    assert.equal(info.vlProfiles.state, 'old');
    assert.deepEqual(info.vlProfiles.options, []);
    assert.match(info.vlProfiles.reason, /does not answer/);
  } finally { cleanup(w); }
});

test('an ambient VL_MODEL, VL_PROVIDER or VL_BASE_URL of the service is not part of the probe', () => {
  const w = world();
  try {
    const r = launch(w, vlNative({ vlBinary: w.bin, model: 'a-opus' }), {
      env: { VL_MODEL: 'ambient-model', VL_PROVIDER: 'anthropic', VL_BASE_URL: 'https://ambient.invalid' },
    });
    assert.equal(r.ok, true, r.reason);
    const models = calls(w.dir).find((c) => c.startsWith('models --json'));
    assert.ok(models.includes('VL_MODEL=unset') && models.includes('VL_PROVIDER=unset'), models);
  } finally { cleanup(w); }
});

// ---- what the real fleet hands to the UI and to nc_status -------------------

async function fleetFor(w, managed) {
  const defsPath = path.join(w.root, 'fleet.json');
  const cwd = path.join(w.home, 'Cella');
  fs.mkdirSync(cwd, { recursive: true });
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{ id: 'vl.native', label: 'VL', rc: false, managed }],
    cells: [{ id: 'Cella', tmuxSession: 'cloud-Cella', cwd, engine: 'vl.native', boot: false }],
  });
  return createBuiltinFleet({
    home: w.home, fleetDefsPath: defsPath, tmuxBin: '/bin/true',
    env: { XDG_CONFIG_HOME: path.join(w.home, '.config') },
  });
}

test('the definitions and the status carry the list of the node, ids as models, nothing else', async () => {
  const w = world();
  try {
    const fleet = await fleetFor(w, vlNative({ vlBinary: w.bin }));
    const defs = fleet.definitions();
    const engine = defs.engines.find((e) => e.id === 'vl.native');
    assert.equal(engine.managedInfo.vlProfiles.state, 'ready');
    assert.equal(engine.managedInfo.vlProfiles.options.length, 8);
    const st = await fleet.status();
    const row = st.engines.find((e) => e.id === 'vl.native');
    assert.deepEqual(row.models, eight().profiles.map((p) => p.id), 'what is saved is the profile id');
    assert.equal(row.vlProfiles.state, 'ready');
    assert.ok(!JSON.stringify([defs, st]).includes(CANARY));
    await fleet.close();
  } finally { cleanup(w); }
});

test('with an old binary the status keeps its plain models and says why there is no list', async () => {
  const w = world({ status: OLD_STATUS });
  try {
    const fleet = await fleetFor(w, vlNative({ vlBinary: w.bin }));
    const st = await fleet.status();
    const row = st.engines.find((e) => e.id === 'vl.native');
    assert.equal(row.vlProfiles.state, 'old');
    assert.ok(!row.models.includes('a-opus'));
    await fleet.close();
  } finally { cleanup(w); }
});


// ---- the selector is opaque: model aliases never rewrite a profile id --------

const LEGACY = 'qwen3.8-max-preview'; // a legacy MODEL alias of qwen3.8-max
const RENAMED = 'qwen3.8-max';

function aliasWorld(ids) {
  const profiles = [];
  if (ids.includes(LEGACY)) profiles.push(profile(LEGACY, 'chosen-original'));
  if (ids.includes(RENAMED)) profiles.push(profile(RENAMED, 'other-account'));
  const catalog = profiles.map((p) => `[profiles.${p.id}]\nmodel = "${p.model}"\n`).join('');
  return world({ models: eight({ profiles }), catalog });
}

test('R1: both ids present, the saved value, the final env and the match stay the exact id', () => {
  const w = aliasWorld([LEGACY, RENAMED]);
  try {
    const spec = normalizeManagedSpec(vlNative({ vlBinary: w.bin, model: LEGACY }));
    assert.equal(spec.model, LEGACY, 'the persisted selector is not aliased');
    const r = launch(w, vlNative({ vlBinary: w.bin, model: LEGACY }));
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.engine.env.VL_MODEL, LEGACY);
    assert.equal(r.info.vlRuntime.selector.profile, LEGACY);
    assert.equal(r.info.vlRuntime.selector.by, 'profile', 'matched by id, before any comparison by model');
    const other = launch(w, vlNative({ vlBinary: w.bin, model: RENAMED }));
    assert.equal(other.engine.env.VL_MODEL, RENAMED);
    assert.equal(other.info.vlRuntime.selector.profile, RENAMED);
  } finally { cleanup(w); }
});

test('R1: the per-cell override is opaque too', () => {
  const w = aliasWorld([LEGACY, RENAMED]);
  try {
    const r = launch(w, vlNative({ vlBinary: w.bin }), { cell: { id: 'CellaProva', model: LEGACY } });
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.engine.env.VL_MODEL, LEGACY);
    assert.equal(r.info.vlRuntime.selector.profile, LEGACY);
  } finally { cleanup(w); }
});

test('R1: with only the legacy id declared the choice is accepted, not refused by a renamed lookup', () => {
  const w = aliasWorld([LEGACY]);
  try {
    const r = launch(w, vlNative({ vlBinary: w.bin, model: LEGACY }));
    assert.equal(r.ok, true, r.reason);
    assert.equal(r.engine.env.VL_MODEL, LEGACY);
    const cell = launch(w, vlNative({ vlBinary: w.bin }), { cell: { id: 'CellaProva', model: LEGACY } });
    assert.equal(cell.ok, true, cell.reason);
    assert.equal(cell.engine.env.VL_MODEL, LEGACY);
  } finally { cleanup(w); }
});

test('R1: the alias still applies to every other client path (remote variant, fixed profile, other clients)', () => {
  const remote = normalizeManagedSpec({ client: 'vl', provider: 'anthropic', model: LEGACY, permissionPolicy: 'standard' });
  assert.equal(remote && remote.model, RENAMED, 'a remote variant keeps the alias');
  const fixed = normalizeManagedSpec(vlNative({ vlProfile: 'zai-P-glm53', model: LEGACY }));
  assert.equal(fixed && fixed.model, RENAMED, 'a fixed profile keeps the model semantics');
  const w = world();
  try {
    const r = launch(w, vlNative({ vlBinary: w.bin, vlProfile: undefined, model: '' }), { cell: { id: 'CellaProva', model: '' } });
    assert.equal(r.ok, true, r.reason);
  } finally { cleanup(w); }
});

// ---- presets are neither offered nor accepted, whatever the inventory kind ---

const presetRow = (id, model) => profile(id, model, { source: 'preset', provider: 'anthropic' });
const catalogOnly = () => eight({
  inventory: 'catalog', active: null, active_error: 'unresolved',
  profiles: [presetRow('anthropic', 'claude-haiku-5-5'), presetRow('zai', 'glm-5.3'), presetRow('ollama', 'llama3')],
});

test('R3: a catalog fallback (presets only) is "no declared profile": nothing offered, nothing accepted', () => {
  const w = world({ models: catalogOnly() });
  try {
    const info = describe(w);
    assert.equal(info.vlProfiles.state, 'none');
    assert.deepEqual(info.vlProfiles.options, []);
    assert.equal(info.vlProfiles.presetNamesResolvable, true, 'kept as information about the runtime');
    assert.match(info.vlProfiles.reason, /nessun profilo dichiarato/);
    for (const name of ['anthropic', 'zai', 'claude-haiku-5-5']) {
      const r = launch(w, vlNative({ vlBinary: w.bin, model: name }));
      assert.equal(r.ok, false, `${name} must not be accepted`);
      assert.match(String(r.reason), /nessun profilo dichiarato/);
    }
    const cell = launch(w, vlNative({ vlBinary: w.bin }), { cell: { id: 'CellaProva', model: 'zai' } });
    assert.equal(cell.ok, false);
  } finally { cleanup(w); }
});

test('R3: a preset row next to declared profiles is not offered and not accepted; the declared ones are unchanged', () => {
  const doc = eight();
  doc.profiles.push(presetRow('anthropic', 'claude-haiku-5-5'));
  const w = world({ models: doc });
  try {
    const info = describe(w);
    assert.equal(info.vlProfiles.state, 'ready');
    assert.deepEqual(info.vlProfiles.options.map((o) => o.value), eight().profiles.map((p) => p.id));
    assert.equal(launch(w, vlNative({ vlBinary: w.bin, model: 'anthropic' })).ok, false);
    assert.equal(launch(w, vlNative({ vlBinary: w.bin, model: 'a-opus' })).ok, true);
    assert.equal(vlProfiles.resolveSelector(vlProfiles.validateInventory(doc).inventory, 'claude-haiku-5-5').by, 'model', 'the declared haiku profile still wins by model');
  } finally { cleanup(w); }
});

test('R3: the status carries no models for a node with no declared profile, not even a declared raw model', async () => {
  const w = world({ models: catalogOnly() });
  try {
    const fleet = await fleetFor(w, vlNative({ vlBinary: w.bin }));
    const defsPath = path.join(w.root, 'fleet.json');
    const defs = JSON.parse(fs.readFileSync(defsPath, 'utf8'));
    defs.models = [{ id: 'raw-declared-model', engine: 'vl.native', contextWindow: 65536, maxTokens: 4096 }];
    atomicWrite(defsPath, defs);
    const fresh = await createBuiltinFleet({
      home: w.home, fleetDefsPath: defsPath, tmuxBin: '/bin/true',
      env: { XDG_CONFIG_HOME: path.join(w.home, '.config') },
    });
    const st = await fresh.status();
    await fresh.close();
    const row = st.engines.find((e) => e.id === 'vl.native');
    assert.equal(row.vlProfiles.state, 'none');
    assert.deepEqual(row.models, []);
    await fleet.close();
  } finally { cleanup(w); }
});

// ---- the listing of a NEW engine: the node's default, from definitions() ------

function defaultBinaryWorld(over) {
  const w = world(over);
  const binDir = path.join(w.home, '.local', 'bin');
  fs.writeFileSync(path.join(binDir, 'vl'), FAKE_VL, { mode: 0o755 });
  fs.chmodSync(path.join(binDir, 'vl'), 0o755);
  setDoc(binDir, 'status.json', over && over.status ? over.status : NEW_STATUS);
  setDoc(binDir, 'models.json', over && over.models ? over.models : eight());
  return { ...w, defaultDir: binDir };
}

test('R2: definitions() carries the node default listing for a new vl.native engine (the default binary, executor-local)', async () => {
  const w = defaultBinaryWorld();
  try {
    const fleet = await fleetFor(w, vlNative({ vlBinary: w.bin }));
    const defs = fleet.definitions();
    assert.equal(defs.vlProfilesDefault.state, 'ready');
    assert.deepEqual(defs.vlProfilesDefault.options.map((o) => o.value), eight().profiles.map((p) => p.id));
    assert.ok(calls(w.defaultDir).some((c) => c.startsWith('models --json')), 'the default binary was asked, not the engine\'s declared one');
    assert.ok(!JSON.stringify(defs).includes(CANARY));
    await fleet.close();
  } finally { cleanup(w); }
});

test('R2: the default listing says "old", "none" or "unavailable" instead of inventing a list', async () => {
  const old = defaultBinaryWorld({ status: OLD_STATUS });
  const none = defaultBinaryWorld({ models: catalogOnly() });
  try {
    const f1 = await fleetFor(old, vlNative({ vlBinary: old.bin }));
    assert.equal(f1.definitions().vlProfilesDefault.state, 'old');
    await f1.close();
    const f2 = await fleetFor(none, vlNative({ vlBinary: none.bin }));
    const d = f2.definitions().vlProfilesDefault;
    assert.equal(d.state, 'none');
    assert.deepEqual(d.options, []);
    await f2.close();
  } finally { cleanup(old); cleanup(none); }
  const bare = world();
  try {
    fs.rmSync(path.join(bare.home, '.local', 'bin', 'vl'), { force: true });
    const f3 = await fleetFor(bare, vlNative({ vlBinary: bare.bin }));
    assert.equal(f3.definitions().vlProfilesDefault.state, 'unavailable');
    await f3.close();
  } finally { cleanup(bare); }
});
