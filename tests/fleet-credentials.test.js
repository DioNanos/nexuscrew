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
