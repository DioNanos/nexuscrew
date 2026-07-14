'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { minimalRuntimeEnv, withUtf8Locale } = require('../lib/runtime/env.js');
const { attachEnv } = require('../lib/pty/attach.js');

test('runtime env: Termux paths survive but secrets and loader injection do not', () => {
  const env = minimalRuntimeEnv({
    HOME: '/data/data/com.termux/files/home', PATH: '/data/data/com.termux/files/usr/bin',
    PREFIX: '/data/data/com.termux/files/usr', TMPDIR: '/data/data/com.termux/files/usr/tmp',
    TERMUX_VERSION: '0.119', ANDROID_DATA: '/data', ANDROID_ROOT: '/system',
    XDG_CONFIG_HOME: '/x/config', NODE_OPTIONS: '--require bad', LD_PRELOAD: '/bad.so',
    API_KEY: 'secret',
  }, { platform: 'android' });
  assert.equal(env.PREFIX, '/data/data/com.termux/files/usr');
  assert.equal(env.TMPDIR, '/data/data/com.termux/files/usr/tmp');
  assert.match(env.LANG, /UTF-8/i);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.LD_PRELOAD, undefined);
  assert.equal(env.API_KEY, undefined);
});

test('runtime env: local macOS PTY gets UTF-8 while preserving its tmux context', () => {
  const source = { HOME: '/Users/test', PATH: '/usr/bin', TMUX: '/tmp/tmux,1,0', LANG: 'C' };
  const env = attachEnv(source, 'darwin');
  assert.equal(env.TMUX, source.TMUX);
  assert.equal(env.LANG, 'en_US.UTF-8');
  assert.equal(env.LC_CTYPE, 'UTF-8');
  assert.deepEqual(withUtf8Locale({ LANG: 'it_IT.UTF-8' }, { platform: 'darwin' }), {
    LANG: 'it_IT.UTF-8', LC_CTYPE: 'it_IT.UTF-8', TERM: 'xterm-256color',
  });
});
