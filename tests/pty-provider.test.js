'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { providerCandidates } = require('../lib/pty/provider.js');

test('PTY provider candidates: prebuilt corretti per Linux x64/arm64', () => {
  assert.deepEqual(providerCandidates({ platform: 'linux', arch: 'x64', env: {} }),
    ['@lydell/node-pty-linux-x64', 'node-pty']);
  assert.deepEqual(providerCandidates({ platform: 'linux', arch: 'arm64', env: {} }),
    ['@lydell/node-pty-linux-arm64', 'node-pty']);
});

test('PTY provider candidates: prebuilt corretti per macOS x64/arm64', () => {
  assert.deepEqual(providerCandidates({ platform: 'darwin', arch: 'x64', env: {} }),
    ['@lydell/node-pty-darwin-x64', 'node-pty']);
  assert.deepEqual(providerCandidates({ platform: 'darwin', arch: 'arm64', env: {} }),
    ['@lydell/node-pty-darwin-arm64', 'node-pty']);
});

test('PTY provider candidates: Termux usa il provider Android anche se platform=linux', () => {
  assert.deepEqual(providerCandidates({ platform: 'android', arch: 'arm64', env: {} }),
    ['@mmmbuto/node-pty-android-arm64', 'node-pty']);
  assert.deepEqual(providerCandidates({
    platform: 'linux', arch: 'arm64', env: { PREFIX: '/data/data/com.termux/files/usr' },
  }), ['@mmmbuto/node-pty-android-arm64', 'node-pty']);
});
