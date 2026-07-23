'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  readPidfile, writePidfile, pidOwnership, pidExists, isAlive, cleanStale, killPidfile,
} = require('../lib/cli/pidfile.js');

function tmpPid() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pid-'));
  return path.join(dir, 'nexuscrew.pid');
}

test('writePidfile + readPidfile round-trip', () => {
  const p = tmpPid();
  writePidfile(p, 12345, 'node nexuscrew serve');
  const meta = readPidfile(p);
  assert.equal(meta.pid, 12345);
  assert.equal(meta.cmd, 'node nexuscrew serve');
  assert.ok(meta.startTs > 0);
  // mode 0600
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('writePidfile exclusive (wx): no silent overwrite', () => {
  const p = tmpPid();
  writePidfile(p, 111, 'cmd-a');
  assert.throws(() => writePidfile(p, 222, 'cmd-b'), /EEXIST|file already exists/i);
  // contenuto invariato (primo writer)
  assert.equal(readPidfile(p).pid, 111);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('readPidfile: assente/malformato -> null', () => {
  const p = tmpPid();
  assert.equal(readPidfile(p), null); // non esiste
  fs.writeFileSync(p, 'not json');
  assert.equal(readPidfile(p), null); // malformato
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('pidExists: processo vivo (self) true, pid morto false', () => {
  assert.equal(pidExists(process.pid), true);
  assert.equal(pidExists(999999), false);
});

test('EPERM: PID esistente ma estraneo non e un processo NexusCrew vivo', () => {
  const foreign = (_pid, signal) => {
    assert.equal(signal, 0);
    const error = new Error('not permitted');
    error.code = 'EPERM';
    throw error;
  };
  assert.equal(pidOwnership(424242, foreign), 'foreign');
  assert.equal(pidExists(424242, foreign), true, 'il PID esiste genericamente');
  assert.equal(isAlive({ pid: 424242, cmd: 'node tunnel-supervisor.js' }, { killImpl: foreign }), false);
});

test('isAlive: self vivo (cmd match conservativo); meta null false', () => {
  // process.pid e' vivo; 'node' e' sicuramente nel cmdline del processo test
  assert.equal(isAlive({ pid: process.pid, cmd: 'node' }), true);
  assert.equal(isAlive(null), false);
  assert.equal(isAlive({ pid: 999999, cmd: 'x' }), false); // pid morto
});

test('cleanStale: pid morto -> rimuove pidfile', () => {
  const p = tmpPid();
  writePidfile(p, 999999, 'dead-process'); // pid morto
  assert.equal(cleanStale(p), true);
  assert.equal(readPidfile(p), null); // rimosso
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('cleanStale: pid vivo -> non rimuove', () => {
  const p = tmpPid();
  writePidfile(p, process.pid, 'node');
  assert.equal(cleanStale(p), false);
  assert.ok(readPidfile(p)); // ancora presente
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('cleanStale: PID riutilizzato da altro UID viene rimosso automaticamente', () => {
  const p = tmpPid();
  writePidfile(p, 424242, 'node tunnel-supervisor.js');
  const foreign = () => {
    const error = new Error('not permitted');
    error.code = 'EPERM';
    throw error;
  };
  assert.equal(cleanStale(p, { killImpl: foreign }), true);
  assert.equal(readPidfile(p), null);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('killPidfile: no pidfile -> no kill', () => {
  const p = tmpPid();
  const r = killPidfile(p);
  assert.equal(r.killed, false);
  assert.match(r.reason, /no pidfile/);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('killPidfile: stale (pid morto) -> remove, no kill', () => {
  const p = tmpPid();
  writePidfile(p, 999999, 'dead');
  const r = killPidfile(p);
  assert.equal(r.killed, false);
  assert.match(r.reason, /stale/);
  assert.equal(readPidfile(p), null); // rimosso
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('killPidfile: PID reuse (cmd mismatch) -> NO kill, remove stale', () => {
  // pid esiste (self) ma cmd salvato non matcha -> PID reuse, non killare
  const p = tmpPid();
  writePidfile(p, process.pid, 'COMPLETELY-DIFFERENT-CMD-XYZ-NOT-MATCHING');
  const r = killPidfile(p);
  assert.equal(r.killed, false);
  assert.match(r.reason, /pid reuse|cmd mismatch/);
  assert.equal(readPidfile(p), null); // pidfile stale rimosso (no broad kill)
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});

test('killPidfile: EPERM rimuove solo il pidfile e non segnala il processo estraneo', () => {
  const p = tmpPid();
  writePidfile(p, 424242, 'node tunnel-supervisor.js');
  const signals = [];
  const foreign = (_pid, signal) => {
    signals.push(signal);
    const error = new Error('not permitted');
    error.code = 'EPERM';
    throw error;
  };
  const r = killPidfile(p, 'SIGTERM', { killImpl: foreign });
  assert.deepEqual(signals, [0], 'solo ownership probe, nessun SIGTERM');
  assert.equal(r.killed, false);
  assert.match(r.reason, /not owned/);
  assert.equal(readPidfile(p), null);
  fs.rmSync(path.dirname(p), { recursive: true, force: true });
});
