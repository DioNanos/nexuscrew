const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertLoopback, defaults, loadConfig, baseDefaults } = require('../lib/config.js');

test('defaults bind to loopback only', () => {
  assert.strictEqual(defaults().bind, '127.0.0.1');
  assert.strictEqual(defaults().readonlyDefault, false); // read-write di default
  assert.strictEqual(defaults().replyLabel, 'human');
});

test('assertLoopback rejects non-loopback bind', () => {
  assert.throws(() => assertLoopback('0.0.0.0'), /loopback/i);
  assert.throws(() => assertLoopback('::'), /loopback/i);
  assert.doesNotThrow(() => assertLoopback('127.0.0.1'));
  assert.doesNotThrow(() => assertLoopback('::1'));
});

test('defaults: profilo portatile (voice null, port 41820)', () => {
  const d = defaults();
  assert.ok(d.filesRoot.endsWith('NexusFiles'));
  assert.equal(d.maxUpload, 100 * 1024 * 1024);
  assert.equal(d.voiceUrl, null); // graceful: null se non configurato (non piu' hardcoded host-specifico)
  assert.equal(d.voiceTokenFile, null); // niente path host-specifico hardcoded
  assert.equal(d.port, 41820); // default unificato (override host via config/env)
  assert.equal(typeof d.voiceToken, 'string');
  assert.ok(d.providerKeysPath.endsWith(path.join('.config', 'keys', 'ai.env')));
  assert.ok(d.providerSecurePath.endsWith(path.join('.config', 'secure', '.env')));
  assert.ok(d.credentialsPath.endsWith(path.join('.nexuscrew', 'credentials.json')));
});

test('baseDefaults: nessun path assoluto hardcoded', () => {
  const d = baseDefaults();
  // tokenPath e filesRoot sotto os.homedir() (portabili ovunque)
  assert.ok(d.tokenPath.includes('.nexuscrew'));
  assert.ok(d.filesRoot.includes('NexusFiles'));
  assert.equal(d.voiceUrl, null);
  assert.equal(d.voiceTokenFile, null);
});

function withConfigFile(content, fn) {
  const tmp = path.join(os.tmpdir(), `nc-cfg-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
  if (content !== null) fs.writeFileSync(tmp, JSON.stringify(content));
  const prev = process.env.NEXUSCREW_CONFIG_FILE;
  process.env.NEXUSCREW_CONFIG_FILE = tmp;
  try { return fn(tmp); } finally {
    process.env.NEXUSCREW_CONFIG_FILE = prev;
    try { if (content !== null) fs.unlinkSync(tmp); } catch (_) {}
  }
}

test('loadConfig: config.json assente -> defaults', () => {
  withConfigFile(null, () => {
    const c = loadConfig();
    assert.equal(c.port, 41820);
    assert.equal(c.voiceUrl, null);
  });
});

test('loadConfig: config.json presente -> override defaults', () => {
  withConfigFile({ port: 41999, voiceUrl: 'http://127.0.0.1:3105' }, () => {
    const c = loadConfig();
    assert.equal(c.port, 41999);
    assert.equal(c.voiceUrl, 'http://127.0.0.1:3105');
  });
});

test('loadConfig: precedence defaults < config.json < env', () => {
  withConfigFile({ port: 41999 }, () => {
    process.env.NEXUSCREW_PORT = '55555';
    try {
      const c = loadConfig();
      assert.equal(c.port, 55555); // env vince su config.json
    } finally { delete process.env.NEXUSCREW_PORT; }
  });
});

test('loadConfig: opts vince su tutto (override programmato)', () => {
  withConfigFile({ port: 41999 }, () => {
    process.env.NEXUSCREW_PORT = '55555';
    try {
      const c = loadConfig({ port: 60000 });
      assert.equal(c.port, 60000); // opts precedence massima
    } finally { delete process.env.NEXUSCREW_PORT; }
  });
});

test('loadConfig: env voice override', () => {
  process.env.NEXUSCREW_VOICE_URL = 'http://1.2.3.4:9';
  try {
    assert.equal(loadConfig().voiceUrl, 'http://1.2.3.4:9');
  } finally { delete process.env.NEXUSCREW_VOICE_URL; }
});

test('loadConfig: reply label neutra e override env', () => {
  assert.equal(baseDefaults().replyLabel, 'human');
  process.env.NEXUSCREW_REPLY_LABEL = 'operator';
  try {
    assert.equal(loadConfig().replyLabel, 'operator');
  } finally { delete process.env.NEXUSCREW_REPLY_LABEL; }
});

test('loadConfig: config.json malformato -> defaults sicuri (no throw)', () => {
  const tmp = path.join(os.tmpdir(), `nc-bad-${process.pid}.json`);
  fs.writeFileSync(tmp, '{ not valid json');
  const prev = process.env.NEXUSCREW_CONFIG_FILE;
  process.env.NEXUSCREW_CONFIG_FILE = tmp;
  try {
    const c = loadConfig();
    assert.equal(c.port, 41820); // fallback defaults
  } finally {
    process.env.NEXUSCREW_CONFIG_FILE = prev;
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
});
