'use strict';
// killPidfile must never remove the pidfile on a probe that does not prove
// death. EPERM (a foreign PID) and any unexpected probe error are
// indeterminate, not stale: removing the record there would erase the proof
// that a process is alive. Only ESRCH, a different readable birth, or the
// equivalent positive proofs of the design may remove it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writePidfile, killPidfile, readPidfile } = require('../lib/cli/pidfile.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nc-kill-'));
}

function probeError(code) {
  const e = new Error(`probe ${code}`);
  e.code = code;
  return e;
}

test('kill: EPERM probe keeps the pidfile and refuses', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'nexuscrew.pid');
  writePidfile(p, 4242, 'node nexuscrew serve');
  const before = fs.readFileSync(p, 'utf8');
  const esito = killPidfile(p, 'SIGTERM', { killImpl: () => { throw probeError('EPERM'); } });
  assert.equal(esito.killed, false);
  assert.match(esito.reason, /not owned|indeterminate|unverifiable/i);
  assert.equal(fs.existsSync(p), true, 'pidfile must survive an EPERM probe');
  assert.equal(fs.readFileSync(p, 'utf8'), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('kill: unexpected probe error keeps the pidfile and refuses', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'nexuscrew.pid');
  writePidfile(p, 4243, 'node nexuscrew serve');
  const before = fs.readFileSync(p, 'utf8');
  const esito = killPidfile(p, 'SIGTERM', { killImpl: () => { throw probeError('EIO'); } });
  assert.equal(esito.killed, false);
  assert.match(esito.reason, /indeterminate|unverifiable|unknown/i);
  assert.equal(fs.existsSync(p), true, 'pidfile must survive an unknown probe error');
  assert.equal(fs.readFileSync(p, 'utf8'), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('kill: ESRCH still proves death and removes the pidfile', () => {
  const dir = tmpDir();
  const p = path.join(dir, 'nexuscrew.pid');
  writePidfile(p, 4244, 'node nexuscrew serve');
  const esito = killPidfile(p, 'SIGTERM', { killImpl: () => { throw probeError('ESRCH'); } });
  assert.equal(esito.killed, false);
  assert.match(esito.reason, /stale/i);
  assert.equal(fs.existsSync(p), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
