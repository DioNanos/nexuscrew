'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runInit, readExistingPort, nodeMajor } = require('../lib/cli/init.js');

function tmpHome() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-init-'));
  return h;
}

test('nodeMajor: numero intero positivo', () => {
  assert.ok(nodeMajor() >= 18); // il runtime di test ha Node >= 18
});

test('runInit dry-run: nessuna scrittura FS', () => {
  const home = tmpHome();
  const logs = [];
  const r = runInit({ platform: 'linux', home, dryRun: true, tmuxOk: true, log: (m) => logs.push(m) });
  assert.equal(r.dryRun, true);
  assert.ok(!fs.existsSync(path.join(home, '.nexuscrew', 'config.json')));
  assert.ok(!fs.existsSync(path.join(home, '.nexuscrew', 'token')));
  assert.ok(!fs.existsSync(path.join(home, 'NexusFiles')));
  assert.ok(logs.some((l) => /DRY-RUN/.test(l)));
  fs.rmSync(home, { recursive: true, force: true });
});

test('runInit: crea config + token + NexusFiles (linux, tmux ok)', () => {
  const home = tmpHome();
  const installTarget = path.join(home, '.config', 'systemd', 'user', 'nexuscrew.service');
  const calls = [];
  const r = runInit({
    platform: 'linux', home, port: 41820, tmuxOk: true,
    installPath: installTarget,
    execImpl: (b, a) => calls.push([b, a]),
    log: () => {},
  });
  assert.ok(fs.existsSync(path.join(home, '.nexuscrew', 'config.json')));
  assert.ok(fs.existsSync(path.join(home, '.nexuscrew', 'token')));
  assert.ok(fs.existsSync(path.join(home, 'NexusFiles')));
  assert.ok(fs.existsSync(installTarget)); // service installato
  assert.equal(r.port, 41820);
  assert.ok(r.url.includes('#token='));
  assert.ok(calls.some((c) => c[0] === 'systemctl'));
  fs.rmSync(home, { recursive: true, force: true });
});

test('runInit migration rule: porta dal service esistente (B2, drop-in su installazione esistente)', () => {
  const home = tmpHome();
  const installTarget = path.join(home, '.config', 'systemd', 'user', 'nexuscrew.service');
  // service esistente con NEXUSCREW_PORT=41777 (simula un service legacy con porta hardcoded)
  fs.mkdirSync(path.dirname(installTarget), { recursive: true });
  fs.writeFileSync(installTarget, `[Service]\nEnvironment=NEXUSCREW_PORT=41777\nExecStart=/old/node bin/nexuscrew.js serve\n`);
  // NESSUN config.json -> migration deve leggere 41777
  const r = runInit({
    platform: 'linux', home, tmuxOk: true,
    installPath: installTarget, execImpl: () => {}, log: () => {},
  });
  assert.equal(r.port, 41777); // migrata dal service, non default 41820
  const cfg = JSON.parse(fs.readFileSync(path.join(home, '.nexuscrew', 'config.json'), 'utf8'));
  assert.equal(cfg.port, 41777); // scritta in config.json
  assert.ok(r.actions.some((a) => /migration.*41777/.test(a)));
  fs.rmSync(home, { recursive: true, force: true });
});

test('runInit: preserva config esistente (no overwrite)', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true });
  fs.writeFileSync(path.join(home, '.nexuscrew', 'config.json'), JSON.stringify({ port: 41999 }) + '\n', { mode: 0o600 });
  const r = runInit({ platform: 'linux', home, tmuxOk: true, installPath: path.join(home, 'svc.service'), execImpl: () => {}, log: () => {} });
  assert.equal(r.port, 41999); // config esistente vince su default
  const cfg = JSON.parse(fs.readFileSync(path.join(home, '.nexuscrew', 'config.json'), 'utf8'));
  assert.equal(cfg.port, 41999); // invariato
  fs.rmSync(home, { recursive: true, force: true });
});

