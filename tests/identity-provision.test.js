'use strict';
// : provisioning dell'authority mode. File 0600 in dir 0700, credenziali
// distinte, idempotenza senza --force, config scritta o stampata. Nessun
// valore di credenziale nei ritorni.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { provisionIdentityAuthority, defaultAuthorityDir } = require('../lib/fleet/identity-provision.js');
const { loadConfig } = require('../lib/config.js');

function mondo() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-prov-'));
  process.env.NEXUSCREW_CONFIG_FILE = path.join(home, 'config.json');
  return { home, configPath: path.join(home, 'config.json') };
}

test('provision: scrive due credenziali distinte 0600 in dir 0700', () => {
  const { home } = mondo();
  const r = provisionIdentityAuthority({ home });
  assert.equal(r.ok, true);
  assert.equal(r.mode, 'authority');
  const dir = defaultAuthorityDir(home);
  assert.equal((fs.lstatSync(dir).mode & 0o777), 0o700);
  const values = [];
  for (const name of ['daemon.credential', 'launcher.credential']) {
    const filePath = path.join(dir, name);
    const st = fs.lstatSync(filePath);
    assert.equal(st.isFile(), true);
    assert.equal((st.mode & 0o777), 0o600);
    const value = fs.readFileSync(filePath, 'utf8').trim();
    assert.ok(value.length >= 64, 'credienza >= 32 byte di entropia');
    values.push(value);
  }
  assert.notEqual(values[0], values[1], 'le due credenziali devono essere distinte');
  assert.equal(JSON.stringify(r).includes(values[0]), false, 'nessun valore nei ritorni');
});

test('provision: idempotente senza --force (non sovrascrive), --force rigenera', () => {
  const { home } = mondo();
  const first = provisionIdentityAuthority({ home });
  assert.equal(first.ok, true);
  const daemonPath = path.join(defaultAuthorityDir(home), 'daemon.credential');
  const before = fs.readFileSync(daemonPath, 'utf8');
  const second = provisionIdentityAuthority({ home });
  assert.equal(second.ok, false);
  assert.equal(second.code, 'ALREADY_PROVISIONED');
  assert.equal(fs.readFileSync(daemonPath, 'utf8'), before, 'file intatto senza --force');
  const third = provisionIdentityAuthority({ home, force: true });
  assert.equal(third.ok, true);
  assert.notEqual(fs.readFileSync(daemonPath, 'utf8'), before, '--force rigenera le credenziali');
});

test('provision: --no-write-config non tocca la config e stampa le istruzioni', () => {
  const { home, configPath } = mondo();
  const r = provisionIdentityAuthority({ home, writeConfig: false });
  assert.equal(r.ok, true);
  assert.equal(r.configUpdated, false);
  assert.match(r.configInstructions, /fleet\.identity\.mode = "authority"/);
  assert.equal(fs.existsSync(configPath), false);
});

test('provision: scrive fleet.identity.mode=authority preservando la config esistente', () => {
  const { home, configPath } = mondo();
  fs.writeFileSync(configPath, JSON.stringify({ port: 41821, existing: 'keep' }));
  const r = provisionIdentityAuthority({ home, configPath });
  assert.equal(r.ok, true);
  assert.equal(r.configUpdated, true);
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  assert.equal(cfg.port, 41821, 'chiavi esistenti preservate');
  assert.equal(cfg.existing, 'keep');
  assert.equal(cfg.fleet.identity.mode, 'authority');
});

test('loadConfig: legge le credenziali dai file provisionati', () => {
  const { home } = mondo();
  provisionIdentityAuthority({ home });
  const cfg = loadConfig({ home });
  assert.ok(cfg.identityDaemonCredential, 'daemon credential caricata');
  assert.ok(cfg.identityLauncherCredential, 'launcher credential caricata');
  assert.notEqual(cfg.identityDaemonCredential, cfg.identityLauncherCredential);
  assert.ok(cfg.identityDaemonCredential.length >= 64);
});

// --- N-1/N-2: distinct enforced (provision + load) e permessi at load --------

test('provision: credenziali identiche (random degenere) -> rifiuto, nulla scritto', () => {
  const { home } = mondo();
  const r = provisionIdentityAuthority({
    home,
    randomBytes: (size) => Buffer.alloc(size, 1), // entropia degenera: sempre identiche
  });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'IDENTICAL_CREDENTIALS');
  assert.match(r.message, /identical/);
  assert.equal(fs.readdirSync(defaultAuthorityDir(home)).filter((f) => f.endsWith('.credential')).length, 0,
    'nessuna credenziale identica deve finire su disco');
  // Anche con --force: rifiuto identico.
  const r2 = provisionIdentityAuthority({
    home, force: true,
    randomBytes: (size) => Buffer.alloc(size, 1),
  });
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'IDENTICAL_CREDENTIALS');
});

test('loadConfig: credenziali identiche nei file -> non caricate + fault registrato', () => {
  const { home } = mondo();
  const dir = defaultAuthorityDir(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'daemon.credential'), 'stesso-segreto\n', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'launcher.credential'), 'stesso-segreto\n', { mode: 0o600 });
  const cfg = loadConfig({ home });
  assert.equal(cfg.identityDaemonCredential, undefined, 'credenziali identiche: non caricate');
  assert.equal(cfg.identityLauncherCredential, undefined);
  assert.match(cfg.identityAuthorityFault || '', /identical/);
});

test('loadConfig: file credenziale 0644 -> rifiutato con fault permessi', () => {
  const { home } = mondo();
  const dir = defaultAuthorityDir(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'daemon.credential'), 'buono\n', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'launcher.credential'), 'permessi-larghi\n', { mode: 0o644 });
  const cfg = loadConfig({ home });
  assert.equal(cfg.identityDaemonCredential, undefined);
  assert.equal(cfg.identityLauncherCredential, undefined);
  assert.match(cfg.identityAuthorityFault || '', /0600/);
});

test('doctor: credenziali identiche -> credentials distinct: no e authority non costruibile', () => {
  const { checkIdentityAuthorityMode } = require('../lib/cli/doctor.js');
  const { home, configPath } = mondo();
  const dir = defaultAuthorityDir(home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'daemon.credential'), 'stesso-segreto\n', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'launcher.credential'), 'stesso-segreto\n', { mode: 0o600 });
  fs.writeFileSync(configPath, JSON.stringify({ fleet: { identity: { mode: 'authority' } } }));
  const check = checkIdentityAuthorityMode({ home, configPath });
  assert.equal(check.ok, false, 'authority richiesta con credenziali identiche: non costruibile');
  assert.match(check.detail, /credentials distinct: no/);
});
