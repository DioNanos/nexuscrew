'use strict';
// tests/fleet-credential-source.test.js — WP1R source policy esplicita
// (credentialSourcePolicy: auto|nexuscrew-store|environment) per generic, profilo
// A e P; migration legacy resta auto/no-op. La POLICY selezionata resta distinta
// dall'EFFECTIVE resolved source (environment|local|nexuscrew-store|compatibility|
// missing). Niente valori reali nei log/assert.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const managed = require('../lib/fleet/managed.js');
const creds = require('../lib/fleet/credentials.js');
const { parseDefinitions } = require('../lib/fleet/definitions.js');

function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncsrc-'));
  fs.chmodSync(home, 0o700);
  return { home, cfg: { home, credentialsPath: path.join(home, '.nexuscrew', 'credentials.json') } };
}

// Fake binary so resolveManagedEngine reaches the env-compose path (findBinary
// honors home/.local/bin/<client>). MAI un client reale: e un eseguibile no-op.
function plantFakeBinary(home, client) {
  const dir = path.join(home, '.local', 'bin');
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, client);
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(bin, 0o755);
  return bin;
}

const CASES = [
  { label: 'generic', provider: 'zai', profile: '', envKey: 'ZAI_API_KEY', storeVal: 'gen-store', runtimeVal: 'gen-runtime' },
  { label: 'profilo A', provider: 'zai', profile: 'a', envKey: 'ZAI_API_KEY_A', storeVal: 'a-store', runtimeVal: 'a-runtime' },
  { label: 'profilo P', provider: 'zai', profile: 'p', envKey: 'ZAI_API_KEY_P', storeVal: 'p-store', runtimeVal: 'p-runtime' },
];

