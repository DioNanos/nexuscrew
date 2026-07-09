'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { detectPlatform, nodeBin, repoRoot, uid } = require('../lib/cli/platform.js');

test('detectPlatform: termux via TERMUX_VERSION', () => {
  assert.equal(detectPlatform({ platform: 'linux', env: { TERMUX_VERSION: '0.118.0' } }), 'termux');
});

test('detectPlatform: termux via PREFIX containing com.termux', () => {
  assert.equal(detectPlatform({ platform: 'linux', env: { PREFIX: '/data/data/com.termux/files/usr' } }), 'termux');
});

test('detectPlatform: termux via process.platform === android (no env Termux)', () => {
  assert.equal(detectPlatform({ platform: 'android', env: {} }), 'termux');
});

test('detectPlatform: mac via darwin', () => {
  assert.equal(detectPlatform({ platform: 'darwin', env: {} }), 'mac');
});

test('detectPlatform: linux non-termux', () => {
  assert.equal(detectPlatform({ platform: 'linux', env: {} }), 'linux');
});

test('detectPlatform: TERMUX_VERSION wins over android ambiguity (ordered signals)', () => {
  // anche su platform linux con env Termux -> termux
  assert.equal(detectPlatform({ platform: 'linux', env: { TERMUX_VERSION: '1' } }), 'termux');
});

test('nodeBin returns process.execPath (no hardcoded nvm)', () => {
  assert.equal(nodeBin(), process.execPath);
});

test('repoRoot resolves to the nexuscrew repo dir', () => {
  const r = repoRoot();
  assert.ok(r.endsWith('nexuscrew'), `expected endswith nexuscrew, got ${r}`);
  assert.ok(require('node:fs').existsSync(require('node:path').join(r, 'package.json')));
});

test('uid returns a positive number', () => {
  const u = uid();
  assert.equal(typeof u, 'number');
  assert.ok(u > 0);
});
