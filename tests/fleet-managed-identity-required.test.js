'use strict';
// D-233: CODEX_APP_SERVER_IDENTITY_REQUIRED e' '1' SOLO in authority mode con
// authority costruibile. Fuori di quello: '0' esplicito con log del motivo.
// Gli override espliciti (engine.env, cfg.env) vincono sempre; forzare '1'
// fuori dall'authority mode produce UNA riga di warning strutturato.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveManagedEngine } = require('../lib/fleet/managed.js');

const KEY = 'CODEX_APP_SERVER_IDENTITY_REQUIRED';
const ENGINE = { id: 'codex-vl.native', label: 'Codex-VL', managed: { client: 'codex-vl', provider: 'native', model: '' } };

function mondo() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-idreq-'));
  const bin = path.join(home, '.local', 'bin', 'codex-vl');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(bin, 0o755);
  const lines = [];
  const log = (m) => lines.push(String(m));
  return { home, lines, log };
}

function resolve(mondo, cfgExtra = {}, engine = ENGINE) {
  return resolveManagedEngine(engine, { id: 'Dev', prompt: 'bootstrap' }, { home: mondo.home, env: {}, log: mondo.log, ...cfgExtra });
}

test('identity required: default legacy -> 0 con log del motivo', () => {
  const m = mondo();
  const r = resolve(m);
  assert.equal(r.ok, true);
  assert.equal(r.engine.env[KEY], '0');
  assert.ok(m.lines.some((l) => l.includes('identity mode') && l.includes('legacy') && l.includes(KEY)), m.lines);
});

test('identity required: authority mode senza credenziali -> 0 con log credentials missing', () => {
  const m = mondo();
  const r = resolve(m, { fleetIdentityMode: 'authority' });
  assert.equal(r.ok, true);
  assert.equal(r.engine.env[KEY], '0');
  assert.ok(m.lines.some((l) => l.includes('authority credentials missing')), m.lines);
});

test('identity required: authority mode con credenziali -> 1 senza log di degradazione', () => {
  const m = mondo();
  const r = resolve(m, {
    fleetIdentityMode: 'authority',
    identityDaemonCredential: 'd'.repeat(32),
    identityLauncherCredential: 'l'.repeat(32),
  });
  assert.equal(r.ok, true);
  assert.equal(r.engine.env[KEY], '1');
  assert.equal(m.lines.filter((l) => l.includes(KEY)).length, 0);
});

test('identity required: authority gia costruita (cfg.identityAuthority) -> 1', () => {
  const m = mondo();
  const r = resolve(m, { fleetIdentityMode: 'authority', identityAuthority: { fake: true } });
  assert.equal(r.ok, true);
  assert.equal(r.engine.env[KEY], '1');
});

test('identity required: override definition esplicito rispettato anche fuori authority', () => {
  const m = mondo();
  const engine = { ...ENGINE, env: { [KEY]: '1' } };
  const r = resolve(m, {}, engine);
  assert.equal(r.ok, true);
  assert.equal(r.engine.env[KEY], '1');
  assert.ok(m.lines.some((l) => l.includes('override definition') && l.includes(KEY)), m.lines);
});

test('identity required: override runtime cfg.env esplicito rispettato', () => {
  const m = mondo();
  const r = resolve(m, { env: { [KEY]: '0' } });
  assert.equal(r.ok, true);
  assert.equal(r.engine.env[KEY], '0');
  // '0' esplicito in legacy: nessun warning, la degradazione e' coerente
  assert.equal(m.lines.filter((l) => l.includes('override')).length, 0);
});

test('identity required: override definition vince su cfg.env', () => {
  const m = mondo();
  const engine = { ...ENGINE, env: { [KEY]: '0' } };
  const r = resolve(m, { env: { [KEY]: '1' } }, engine);
  assert.equal(r.ok, true);
  assert.equal(r.engine.env[KEY], '0');
});

test('identity required: credenziali identiche nei file -> 0 con log del fault', () => {
  const m = mondo();
  const dir = path.join(m.home, '.nexuscrew', 'identity-authority');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'daemon.credential'), 'uguale\n', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'launcher.credential'), 'uguale\n', { mode: 0o600 });
  // Come in produzione: il runtime passa il cfg di loadConfig, che ha letto i
  // file e registrato il fault.
  const cfg = require('../lib/config.js').loadConfig({ home: m.home });
  const r = resolve(m, { ...cfg, fleetIdentityMode: 'authority' });
  assert.equal(r.ok, true);
  assert.equal(r.engine.env[KEY], '0');
  assert.ok((cfg.identityAuthorityFault || '').includes('identical'), cfg.identityAuthorityFault);
  assert.ok(m.lines.some((l) => l.includes('identical')), m.lines);
});

test('identity required: cfg con credenziali esplicite identiche -> 0 con log fault', () => {
  const m = mondo();
  const r = resolve(m, {
    fleetIdentityMode: 'authority',
    identityDaemonCredential: 'stesso',
    identityLauncherCredential: 'stesso',
  });
  assert.equal(r.ok, true);
  assert.equal(r.engine.env[KEY], '0');
  assert.ok(m.lines.some((l) => l.includes('identical')), m.lines);
});
