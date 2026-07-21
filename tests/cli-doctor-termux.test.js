'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert');
// doctor.js has no external (express/qrcode) deps: it loads the platform/url/
// auth/path helpers and the runtime env helpers only. Keeping this file
// dependency-free lets the Tranche A doctor boundary run in isolation.
const { checkTermuxExec, doctor } = require('../lib/cli/doctor.js');

// Synthetic Termux prefix under a temp dir whose path contains `com.termux`.
function makeTermuxPrefix(withLib) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-doctor-termux-'));
  const prefix = path.join(tmpRoot, 'com.termux', 'files', 'usr');
  const libDir = path.join(prefix, 'lib');
  fs.mkdirSync(libDir, { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'com.termux', 'files', 'home'), { recursive: true });
  let libPath = null;
  if (withLib) {
    libPath = path.join(libDir, withLib);
    fs.writeFileSync(libPath, 'dummy', { mode: 0o755 });
    fs.chmodSync(libPath, 0o755);
  }
  return { tmpRoot, prefix, home: path.dirname(prefix) + '/home', libPath };
}

test('checkTermuxExec: off-Termux e non applicabile (ok, nessun warn)', () => {
  const r = checkTermuxExec({ HOME: '/home/tester', PATH: '/usr/bin' }, { platform: 'linux' });
  assert.equal(r.ok, true);
  assert.equal(r.warn, undefined);
  assert.match(r.detail, /non applicabile/);
});

test('checkTermuxExec: trusted preload presente -> OK', () => {
  const { tmpRoot, prefix, home, libPath } = makeTermuxPrefix('libtermux-exec-ld-preload.so');
  try {
    const r = checkTermuxExec({ PREFIX: prefix, HOME: home, LD_PRELOAD: libPath }, { platform: 'android' });
    assert.equal(r.ok, true);
    assert.equal(r.warn, undefined);
    assert.match(r.detail, /libtermux-exec-ld-preload\.so/);
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('checkTermuxExec: libreria presente ma preload non valido -> WARN azionabile', () => {
  const { tmpRoot, prefix, home } = makeTermuxPrefix('libtermux-exec.so');
  try {
    const r = checkTermuxExec({ PREFIX: prefix, HOME: home }, { platform: 'android' });
    assert.equal(r.ok, true);
    assert.equal(r.warn, true);
    assert.match(r.detail, /LD_PRELOAD non valido/);
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('checkTermuxExec: riconosce anche una variante versionata senza preload', () => {
  const { tmpRoot, prefix, home } = makeTermuxPrefix('libtermux-exec-2.1.so');
  try {
    const r = checkTermuxExec({ PREFIX: prefix, HOME: home }, { platform: 'android' });
    assert.equal(r.ok, true);
    assert.equal(r.warn, true);
    assert.match(r.detail, /libtermux-exec-2\.1\.so/);
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('checkTermuxExec: libreria assente su Termux -> FAIL (Play build non puo eseguire)', () => {
  const { tmpRoot, prefix, home } = makeTermuxPrefix(null);
  try {
    const r = checkTermuxExec({ PREFIX: prefix, HOME: home }, { platform: 'android' });
    assert.equal(r.ok, false);
    assert.match(r.detail, /libtermux-exec non trovata/);
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('checkTermuxExec: nessun dettaglio sensibile mai esposto (path completo ok, ma niente token/env)', () => {
  const { tmpRoot, prefix, home, libPath } = makeTermuxPrefix('libtermux-exec.so');
  try {
    const r = checkTermuxExec({
      PREFIX: prefix, HOME: home, LD_PRELOAD: libPath,
      OPENAI_API_KEY: 'sk-leak', ANTHROPIC_AUTH_TOKEN: 'tok',
    }, { platform: 'android' });
    assert.equal(r.ok, true);
    assert.ok(!String(r.detail).includes('sk-leak'));
    assert.ok(!String(r.detail).includes('tok'));
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('doctor: check termux-exec incluso nella suite e ok su Linux (nessuna regressione)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-doctor-suite-'));
  try {
    const svc = path.join(home, '.config', 'systemd', 'user', 'nexuscrew.service');
    fs.mkdirSync(path.dirname(svc), { recursive: true });
    fs.writeFileSync(svc, 'x');
    // Provide a valid 0600 token file so the unrelated token-perms check passes.
    const tokenPath = path.join(home, 'token');
    fs.writeFileSync(tokenPath, 't', { mode: 0o600 });
    fs.chmodSync(tokenPath, 0o600);
    const r = doctor({
      home, platform: 'linux', log: () => {}, installPath: svc, env: {}, tokenPath,
      fleetEnabled: false,
      execImpl: (_b, a) => {
        if (a && a.includes('is-active')) return 'active';
        if (a && a.includes('is-enabled')) return 'enabled';
        if (a && a.includes('--property=KillMode')) return 'process';
        return '';
      },
      ptyLoad: () => ({ spawn() {} }),
      commandExists: () => true,
    });
    const termuxCheck = r.checks.find((c) => c.name === 'termux-exec preload');
    assert.ok(termuxCheck, 'il check termux-exec e presente nella suite');
    assert.equal(termuxCheck.ok, true);
    assert.equal(r.code, 0); // off-Termux non fa fallire il doctor
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