test('runInit: token preservato (no overwrite)', () => {
  const home = tmpHome();
  fs.mkdirSync(path.join(home, '.nexuscrew'), { recursive: true });
  fs.writeFileSync(path.join(home, '.nexuscrew', 'token'), 'EXISTING_TOKEN\n', { mode: 0o600 });
  const r = runInit({ platform: 'linux', home, tmuxOk: true, installPath: path.join(home, 'svc.service'), execImpl: () => {}, log: () => {} });
  assert.equal(r.token, 'EXISTING_TOKEN'); // preservato
  assert.equal(fs.readFileSync(path.join(home, '.nexuscrew', 'token'), 'utf8').trim(), 'EXISTING_TOKEN');
  fs.rmSync(home, { recursive: true, force: true });
});

test('runInit: tmux mancante -> service NON installato, config/token creati (M8)', () => {
  const home = tmpHome();
  const installTarget = path.join(home, 'svc.service');
  const r = runInit({ platform: 'linux', home, tmuxOk: false, installPath: installTarget, execImpl: () => { throw new Error('non deve chiamare'); }, log: () => {} });
  assert.equal(r.tmuxOk, false);
  assert.ok(!fs.existsSync(installTarget)); // service non installato
  assert.ok(fs.existsSync(path.join(home, '.nexuscrew', 'config.json'))); // ma config creato
  assert.ok(fs.existsSync(path.join(home, '.nexuscrew', 'token'))); // token creato
  assert.ok(r.actions.some((a) => /tmux non trovato/.test(a)));
  fs.rmSync(home, { recursive: true, force: true });
});

test('runInit termux: disclaimer Termux:boot best-effort (R4)', () => {
  const home = tmpHome();
  const r = runInit({ platform: 'termux', home, tmuxOk: true, installPath: path.join(home, 'boot.sh'), execImpl: () => {}, log: () => {} });
  assert.ok(r.actions.some((a) => /Termux:boot/.test(a)));
  // disclaimer menziona l'app Android
  assert.ok(r.actions.some((a) => /Termux:Boot|app/.test(a)));
  fs.rmSync(home, { recursive: true, force: true });
});

test('runInit: URL stampato con #token', () => {
  const home = tmpHome();
  const r = runInit({ platform: 'linux', home, port: 41820, tmuxOk: true, installPath: path.join(home, 'svc.service'), execImpl: () => {}, log: () => {} });
  assert.match(r.url, /http:\/\/127\.0\.0\.1:41820\/#token=/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('runInit: activation fallita -> WARN con diagnosi (M1)', () => {
  const home = tmpHome();
  const r = runInit({
    platform: 'linux', home, tmuxOk: true,
    installPath: path.join(home, 'svc.service'),
    execImpl: () => { throw new Error('systemctl broken'); },
    log: () => {},
  });
  assert.ok(r.actions.some((a) => /activation fallita/.test(a))); // failure visibile (non ingoiata)
  fs.rmSync(home, { recursive: true, force: true });
});

test('readExistingPort: parse service linux/mac/termux', () => {
  const linux = '[Service]\nEnvironment=NEXUSCREW_PORT=41777\n';
  assert.equal(readExistingPort('linux', '/h', writeTmp(linux)), 41777);
  const mac = '<key>NEXUSCREW_PORT</key><string>41777</string>';
  assert.equal(readExistingPort('mac', '/h', writeTmp(mac)), 41777);
  const termux = 'export NEXUSCREW_PORT=41777\n';
  assert.equal(readExistingPort('termux', '/h', writeTmp(termux)), 41777);
  assert.equal(readExistingPort('linux', '/h', '/nonexistent'), null);
});

function writeTmp(content) {
  const p = path.join(os.tmpdir(), 'nc-port-' + Math.random().toString(36).slice(2));
  fs.writeFileSync(p, content);
  return p;
}
