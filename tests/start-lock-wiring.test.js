'use strict';
// U2: start, restart e startPortable passano dal lock di avvio condiviso (boot/show/start/runner).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const commands = require('../lib/cli/commands.js');
const lock = require('../lib/update/start-lock.js');

const LIB = path.resolve(__dirname, '../lib/update/start-lock.js');
const tmp = (t) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-slw-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
function holder(t, home, holdMs) {
  const child = spawn(process.execPath, ['-e', `
    const l = require(${JSON.stringify(LIB)});
    const h = l.acquireStartLock({ home: ${JSON.stringify(home)}, label: 'show' });
    process.stdout.write('held\\n'); setTimeout(() => { h.release(); process.exit(0); }, ${holdMs});
  `], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { try { child.kill('SIGKILL'); } catch (_) {} });
  return new Promise((resolve) => child.stdout.once('data', () => resolve(child)));
}
const fakeChild = { pid: 4242, unref() {} };

test('startPortable: con un altro avviatore in corso attende, poi parte; a lock libero non lascia il file', async (t) => {
  const home = tmp(t); let spawned = 0;
  await holder(t, home, 400);
  const r = commands.startPortable({ home, startLockWaitMs: 5000, spawnImpl: () => { spawned += 1; return fakeChild; } });
  assert.equal(r.started, true); assert.equal(spawned, 1);
  assert.equal(fs.existsSync(lock.lockPath(home)), false);
});

test('startPortable: se l\'altro avviatore non finisce, errore chiaro e NESSUN processo lanciato', async (t) => {
  const home = tmp(t); let spawned = 0;
  await holder(t, home, 3000);
  assert.throws(() => commands.startPortable({ home, startLockWaitMs: 200, spawnImpl: () => { spawned += 1; return fakeChild; } }), (e) => e.code === 'start-lock-timeout');
  assert.equal(spawned, 0);
});

test('start e restart (service manager) passano dallo stesso lock', async (t) => {
  const home = tmp(t); const calls = [];
  await holder(t, home, 3000);
  const execImpl = (bin, args) => { calls.push(`${bin} ${args.join(' ')}`); return ''; };
  assert.throws(() => commands.start({ home, platform: 'linux', execImpl, log: () => {}, startLockWaitMs: 200 }), (e) => e.code === 'start-lock-timeout');
  assert.throws(() => commands.restart({ home, platform: 'linux', execImpl, log: () => {}, startLockWaitMs: 200 }), (e) => e.code === 'start-lock-timeout');
  assert.deepEqual(calls, [], 'nessun comando emesso senza lock');
});

test('nessun deadlock: dentro un lock gia\' tenuto da questo processo (smartUp -> restart -> startPortable) si procede', (t) => {
  const home = tmp(t); let spawned = 0;
  lock.withStartLock(() => {
    const r = commands.startPortable({ home, startLockWaitMs: 100, spawnImpl: () => { spawned += 1; return fakeChild; } });
    assert.equal(r.started, true);
  }, { home, waitMs: 100 });
  assert.equal(spawned, 1);
  assert.equal(fs.existsSync(lock.lockPath(home)), false);
});
