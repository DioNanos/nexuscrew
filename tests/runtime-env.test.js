'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');
const {
  minimalRuntimeEnv, withUtf8Locale, trustedTermuxPreload, TERMUX_EXEC_BASENAME_RE,
} = require('../lib/runtime/env.js');
const { attachEnv } = require('../lib/pty/attach.js');

// Build a synthetic Termux prefix under a temp dir whose path contains
// `com.termux` (so termuxRuntimePaths detection fires via PREFIX). The caller
// owns cleanup of the returned tmpRoot.
function makeTermuxPrefix(withLib = 'libtermux-exec.so', mode = 0o755) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-env-termux-'));
  const prefix = path.join(tmpRoot, 'com.termux', 'files', 'usr');
  const libDir = path.join(prefix, 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  const home = path.join(tmpRoot, 'com.termux', 'files', 'home');
  fs.mkdirSync(home, { recursive: true });
  const libPath = withLib ? path.join(libDir, withLib) : null;
  if (libPath) {
    fs.writeFileSync(libPath, 'dummy', { mode });
    fs.chmodSync(libPath, mode);
  }
  return { tmpRoot, prefix, libDir, home, libPath };
}

const TERMUX_BASE_ENV = (override = {}) => ({
  HOME: '/data/data/com.termux/files/home',
  PATH: '/data/data/com.termux/files/usr/bin',
  PREFIX: '/data/data/com.termux/files/usr',
  ...override,
});

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

test('runtime env: Termux cold start reconstructs tmux paths without a shell profile', () => {
  const env = minimalRuntimeEnv({
    HOME: '/data/data/com.termux/files/home',
    PATH: '/data/data/com.termux/files/usr/bin',
  }, { platform: 'android' });
  assert.equal(env.PREFIX, '/data/data/com.termux/files/usr');
  assert.equal(env.TMPDIR, '/data/data/com.termux/files/usr/tmp');
  assert.equal(env.TMUX_TMPDIR, '/data/data/com.termux/files/usr/var/run');
});

