'use strict';
// B4.3 — Test del service companion di boot: installFleetService (speculare a
// installService) + selectProviderModeSync + wiring runInit (design §4c/§9b/§9d).
// Stile dei test esistenti (node:test, tmpHome, cleanup fs.rmSync). Commenti in IT.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  installFleetService, fleetInstallPath, fleetFileMode,
  generateFleetService, migrationGate, selectProviderModeSync,
} = require('../lib/cli/fleet-service.js');
const { runInit } = require('../lib/cli/init.js');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nc-fleet-'));
}

// fleet.json valido minimale (stessa shape dei test fleet-builtin): command/cwd
// assoluti reali sotto home (parseDefinitions valido, fail-closed su garbage).
function writeValidFleet(defsPath, home) {
  const command = path.join(home, 'bin', 'fleet-bin');
  fs.mkdirSync(path.dirname(command), { recursive: true });
  fs.writeFileSync(command, '#!/bin/sh\necho hi\n', { mode: 0o755 });
  const cwd = path.join(home, 'Dev');
  fs.mkdirSync(cwd, { recursive: true });
  const def = {
    schemaVersion: 1,
    engines: [{
      id: 'claude', label: 'Claude', rc: true,
      command, args: ['--dangerously-skip-permissions'],
      promptMode: 'flag', promptFlag: '--append-system-prompt',
    }],
    cells: [{ id: 'Dev', cwd, engine: 'claude', boot: true }],
  };
  fs.mkdirSync(path.dirname(defsPath), { recursive: true });
  fs.writeFileSync(defsPath, JSON.stringify(def), { mode: 0o600 });
  return { command, cwd };
}

// ---------------------------------------------------------------------------
// installFleetService — UNIT (speculare a installService)
// ---------------------------------------------------------------------------

test('installFleetService linux: scrive unit + daemon-reload + enable, NESSUN restart (oneshot §4c)', () => {
  const home = tmpHome();
  const target = path.join(home, 'fleet.service');
  const calls = [];
  const content = generateFleetService({
    platform: 'linux', nodeBin: '/usr/bin/node',
    entryPath: path.join(home, 'repo', 'bin', 'nexuscrew.js'),
    repoRoot: path.join(home, 'repo'),
  });
  const r = installFleetService('linux', content, { home, uid: 1000, installPath: target }, {
    execImpl: (b, a) => calls.push([b, a]),
  });
  assert.equal(r.written, true);
  assert.ok(fs.existsSync(target));
  // contenuto generato preservato (verifica scrittura integrale)
  const onDisk = fs.readFileSync(target, 'utf8');
  assert.ok(onDisk.includes('fleet-boot'));
  assert.ok(/Type=oneshot/.test(onDisk));
  // daemon-reload + enable del companion; NESSUN restart (oneshot, parte al boot)
  assert.ok(calls.some(([b, a]) => b === 'systemctl' && a.join(' ') === '--user daemon-reload'));
  assert.ok(calls.some(([b, a]) => b === 'systemctl' && a.join(' ') === '--user enable nexuscrew-fleet.service'));
  assert.ok(!calls.some(([b, a]) => /restart/.test(a.join(' '))), 'oneshot non deve restartare');
  fs.rmSync(home, { recursive: true, force: true });
});

test('installFleetService mac: scrive plist com.mmmbuto.nexuscrew-fleet + bootstrap', () => {
  const home = tmpHome();
  const target = path.join(home, 'com.mmmbuto.nexuscrew-fleet.plist');
  const calls = [];
  const content = generateFleetService({
    platform: 'mac', nodeBin: '/usr/local/bin/node',
    entryPath: path.join(home, 'repo', 'bin', 'nexuscrew.js'),
    repoRoot: path.join(home, 'repo'), home,
  });
  const r = installFleetService('mac', content, { home, uid: 501, installPath: target }, {
    execImpl: (b, a) => calls.push([b, a]),
  });
  assert.equal(r.written, true);
  assert.ok(fs.existsSync(target));
  const plist = fs.readFileSync(target, 'utf8');
  assert.ok(plist.includes('com.mmmbuto.nexuscrew-fleet'));
  assert.match(plist, /<key>PATH<\/key>\s*<string>\/usr\/local\/bin:\/opt\/homebrew\/bin:\/usr\/bin:\/bin<\/string>/);
  // idempotente come service.js: bootout (ignore se assente) + bootstrap
  assert.ok(calls.some(([b, a]) => b === 'launchctl'
    && a.join(' ') === `bootstrap gui/501 ${target}`));
  fs.rmSync(home, { recursive: true, force: true });
});

