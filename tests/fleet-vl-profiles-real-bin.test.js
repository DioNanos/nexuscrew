'use strict';
// The vl profile inventory against the REAL binary (never a turn, never a
// network call): the document the binary prints must be one this NexusCrew
// accepts, and the preflight must decide on it as on the fake ones.
//
// The binary comes from NEXUSCREW_VL_REAL_BIN, like fleet-vl-real-bin.test.js,
// and must carry the profile selector (`capabilities.model_selector`); without
// it the tests are skipped, with the reason, never green.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { describeManaged, resolveManagedEngine } = require('../lib/fleet/managed.js');

const REAL_BIN = process.env.NEXUSCREW_VL_REAL_BIN || '';
const have = Boolean(REAL_BIN) && fs.existsSync(REAL_BIN) && fs.statSync(REAL_BIN).isFile();
const declaresSelector = have && (() => {
  // This probe runs the real binary BEFORE any test world exists: without an
  // explicit HOME/XDG the binary would resolve (or worse, create) its state
  // under the operator's real home. A throwaway world keeps the probe
  // read-only with respect to everything outside this scratch directory.
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlprobe-'));
  let stdout = '';
  try {
    const env = {
      PATH: '/usr/bin:/bin',
      HOME: probe,
      XDG_CONFIG_HOME: path.join(probe, '.config'),
      XDG_STATE_HOME: path.join(probe, '.state'),
      XDG_DATA_HOME: path.join(probe, '.data'),
      XDG_RUNTIME_DIR: path.join(probe, '.run'),
      TMPDIR: path.join(probe, 'tmp'),
    };
    for (const dir of [env.XDG_CONFIG_HOME, env.XDG_STATE_HOME, env.XDG_DATA_HOME, env.XDG_RUNTIME_DIR, env.TMPDIR]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    const r = spawnSync(REAL_BIN, ['status'], { encoding: 'utf8', timeout: 5000, env });
    stdout = r.stdout || '';
  } finally {
    try { fs.rmSync(probe, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
  try { return JSON.parse(stdout).capabilities.model_selector === 'profile'; } catch (_) { return false; }
})();
const SKIP = !have
  ? 'NEXUSCREW_VL_REAL_BIN not declared or absent: real-binary tests skipped'
  : (!declaresSelector ? 'the binary does not declare capabilities.model_selector = "profile": skipped' : false);

const CANARY = 'CANARY-REAL-KEY-7d21-NOT-A-REAL-KEY';
const CATALOG = `
[profiles.zai-A]
provider = "anthropic-bearer"
base_url = "https://api.example.invalid/anthropic"
model = "glm-5.3"
api_key_env = "FAKE_KEY_A"

[profiles.zai-P]
provider = "anthropic-bearer"
base_url = "https://api.example.invalid/anthropic"
model = "glm-5.3"
api_key_env = "FAKE_KEY_P"

[profiles.local-llama]
provider = "openai-compat"
base_url = "http://127.0.0.1:9"
model = "llama3:8b"

[profiles.odd-model]
provider = "openai-compat"
base_url = "http://127.0.0.1:9"
model = "/home/someone/private-model"
`;

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlreal-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.config', 'vl'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'vl', 'config.toml'), CATALOG);
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), PATH: '/usr/bin:/bin', FAKE_KEY_A: CANARY };
  return { root, home, env };
}

const managed = (extra = {}) => ({ client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard', vlBinary: REAL_BIN, envPassthrough: ['FAKE_KEY_A'], ...extra });

test('the real inventory is accepted: A and P apart, keys by state, the odd model counted out', { skip: SKIP }, () => {
  const w = world();
  try {
    const info = describeManaged(managed(), { home: w.home, platform: 'linux', env: w.env, withVlProfiles: true, vlProfilesNoCache: true });
    assert.equal(info.vlProfiles.state, 'ready', info.vlProfiles.reason);
    const byId = Object.fromEntries(info.vlProfiles.options.map((o) => [o.value, o]));
    assert.deepEqual(Object.keys(byId).sort(), ['local-llama', 'zai-A', 'zai-P']);
    assert.equal(byId['zai-A'].key, 'present');
    assert.equal(byId['zai-P'].key, 'absent');
    assert.equal(byId['zai-A'].label, 'glm-5.3 · zai-A');
    assert.equal(byId['zai-P'].label, 'glm-5.3 · zai-P');
    assert.equal(info.vlProfiles.inventory, 'config');
    assert.equal(info.vlProfiles.presetNamesResolvable, true);
    assert.deepEqual(info.vlProfiles.excluded, { notAssembled: 0, invalidIdentifier: 1 });
    const wire = JSON.stringify(info);
    for (const needle of [CANARY, 'example.invalid', '/home/someone', 'FAKE_KEY_A', 'private-model']) {
      assert.ok(!wire.includes(needle), `${needle} leaked`);
    }
  } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
});

test('the preflight decides on the real inventory: id, unique model, ambiguity, unknown, preset', { skip: SKIP }, () => {
  const w = world();
  try {
    const launch = (model) => resolveManagedEngine({ id: 'vl.native', managed: managed({ model }) },
      { id: 'CellaProva' }, { home: w.home, platform: 'linux', env: w.env });
    const byId = launch('zai-P');
    assert.equal(byId.ok, true, byId.reason);
    assert.equal(byId.engine.env.VL_MODEL, 'zai-P');
    assert.equal(byId.info.vlRuntime.selector.key, 'absent');
    const byModel = launch('llama3:8b');
    assert.equal(byModel.ok, true, byModel.reason);
    assert.equal(byModel.info.vlRuntime.selector.profile, 'local-llama');
    const ambiguous = launch('glm-5.3');
    assert.equal(ambiguous.ok, false);
    assert.match(String(ambiguous.reason), /ambiguo: zai-A, zai-P/);
    const unknown = launch('nope');
    assert.equal(unknown.ok, false);
    assert.match(String(unknown.reason), /non e' fra i profili del nodo/);
    // a built-in preset name resolves in the runtime but is not in the list
    assert.equal(launch('zai').ok, false);
    assert.ok(!String(ambiguous.reason + unknown.reason).includes(CANARY));
  } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
});

test('a config that declares no profile: the real fallback lists only presets, so nothing is offered and no preset is accepted', { skip: SKIP }, () => {
  const w = world();
  try {
    fs.writeFileSync(path.join(w.home, '.config', 'vl', 'config.toml'), '# no profiles declared\n');
    const info = describeManaged(managed(), { home: w.home, platform: 'linux', env: w.env, withVlProfiles: true, vlProfilesNoCache: true });
    assert.equal(info.vlProfiles.state, 'none', info.vlProfiles.reason);
    assert.deepEqual(info.vlProfiles.options, []);
    assert.equal(info.vlProfiles.inventory, 'catalog');
    assert.equal(info.vlProfiles.presetNamesResolvable, true, 'information about the runtime, not an authorization');
    const launch = (model) => resolveManagedEngine({ id: 'vl.native', managed: managed({ model }) },
      { id: 'CellaProva' }, { home: w.home, platform: 'linux', env: w.env });
    for (const name of ['anthropic', 'zai', 'ollama']) {
      const r = launch(name);
      assert.equal(r.ok, false, `${name} must not be accepted`);
      assert.match(String(r.reason), /nessun profilo dichiarato/);
    }
  } finally { fs.rmSync(w.root, { recursive: true, force: true }); }
});
