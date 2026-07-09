'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dispatch, serve, start, stop, status, parseFlags, HELP } = require('../lib/cli/commands.js');

// --- parseFlags ---

test('parseFlags: --dry-run, --port=N, --pidfile, rest', () => {
  const r = parseFlags(['init', '--dry-run', '--port=41820']);
  assert.equal(r.rest[0], 'init');
  assert.equal(r.flags['dry-run'], true);
  assert.equal(r.flags.port, '41820');
  const r2 = parseFlags(['serve', '--pidfile']);
  assert.equal(r2.flags.pidfile, true);
});

// --- dispatch help/unknown ---

test('dispatch: help -> code 0, stampa HELP', () => {
  const logs = [];
  const r = dispatch(['help'], { log: (m) => logs.push(m) });
  assert.equal(r.code, 0);
  assert.ok(logs.join('\n').includes('Usage'));
});

test('dispatch: no args -> help code 0', () => {
  const logs = [];
  const r = dispatch([], { log: (m) => logs.push(m) });
  assert.equal(r.code, 0);
  assert.ok(logs.join('\n').includes('init'));
});

test('dispatch: unknown command -> code 1', () => {
  const logs = [];
  const r = dispatch(['bogus'], { log: (m) => logs.push(m) });
  assert.equal(r.code, 1);
  assert.ok(logs.join('\n').includes('unknown'));
});

// --- dispatch init (tmpdir, dry-run) ---

test('dispatch init --dry-run: runInit dry-run (no write su home tmp)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cmd-'));
  const logs = [];
  const r = dispatch(['init', '--dry-run'], { log: (m) => logs.push(m), home, tmuxOk: true });
  assert.equal(r.code, 0);
  assert.ok(!fs.existsSync(path.join(home, '.nexuscrew', 'config.json'))); // dry-run no write
  assert.ok(logs.some((l) => /DRY-RUN/.test(l)));
  fs.rmSync(home, { recursive: true, force: true });
});

// --- serve ---

test('serve: serverStart chiamato (mock)', () => {
  let called = false;
  serve({ serverStart: () => { called = true; } });
  assert.equal(called, true);
});

test('serve --pidfile: scrive pidfile + cleanup (mock serverStart)', () => {
  const tmpPid = path.join(os.tmpdir(), 'nc-serve-test-' + process.pid + '.pid');
  process.env.NEXUSCREW_PIDFILE = tmpPid;
  fs.rmSync(tmpPid, { force: true });
  let started = false;
  serve({ pidfile: true, serverStart: () => { started = true; } });
  assert.equal(started, true);
  assert.ok(fs.existsSync(tmpPid)); // pidfile scritto
  // cleanup su exit
  process.emit('exit');
  assert.ok(!fs.existsSync(tmpPid)); // rimosso
  delete process.env.NEXUSCREW_PIDFILE;
});

test('serve --pidfile: already-running -> throw (no double start)', () => {
  const tmpPid = path.join(os.tmpdir(), 'nc-serve-running-' + process.pid + '.pid');
  process.env.NEXUSCREW_PIDFILE = tmpPid;
  fs.rmSync(tmpPid, { force: true });
  // pre-crea pidfile con pid vivo (self)
  fs.writeFileSync(tmpPid, JSON.stringify({ pid: process.pid, cmd: 'node', startTs: Date.now() }) + '\n');
  assert.throws(
    () => serve({ pidfile: true, serverStart: () => {} }),
    /already running/i,
  );
  fs.rmSync(tmpPid, { force: true });
  delete process.env.NEXUSCREW_PIDFILE;
});

// --- start/stop/status per-platform (mock execImpl) ---

test('start linux: systemctl --user start (mock)', () => {
  const calls = [];
  const r = start({ platform: 'linux', execImpl: (b, a) => calls.push([b, a]), log: () => {} });
  assert.equal(r.started, true);
  assert.ok(calls.some((c) => c[0] === 'systemctl' && c[1].includes('start')));
});

test('start mac: launchctl kickstart (mock)', () => {
  const calls = [];
  const r = start({ platform: 'mac', uid: 501, execImpl: (b, a) => calls.push([b, a]), log: () => {} });
  assert.equal(r.started, true);
  assert.ok(calls.some((c) => c[0] === 'launchctl' && c[1].includes('kickstart')));
});

test('stop linux: systemctl --user stop (mock)', () => {
  const calls = [];
  const r = stop({ platform: 'linux', execImpl: (b, a) => calls.push([b, a]), log: () => {} });
  assert.equal(r.stopped, true);
  assert.ok(calls.some((c) => c[1].includes('stop')));
});

test('stop termux: no pidfile -> no kill, reason', () => {
  const tmpPid = path.join(os.tmpdir(), 'nc-stop-nopid-' + process.pid + '.pid');
  process.env.NEXUSCREW_PIDFILE = tmpPid;
  fs.rmSync(tmpPid, { force: true });
  const r = stop({ platform: 'termux', execImpl: () => {}, log: () => {} });
  assert.equal(r.stopped, false);
  assert.match(r.reason, /no pidfile/);
  delete process.env.NEXUSCREW_PIDFILE;
});

test('status linux: systemctl is-active (mock)', () => {
  const r = status({
    platform: 'linux',
    execImpl: (b, a) => 'active',
    log: () => {},
    home: os.homedir(),
  });
  assert.equal(r.platform, 'linux');
  assert.equal(r.running, true);
});

test('status termux: boot-script + pidfile state', () => {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-st-'));
  const tmpPid = path.join(tmpHome, 'nexuscrew.pid');
  process.env.NEXUSCREW_PIDFILE = tmpPid;
  fs.rmSync(tmpPid, { force: true });
  // no boot script, no pidfile -> not installed, not running
  const r = status({ platform: 'termux', execImpl: () => {}, log: () => {}, home: tmpHome });
  assert.equal(r.bootScriptInstalled, false);
  assert.equal(r.running, false);
  // crea boot script -> installed
  fs.mkdirSync(path.join(tmpHome, '.termux', 'boot'), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, '.termux', 'boot', 'nexuscrew.sh'), 'x');
  const r2 = status({ platform: 'termux', execImpl: () => {}, log: () => {}, home: tmpHome });
  assert.equal(r2.bootScriptInstalled, true);
  assert.equal(r2.running, false); // nessun pidfile vivo
  delete process.env.NEXUSCREW_PIDFILE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

test('dispatch serve: chiama serve + keepAlive (no exit, server resta vivo)', () => {
  let called = false;
  const r = dispatch(['serve'], { serverStart: () => { called = true; }, log: () => {} });
  assert.equal(r.code, 0);
  assert.equal(r.keepAlive, true); // serve non deve exit (server.listen tiene il processo)
  assert.equal(called, true);
});
