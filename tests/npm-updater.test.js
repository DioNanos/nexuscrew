'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const core = require('../lib/update/core.js');
const { createNpmUpdater, isGlobalInstall, lookupLatestNpm } = require('../lib/update/manager.js');
const { restartRuntime, runUpdate } = require('../lib/update/runner.js');

test('npm updater: confronto semver stabile/prerelease e parsing npm JSON', () => {
  assert.equal(core.compareVersions('0.8.9', '0.8.8'), 1);
  assert.equal(core.compareVersions('0.8.9', '0.8.9'), 0);
  assert.equal(core.compareVersions('0.8.9-beta.2', '0.8.9-beta.10'), -1);
  assert.equal(core.compareVersions('0.8.9', '0.8.9-rc.1'), 1);
  assert.equal(core.registryVersion('"1.2.3"\n'), '1.2.3');
  assert.equal(core.registryVersion('1.2.3\n'), '1.2.3');
  assert.equal(core.registryVersion('["1.2.3"]\n'), '1.2.3');
  assert.equal(core.registryVersion('{"version":"1.2.3"}\n'), '1.2.3');
  assert.equal(core.registryVersion('\u001b[32m1.2.3\u001b[0m\n'), '1.2.3');
  assert.throws(() => core.registryVersion('latest'), /versione non valida/);
});

test('npm updater: npm view usa cwd stabile anche se il cwd originario è stato eliminato', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-updater-cwd-'));
  let seen = null;
  const latest = await lookupLatestNpm({ home, execFileImpl: (_bin, _args, opts, cb) => {
    seen = opts.cwd; cb(null, '"0.8.13"\n');
  } });
  assert.equal(latest, '0.8.13');
  assert.equal(seen, path.join(home, '.nexuscrew'));
  assert.equal(fs.statSync(seen).isDirectory(), true);
  fs.rmSync(home, { recursive: true, force: true });
});

test('npm updater: riconosce installazioni globali Linux/macOS/Termux, non il checkout', () => {
  assert.equal(isGlobalInstall('/usr/lib/node_modules/@mmmbuto/nexuscrew'), true);
  assert.equal(isGlobalInstall('/opt/homebrew/lib/node_modules/@mmmbuto/nexuscrew'), true);
  assert.equal(isGlobalInstall('/data/data/com.termux/files/usr/lib/node_modules/@mmmbuto/nexuscrew'), true);
  assert.equal(isGlobalInstall('/home/tester/projects/nexuscrew'), false);
});

test('npm updater: latest inferiore non provoca mai downgrade', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-updater-'));
  let spawned = false;
  const updater = createNpmUpdater({
    currentVersion: '0.8.9', home: dir, statusPath: path.join(dir, 'state.json'),
    supported: true, enabled: false, lookupLatest: async () => '0.8.8',
    spawnImpl: () => { spawned = true; },
  });
  const status = await updater.check();
  assert.equal(status.available, false);
  assert.equal(status.latest, '0.8.8');
  assert.equal(status.phase, 'idle');
  assert.equal(spawned, false);
  updater.close();
});

test('npm updater: latest 0.8.24 non sostituisce current 0.8.25-alibaba.0', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-updater-alibaba-'));
  let spawned = false;
  const updater = createNpmUpdater({
    currentVersion: '0.8.25-alibaba.0', home: dir, statusPath: path.join(dir, 'state.json'),
    supported: true, enabled: true, lookupLatest: async () => '0.8.24',
    spawnImpl: () => { spawned = true; },
  });
  const status = await updater.check({ autoApply: true });
  assert.equal(core.compareVersions('0.8.24', '0.8.25-alibaba.0'), -1);
  assert.equal(status.available, false);
  assert.equal(status.latest, '0.8.24');
  assert.equal(status.phase, 'idle');
  assert.equal(spawned, false);
  updater.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('npm updater: applica esclusivamente la versione esatta verificata', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-updater-'));
  let call = null; let unref = false;
  const updater = createNpmUpdater({
    currentVersion: '0.8.8', home: dir, statusPath: path.join(dir, 'state.json'),
    logPath: path.join(dir, 'update.log'), runnerPath: '/safe/runner.js',
    supported: true, enabled: false, lookupLatest: async () => '0.8.9', useSystemdRun: false,
    spawnImpl: (bin, argv, opts) => { call = { bin, argv, opts }; return { pid: 43210, unref: () => { unref = true; } }; },
  });
  assert.equal((await updater.check()).available, true);
  const status = await updater.apply();
  assert.equal(status.phase, 'installing');
  assert.deepEqual(call.argv.slice(0, 3), ['/safe/runner.js', '--version', '0.8.9']);
  assert.equal(call.opts.detached, true);
  assert.equal(call.opts.cwd, path.join(dir, '.nexuscrew'));
  assert.equal(unref, true);
  updater.close();
});

