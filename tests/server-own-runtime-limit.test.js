'use strict';
// Contract of the default "own runtime" judgement used while the main port is
// busy. It may only make the start WAIT, for a bounded time, reading the pid
// file. A true answer never signals, never removes or rewrites the record,
// never creates a guard and never starts a second service; a false positive
// merely lets the wait expire, a false negative is the plain "port busy"
// refusal. Everything runs in a temporary home with a child created here.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const pidf = require('../lib/cli/pidfile.js');
const { start } = require('../lib/server.js');

const freePort = () => new Promise((resolve) => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
});
const occupy = (port) => new Promise((resolve) => {
  const s = net.createServer((c) => c.on('error', () => {})); s.listen(port, '127.0.0.1', () => resolve(s));
});
function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncown-'));
  fs.mkdirSync(path.join(dir, '.nexuscrew'), { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const serverOpts = (dir, port, extra = {}) => ({
  home: dir, configDir: path.join(dir, '.nexuscrew'), configPath: path.join(dir, '.nexuscrew', 'config.json'),
  tokenPath: path.join(dir, '.nexuscrew', 'token'), nodesPath: path.join(dir, '.nexuscrew', 'nodes.json'),
  filesRoot: path.join(dir, 'files'), bind: '127.0.0.1', port, panelPort: 0, autoUpdate: false, fleetEnabled: false, log: () => {}, lang: 'en', protectSharedTmuxServer: false, ...extra,
});

const CODE = 'setInterval(() => {}, 1000)';
async function figlio(t) {
  const child = spawn(process.execPath, ['-e', CODE], { stdio: 'ignore' });
  let uscito = false;
  child.on('exit', () => { uscito = true; });
  t.after(() => { try { child.kill('SIGKILL'); } catch (_) {} });
  await new Promise((resolve) => { if (child.pid) resolve(); else child.on('spawn', resolve); });
  return { child, uscito: () => uscito };
}
const cmd = `${process.execPath} -e ${CODE}`;
const stato = (dir) => fs.readdirSync(path.join(dir, '.nexuscrew')).sort();

test('own-runtime: a live record on this port only makes the start wait, then the plain busy refusal; nothing is touched', async (t) => {
  const dir = home(t); const port = await freePort();
  const blocker = await occupy(port); t.after(() => blocker.close());
  const { child, uscito } = await figlio(t);
  const pidPath = pidf.defaultPidfilePath(dir);
  pidf.writePidfile(pidPath, child.pid, cmd, { port });
  const prima = fs.readFileSync(pidPath);
  const errors = [];
  const t0 = Date.now();
  const made = start(serverOpts(dir, port, { onListenError: (e) => errors.push(e), ownPortWaitMs: 400, ownPortRetryMs: 50 }));
  t.after(() => { try { made.close(); } catch (_) {} });
  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(errors.length, 1, 'the wait expires into one refusal');
  assert.equal(errors[0].code, 'EADDRINUSE');
  assert.ok(Date.now() - t0 >= 400, 'it did wait for the bounded time');
  assert.deepEqual(fs.readFileSync(pidPath), prima, 'record byte-identical');
  assert.equal(uscito(), false, 'no signal reached the process');
  assert.doesNotThrow(() => process.kill(child.pid, 0));
  assert.equal(stato(dir).some((n) => n.endsWith('.guard')), false, 'no guard created');
});

test('own-runtime: a dead pid (false negative) is the immediate busy refusal, record untouched', async (t) => {
  const dir = home(t); const port = await freePort();
  const blocker = await occupy(port); t.after(() => blocker.close());
  const { child, uscito } = await figlio(t);
  const pidPath = pidf.defaultPidfilePath(dir);
  pidf.writePidfile(pidPath, child.pid, cmd, { port });
  child.kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(uscito(), true);
  const prima = fs.readFileSync(pidPath);
  const errors = [];
  const t0 = Date.now();
  const made = start(serverOpts(dir, port, { onListenError: (e) => errors.push(e), ownPortWaitMs: 5000, ownPortRetryMs: 50 }));
  t.after(() => { try { made.close(); } catch (_) {} });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'EADDRINUSE');
  assert.ok(Date.now() - t0 < 2000, 'no wait without a live record');
  assert.deepEqual(fs.readFileSync(pidPath), prima, 'a read-only judgement never removes the record');
});

test('own-runtime: a live record for another port does not make the start wait', async (t) => {
  const dir = home(t); const port = await freePort();
  const blocker = await occupy(port); t.after(() => blocker.close());
  const { child } = await figlio(t);
  const pidPath = pidf.defaultPidfilePath(dir);
  pidf.writePidfile(pidPath, child.pid, cmd, { port: port + 1 });
  const prima = fs.readFileSync(pidPath);
  const errors = [];
  const made = start(serverOpts(dir, port, { onListenError: (e) => errors.push(e), ownPortWaitMs: 5000, ownPortRetryMs: 50 }));
  t.after(() => { try { made.close(); } catch (_) {} });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'EADDRINUSE');
  assert.deepEqual(fs.readFileSync(pidPath), prima);
});