test('installFleetService termux: boot script chmod 755 (design)', () => {
  const home = tmpHome();
  const target = path.join(home, '.termux', 'boot', 'nexuscrew-fleet.sh');
  const r = installFleetService('termux', '#!/data/data/com.termux/files/usr/bin/sh\nexit 0\n',
    { home, installPath: target }, { execImpl: () => {} });
  assert.equal(r.written, true);
  assert.equal(fs.statSync(target).mode & 0o777, 0o755); // chmod 755 (boot script eseguibile)
  fs.rmSync(home, { recursive: true, force: true });
});

test('installFleetService dry-run: nessuna scrittura FS, nessun exec', () => {
  const home = tmpHome();
  const target = path.join(home, 'fleet.service');
  const r = installFleetService('linux', '# fake', { home, installPath: target }, {
    dryRun: true,
    execImpl: () => { throw new Error('non deve chiamare il service manager'); },
  });
  assert.equal(r.written, false);
  assert.ok(!fs.existsSync(target));
  fs.rmSync(home, { recursive: true, force: true });
});

test('installFleetService activation fallita: file PRESERVATO + failures raccolti (M1)', () => {
  const home = tmpHome();
  const target = path.join(home, 'fleet.service');
  const r = installFleetService('linux', '# fake unit', { home, installPath: target }, {
    execImpl: () => { throw new Error('systemctl broken'); },
  });
  assert.equal(r.written, true);
  assert.ok(fs.existsSync(target)); // file preservato (no rollback)
  assert.ok(r.failures.length > 0); // activation fallita NON ingoiata
  assert.ok(r.failures.some((f) => /daemon-reload|enable/.test(f.cmd)));
  fs.rmSync(home, { recursive: true, force: true });
});

test('installFleetService: rifiuta symlink target (no-symlink atomic, M3)', () => {
  const home = tmpHome();
  const real = path.join(home, 'real.service');
  const link = path.join(home, 'fleet.service');
  fs.writeFileSync(real, '# real');
  fs.symlinkSync(real, link);
  assert.throws(
    () => installFleetService('linux', '# fake', { home, installPath: link }, { execImpl: () => {} }),
    /symlink/,
  );
  fs.rmSync(home, { recursive: true, force: true });
});