test('npm update runner: install globale pin esatto, cwd stabile, verifica e restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-runner-'));
  const statusPath = path.join(dir, 'state.json');
  let install = null; let installOpts = null; let restarted = false;
  const out = await runUpdate({
    version: '0.8.9', home: dir, statusPath,
    execImpl: (bin, argv, opts) => { install = { bin, argv }; installOpts = opts; },
    readInstalledVersion: () => '0.8.9',
    preflightImpl: async () => true,
    restartImpl: async () => { restarted = true; return 'portable'; },
  });
  assert.equal(install.bin, 'npm');
  assert.ok(install.argv.includes('@mmmbuto/nexuscrew@0.8.9'));
  assert.equal(install.argv.includes('latest'), false);
  assert.equal(installOpts.cwd, path.join(dir, '.nexuscrew'));
  assert.equal(restarted, true);
  assert.deepEqual(out, { updated: true, version: '0.8.9', restartMode: 'portable' });
  const saved = core.readState(statusPath);
  assert.equal(saved.phase, 'installed');
  assert.equal(saved.current, '0.8.9');
});

test('npm update runner: failure redatta e nessun restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-runner-'));
  const statusPath = path.join(dir, 'state.json');
  let restarted = false;
  await assert.rejects(() => runUpdate({
    version: '0.8.9', home: dir, statusPath,
    execImpl: () => { throw new Error(`registry failed ${'A'.repeat(48)}`); },
    readInstalledVersion: () => '0.8.8', preflightImpl: async () => true,
    restartImpl: async () => { restarted = true; },
  }), /registry failed/);
  assert.equal(restarted, false);
  assert.equal(core.readState(statusPath).lastError.includes('A'.repeat(48)), false);
});

test('npm update runner: un restart service non verificato blocca update e health', async () => {
  let health = false;
  await assert.rejects(() => restartRuntime({
    home: '/tmp/nc-update-restart-guard', platform: 'linux', port: 41820, token: 'test-token',
    commands: {
      isServiceRunning: () => true,
      restart: () => ({ restarted: false, reason: 'tmux survival guard failed' }),
    },
    waitForRuntimeImpl: async () => { health = true; return true; },
  }), /tmux survival guard failed/);
  assert.equal(health, false);
});

test('npm updater: lock interprocesso rifiuta un secondo apply e check non clobbera installing', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-updater-lock-'));
  const common = {
    currentVersion: '0.8.8', home: dir, statusPath: path.join(dir, 'state.json'),
    lockPath: path.join(dir, 'update.lock'), logPath: path.join(dir, 'update.log'),
    supported: true, enabled: false, lookupLatest: async () => '0.8.9', useSystemdRun: false,
  };
  const first = createNpmUpdater({ ...common, spawnImpl: () => ({ pid: 43211, unref() {} }) });
  await first.check();
  assert.equal((await first.apply()).phase, 'installing');
  assert.equal((await first.check()).phase, 'installing', 'check non sovrascrive installing');
  const second = createNpmUpdater({ ...common, spawnImpl: () => { throw new Error('must not spawn'); } });
  await assert.rejects(() => second.apply(), (error) => error.status === 409 && error.code === 'update-busy');
  first.close(); second.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('npm updater: latest prerelease viene rifiutata anche se dist-tag errato', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-updater-prerelease-'));
  const updater = createNpmUpdater({ currentVersion: '0.8.8', home: dir,
    statusPath: path.join(dir, 'state.json'), supported: true, enabled: false,
    lookupLatest: async () => '0.8.9-rc.1' });
  const status = await updater.check();
  assert.equal(status.phase, 'error');
  assert.match(status.lastError, /prerelease/);
  updater.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('npm update runner: boot failure rolls back exact previous version once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-runner-rollback-'));
  const statusPath = path.join(dir, 'state.json');
  let installed = '0.8.8'; const installs = []; let restarts = 0;
  await assert.rejects(() => runUpdate({
    version: '0.8.9', home: dir, statusPath,
    execImpl: (_bin, argv) => { const spec = argv.find((arg) => arg.startsWith('@mmmbuto/nexuscrew@')); installed = spec.split('@').at(-1); installs.push(installed); },
    readInstalledVersion: () => installed,
    preflightImpl: async ({ version }) => { assert.equal(version, installed); },
    restartImpl: async () => { restarts += 1; if (restarts === 1) throw new Error('new runtime unhealthy'); return 'service'; },
  }), /unhealthy/);
  assert.deepEqual(installs, ['0.8.9', '0.8.8']);
  assert.equal(restarts, 2);
  const state = core.readState(statusPath);
  assert.equal(state.phase, 'error');
  assert.equal(state.rolledBackTo, '0.8.8');
  assert.equal(state.blockedVersion, '0.8.9');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('update errors redact registry credentials and local home paths', () => {
  const message = core.scrubError(new Error('https://user:password@registry.example /home/tester/.npm/_logs/x Bearer ' + 'Z'.repeat(44)));
  assert.equal(message.includes('password'), false);
  assert.equal(message.includes('/home/tester'), false);
  assert.equal(message.includes('Z'.repeat(44)), false);
});
