'use strict';
// tests/fleet-credential-source.test.js — WP1 source policy esplicita
// (environment|nexuscrew-store|auto) per generic, profilo A e P; migrazione
// legacy resta auto/no-op. Niente valori reali nei log/assert: solo source.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const managed = require('../lib/fleet/managed.js');
const creds = require('../lib/fleet/credentials.js');

function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncsrc-'));
  fs.chmodSync(home, 0o700);
  return { home, cfg: { home, credentialsPath: path.join(home, '.nexuscrew', 'credentials.json') } };
}

const CASES = [
  { label: 'generic', provider: 'zai', profile: '', envKey: 'ZAI_API_KEY', storeVal: 'gen-store', runtimeVal: 'gen-runtime' },
  { label: 'profilo A', provider: 'zai', profile: 'a', envKey: 'ZAI_API_KEY_A', storeVal: 'a-store', runtimeVal: 'a-runtime' },
  { label: 'profilo P', provider: 'zai', profile: 'p', envKey: 'ZAI_API_KEY_P', storeVal: 'p-store', runtimeVal: 'p-runtime' },
];

for (const c of CASES) {
  test(`source policy nexuscrew-store (${c.label}) risolve solo dal local store e ignora l'ambiente`, () => {
    const { home, cfg } = world();
    try {
      creds.setCredential(cfg, c.envKey, c.storeVal, home);
      const profile = managed.profileFor('claude', c.provider, c.profile);
      const spec = managed.normalizeManagedSpec({ client: 'claude', provider: c.provider, credentialProfile: c.profile, credentialSource: 'nexuscrew-store' });
      // runtime inquina con un valore diverso: nexuscrew-store NON deve usarlo
      const cred = managed.credential(profile, spec, { ...cfg, env: { [c.envKey]: c.runtimeVal } }, home);
      assert.equal(cred.value, c.storeVal, `valore dallo store, non runtime (${c.label})`);
      assert.equal(cred.source, 'nexuscrew-store');
      // senza valore nello store -> missing anche se runtime presente
      creds.removeCredential(cfg, c.envKey, home);
      const cred2 = managed.credential(profile, spec, { ...cfg, env: { [c.envKey]: c.runtimeVal } }, home);
      assert.equal(cred2.value, '');
      assert.equal(cred2.source, 'missing');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });

  test(`source policy environment (${c.label}) risolve solo da runtime env`, () => {
    const { home, cfg } = world();
    try {
      creds.setCredential(cfg, c.envKey, c.storeVal, home);
      const profile = managed.profileFor('claude', c.provider, c.profile);
      const spec = managed.normalizeManagedSpec({ client: 'claude', provider: c.provider, credentialProfile: c.profile, credentialSource: 'environment' });
      // ambiente presente -> environment; lo store NON deve essere usato
      const cred = managed.credential(profile, spec, { ...cfg, env: { [c.envKey]: c.runtimeVal } }, home);
      assert.equal(cred.value, c.runtimeVal);
      assert.equal(cred.source, 'environment');
      // ambiente assente -> missing anche se lo store ha il valore
      const cred2 = managed.credential(profile, spec, { ...cfg, env: {} }, home);
      assert.equal(cred2.value, '');
      assert.equal(cred2.source, 'missing');
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  });
}

test('source policy auto = precedenza legacy: runtime vince su local store (nessuna regressione)', () => {
  const { home, cfg } = world();
  try {
    const c = CASES[0];
    creds.setCredential(cfg, c.envKey, c.storeVal, home);
    const profile = managed.profileFor('claude', c.provider, c.profile);
    const spec = managed.normalizeManagedSpec({ client: 'claude', provider: c.provider, credentialProfile: c.profile, credentialSource: 'auto' });
    const cred = managed.credential(profile, spec, { ...cfg, env: { [c.envKey]: c.runtimeVal } }, home);
    assert.equal(cred.value, c.runtimeVal, 'auto: runtime prevale come da behavior legacy');
    assert.equal(cred.source, 'environment');
    // senza runtime, auto ricade sul local store
    const cred2 = managed.credential(profile, spec, { ...cfg, env: {} }, home);
    assert.equal(cred2.value, c.storeVal);
    assert.equal(cred2.source, 'local');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('migrazione fleet legacy senza credentialSource resta auto (no-op): nessuna cella cambia risoluzione', () => {
  // Uno store engine legacy (pre-WP1) non porta credentialSource: normalizeManagedSpec
  // lo accetta e NON aggiunge il campo (default auto), senza forzare nessuna source.
  for (const c of CASES) {
    const legacy = managed.normalizeManagedSpec({ client: 'claude', provider: c.provider, credentialProfile: c.profile });
    assert.ok(legacy, `engine legacy ${c.label} valido`);
    assert.equal(legacy.credentialSource, undefined, `no-op: campo assente nel迁移 legacy (${c.label})`);
  }
  // valore esplicito fuori dall'enum chiusa rifiutato
  assert.equal(managed.normalizeManagedSpec({ client: 'claude', provider: 'zai', credentialSource: 'bogus' }), null);
  for (const ok of ['environment', 'nexuscrew-store']) {
    const spec = managed.normalizeManagedSpec({ client: 'claude', provider: 'zai', credentialSource: ok });
    assert.equal(spec && spec.credentialSource, ok);
  }
  // auto esplicito -> campo assente (trattato come default, no-op)
  const autoSpec = managed.normalizeManagedSpec({ client: 'claude', provider: 'zai', credentialSource: 'auto' });
  assert.equal(autoSpec && autoSpec.credentialSource, undefined);
});

// --- Punto 3: nexuscrew-store neutralizza il set del profilo con UNSET -------
// Mai stringa vuota. Per Anthropic-compatible (claude.*) il set e
// {ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN, ANTHROPIC_API_KEY}; per gli altri
// client resta il solo envKey del profilo. Si deriva ed enumera per profilo,
// non si maschera soltanto envKey.

test('credentialEnvNeutralizeSet enumera l intero set Anthropic-compatible per claude (e solo envKey per altri client)', () => {
  assert.deepEqual(
    managed.credentialEnvNeutralizeSet(managed.profileFor('claude', 'zai', '')).sort(),
    ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'],
  );
  assert.deepEqual(
    managed.credentialEnvNeutralizeSet(managed.profileFor('claude', 'zai', 'a')).sort(),
    ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'],
  );
  // client non-claude: solo l envKey del profilo (OPENAI_API_KEY per codex openai-api)
  assert.deepEqual(managed.credentialEnvNeutralizeSet(managed.profileFor('codex', 'openai-api', '')), ['OPENAI_API_KEY']);
});

test('nexuscrew-store neutralizza API_KEY con UNSET (non stringa vuota) mantenendo AUTH_TOKEN/BASE_URL dallo store', () => {
  const profile = managed.profileFor('claude', 'zai', '');
  const env = { ANTHROPIC_BASE_URL: profile.endpoint, ANTHROPIC_AUTH_TOKEN: 'store-val', ANTHROPIC_API_KEY: '' };
  managed.applyStoreNeutralization(env, { credentialSource: 'nexuscrew-store' }, profile);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'store-val', 'AUTH_TOKEN dallo store mantenuto');
  assert.equal(env.ANTHROPIC_BASE_URL, profile.endpoint, 'BASE_URL mantenuto');
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_API_KEY'), false, 'API_KEY UNSET, non stringa vuota');
});

test('auto NON neutralizza: API_KEY resta stringa vuota come da legacy (unset-vs-empty preservato)', () => {
  const profile = managed.profileFor('claude', 'zai', '');
  const env = { ANTHROPIC_BASE_URL: profile.endpoint, ANTHROPIC_AUTH_TOKEN: 'rt', ANTHROPIC_API_KEY: '' };
  managed.applyStoreNeutralization(env, { credentialSource: 'auto' }, profile);
  assert.equal(Object.prototype.hasOwnProperty.call(env, 'ANTHROPIC_API_KEY'), true, 'auto: proprieta mantenuta');
  assert.equal(env.ANTHROPIC_API_KEY, '', 'auto: stringa vuota legacy preservata (no unset)');
});

test('environment NON neutralizza (la fonte e l ambiente stesso)', () => {
  const profile = managed.profileFor('claude', 'zai', '');
  const env = { ANTHROPIC_BASE_URL: profile.endpoint, ANTHROPIC_AUTH_TOKEN: 'rt', ANTHROPIC_API_KEY: '' };
  managed.applyStoreNeutralization(env, { credentialSource: 'environment' }, profile);
  assert.equal(env.ANTHROPIC_API_KEY, '');
});

// --- Punto 4: metadata diagnostici bounded (source/presenza), mai valore -----
test('describeManaged espone source/presenza, mai il valore della credenziale', () => {
  const { home, cfg } = world();
  try {
    creds.setCredential(cfg, 'ZAI_API_KEY', 'secret-value-xyz', home);
    const spec = managed.normalizeManagedSpec({ client: 'claude', provider: 'zai', credentialSource: 'nexuscrew-store' });
    const desc = managed.describeManaged(spec, { ...cfg, home, env: {} });
    assert.equal(desc.authConfigured, true);
    assert.equal(desc.credentialSource, 'nexuscrew-store');
    assert.equal(JSON.stringify(desc).includes('secret-value-xyz'), false, 'mai il valore del segreto');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