test('installFleetService: idempotente su installazione gia\' presente (reinstall ok)', () => {
  const home = tmpHome();
  const target = path.join(home, 'fleet.service');
  installFleetService('linux', '# v1', { home, installPath: target }, { execImpl: () => {} });
  // seconda installazione sovrascrive atomicamente (no errore su file esistente)
  const r = installFleetService('linux', '# v2', { home, installPath: target }, { execImpl: () => {} });
  assert.equal(r.written, true);
  assert.equal(fs.readFileSync(target, 'utf8'), '# v2');
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// fleetInstallPath / fleetFileMode
// ---------------------------------------------------------------------------

test('fleetInstallPath: nomi companion linux/mac/termux', () => {
  assert.equal(fleetInstallPath('linux', '/h'), path.join('/h', '.config', 'systemd', 'user', 'nexuscrew-fleet.service'));
  assert.equal(fleetInstallPath('mac', '/h'), path.join('/h', 'Library', 'LaunchAgents', 'com.mmmbuto.nexuscrew-fleet.plist'));
  assert.equal(fleetInstallPath('termux', '/h'), path.join('/h', '.termux', 'boot', 'nexuscrew-fleet.sh'));
});

test('fleetFileMode: termux 755, linux/mac 644', () => {
  assert.equal(fleetFileMode('linux'), 0o644);
  assert.equal(fleetFileMode('mac'), 0o644);
  assert.equal(fleetFileMode('termux'), 0o755);
});

// ---------------------------------------------------------------------------
// selectProviderModeSync — resolver sync fedele a selectProvider (companion
// solo se builtin §9b). Seam di default del companion; i test di runInit sotto
// iniettano opts.selectProvider per controllare il mode deterministicamente.
// ---------------------------------------------------------------------------

test('selectProviderModeSync: disabled se fleetEnabled=false', () => {
  assert.equal(selectProviderModeSync({ fleetEnabled: false }).mode, 'disabled');
});

test('selectProviderModeSync: builtin se fleet.json valido', () => {
  const home = tmpHome();
  const defsPath = path.join(home, '.nexuscrew', 'fleet.json');
  writeValidFleet(defsPath, home);
  const r = selectProviderModeSync({ home, fleetDefsPath: defsPath });
  assert.equal(r.mode, 'builtin');
  fs.rmSync(home, { recursive: true, force: true });
});

test('selectProviderModeSync: un vecchio binario fleet non cambia il provider builtin', () => {
  const home = tmpHome();
  const defsPath = path.join(home, '.nexuscrew', 'fleet.json');
  writeValidFleet(defsPath, home);
  const bin = path.join(home, '.local', 'bin', 'fleet');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  const r = selectProviderModeSync({ home, fleetDefsPath: defsPath });
  assert.equal(r.mode, 'builtin');
  fs.rmSync(home, { recursive: true, force: true });
});

test('selectProviderModeSync: ignora anche un vecchio fleet sotto $PREFIX', () => {
  const home = tmpHome();
  const prefix = path.join(home, 'termux-prefix');
  const bin = path.join(prefix, 'bin', 'fleet');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  const defsPath = path.join(home, '.nexuscrew', 'fleet.json');
  writeValidFleet(defsPath, home);
  const r = selectProviderModeSync({
    home,
    fleetDefsPath: defsPath,
    env: { PREFIX: prefix },
  });
  assert.equal(r.mode, 'builtin');
  fs.rmSync(home, { recursive: true, force: true });
});

test('selectProviderModeSync: fleet.json mancante fallisce chiuso', () => {
  const home = tmpHome();
  const missing = path.join(home, '.nexuscrew', 'fleet.json');
  assert.equal(selectProviderModeSync({ home, fleetDefsPath: missing }).mode, 'disabled');
  fs.rmSync(home, { recursive: true, force: true });
});

test('selectProviderModeSync: auto disabled se fleet.json non esiste', () => {
  const home = tmpHome();
  const r = selectProviderModeSync({ home, fleetDefsPath: path.join(home, '.nexuscrew', 'fleet.json') });
  assert.equal(r.mode, 'disabled');
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// runInit — integrazione companion (design §9b/§9d). Il companion NON deve mai
// far fallire l'init principale. selectProvider/migrationGate iniettabili.
// ---------------------------------------------------------------------------

test('runInit companion: READONLY -> non installato (§9d)', () => {
  const home = tmpHome();
  const fleetTarget = path.join(home, 'fleet.service');
  const r = runInit({
    platform: 'linux', home, tmuxOk: true,
    installPath: path.join(home, 'svc.service'), fleetInstallPath: fleetTarget,
    readonly: true,
    selectProvider: () => ({ mode: 'builtin' }),
    migrationGate: () => ({ blocked: false }),
    execImpl: () => { throw new Error('READONLY: non deve installare'); },
    log: () => {},
  });
  assert.ok(r.actions.some((a) => /fleet companion: READONLY/.test(a)));
  assert.ok(!fs.existsSync(fleetTarget)); // non installato
  fs.rmSync(home, { recursive: true, force: true });
});

test('runInit companion: NEXUSCREW_READONLY=1 (env) -> non installato (§9d)', () => {
  const home = tmpHome();
  const fleetTarget = path.join(home, 'fleet.service');
  process.env.NEXUSCREW_READONLY = '1';
  try {
    const r = runInit({
      platform: 'linux', home, tmuxOk: true,
      installPath: path.join(home, 'svc.service'), fleetInstallPath: fleetTarget,
      selectProvider: () => ({ mode: 'builtin' }),
      migrationGate: () => ({ blocked: false }),
      execImpl: () => { throw new Error('READONLY: non deve installare'); },
      log: () => {},
    });
    assert.ok(r.actions.some((a) => /fleet companion: READONLY/.test(a)));
    assert.ok(!fs.existsSync(fleetTarget));
  } finally {
    delete process.env.NEXUSCREW_READONLY;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test('runInit companion: provider disabled -> non installato (§9b)', () => {
  const home = tmpHome();
  const fleetTarget = path.join(home, 'fleet.service');
  const r = runInit({
    platform: 'linux', home, tmuxOk: true,
    installPath: path.join(home, 'svc.service'), fleetInstallPath: fleetTarget,
    selectProvider: () => ({ mode: 'disabled' }),
    migrationGate: () => ({ blocked: false }),
    execImpl: () => {},
    log: () => {},
  });
  assert.ok(r.actions.some((a) => /fleet companion: non installato \(provider disabled\)/.test(a)));
  assert.ok(!fs.existsSync(fleetTarget));
  fs.rmSync(home, { recursive: true, force: true });
});

test('runInit companion: migration gate bloccato -> WARN remediation, NON installa (§9b)', () => {
  const home = tmpHome();
  const fleetTarget = path.join(home, 'fleet.service');
  const r = runInit({
    platform: 'linux', home, tmuxOk: true,
    installPath: path.join(home, 'svc.service'), fleetInstallPath: fleetTarget,
    selectProvider: () => ({ mode: 'builtin' }),
    migrationGate: () => ({
      blocked: true, units: ['cloud-cell@Foo.service'],
      remediation: 'disabilita le unit legacy cloud-cell@*.service',
    }),
    execImpl: () => { throw new Error('gate bloccato: non deve installare'); },
    log: () => {},
  });
  assert.ok(r.actions.some((a) => /WARN.*migration gate bloccato/.test(a)));
  assert.ok(r.actions.some((a) => /cloud-cell@Foo\.service/.test(a)));
  assert.ok(!fs.existsSync(fleetTarget)); // mai doppio boot
  fs.rmSync(home, { recursive: true, force: true });
});

test('runInit companion: dry-run -> generato, NON installato', () => {
  const home = tmpHome();
  const fleetTarget = path.join(home, 'fleet.service');
  const r = runInit({
    platform: 'linux', home, dryRun: true, tmuxOk: true,
    installPath: path.join(home, 'svc.service'), fleetInstallPath: fleetTarget,
    selectProvider: () => ({ mode: 'builtin' }),
    migrationGate: () => ({ blocked: false }),
    execImpl: () => { throw new Error('dry-run: non deve scrivere/installare'); },
    log: () => {},
  });
  assert.ok(r.actions.some((a) => /DRY-RUN fleet companion generato, NON installato/.test(a)));
  assert.ok(!fs.existsSync(fleetTarget));
  fs.rmSync(home, { recursive: true, force: true });
});

test('runInit companion: builtin happy path -> installa companion (daemon-reload+enable)', () => {
  const home = tmpHome();
  const fleetTarget = path.join(home, 'fleet.service');
  const calls = [];
  const r = runInit({
    platform: 'linux', home, tmuxOk: true,
    installPath: path.join(home, 'svc.service'), fleetInstallPath: fleetTarget,
    selectProvider: () => ({ mode: 'builtin' }),
    migrationGate: () => ({ blocked: false }),
    execImpl: (b, a) => calls.push([b, a]),
    log: () => {},
  });
  assert.ok(fs.existsSync(fleetTarget));
  assert.ok(fs.readFileSync(fleetTarget, 'utf8').includes('fleet-boot'));
  // enable del companion (distinto dal service principale 'nexuscrew')
  assert.ok(calls.some(([b, a]) => b === 'systemctl' && a.join(' ') === '--user enable nexuscrew-fleet.service'));
  assert.ok(r.actions.some((a) => /fleet companion installed/.test(a)));
  fs.rmSync(home, { recursive: true, force: true });
});

test('runInit companion: activation fallita -> WARN + file preservato (non blocca init)', () => {
  const home = tmpHome();
  const fleetTarget = path.join(home, 'fleet.service');
  const r = runInit({
    platform: 'linux', home, tmuxOk: true,
    installPath: path.join(home, 'svc.service'), fleetInstallPath: fleetTarget,
    selectProvider: () => ({ mode: 'builtin' }),
    migrationGate: () => ({ blocked: false }),
    execImpl: () => { throw new Error('systemctl broken'); },
    log: () => {},
  });
  assert.ok(fs.existsSync(fleetTarget)); // file preservato
  assert.ok(r.actions.some((a) => /WARN.*fleet companion.*activation fallita/.test(a)));
  // init principale comunque completato (URL stampato)
  assert.ok(r.actions.some((a) => /^URL:/.test(a)));
  fs.rmSync(home, { recursive: true, force: true });
});

test('runInit companion: errore interno -> WARN, init principale prosegue', () => {
  const home = tmpHome();
  const r = runInit({
    platform: 'linux', home, tmuxOk: true,
    installPath: path.join(home, 'svc.service'),
    // selectProvider che throwa: simula bug/errore nel resolver
    selectProvider: () => { throw new Error('boom resolver'); },
    execImpl: () => {},
    log: () => {},
  });
  assert.ok(r.actions.some((a) => /WARN.*fleet companion fallito/.test(a)));
  assert.ok(r.actions.some((a) => /^URL:/.test(a))); // init principale ok
  fs.rmSync(home, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// migrationGate (già esportata, ma verifichiamo il contrato usato dal companion)
// ---------------------------------------------------------------------------

test('migrationGate: non-linux passa (no systemd)', () => {
  const r = migrationGate({ platform: 'termux' });
  assert.equal(r.blocked, false);
});

test('migrationGate: exec che elenca cloud-cell@*.service -> blocked', () => {
  const r = migrationGate({
    platform: 'linux',
    exec: () => 'cloud-cell@SysAdmin.service  enabled\ncloud-cell@Dev.service  enabled\n',
  });
  assert.equal(r.blocked, true);
  assert.ok(r.units.includes('cloud-cell@SysAdmin.service'));
  assert.ok(r.remediation);
});

test('migrationGate: exec senza unit legacy -> non bloccato', () => {
  const r = migrationGate({ platform: 'linux', exec: () => '' });
  assert.equal(r.blocked, false);
});