// --- policy vs effective: resolve() distingue selezione (policy) da esito -------
for (const c of CASES) {
  test(`nexuscrew-store (${c.label}) risolve solo dal local store e ignora l'ambiente`, () => {
    const { home, cfg } = world();
    try {
      creds.setCredential(cfg, c.envKey, c.storeVal, home);
      const profile = managed.profileFor('claude', c.provider, c.profile);
      const spec = managed.normalizeManagedSpec({ client: 'claude', provider: c.provider, credentialProfile: c.profile, credentialSourcePolicy: 'nexuscrew-store' });
      const cred = managed.credential(profile, spec, { ...cfg, env: { [c.envKey]: c.runtimeVal } }, home);
      assert.equal(cred.value, c.storeVal);
      assert.equal(cred.source, 'nexuscrew-store', 'effective source');
      creds.removeCredential(cfg, c.envKey, home);
      const cred2 = managed.credential(profile, spec, { ...cfg, env: { [c.envKey]: c.runtimeVal } }, home);
      assert.equal(cred2.value, '');
      assert.equal(cred2.source, 'missing');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test(`environment (${c.label}) risolve solo da runtime env`, () => {
    const { home, cfg } = world();
    try {
      creds.setCredential(cfg, c.envKey, c.storeVal, home);
      const profile = managed.profileFor('claude', c.provider, c.profile);
      const spec = managed.normalizeManagedSpec({ client: 'claude', provider: c.provider, credentialProfile: c.profile, credentialSourcePolicy: 'environment' });
      const cred = managed.credential(profile, spec, { ...cfg, env: { [c.envKey]: c.runtimeVal } }, home);
      assert.equal(cred.value, c.runtimeVal);
      assert.equal(cred.source, 'environment');
      const cred2 = managed.credential(profile, spec, { ...cfg, env: {} }, home);
      assert.equal(cred2.value, '');
      assert.equal(cred2.source, 'missing');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
}

test('auto = precedenza legacy: runtime vince su local store; policy assente nello spec (no-op)', () => {
  const { home, cfg } = world();
  try {
    const c = CASES[0];
    creds.setCredential(cfg, c.envKey, c.storeVal, home);
    const profile = managed.profileFor('claude', c.provider, c.profile);
    const spec = managed.normalizeManagedSpec({ client: 'claude', provider: c.provider, credentialProfile: c.profile, credentialSourcePolicy: 'auto' });
    assert.equal(spec.credentialSourcePolicy, undefined, 'auto resta omesso nello spec normalizzato (no-op legacy)');
    const cred = managed.credential(profile, spec, { ...cfg, env: { [c.envKey]: c.runtimeVal } }, home);
    assert.equal(cred.value, c.runtimeVal);
    assert.equal(cred.source, 'environment');
    const cred2 = managed.credential(profile, spec, { ...cfg, env: {} }, home);
    assert.equal(cred2.value, c.storeVal);
    assert.equal(cred2.source, 'local');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('migrazione fleet legacy senza credentialSourcePolicy resta auto (no-op)', () => {
  for (const c of CASES) {
    const legacy = managed.normalizeManagedSpec({ client: 'claude', provider: c.provider, credentialProfile: c.profile });
    assert.ok(legacy);
    assert.equal(legacy.credentialSourcePolicy, undefined, `campo assente nel迁移 legacy (${c.label})`);
  }
  assert.equal(managed.normalizeManagedSpec({ client: 'claude', provider: 'zai', credentialSourcePolicy: 'bogus' }), null);
  for (const ok of ['environment', 'nexuscrew-store']) {
    const spec = managed.normalizeManagedSpec({ client: 'claude', provider: 'zai', credentialSourcePolicy: ok });
    assert.equal(spec && spec.credentialSourcePolicy, ok);
  }
  const autoSpec = managed.normalizeManagedSpec({ client: 'claude', provider: 'zai', credentialSourcePolicy: 'auto' });
  assert.equal(autoSpec && autoSpec.credentialSourcePolicy, undefined);
});

// --- neutralizzazione set Anthropic-compatible (helper) ----------------------
test('credentialEnvNeutralizeSet enumera l intero set Anthropic-compatible per claude (e solo envKey per altri client)', () => {
  assert.deepEqual(
    managed.credentialEnvNeutralizeSet(managed.profileFor('claude', 'zai', '')).sort(),
    ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'],
  );
  assert.deepEqual(managed.credentialEnvNeutralizeSet(managed.profileFor('codex', 'openai-api', '')), ['OPENAI_API_KEY']);
});

test('nexuscrew-store neutralizza API_KEY con UNSET (non stringa vuota); auto/environment no', () => {
  const profile = managed.profileFor('claude', 'zai', '');
  const envStore = { ANTHROPIC_BASE_URL: profile.endpoint, ANTHROPIC_AUTH_TOKEN: 's', ANTHROPIC_API_KEY: '' };
  managed.applyStoreNeutralization(envStore, { credentialSourcePolicy: 'nexuscrew-store' }, profile);
  assert.equal(Object.prototype.hasOwnProperty.call(envStore, 'ANTHROPIC_API_KEY'), false);

  const envAuto = { ANTHROPIC_BASE_URL: profile.endpoint, ANTHROPIC_AUTH_TOKEN: 'r', ANTHROPIC_API_KEY: '' };
  managed.applyStoreNeutralization(envAuto, { credentialSourcePolicy: 'auto' }, profile);
  assert.equal(envAuto.ANTHROPIC_API_KEY, '');
});

// --- describeManaged: policy selezionata distinta da effective source ---------
test('describeManaged espone credentialSourcePolicy (selezionata) e credentialSource (effective), mai il valore', () => {
  const { home, cfg } = world();
  try {
    creds.setCredential(cfg, 'ZAI_API_KEY', 'secret-value-xyz', home);
    const spec = managed.normalizeManagedSpec({ client: 'claude', provider: 'zai', credentialSourcePolicy: 'nexuscrew-store' });
    const desc = managed.describeManaged(spec, { ...cfg, home, env: {} });
    assert.equal(desc.credentialSourcePolicy, 'nexuscrew-store', 'policy selezionata');
    assert.equal(desc.credentialSource, 'nexuscrew-store', 'effective source');
    assert.equal(JSON.stringify(desc).includes('secret-value-xyz'), false, 'mai il valore del segreto');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// --- FULL resolved managed engine -> broker child env (non solo helper) --------
// Verifica l env che resolveManagedEngine compone per il broker (engine.env):
// nexuscrew-store => ANTHROPIC_AUTH_TOKEN dallo store, ANTHROPIC_API_KEY ASSENTE
// (non empty), BASE_URL presente. auto => API_KEY resta '' (legacy).
for (const c of CASES) {
  test(`resolveManagedEngine broker env (${c.label}): nexuscrew-store lascia API_KEY assente; auto la lascia vuota`, () => {
    const { home, cfg } = world();
    try {
      plantFakeBinary(home, 'claude');
      creds.setCredential(cfg, c.envKey, c.storeVal, home);
      const engine = { id: 'claude.zai', managed: { client: 'claude', provider: c.provider, credentialProfile: c.profile, credentialSourcePolicy: 'nexuscrew-store' } };
      const cell = { id: 't', model: 'glm-5.2[1m]', engine: 'claude.zai' };
      const r = managed.resolveManagedEngine(engine, cell, { ...cfg, home, env: { [c.envKey]: c.runtimeVal } });
      assert.equal(r.ok, true, `(${c.label}) engine resolved`);
      assert.equal(r.engine.env.ANTHROPIC_AUTH_TOKEN, c.storeVal, 'AUTH_TOKEN dallo store, non runtime');
      assert.ok(r.engine.env.ANTHROPIC_BASE_URL, 'BASE_URL presente');
      assert.equal(Object.prototype.hasOwnProperty.call(r.engine.env, 'ANTHROPIC_API_KEY'), false, 'API_KEY ASSENTE (unset, non empty)');

      // auto: la stringa vuota legacy e preservata
      const engineAuto = { id: 'claude.zai', managed: { client: 'claude', provider: c.provider, credentialProfile: c.profile } };
      const rAuto = managed.resolveManagedEngine(engineAuto, cell, { ...cfg, home, env: { [c.envKey]: c.runtimeVal } });
      assert.equal(rAuto.ok, true);
      assert.equal(rAuto.engine.env.ANTHROPIC_API_KEY, '', 'auto: legacy empty preservato');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
}

// --- conflicting runtime vs store (auto precedence end-to-end nel broker env) --
test('resolveManagedEngine broker env: auto con runtime+store usa runtime (environment); senza runtime ricade sullo store', () => {
  const { home, cfg } = world();
  try {
    const c = CASES[0];
    plantFakeBinary(home, 'claude');
    creds.setCredential(cfg, c.envKey, c.storeVal, home);
    const engine = { id: 'claude.zai', managed: { client: 'claude', provider: c.provider } }; // auto
    const cell = { id: 't', model: 'glm-5.2[1m]', engine: 'claude.zai' };
    const rBoth = managed.resolveManagedEngine(engine, cell, { ...cfg, home, env: { [c.envKey]: c.runtimeVal } });
    assert.equal(rBoth.engine.env.ANTHROPIC_AUTH_TOKEN, c.runtimeVal, 'runtime prevale (auto)');
    const rStore = managed.resolveManagedEngine(engine, cell, { ...cfg, home, env: {} });
    assert.equal(rStore.engine.env.ANTHROPIC_AUTH_TOKEN, c.storeVal, 'senza runtime ricade sullo store');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// --- definitions round-trip + fail-closed per managed.credentialSourcePolicy ---
test('parseDefinitions round-trip: managed.credentialSourcePolicy persiste; auto e omesso; bogus -> fail-closed', () => {
  const fleet = (policy) => ({ schemaVersion: 1, engines: [{ id: 'claude.zai', managed: { client: 'claude', provider: 'zai', credentialSourcePolicy: policy } }], cells: [] });
  const ok = parseDefinitions(fleet('nexuscrew-store'));
  assert.ok(ok);
  assert.equal(ok.engines.find((e) => e.id === 'claude.zai').managed.credentialSourcePolicy, 'nexuscrew-store');
  const auto = parseDefinitions(fleet('auto'));
  assert.equal(auto.engines.find((e) => e.id === 'claude.zai').managed.credentialSourcePolicy, undefined, 'auto omesso (no-op)');
  assert.equal(parseDefinitions(fleet('bogus')), null, 'fail-closed su policy fuori enum');
  // assente = auto (legacy no-op)
  const legacy = parseDefinitions({ schemaVersion: 1, engines: [{ id: 'claude.zai', managed: { client: 'claude', provider: 'zai' } }], cells: [] });
  assert.equal(legacy.engines.find((e) => e.id === 'claude.zai').managed.credentialSourcePolicy, undefined);
});
