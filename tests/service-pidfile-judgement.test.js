'use strict';
// Callers of the legacy isAlive/cleanStale pair must move to the
// evidence-positive judgement: a record that cannot be proven dead is never
// removed to make room, never reported as "not running", and never silently
// skipped by the updater. Covered here: serve (non-portable platforms),
// portableRuntimeState, doctor, update runner.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pidf = require('../lib/cli/pidfile.js');
const { serve } = require('../lib/cli/commands.js');
const { portableRuntimeState } = require('../lib/cli/runtime-lifecycle.js');
const { checkService } = require('../lib/cli/doctor.js');
const { restartRuntime } = require('../lib/update/runner.js');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'nc-judge-'));
}

function probeError(code) {
  const e = new Error(`probe ${code}`);
  e.code = code;
  return e;
}

const foreignKill = () => { throw probeError('EPERM'); };

test('serve (linux): foreign pidfile is refused, never removed, no server', () => {
  const home = tmpHome();
  const pidPath = pidf.defaultPidfilePath(home);
  pidf.writePidfile(pidPath, 424242, 'node nexuscrew serve');
  const before = fs.readFileSync(pidPath, 'utf8');
  let started = 0;
  assert.throws(
    () => serve({
      home, platform: 'linux', pidfile: true, port: 45999,
      serverStart: () => { started += 1; },
      pidImpl: { killImpl: foreignKill },
    }),
    (e) => /PIDFILE_UNVERIFIABLE|non verificabile/.test(e.message),
  );
  assert.equal(started, 0, 'no server may start over an unverifiable record');
  assert.equal(fs.readFileSync(pidPath, 'utf8'), before, 'the record survives');
  fs.rmSync(home, { recursive: true, force: true });
});

test('serve (linux): stale proven by ESRCH is replaced and the server starts', () => {
  const home = tmpHome();
  const pidPath = pidf.defaultPidfilePath(home);
  pidf.writePidfile(pidPath, 424242, 'node nexuscrew serve');
  let started = 0;
  serve({
    home, platform: 'linux', pidfile: true, port: 45999,
    serverStart: () => { started += 1; },
    pidImpl: { killImpl: () => { throw probeError('ESRCH'); } },
  });
  assert.equal(started, 1);
  assert.equal(pidf.readPidfile(pidPath).pid, process.pid);
  fs.rmSync(home, { recursive: true, force: true });
});

test('portableRuntimeState (linux): foreign record is unverifiable and survives the read', () => {
  const home = tmpHome();
  const pidPath = pidf.defaultPidfilePath(home);
  pidf.writePidfile(pidPath, 424242, 'node nexuscrew serve');
  const state = portableRuntimeState({ home, platform: 'linux', pidImpl: { killImpl: foreignKill } });
  assert.equal(state.running, true, 'no proof of death: never "stopped"');
  assert.equal(state.unverifiable, true);
  assert.ok(fs.existsSync(pidPath), 'a state read never removes the record');
  fs.rmSync(home, { recursive: true, force: true });
});

