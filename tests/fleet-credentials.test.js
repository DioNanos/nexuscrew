'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  credentialsPath, readCredentialStore, setCredential, removeCredential,
} = require('../lib/fleet/credentials.js');
const { credentialSources, parseProviderKeyFiles } = require('../lib/fleet/managed.js');

function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nccred-'));
  fs.chmodSync(home, 0o700);
  return { home, cfg: { home, credentialsPath: path.join(home, '.nexuscrew', 'credentials.json') } };
}

test('local credential store is private, atomic and never returned by status-shaped writes', () => {
  const { home, cfg } = world();
  try {
    setCredential(cfg, 'OLLAMA_API_KEY', 'local-secret', home);
    const file = credentialsPath(cfg, home);
    assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(readCredentialStore(cfg, home), { OLLAMA_API_KEY: 'local-secret' });
    assert.equal(fs.readdirSync(path.dirname(file)).some((name) => name.endsWith('.tmp')), false);
    assert.equal(removeCredential(cfg, 'OLLAMA_API_KEY', home), true);
    assert.deepEqual(readCredentialStore(cfg, home), {});
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('credential store rejects symlink, loose file mode, invalid keys and line breaks', () => {
  const { home, cfg } = world();
  try {
    fs.mkdirSync(path.join(home, '.nexuscrew'), { mode: 0o700 });
    const target = path.join(home, 'outside.json');
    fs.writeFileSync(target, '{"schemaVersion":1,"credentials":{"X":"secret"}}\n', { mode: 0o600 });
    fs.symlinkSync(target, cfg.credentialsPath);
    assert.throws(() => readCredentialStore(cfg, home), /unsafe credential store/);
    assert.throws(() => setCredential(cfg, 'BAD-KEY', 'x', home), /invalid credential/);
    assert.throws(() => setCredential(cfg, 'GOOD_KEY', 'a\nb', home), /line breaks/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('resolution order is runtime, local store, providers.zsh, canonical files, legacy', () => {
  const { home, cfg } = world();
  try {
    const shell = path.join(home, '.config', 'ai-shell', 'providers.zsh');
    const keys = path.join(home, '.config', 'keys', 'ai.env');
    const legacy = path.join(home, '.nexuscrew', 'providers.env');
    fs.mkdirSync(path.dirname(shell), { recursive: true });
    fs.mkdirSync(path.dirname(keys), { recursive: true, mode: 0o700 }); fs.chmodSync(path.dirname(keys), 0o700);
    fs.mkdirSync(path.dirname(legacy), { recursive: true, mode: 0o700 }); fs.chmodSync(path.dirname(legacy), 0o700);
    fs.writeFileSync(shell, 'export API_KEY=shell\n', { mode: 0o644 });
    fs.writeFileSync(keys, 'API_KEY=canonical\n', { mode: 0o600 });
    fs.writeFileSync(legacy, 'API_KEY=legacy\n', { mode: 0o600 });
    setCredential(cfg, 'API_KEY', 'local', home);
    const sources = credentialSources({ ...cfg, env: { API_KEY: 'runtime' }, providerShellPath: shell, providerKeysPath: keys, providerSecurePath: path.join(home, 'missing'), providerSecretsPath: legacy }, home);
    assert.equal(sources.runtime.API_KEY, 'runtime');
    assert.equal(sources.local.API_KEY, 'local');
    assert.equal(sources.shell.API_KEY, 'shell');
    assert.equal(sources.keys.API_KEY, 'canonical');
    assert.equal(sources.legacy.API_KEY, 'legacy');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// L'override fra i due file di chiavi non era coperto: il test sopra passa un
// `providerSecurePath` INESISTENTE, quindi l'ordine reale (l'ultimo vince) non
// era mai stato provato. Qui si prova, e si prova che il conflitto sia DETTO —
// e' il caso che sul campo si e' presentato come «la cella usa una chiave
// revocata», dove l'unico modo di accorgersene era confrontare gli hash a mano.
test('secure/.env overrides ai.env, and the disagreement is reported with hashes only', () => {
  const { home } = world();
  try {
    const keysDir = path.join(home, '.config', 'keys');
    const secureDir = path.join(home, '.config', 'secure');
    fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 }); fs.chmodSync(keysDir, 0o700);
    fs.mkdirSync(secureDir, { recursive: true, mode: 0o700 }); fs.chmodSync(secureDir, 0o700);
    const canonical = path.join(keysDir, 'ai.env');
    const secure = path.join(secureDir, '.env');
    fs.writeFileSync(canonical, 'API_KEY=revoked-old-value\n', { mode: 0o600 });
    fs.writeFileSync(secure, 'API_KEY=good-new-value\n', { mode: 0o600 });

    // Il conflitto e' una proprieta' della CATENA di precedenza (shell + i due
    // file), non della sola coppia: si interroga credentialSources, che e' dove
    // la catena si legge.
    const values = parseProviderKeyFiles({ providerKeysPath: canonical, providerSecurePath: secure }, home);
    assert.equal(values.API_KEY, 'good-new-value', 'l\'ultimo file vince: e\' la precedenza dichiarata');

    const sources = credentialSources({ home, providerKeysPath: canonical, providerSecurePath: secure }, home);
    const conflicts = sources.conflicts || [];
    assert.equal(conflicts.length, 1, 'il disaccordo fra i due file va dichiarato');
    assert.equal(conflicts[0].envKey, 'API_KEY');
    assert.equal(conflicts[0].winner.path, secure);
    assert.equal(conflicts[0].others[0].path, canonical);
    assert.match(conflicts[0].winner.hash8, /^[0-9a-f]{8}$/);
    assert.notEqual(conflicts[0].winner.hash8, conflicts[0].others[0].hash8);
    // Il valore non entra MAI nell'esito del conflitto.
    const serialized = JSON.stringify(conflicts);
    assert.ok(!serialized.includes('revoked-old-value'));
    assert.ok(!serialized.includes('good-new-value'));

    // Stesso valore nei due file: nessun conflitto da segnalare.
    fs.writeFileSync(canonical, 'API_KEY=good-new-value\n', { mode: 0o600 });
    const quiet = credentialSources({ home, providerKeysPath: canonical, providerSecurePath: secure }, home);
    assert.deepEqual(quiet.conflicts, [], 'la stessa chiave in due posti non e\' un conflitto');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('canonical ai.env may symlink only to a safe private file in an allowed config root', () => {
  const { home } = world();
  try {
    const keysDir = path.join(home, '.config', 'keys');
    const secureDir = path.join(home, '.config', 'secure');
    fs.mkdirSync(keysDir, { recursive: true, mode: 0o700 }); fs.chmodSync(keysDir, 0o700);
    fs.mkdirSync(secureDir, { recursive: true, mode: 0o700 }); fs.chmodSync(secureDir, 0o700);
    const target = path.join(secureDir, '.env');
    fs.writeFileSync(target, 'SAFE_KEY=inside\nEXPANDED=$OTHER\n', { mode: 0o600 });
    fs.symlinkSync(path.relative(keysDir, target), path.join(keysDir, 'ai.env'));
    const values = parseProviderKeyFiles({ providerKeysPath: path.join(keysDir, 'ai.env'), providerSecurePath: target }, home);
    assert.equal(values.SAFE_KEY, 'inside');
    assert.equal(Object.prototype.hasOwnProperty.call(values, 'EXPANDED'), false, 'unresolved variable is rejected');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