test('runtime env: an explicit Termux tmux socket remains authoritative', () => {
  const env = minimalRuntimeEnv({
    HOME: '/data/data/com.termux/files/home',
    PATH: '/data/data/com.termux/files/usr/bin',
    PREFIX: '/data/data/com.termux/files/usr',
    TMUX_TMPDIR: '/data/data/com.termux/files/usr/var/run-custom',
  }, { platform: 'android' });
  assert.equal(env.TMUX_TMPDIR, '/data/data/com.termux/files/usr/var/run-custom');
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

// --- Tranche A: Termux LD_PRELOAD fail-closed filter ---

test('basename allowlist accepts libtermux-exec.so and the ld-preload variant', () => {
  assert.ok(TERMUX_EXEC_BASENAME_RE.test('libtermux-exec.so'));
  assert.ok(TERMUX_EXEC_BASENAME_RE.test('libtermux-exec-ld-preload.so'));
  assert.ok(TERMUX_EXEC_BASENAME_RE.test('libtermux-exec-ld-preload-2.1.so'));
  assert.ok(TERMUX_EXEC_BASENAME_RE.test('libtermux-exec-1.3.so'));
  assert.ok(!TERMUX_EXEC_BASENAME_RE.test('libother.so'));
  assert.ok(!TERMUX_EXEC_BASENAME_RE.test('libtermux-exec-evil.so'));
  assert.ok(!TERMUX_EXEC_BASENAME_RE.test('libtermux-exec.so.1'));
  assert.ok(!TERMUX_EXEC_BASENAME_RE.test('libtermux-exec.so '));
});

test('trustedTermuxPreload: valid trusted preload under PREFIX/lib is preserved', () => {
  const { tmpRoot, prefix, libPath } = makeTermuxPrefix('libtermux-exec.so');
  try {
    const env = TERMUX_BASE_ENV({ PREFIX: prefix, HOME: path.dirname(prefix) + '/home', LD_PRELOAD: libPath });
    const got = trustedTermuxPreload(env, { platform: 'android' });
    assert.equal(got, libPath);
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('trustedTermuxPreload: ld-preload named variant and versioned variant accepted', () => {
  for (const name of ['libtermux-exec-ld-preload.so', 'libtermux-exec-2.0.so']) {
    const { tmpRoot, prefix, libPath } = makeTermuxPrefix(name);
    try {
      const env = TERMUX_BASE_ENV({ PREFIX: prefix, LD_PRELOAD: libPath });
      assert.equal(trustedTermuxPreload(env, { platform: 'android' }), libPath, name);
    } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
  }
});

test('trustedTermuxPreload: relative, list, mixed and foreign values are dropped', () => {
  const { tmpRoot, prefix, libPath } = makeTermuxPrefix('libtermux-exec.so');
  try {
    const base = { PREFIX: prefix, HOME: path.dirname(prefix) + '/home' };
    const cases = {
      relative: { ...base, LD_PRELOAD: 'libtermux-exec.so' },
      list: { ...base, LD_PRELOAD: `${libPath}:${libPath}` },
      space: { ...base, LD_PRELOAD: `${libPath} /other.so` },
      foreign: { ...base, LD_PRELOAD: path.join(prefix, 'lib', 'libother.so') },
    };
    // foreign needs the libother file present to reach the basename check
    fs.writeFileSync(cases.foreign.LD_PRELOAD, 'x', { mode: 0o755 });
    for (const [label, env] of Object.entries(cases)) {
      assert.equal(trustedTermuxPreload(env, { platform: 'android' }), null, label);
    }
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('trustedTermuxPreload: outside-prefix, missing and non-regular are dropped', () => {
  const { tmpRoot, prefix, libDir } = makeTermuxPrefix(null);
  try {
    const home = path.dirname(prefix) + '/home';
    // outside prefix: same basename, different lib dir
    const otherDir = path.join(tmpRoot, 'other', 'lib');
    fs.mkdirSync(otherDir, { recursive: true });
    const outside = path.join(otherDir, 'libtermux-exec.so');
    fs.writeFileSync(outside, 'x', { mode: 0o755 });
    assert.equal(trustedTermuxPreload({ PREFIX: prefix, HOME: home, LD_PRELOAD: outside }, { platform: 'android' }), null, 'outside-prefix');
    // missing file
    assert.equal(trustedTermuxPreload({ PREFIX: prefix, HOME: home, LD_PRELOAD: path.join(libDir, 'libtermux-exec.so.missing') }, { platform: 'android' }), null, 'missing');
    // non-regular (directory named like the library)
    const dirLib = path.join(libDir, 'libtermux-exec.so');
    fs.mkdirSync(dirLib, { recursive: true });
    assert.equal(trustedTermuxPreload({ PREFIX: prefix, HOME: home, LD_PRELOAD: dirLib }, { platform: 'android' }), null, 'non-regular');
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('trustedTermuxPreload: group/world-writable file is dropped', () => {
  const { tmpRoot, prefix, libPath } = makeTermuxPrefix('libtermux-exec.so', 0o777);
  try {
    fs.chmodSync(libPath, 0o777);
    const env = { PREFIX: prefix, HOME: path.dirname(prefix) + '/home', LD_PRELOAD: libPath };
    assert.equal(trustedTermuxPreload(env, { platform: 'android' }), null);
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('trustedTermuxPreload: never preserved without a Termux runtime signal', () => {
  // No PREFIX and a non-Termux home layout: detection must fail regardless of
  // platform, so the preload is dropped. (A linux/darwin process that DOES run
  // under a real Termux prefix is genuinely Termux and is covered above.)
  const noTermux = { HOME: '/home/tester', PATH: '/usr/bin', LD_PRELOAD: '/data/data/com.termux/files/usr/lib/libtermux-exec.so' };
  assert.equal(trustedTermuxPreload(noTermux, { platform: 'linux' }), null);
  assert.equal(trustedTermuxPreload(noTermux, { platform: 'darwin' }), null);
  assert.equal(trustedTermuxPreload(noTermux, { platform: 'android' }), null);
});

test('minimalRuntimeEnv: trusted preload survives only on Termux with a valid file', () => {
  const { tmpRoot, prefix, libPath } = makeTermuxPrefix('libtermux-exec.so');
  try {
    const env = minimalRuntimeEnv(TERMUX_BASE_ENV({ PREFIX: prefix, HOME: path.dirname(prefix) + '/home', LD_PRELOAD: libPath }), { platform: 'android' });
    assert.equal(env.LD_PRELOAD, libPath);
    assert.equal(env.PREFIX, prefix); // sanity: termux paths still resolved
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('minimalRuntimeEnv: invalid preload is dropped but Termux paths still resolved', () => {
  const { tmpRoot, prefix } = makeTermuxPrefix(null);
  try {
    const env = minimalRuntimeEnv(TERMUX_BASE_ENV({ PREFIX: prefix, HOME: path.dirname(prefix) + '/home', LD_PRELOAD: '/bad.so' }), { platform: 'android' });
    assert.equal(env.LD_PRELOAD, undefined);
    assert.equal(env.PREFIX, prefix);
    assert.equal(env.TMUX_TMPDIR, path.join(prefix, 'var', 'run'));
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('minimalRuntimeEnv: provider/credential/loader injection still excluded on Termux', () => {
  const { tmpRoot, prefix, libPath } = makeTermuxPrefix('libtermux-exec.so');
  try {
    const env = minimalRuntimeEnv({
      HOME: path.dirname(prefix) + '/home', PATH: '/bin', PREFIX: prefix,
      LD_PRELOAD: libPath, // trusted: survives
      // untrusted: must be dropped
      NODE_OPTIONS: '--require bad', DYLD_INSERT_LIBRARIES: '/bad.dylib',
      TERMUX_EXEC_UNRELATED: 'x', TERMUX_API_KEY: 'secret',
      OPENAI_API_KEY: 'sk-secret', ANTHROPIC_AUTH_TOKEN: 'tok',
      API_KEY: 'secret', SHELL: '/bin/sh',
    }, { platform: 'android' });
    assert.equal(env.LD_PRELOAD, libPath);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.DYLD_INSERT_LIBRARIES, undefined);
    assert.equal(env.TERMUX_EXEC_UNRELATED, undefined);
    assert.equal(env.TERMUX_API_KEY, undefined);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.API_KEY, undefined);
    assert.equal(env.SHELL, '/bin/sh'); // allowlisted key still passes
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('minimalRuntimeEnv: off-Termux the preload is never preserved (no regression)', () => {
  const env = minimalRuntimeEnv({ HOME: '/home/tester', PATH: '/usr/bin', LD_PRELOAD: '/data/data/com.termux/files/usr/lib/libtermux-exec.so' }, { platform: 'linux' });
  assert.equal(env.LD_PRELOAD, undefined);
});