test('doctor (termux): foreign record is reported unverifiable, not "inactive"', () => {
  const home = tmpHome();
  const pidPath = pidf.defaultPidfilePath(home);
  pidf.writePidfile(pidPath, 424242, 'node nexuscrew serve');
  const definition = path.join(home, 'nexuscrew-service.sh');
  fs.writeFileSync(definition, '#!/data/…/bash\nexit 0\n');
  const check = checkService('termux', home, () => { throw new Error('unexpected exec'); }, 1000, definition, { killImpl: foreignKill });
  assert.equal(check.ok, true);
  assert.match(check.detail, /unverifiable/);
  assert.doesNotMatch(check.detail, /but not active/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('doctor (termux): alive record with a comparable birth is active', () => {
  const home = tmpHome();
  const pidPath = pidf.defaultPidfilePath(home);
  pidf.writePidfile(pidPath, process.pid, 'node nexuscrew serve');
  const definition = path.join(home, 'nexuscrew-service.sh');
  fs.writeFileSync(definition, '#!/data/…/bash\nexit 0\n');
  const check = checkService('termux', home, () => { throw new Error('unexpected exec'); }, 1000, definition, {});
  assert.match(check.detail, /^active$/);
  assert.doesNotMatch(check.detail, /unverifiable|but not active/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('update runner: foreign record aborts the restart, never silently skips it', async () => {
  const home = tmpHome();
  const pidPath = path.join(home, 'x.pid');
  let stopped = 0;
  await assert.rejects(
    restartRuntime({
      home, platform: 'termux', port: 41820, token: 't', expectedVersion: '0.9.51', log: () => {},
      commands: {
        isServiceRunning: () => false,
        fermaTunnelPrimaDiRiavviare: () => {},
        stopPortableRuntime: () => { stopped += 1; return { killed: true }; },
        startPortable: () => ({ started: true }),
        portAvailable: async () => true,
      },
      pidfile: {
        defaultPidfilePath: () => pidPath,
        readPidfile: () => ({ pid: 424242, cmd: 'node nexuscrew serve' }),
        inspectPidfile: () => ({ state: 'indeterminate', reason: 'kill-foreign', meta: { pid: 424242 } }),
      },
      waitForRuntimeImpl: async () => true,
      runtimeVersionImpl: async () => '0.9.51',
    }),
    (e) => /non verificabile|PIDFILE_UNVERIFIABLE/.test(e.message),
  );
  assert.equal(stopped, 0, 'no stop attempt without a proof of ownership');
  fs.rmSync(home, { recursive: true, force: true });
});

// ---- update runner: the whole restart decision follows the inspection --------------------------------------------

function runnerCase(dir, ins, { killedStop = true } = {}) {
  const calls = { stop: 0, start: 0 };
  const liveMeta = { pid: 424242, cmd: 'node nexuscrew serve' };
  return {
    calls,
    opts: {
      home: dir, platform: 'termux', port: 41820, token: 't', expectedVersion: '0.9.51', log: () => {},
      commands: {
        isServiceRunning: () => false,
        fermaTunnelPrimaDiRiavviare: () => {},
        stopPortableRuntime: () => { calls.stop += 1; return killedStop ? { killed: true } : { killed: false, reason: 'refused' }; },
        startPortable: () => { calls.start += 1; return { started: true }; },
        portAvailable: async () => true,
      },
      // The legacy pair would say "alive" here: the decision must not use it.
      pidfile: {
        defaultPidfilePath: () => path.join(dir, 'x.pid'),
        readPidfile: () => liveMeta,
        isAlive: () => true,
        inspectPidfile: () => ins,
      },
      waitForRuntimeImpl: async () => true,
      runtimeVersionImpl: async () => '0.9.51',
    },
  };
}

test('update runner: an indeterminate record (birth unreadable) aborts, no stop, no start', async () => {
  const home = tmpHome();
  const c = runnerCase(home, { state: 'indeterminate', reason: 'start-unreadable', meta: { pid: 424242 } });
  await assert.rejects(restartRuntime(c.opts), /PIDFILE_UNVERIFIABLE/);
  assert.deepEqual(c.calls, { stop: 0, start: 0 });
  fs.rmSync(home, { recursive: true, force: true });
});

test('update runner: an invalid record aborts, no stop, no start', async () => {
  const home = tmpHome();
  const c = runnerCase(home, { state: 'invalid', reason: 'schema' });
  await assert.rejects(restartRuntime(c.opts), /PIDFILE_INVALID/);
  assert.deepEqual(c.calls, { stop: 0, start: 0 });
  fs.rmSync(home, { recursive: true, force: true });
});

test('update runner: a record proven stale is not stopped (nothing runs)', async () => {
  const home = tmpHome();
  const c = runnerCase(home, { state: 'stale', proof: 'esrch', meta: { pid: 424242 } });
  const mode = await restartRuntime(c.opts);
  assert.equal(mode, 'inactive');
  assert.deepEqual(c.calls, { stop: 0, start: 0 });
  fs.rmSync(home, { recursive: true, force: true });
});

test('update runner: an absent record is not stopped', async () => {
  const home = tmpHome();
  const c = runnerCase(home, { state: 'absent' });
  assert.equal(await restartRuntime(c.opts), 'inactive');
  assert.deepEqual(c.calls, { stop: 0, start: 0 });
  fs.rmSync(home, { recursive: true, force: true });
});

test('update runner: a record attested alive goes through the one stop and the start', async () => {
  const home = tmpHome();
  const c = runnerCase(home, { state: 'alive', meta: { pid: 424242 } });
  assert.equal(await restartRuntime(c.opts), 'portable');
  assert.deepEqual(c.calls, { stop: 1, start: 1 });
  fs.rmSync(home, { recursive: true, force: true });
});

test('update runner: a pre-attestation record is left to the stop routine, which may refuse loudly', async () => {
  const home = tmpHome();
  const ok = runnerCase(home, { state: 'indeterminate', reason: 'no-attestation', meta: { pid: 424242 } });
  assert.equal(await restartRuntime(ok.opts), 'portable');
  assert.deepEqual(ok.calls, { stop: 1, start: 1 });
  const no = runnerCase(home, { state: 'indeterminate', reason: 'no-attestation', meta: { pid: 424242 } }, { killedStop: false });
  await assert.rejects(restartRuntime(no.opts), /portable restart failed/);
  assert.deepEqual(no.calls, { stop: 1, start: 0 });
  fs.rmSync(home, { recursive: true, force: true });
});
