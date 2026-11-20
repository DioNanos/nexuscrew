'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const { createNpmUpdater } = require('../lib/update/manager.js');
const { acquireUpdateLock, adoptUpdateLock, readLock, readState, writeState } = require('../lib/update/core.js');
const { createServer } = require('../lib/server.js');
const { createServeShutdownCoordinator } = require('../lib/cli/shutdown-coordinator.js');

function makeTempDir(t, prefix = 'nc-up-ord-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, '.nexuscrew'), { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function fakeNpmCmds(dir) {
  return {
    home: dir,
    currentVersion: '0.9.82',
    supported: true,
    useSystemdRun: false,
    initialDelayMs: 60_000,
    intervalMs: 60_000,
    cwd: dir,
  };
}

function makeControlledTimers() {
  let nextId = 1;
  const active = new Map();
  return {
    active,
    setTimer(fn, ms) {
      const id = nextId++;
      const handle = { id, ms, fn, unref() {} };
      active.set(id, handle);
      return handle;
    },
    clearTimer(handle) {
      if (handle && active.has(handle.id)) active.delete(handle.id);
    },
    fireAll() {
      for (const [id, h] of [...active.entries()]) {
        active.delete(id);
        h.fn();
      }
    },
  };
}

function spawnIdleChild(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 10000);'], {
    stdio: 'ignore',
  });
  t.after(() => {
    try { child.kill('SIGKILL'); } catch (_) {}
  });
  return child;
}

test('updater idle shutdown completes quiescent with zero fake UPDATE codes and stays closed against start/setEnabled/apply', async (t) => {
  const dir = makeTempDir(t, 'nc-upd-abort-');
  const timers = makeControlledTimers();
  const statusPath = path.join(dir, '.nexuscrew', 'npm-update.json');
  writeState(statusPath, { phase: 'idle', latest: '0.9.82', available: false });

  const updater = createNpmUpdater({
    ...fakeNpmCmds(dir),
    enabled: true,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    lookupLatest: async () => '0.9.82',
  });

  updater.start();
  assert.equal(timers.active.size, 1);

  const res = await updater.drain({ deadlineMono: performance.now() + 500 });
  assert.equal(res.quiescent, true);
  assert.equal(res.timedOut, false);
  assert.equal(res.handoff, false);
  assert.equal(res.activeOpsRemaining, 0);
  assert.deepEqual(res.codes, []);
  assert.equal(timers.active.size, 0, 'periodic timer must be cancelled');

  // Re-arming or triggering updates after close must remain inert
  updater.start();
  updater.setEnabled(true);
  assert.equal(timers.active.size, 0, 'setEnabled/start after close must not re-arm timers');
  await assert.rejects(() => updater.apply(), { code: 'update-disarmed', status: 503 });
  assert.equal(readState(statusPath).phase, 'idle');
});

test('updater disarm during suspended lookupLatest prevents launch/timers; live consumer child blocks quiescence without premature close', async (t) => {
  // 1) Disarm while lookupLatest is suspended -> resolves with newer version -> zero launch, zero timers, no reopen
  {
    const dir = makeTempDir(t, 'nc-upd-child-check-');
    const timers = makeControlledTimers();
    let releaseLookup = null;
    let spawnCalls = 0;

    const updater = createNpmUpdater({
      ...fakeNpmCmds(dir),
      enabled: true,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      lookupLatest: () => new Promise((resolve) => { releaseLookup = resolve; }),
      spawnImpl: () => {
        spawnCalls += 1;
        return { pid: 999991, once() {}, unref() {} };
      },
    });

    const checkP = updater.check({ autoApply: true });
    // Flush microtasks so lookupLatest is awaited
    await new Promise((r) => setImmediate(r));
    updater.disarm();

    releaseLookup('9.9.9');
    await checkP;

    assert.equal(spawnCalls, 0, 'disarmed updater must not launch after lookupLatest resolves');
    assert.equal(timers.active.size, 0, 'disarmed updater must not schedule next interval');
    updater.start();
    updater.setEnabled(true);
    await assert.rejects(() => updater.apply(), { code: 'update-disarmed' });
    assert.equal(timers.active.size, 0);
  }

  // 2) Child consumer of npm view stays alive past Promise callback and deadline -> UPDATE_IN_PROGRESS, timedOut=true
  {
    const dir = makeTempDir(t, 'nc-upd-child-run-');
    const fakeChild = new EventEmitter();
    fakeChild.exitCode = null;
    fakeChild.signalCode = null;

    const updater = createNpmUpdater({
      ...fakeNpmCmds(dir),
      npmInvocationImpl: () => ({ bin: process.execPath, argvPrefix: [] }),
      execFileImpl: (_bin, _args, _opts, cb) => {
        // Promise resolves via callback while underlying child process is still open
        queueMicrotask(() => cb(null, '"9.9.9"\n'));
        return fakeChild;
      },
    });

    await updater.check({ autoApply: false });
    const t0 = performance.now();
    const res = await updater.drain({ deadlineMono: t0 + 50 });
    const elapsed = performance.now() - t0;

    assert.equal(res.quiescent, false);
    assert.equal(res.timedOut, true);
    assert.equal(res.handoff, false);
    assert.ok(res.activeOpsRemaining >= 1);
    assert.ok(res.codes.includes('UPDATE_IN_PROGRESS'));
    assert.ok(elapsed >= 40, 'must wait toward deadline rather than faking early exit');

    // Once real child exits later, subsequent inspection when no lock exists sees 0 active consumers
    fakeChild.exitCode = 0;
    fakeChild.emit('exit', 0);
    const afterRes = await updater.drain({ deadlineMono: performance.now() + 200 });
    assert.equal(afterRes.quiescent, true);
    assert.deepEqual(afterRes.codes, []);
  }

  // 3) Consumer error event without exit/close preserves active census, pidfile, and ineligible post-drain cleanup hook across server and CLI coordinator
  {
    const dir = makeTempDir(t, 'nc-upd-child-err-');
    const cfgDir = path.join(dir, '.nexuscrew');
    const pidPath = path.join(dir, 'service.pid');
    fs.writeFileSync(pidPath, JSON.stringify({ pid: process.pid }));
    const liveChild = new EventEmitter();
    liveChild.pid = 777123;
    liveChild.exitCode = null;
    liveChild.signalCode = null;

    let hookQuiescent = null;
    const created = createServer({
      home: dir,
      configDir: cfgDir,
      configPath: path.join(cfgDir, 'config.json'),
      tokenPath: path.join(cfgDir, 'token'),
      nodesPath: path.join(cfgDir, 'nodes.json'),
      filesRoot: path.join(dir, 'files'),
      bind: '127.0.0.1',
      port: 0,
      panelPort: 0,
      fleetEnabled: false,
      autoUpdate: true,
      protectSharedTmuxServer: false,
      log: () => {},
      updateSeams: {
        currentVersion: '0.9.82',
        supported: true,
        useSystemdRun: false,
        cwd: dir,
        npmInvocationImpl: () => ({ bin: process.execPath, argvPrefix: [] }),
        execFileImpl: (_bin, _args, _opts, cb) => {
          queueMicrotask(() => cb(null, '"9.9.9"\n'));
          return liveChild;
        },
      },
    });

    await created.updater.check({ autoApply: false });
    // Emit non-spawn error while process remains alive -> must NOT release consumer
    liveChild.emit('error', new Error('kill EPERM'));

    const coord = createServeShutdownCoordinator({
      budgetMs: 120,
      exitImpl: () => {},
      writeLine: () => {},
    });
    coord.registerPidCleanup(() => {
      fs.unlinkSync(pidPath);
      return true;
    });
    coord.registerServer({
      disarm: () => created.shutdownController.disarm(),
      closeOrdered: (args) => created.closeOrdered({
        ...args,
        deadlineMono: Math.min(args.deadlineMono, performance.now() + 60),
        afterDrainHook: (summary) => {
          hookQuiescent = summary.quiescent;
        },
      }),
    });

    const out = await coord.shutdown({ reason: 'signal', exitOnFinish: true });
    assert.equal(out.quiescent, false, 'error event without exit/close must preserve active consumer');
    assert.equal(out.timedOut, true);
    assert.ok(out.counts.residues >= 1);
    assert.ok(out.counts.activeOpsRemaining >= 1);
    assert.ok(out.codes.includes('UPDATE_IN_PROGRESS'));
    assert.equal(out.pidfileRemoved, false, 'pidfile must remain conserved when consumer child only emitted error');
    assert.ok(fs.existsSync(pidPath));
    assert.equal(hookQuiescent, false, 'post-drain cleanup hook must stay ineligible when consumer error lacked exit/close');

    // Only real exit/close later settles the consumer
    liveChild.exitCode = 0;
    liveChild.emit('close', 0);
    const settledDrain = await created.updater.drain({ deadlineMono: performance.now() + 200 });
    assert.equal(settledDrain.quiescent, true);
    assert.deepEqual(settledDrain.codes, []);
  }

  // 4) Proven pre-spawn failure settles consumer cleanly without hang, whereas unattestable handle blocks quiescence
  {
    const dir = makeTempDir(t, 'nc-upd-child-spawnfail-');
    const spawnFailChild = new EventEmitter();
    spawnFailChild.pid = undefined;
    spawnFailChild.exitCode = null;
    spawnFailChild.signalCode = null;
    const spawnUpdater = createNpmUpdater({
      ...fakeNpmCmds(dir),
      npmInvocationImpl: () => ({ bin: process.execPath, argvPrefix: [] }),
      execFileImpl: (_bin, _args, _opts, cb) => {
        const err = new Error('spawn ENOENT');
        err.code = 'ENOENT';
        err.syscall = 'spawn npm';
        queueMicrotask(() => {
          spawnFailChild.emit('error', err);
          cb(err);
        });
        return spawnFailChild;
      },
    });
    await spawnUpdater.check({ autoApply: false });
    const spawnDrain = await spawnUpdater.drain({ deadlineMono: performance.now() + 100 });
    assert.equal(spawnDrain.quiescent, true, 'proven spawn failure without child pid settles consumer');

    const dir2 = makeTempDir(t, 'nc-upd-child-unattested-');
    const unattestableUpdater = createNpmUpdater({
      ...fakeNpmCmds(dir2),
      npmInvocationImpl: () => ({ bin: process.execPath, argvPrefix: [] }),
      execFileImpl: (_bin, _args, _opts, cb) => {
        queueMicrotask(() => cb(null, '"9.9.9"\n'));
        return { pid: 555111 }; // No EventEmitter `.once` -> unattestable consumer handle
      },
    });
    await unattestableUpdater.check({ autoApply: false });
    const unattDrain = await unattestableUpdater.drain({ deadlineMono: performance.now() + 100 });
    assert.equal(unattDrain.quiescent, false, 'unattestable child consumer must fail closed');
    assert.ok(unattDrain.activeOpsRemaining >= 1);
    assert.ok(unattDrain.codes.includes('UPDATE_IN_PROGRESS'));
  }
});

test('updater attested handoff with live correlated runner produces UPDATE_HANDOFF without killing runner or deleting lock', async (t) => {
  const dir = makeTempDir(t, 'nc-upd-dead-');
  const lockPath = path.join(dir, '.nexuscrew', 'npm-update.lock');
  const statusPath = path.join(dir, '.nexuscrew', 'npm-update.json');
  const runnerChild = spawnIdleChild(t);
  let spawnedToken = null;

  const updater = createNpmUpdater({
    ...fakeNpmCmds(dir),
    lookupLatest: async () => '9.9.9',
    spawnImpl: (_bin, argv) => {
      spawnedToken = argv[argv.indexOf('--lock-token') + 1];
      return Object.assign(new EventEmitter(), { pid: runnerChild.pid, unref() {} });
    },
  });

  await updater.apply();
  assert.ok(spawnedToken);
  assert.equal(adoptUpdateLock(lockPath, spawnedToken, runnerChild.pid), true);
  writeState(statusPath, {
    ...readState(statusPath),
    phase: 'installing',
    targetVersion: '9.9.9',
    updaterPid: runnerChild.pid,
  });

  const res = await updater.drain({ deadlineMono: performance.now() + 200 });
  assert.equal(res.quiescent, false);
  assert.equal(res.timedOut, false);
  assert.equal(res.handoff, true);
  assert.ok(res.activeOpsRemaining >= 1);
  assert.deepEqual(res.codes, ['UPDATE_HANDOFF']);
  assert.equal(runnerChild.exitCode, null);
  assert.equal(readLock(lockPath)?.token, spawnedToken);
  assert.equal(readLock(lockPath)?.pid, runnerChild.pid);
});

test('server ordered shutdown distinguishes UPDATE_HANDOFF from UPDATE_IN_PROGRESS, preserves coordinator pidfile, keeps exitCode 0, and redacts sensitive fields', async (t) => {
  // Attested runner handoff on real createServer + shutdown coordinator
  const dir = makeTempDir(t, 'nc-upd-dead-srv-');
  const cfgDir = path.join(dir, '.nexuscrew');
  const lockPath = path.join(cfgDir, 'npm-update.lock');
  const statusPath = path.join(cfgDir, 'npm-update.json');
  const pidPath = path.join(dir, 'service.pid');
  fs.writeFileSync(pidPath, JSON.stringify({ pid: process.pid }));

  const runnerChild = spawnIdleChild(t);
  let spawnedToken = null;

  const created = createServer({
    home: dir,
    configDir: cfgDir,
    configPath: path.join(cfgDir, 'config.json'),
    tokenPath: path.join(cfgDir, 'token'),
    nodesPath: path.join(cfgDir, 'nodes.json'),
    filesRoot: path.join(dir, 'files'),
    bind: '127.0.0.1',
    port: 0,
    panelPort: 0,
    fleetEnabled: false,
    autoUpdate: true,
    protectSharedTmuxServer: false,
    log: () => {},
    updateSeams: {
      currentVersion: '0.9.82',
      supported: true,
      useSystemdRun: false,
      cwd: dir,
      lookupLatest: async () => '9.9.9',
      spawnImpl: (_bin, argv) => {
        const idx = argv.indexOf('--lock-token');
        spawnedToken = argv[idx + 1];
        return Object.assign(new EventEmitter(), { pid: runnerChild.pid, unref() {} });
      },
    },
  });

  await created.updater.apply();
  assert.ok(spawnedToken);

  // Runner adopts the lock with its own PID and updates status to installing with updaterPid=runnerChild.pid
  assert.equal(adoptUpdateLock(lockPath, spawnedToken, runnerChild.pid), true);
  writeState(statusPath, {
    ...readState(statusPath),
    phase: 'installing',
    targetVersion: '9.9.9',
    updaterPid: runnerChild.pid,
  });

  const exits = [];
  const warnings = [];
  let hookCalled = false;
  let hookQuiescent = null;
  const coord = createServeShutdownCoordinator({
    budgetMs: 500,
    exitImpl: (code) => exits.push(code),
    writeLine: (line) => warnings.push(line),
  });
  coord.registerPidCleanup(() => {
    fs.unlinkSync(pidPath);
    return true;
  });
  coord.registerServer({
    disarm: () => created.shutdownController.disarm(),
    closeOrdered: (args) => created.closeOrdered({
      ...args,
      afterDrainHook: (summary) => {
        hookCalled = true;
        hookQuiescent = summary.quiescent;
      },
    }),
  });

  const out = await coord.shutdown({ reason: 'signal', exitOnFinish: true });
  assert.equal(out.status, 'completed_with_residues');
  assert.equal(out.quiescent, false);
  assert.equal(out.timedOut, false);
  assert.ok(out.codes.includes('UPDATE_HANDOFF'));
  assert.ok(!out.codes.includes('UPDATE_IN_PROGRESS'));
  assert.ok(out.counts.residues >= 1);
  assert.ok(out.counts.activeOpsRemaining >= 1);
  assert.equal(out.pidfileRemoved, false, 'conserved old pidfile must remain when runner handoff is active');
  assert.ok(fs.existsSync(pidPath));
  assert.equal(out.exitCode, 0, 'handoff must not turn shutdown exitCode into 1');
  assert.deepEqual(exits, [0]);
  assert.equal(warnings.length, 1);
  assert.equal(hookCalled, true);
  assert.equal(hookQuiescent, false, 'post-drain cleanup hook must see quiescent=false during update handoff');

  // Runner child is still alive and lock was neither unlinked nor stolen
  assert.equal(runnerChild.exitCode, null);
  assert.equal(readLock(lockPath)?.token, spawnedToken);
  assert.equal(readLock(lockPath)?.pid, runnerChild.pid);

  // Bounded diagnostics & outcome contain no token, PID, path, or raw error string
  const diagRecs = created.diagnostics.logs({}).records;
  const serialized = JSON.stringify({ out, warnings, diagRecs });
  assert.ok(!serialized.includes(spawnedToken), 'lock token must never leak');
  assert.ok(!serialized.includes(String(runnerChild.pid)), 'runner pid must never leak');
  assert.ok(!serialized.includes(dir), 'filesystem path must never leak');
});

test('systemd-run exit0, late exit callback after close, un-adopted lock, invalid lock, and missing lock with active phase never claim handoff or quiescent', async (t) => {
  // Case A: systemd-run wrapper exits 0 cleanly without runner adopting lock -> UPDATE_IN_PROGRESS, adoption timer cancelled, lock untouched
  {
    const dir = makeTempDir(t, 'nc-upd-lock-sys-');
    const cfgDir = path.join(dir, '.nexuscrew');
    const lockPath = path.join(cfgDir, 'npm-update.lock');
    const timers = makeControlledTimers();
    const wrapper = Object.assign(new EventEmitter(), { pid: process.pid + 12345, unref() {} });

    const updater = createNpmUpdater({
      ...fakeNpmCmds(dir),
      useSystemdRun: true,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      lookupLatest: async () => '9.9.9',
      spawnImpl: () => wrapper,
    });

    await updater.apply();
    wrapper.emit('exit', 0);
    // 15_000ms adoption timer was registered
    assert.equal(timers.active.size, 1);

    const res = await updater.drain({ deadlineMono: performance.now() + 200 });
    assert.equal(res.quiescent, false);
    assert.equal(res.handoff, false);
    assert.ok(res.codes.includes('UPDATE_IN_PROGRESS'));
    assert.ok(!res.codes.includes('UPDATE_HANDOFF'));
    assert.equal(timers.active.size, 0, 'adoption timer must be cancelled on close');
    assert.equal(readLock(lockPath)?.pid, process.pid, 'shutdown must not delete or adopt lock');
  }

  // Case B: systemd-run exit arrives AFTER close -> registers no new adoption timer, does not release/mutate lock or state
  {
    const dir = makeTempDir(t, 'nc-upd-lock-late-exit-');
    const cfgDir = path.join(dir, '.nexuscrew');
    const lockPath = path.join(cfgDir, 'npm-update.lock');
    const statusPath = path.join(cfgDir, 'npm-update.json');
    const timers = makeControlledTimers();
    const wrapper = Object.assign(new EventEmitter(), { pid: process.pid + 12346, unref() {} });

    const updater = createNpmUpdater({
      ...fakeNpmCmds(dir),
      useSystemdRun: true,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      lookupLatest: async () => '9.9.9',
      spawnImpl: () => wrapper,
    });

    await updater.apply();
    updater.close();
    wrapper.emit('exit', 1); // Arrives AFTER close!
    assert.equal(timers.active.size, 0, 'late wrapper exit must not schedule adoption timer');
    assert.ok(readLock(lockPath), 'late wrapper exit after close must not unlink lock');
    assert.equal(readState(statusPath).phase, 'installing', 'late wrapper exit after close must not mutate phase');

    const res = await updater.drain({ deadlineMono: performance.now() + 200 });
    assert.equal(res.quiescent, false);
    assert.equal(res.handoff, false);
    assert.ok(res.codes.includes('UPDATE_IN_PROGRESS'));
  }

  // Case C: lock replaced/symlink/corrupt or missing with installing state -> fails closed as UPDATE_IN_PROGRESS
  for (const kind of ['corrupt', 'symlink', 'missing-while-installing', 'foreign-token']) {
    const dir = makeTempDir(t, `nc-upd-lock-${kind}-`);
    const cfgDir = path.join(dir, '.nexuscrew');
    const lockPath = path.join(cfgDir, 'npm-update.lock');
    const statusPath = path.join(cfgDir, 'npm-update.json');

    const updater = createNpmUpdater({
      ...fakeNpmCmds(dir),
      lookupLatest: async () => '9.9.9',
      spawnImpl: () => Object.assign(new EventEmitter(), { pid: 999993, unref() {} }),
    });
    await updater.apply();

    if (kind === 'corrupt') {
      fs.writeFileSync(lockPath, '{not-json');
    } else if (kind === 'symlink') {
      fs.unlinkSync(lockPath);
      fs.symlinkSync(statusPath, lockPath);
    } else if (kind === 'missing-while-installing') {
      fs.unlinkSync(lockPath);
      assert.equal(readState(statusPath).phase, 'installing');
    } else if (kind === 'foreign-token') {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: 'foreign', adoptedAt: Date.now() }));
    }

    const res = await updater.drain({ deadlineMono: performance.now() + 200 });
    assert.equal(res.quiescent, false, `${kind} must remain non-quiescent`);
    assert.equal(res.handoff, false, `${kind} must never claim UPDATE_HANDOFF`);
    assert.ok(res.codes.includes('UPDATE_IN_PROGRESS'));
  }
});

test('updater attested terminal completion allows quiescent outcome once lock is cleanly absent and no child remains', async (t) => {
  const dir = makeTempDir(t, 'nc-upd-done-');
  const cfgDir = path.join(dir, '.nexuscrew');
  const lockPath = path.join(cfgDir, 'npm-update.lock');
  const statusPath = path.join(cfgDir, 'npm-update.json');
  const wrapper = Object.assign(new EventEmitter(), { pid: process.pid + 12347, unref() {} });
  let token = null;

  const updater = createNpmUpdater({
    ...fakeNpmCmds(dir),
    useSystemdRun: true,
    lookupLatest: async () => '9.9.9',
    spawnImpl: (_bin, argv) => {
      token = argv[argv.indexOf('--lock-token') + 1];
      return wrapper;
    },
  });

  await updater.apply();
  // Simulate runner finishing cleanly before shutdown: writes terminal 'installed' then unlinks lock
  writeState(statusPath, { ...readState(statusPath), phase: 'installed', current: '9.9.9', updaterPid: process.pid + 12348 });
  const { releaseUpdateLock } = require('../lib/update/core.js');
  assert.equal(releaseUpdateLock(lockPath, token), true);

  const res = await updater.drain({ deadlineMono: performance.now() + 200 });
  assert.equal(res.quiescent, true);
  assert.equal(res.timedOut, false);
  assert.equal(res.handoff, false);
  assert.deepEqual(res.codes, []);

  // Even an external stale-looking active lock present before startup blocks quiescence cleanly (without handoff)
  const dir2 = makeTempDir(t, 'nc-upd-done-ext-');
  const lock2 = path.join(dir2, '.nexuscrew', 'npm-update.lock');
  assert.equal(acquireUpdateLock(lock2, process.pid, 'external-token').ok, true);
  const up2 = createNpmUpdater({ ...fakeNpmCmds(dir2) });
  const res2 = await up2.drain({ deadlineMono: performance.now() + 200 });
  assert.equal(res2.quiescent, false);
  assert.equal(res2.handoff, false);
  assert.ok(res2.codes.includes('UPDATE_IN_PROGRESS'));
});

test('isolated runner restarts cleanly across portable/Termux, managed Linux, and managed macOS without quiescent mock', async (t) => {
  const http = require('node:http');
  const { spawn } = require('node:child_process');
  const { acquireUpdateLock } = require('../lib/update/core.js');
  const { runUpdate, restartRuntime } = require('../lib/update/runner.js');
  const pidf = require('../lib/cli/pidfile.js');
  const commands = require('../lib/cli/commands.js');

  function makeIsolatedHome(prefix) {
    const home = makeTempDir(t, prefix);
    const ncDir = path.join(home, '.nexuscrew');
    fs.mkdirSync(ncDir, { recursive: true });
    return {
      home,
      ncDir,
      configPath: path.join(ncDir, 'config.json'),
      tokenPath: path.join(ncDir, 'token'),
      pidPath: path.join(ncDir, 'nexuscrew.pid'),
      statusPath: path.join(ncDir, 'npm-update.json'),
      lockPath: path.join(ncDir, 'npm-update.lock'),
    };
  }

  function startChildHttpDaemon(envExtra, code) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', code], {
        env: { ...process.env, ...envExtra },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      let settled = false;
      child.stdout.on('data', (d) => {
        out += d.toString();
        const m = out.match(/READY:(\d+)/);
        if (m && !settled) {
          settled = true;
          resolve({ child, port: Number(m[1]) });
        }
      });
      child.stderr.on('data', (d) => { err += d.toString(); });
      child.on('exit', (exitCode) => {
        if (!settled) reject(new Error(`daemon exited early (${exitCode}): ${err}`));
      });
    });
  }

  // Portable / Termux in an isolated runner subprocess:
  // Old daemon runs on ephemeral port, conserves pidfile on non-quiescent exit (SIGTERM),
  // isolated runner stops old daemon, verifies replacement startup & /api/config version, releases lock.
  {
    const paths = makeIsolatedHome('nc-upd-rst-portable-');
    const token = 'test-token-portable-rst';
    fs.writeFileSync(paths.tokenPath, token);
    const daemonScript = `
      const http = require('node:http');
      const pidf = require(${JSON.stringify(path.resolve(__dirname, '..', 'lib/cli/pidfile.js'))});
      const version = process.env.FAKE_VERSION;
      const keepPidfileOnExit = process.env.KEEP_PIDFILE === '1';
      const pidPath = process.env.TEST_PID_PATH;
      const fixedPort = Number(process.env.TEST_PORT || 0);
      const server = http.createServer((req, res) => {
        if (req.url === '/api/health') { res.writeHead(200); res.end('ok'); return; }
        if (req.url === '/api/config') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ version })); return; }
        res.writeHead(404); res.end();
      });
      process.on('SIGTERM', () => {
        server.close(() => {
          if (!keepPidfileOnExit) pidf.removeOwnPidfile(pidPath, '');
          process.exit(0);
        });
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      });
      server.listen(fixedPort, '127.0.0.1', () => {
        const addr = server.address();
        const ins = pidf.inspectPidfile(pidPath);
        if (ins.state === 'stale') pidf.removeStalePidfile(pidPath, ins);
        pidf.writePidfile(pidPath, process.pid, 'nexuscrew serve --pidfile', { port: addr.port });
        process.stdout.write('READY:' + addr.port + '\\n');
      });
    `;
    const oldDaemon = await startChildHttpDaemon({
      HOME: paths.home,
      FAKE_VERSION: '0.9.82',
      KEEP_PIDFILE: '1',
      TEST_PID_PATH: paths.pidPath,
      TEST_PORT: '0',
    }, daemonScript);
    t.after(() => { try { oldDaemon.child.kill('SIGKILL'); } catch (_) {} });

    fs.writeFileSync(paths.configPath, JSON.stringify({ port: oldDaemon.port }));
    const daemonFile = path.join(paths.home, 'fake-new-daemon.js');
    fs.writeFileSync(daemonFile, daemonScript);

    const lockToken = 'portable-rst-lock-123456';
    writeState(paths.statusPath, { phase: 'pending', current: '0.9.82', targetVersion: '0.9.83' });
    assert.equal(acquireUpdateLock(paths.lockPath, process.pid, lockToken).ok, true);

    const runnerDriver = `
      const fs = require('node:fs');
      const { spawn } = require('node:child_process');
      const commands = require(${JSON.stringify(path.resolve(__dirname, '..', 'lib/cli/commands.js'))});
      const { runUpdate, restartRuntime } = require(${JSON.stringify(path.resolve(__dirname, '..', 'lib/update/runner.js'))});
      const home = process.env.TEST_HOME;
      const port = Number(process.env.TEST_PORT);
      const token = process.env.TEST_TOKEN;
      const daemonFile = process.env.TEST_DAEMON_FILE;
      const wrappedCommands = {
        ...commands,
        isServiceRunning: () => false,
        fermaTunnelPrimaDiRiavviare: () => ({ stopped: 0 }),
        stopPortableRuntime: (o) => commands.stopPortableRuntime({ ...o, platform: 'termux', stopWaitMs: 3000 }),
        startPortable: ({ home: h }) => {
          const out = fs.openSync(${JSON.stringify(path.join(paths.home, 'new-daemon.log'))}, 'a');
          const c = spawn(process.execPath, [daemonFile], {
            detached: true,
            stdio: ['ignore', out, out],
            env: {
              ...process.env,
              HOME: h,
              FAKE_VERSION: '0.9.83',
              KEEP_PIDFILE: '0',
              TEST_PID_PATH: ${JSON.stringify(paths.pidPath)},
              TEST_PORT: String(port),
            },
          });
          fs.closeSync(out);
          c.unref();
          return { started: true, pid: c.pid, portable: true };
        },
      };
      runUpdate({
        version: '0.9.83',
        home,
        statusPath: ${JSON.stringify(paths.statusPath)},
        lockPath: ${JSON.stringify(paths.lockPath)},
        lockToken: ${JSON.stringify(lockToken)},
        npmPreflightImpl: async () => true,
        execImpl: () => '',
        readInstalledVersion: () => '0.9.83',
        preflightImpl: async () => true,
        healBootImpl: () => ({ regenerated: [], skipped: [], warnings: [], errors: [], activation: { applied: [], skipped: [], errors: [] } }),
        restartImpl: (o) => restartRuntime({
          ...o,
          platform: 'termux',
          port,
          token,
          commands: wrappedCommands,
          healthAttempts: 40,
          healthDelayMs: 50,
        }),
      }).then((r) => {
        process.stdout.write(JSON.stringify({ ok: true, r }) + '\\n');
      }).catch((e) => {
        process.stderr.write((e && e.stack) || String(e));
        process.exitCode = 1;
      });
    `;

    const runnerOut = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', runnerDriver], {
        env: {
          ...process.env,
          HOME: paths.home,
          TEST_HOME: paths.home,
          TEST_PORT: String(oldDaemon.port),
          TEST_TOKEN: token,
          TEST_DAEMON_FILE: daemonFile,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d.toString(); });
      child.stderr.on('data', (d) => { err += d.toString(); });
      child.on('exit', (code) => {
        if (code !== 0) reject(new Error(`runner failed (${code}): ${err}`));
        else resolve(out.trim());
      });
    });

    const parsed = JSON.parse(runnerOut.split('\n').pop());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.r.restartMode, 'portable');
    assert.equal(fs.existsSync(paths.lockPath), false, 'runner must release lock after restart completion');
    assert.equal(readState(paths.statusPath).phase, 'installed');
    assert.equal(readState(paths.statusPath).current, '0.9.83');

    const newMeta = pidf.readPidfile(paths.pidPath);
    t.after(() => { if (newMeta && newMeta.pid) { try { process.kill(newMeta.pid, 'SIGKILL'); } catch (_) {} } });
    assert.ok(newMeta && newMeta.pid !== oldDaemon.child.pid, 'new daemon pidfile must replace old pid');
  }

  // Managed Linux (systemctl seam) and Managed macOS (launchctl seam) without quiescent mock
  for (const platformCase of ['linux', 'mac']) {
    const paths = makeIsolatedHome(`nc-upd-rst-${platformCase}-`);
    const token = `tok-${platformCase}`;
    fs.writeFileSync(paths.tokenPath, token);
    const lockToken = `tok-lock-${platformCase}`;
    writeState(paths.statusPath, { phase: 'pending', current: '0.9.82', targetVersion: '0.9.83' });
    assert.equal(acquireUpdateLock(paths.lockPath, process.pid, lockToken).ok, true);

    const server = http.createServer((req, res) => {
      if (req.url === '/api/health') { res.writeHead(200); res.end('ok'); return; }
      if (req.url === '/api/config') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ version: '0.9.83' })); return; }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    t.after(() => new Promise((r) => server.close(r)));
    const port = server.address().port;
    fs.writeFileSync(paths.configPath, JSON.stringify({ port }));

    const execCalls = [];
    const execStub = (bin, argv) => {
      execCalls.push([bin, ...argv]);
      if (bin === 'systemctl' && argv.includes('is-active')) return 'active\n';
      if (bin === 'systemctl' && argv.includes('show')) return 'process\n';
      return '';
    };

    const result = await runUpdate({
      version: '0.9.83',
      home: paths.home,
      statusPath: paths.statusPath,
      lockPath: paths.lockPath,
      lockToken,
      npmPreflightImpl: async () => true,
      execImpl: execStub,
      readInstalledVersion: () => '0.9.83',
      preflightImpl: async () => true,
      healBootImpl: () => ({ regenerated: [], skipped: [], warnings: [], errors: [], activation: { applied: [], skipped: [], errors: [] } }),
      restartImpl: (o) => restartRuntime({
        ...o,
        platform: platformCase,
        port,
        token,
        healthAttempts: 20,
        healthDelayMs: 25,
        commands: {
          ...commands,
          isServiceRunning: ({ platform: p }) => {
            assert.equal(p, platformCase);
            return true;
          },
          restart: ({ platform: p, home: h, log }) => commands.restart({
            platform: p,
            home: h,
            log,
            execImpl: execStub,
            uid: 1000,
            stopTunnelsImpl: () => ({ stopped: 0 }),
          }),
        },
      }),
    });

    assert.equal(result.updated, true);
    assert.equal(result.restartMode, 'service');
    assert.equal(fs.existsSync(paths.lockPath), false);
    assert.equal(readState(paths.statusPath).phase, 'installed');
    if (platformCase === 'linux') {
      assert.ok(execCalls.some((c) => c[0] === 'systemctl' && c.includes('restart')));
    } else {
      assert.ok(execCalls.some((c) => c[0] === 'launchctl' && c.includes('kickstart')));
    }
  }
});

test('real daemon restart across portable and managed Linux/macOS executes real closeOrdered, Q, and replacement serve', async (t) => {
  const net = require('node:net');
  const http = require('node:http');
  const { spawn } = require('node:child_process');
  const { acquireUpdateLock } = require('../lib/update/core.js');
  const { runUpdate, restartRuntime } = require('../lib/update/runner.js');
  const pidf = require('../lib/cli/pidfile.js');
  const lifecycle = require('../lib/cli/runtime-lifecycle.js');
  const commands = require('../lib/cli/commands.js');
  const BIN_PATH = path.resolve(__dirname, '..', 'bin', 'nexuscrew.js');
  const PKG_VERSION = require('../package.json').version;

  function allocateFreePort() {
    return new Promise((resolve, reject) => {
      const srv = net.createServer();
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', () => {
        const { port } = srv.address();
        srv.close((err) => (err ? reject(err) : resolve(port)));
      });
    });
  }

  function makeIsolatedHome(prefix) {
    const home = makeTempDir(t, prefix);
    const ncDir = path.join(home, '.nexuscrew');
    fs.mkdirSync(ncDir, { recursive: true, mode: 0o700 });
    return {
      home,
      ncDir,
      configPath: path.join(ncDir, 'config.json'),
      tokenPath: path.join(ncDir, 'token'),
      pidPath: pidf.defaultPidfilePath(home),
      statusPath: path.join(ncDir, 'npm-update.json'),
      lockPath: path.join(ncDir, 'npm-update.lock'),
    };
  }

  async function waitForHealth(port, token, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await new Promise((resolve) => {
        const req = http.get({
          host: '127.0.0.1',
          port,
          path: '/api/config',
          headers: { authorization: `Bearer ${token}` },
        }, (resp) => {
          let body = '';
          resp.on('data', (c) => { body += c.toString('utf8'); });
          resp.on('end', () => resolve({ status: resp.statusCode, body }));
        });
        req.on('error', () => resolve(null));
      });
      if (res && res.status === 200) {
        return JSON.parse(res.body);
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    throw new Error(`server on port ${port} did not become healthy within ${timeoutMs}ms`);
  }

  function isLiveProcess(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    if (!pidf.pidExists(pid)) return false;
    const stat = pidf.readProcStat(pid);
    return !stat || (stat.state !== 'Z' && stat.state !== 'X');
  }

  // 1) Real portable restart: real `bin/nexuscrew.js serve --pidfile` old daemon -> runner stops via real SIGTERM/closeOrdered/Q ->
  //    real `commands.startPortable` boots replacement `bin/nexuscrew.js serve --pidfile` -> verifies new PID, new generationId, live /api/config version.
  {
    const paths = makeIsolatedHome('nc-up-real-portable-');
    const port = await allocateFreePort();
    const token = 'tok-real-portable-rst';
    fs.writeFileSync(paths.tokenPath, `${token}\n`, { mode: 0o600 });
    fs.writeFileSync(paths.configPath, JSON.stringify({
      port,
      panelPort: 0,
      fleetEnabled: false,
      protectSharedTmuxServer: false,
      liveBridgeEnabled: false,
      autoUpdate: false,
    }), { mode: 0o600 });

    const oldEnv = {
      ...process.env,
      HOME: paths.home,
      NEXUSCREW_CONFIG_FILE: paths.configPath,
      NEXUSCREW_TOKEN_FILE: paths.tokenPath,
    };
    delete oldEnv.NEXUSCREW_PIDFILE;
    delete oldEnv.NEXUSCREW_PORT;

    const oldDaemon = spawn(process.execPath, [BIN_PATH, 'serve', '--pidfile'], {
      cwd: path.resolve(__dirname, '..'),
      env: oldEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(() => { try { oldDaemon.kill('SIGKILL'); } catch (_) {} });
    let oldErr = '';
    oldDaemon.stderr.on('data', (d) => { oldErr += d.toString('utf8'); });
    const oldExitP = new Promise((resolve) => oldDaemon.once('exit', (code, signal) => resolve({ code, signal })));

    const oldCfg = await waitForHealth(port, token, 6000);
    assert.equal(oldCfg.version, PKG_VERSION);
    const oldMeta = pidf.readPidfile(paths.pidPath);
    assert.ok(oldMeta && oldMeta.pid === oldDaemon.pid, `old daemon must own pidfile; err=${oldErr}`);
    assert.equal(pidf.inspectPidfile(paths.pidPath).state, 'alive');

    const lockToken = 'real-portable-rst-lock';
    writeState(paths.statusPath, { phase: 'pending', current: '0.9.82', targetVersion: PKG_VERSION });
    assert.equal(acquireUpdateLock(paths.lockPath, process.pid, lockToken).ok, true);
    t.after(() => {
      try {
        const m = pidf.readPidfile(paths.pidPath);
        if (m && m.pid && m.pid !== oldDaemon.pid) process.kill(m.pid, 'SIGKILL');
      } catch (_) {}
    });

    const runnerScript = `
      'use strict';
      const path = require('node:path');
      const { acquireUpdateLock } = require(${JSON.stringify(path.resolve(__dirname, '..', 'lib/update/core.js'))});
      const { runUpdate, restartRuntime } = require(${JSON.stringify(path.resolve(__dirname, '..', 'lib/update/runner.js'))});
      const commands = require(${JSON.stringify(path.resolve(__dirname, '..', 'lib/cli/commands.js'))});
      const home = process.env.TEST_HOME;
      const port = Number(process.env.TEST_PORT);
      const token = process.env.TEST_TOKEN;
      const lockPath = process.env.TEST_LOCK_PATH;
      const lockToken = process.env.TEST_LOCK_TOKEN;
      // Transfer lock ownership to runner subprocess pid as real detached runner does
      require('node:fs').writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: lockToken, ts: Date.now() }));
      const realCommands = {
        ...commands,
        isServiceRunning: () => false,
        fermaTunnelPrimaDiRiavviare: () => ({ stopped: 0 }),
        stopPortableRuntime: (o) => commands.stopPortableRuntime({ ...o, platform: 'linux', stopWaitMs: 4000 }),
        startPortable: (o) => commands.startPortable(o),
      };
      runUpdate({
        version: ${JSON.stringify(PKG_VERSION)},
        home,
        statusPath: process.env.TEST_STATUS_PATH,
        lockPath,
        lockToken,
        npmPreflightImpl: async () => true,
        execImpl: () => '',
        readInstalledVersion: () => ${JSON.stringify(PKG_VERSION)},
        preflightImpl: async () => true,
        healBootImpl: () => ({ regenerated: [], skipped: [], warnings: [], errors: [], activation: { applied: [], skipped: [], errors: [] } }),
        restartImpl: (o) => restartRuntime({
          ...o,
          platform: 'linux',
          port,
          token,
          commands: realCommands,
          healthAttempts: 80,
          healthDelayMs: 50,
        }),
      }).then((r) => {
        process.stdout.write(JSON.stringify({ ok: true, r }) + '\\n');
      }).catch((e) => {
        process.stderr.write((e && e.stack) || String(e));
        process.exitCode = 1;
      });
    `;

    const runnerOut = await new Promise((resolve, reject) => {
      const rEnv = {
        ...process.env,
        HOME: paths.home,
        NEXUSCREW_CONFIG_FILE: paths.configPath,
        NEXUSCREW_TOKEN_FILE: paths.tokenPath,
        TEST_HOME: paths.home,
        TEST_PORT: String(port),
        TEST_TOKEN: token,
        TEST_LOCK_PATH: paths.lockPath,
        TEST_LOCK_TOKEN: lockToken,
        TEST_STATUS_PATH: paths.statusPath,
      };
      delete rEnv.NEXUSCREW_PIDFILE;
      delete rEnv.NEXUSCREW_PORT;
      const child = spawn(process.execPath, ['-e', runnerScript], {
        cwd: path.resolve(__dirname, '..'),
        env: rEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => { out += d.toString('utf8'); });
      child.stderr.on('data', (d) => { err += d.toString('utf8'); });
      child.once('exit', (code) => {
        if (code !== 0) reject(new Error(`real portable runner failed (${code}): ${err}`));
        else resolve(out.trim());
      });
    });

    const parsed = JSON.parse(runnerOut.split('\n').pop());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.r.restartMode, 'portable');
    assert.equal(fs.existsSync(paths.lockPath), false, 'lock must be released after portable update');
    assert.equal(readState(paths.statusPath).phase, 'installed');

    const oldExit = await oldExitP;
    assert.equal(oldExit.code, 0, `old daemon must exit 0 via ordered shutdown; stderr=${oldErr}`);
    assert.equal(oldExit.signal, null);
    assert.match(
      oldErr.trim(),
      /^nexuscrew: ordered shutdown incomplete \(status=completed_with_residues, reason=signal, .*activeOps=1/,
      'old daemon shutting down while update lock is active must report incomplete ordered shutdown with activeOps=1',
    );

    const newMeta = pidf.readPidfile(paths.pidPath);
    t.after(() => {
      if (newMeta && newMeta.pid) {
        try { lifecycle.stopPortableRuntime({ home: paths.home, platform: 'linux', stopWaitMs: 3000 }); } catch (_) {}
        try { process.kill(newMeta.pid, 'SIGKILL'); } catch (_) {}
      }
    });
    assert.ok(newMeta && newMeta.pid !== oldDaemon.pid, 'replacement daemon must have a new PID');
    assert.notEqual(newMeta.generationId, oldMeta.generationId, 'replacement daemon must have a new generationId');
    assert.equal(pidf.inspectPidfile(paths.pidPath).state, 'alive');

    const newCfg = await waitForHealth(port, token, 4000);
    assert.equal(newCfg.version, PKG_VERSION);

    const cleanStop = lifecycle.stopPortableRuntime({ home: paths.home, platform: 'linux', stopWaitMs: 3000 });
    assert.equal(cleanStop.killed, true);
    assert.equal(fs.existsSync(paths.pidPath), false, 'replacement daemon must remove pidfile on clean stop');
  }

  // 2) Real managed Linux (systemctl) and macOS (launchctl) restart:
  //    service-manager seam genuinely sends SIGTERM to old `bin/nexuscrew.js serve` daemon and launches new `bin/nexuscrew.js serve` daemon.
  for (const platformCase of ['linux', 'mac']) {
    const paths = makeIsolatedHome(`nc-up-real-${platformCase}-`);
    const port = await allocateFreePort();
    const token = `tok-real-${platformCase}`;
    fs.writeFileSync(paths.tokenPath, `${token}\n`, { mode: 0o600 });
    fs.writeFileSync(paths.configPath, JSON.stringify({
      port,
      panelPort: 0,
      fleetEnabled: false,
      protectSharedTmuxServer: false,
      liveBridgeEnabled: false,
      autoUpdate: false,
    }), { mode: 0o600 });

    const daemonEnv = {
      ...process.env,
      HOME: paths.home,
      NEXUSCREW_CONFIG_FILE: paths.configPath,
      NEXUSCREW_TOKEN_FILE: paths.tokenPath,
    };
    delete daemonEnv.NEXUSCREW_PIDFILE;
    delete daemonEnv.NEXUSCREW_PORT;

    const oldDaemon = spawn(process.execPath, [BIN_PATH, 'serve'], {
      cwd: path.resolve(__dirname, '..'),
      env: daemonEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let oldErr = '';
    oldDaemon.stderr.on('data', (d) => { oldErr += d.toString('utf8'); });
    t.after(() => { try { oldDaemon.kill('SIGKILL'); } catch (_) {} });
    await waitForHealth(port, token, 6000);

    let replacementDaemon = null;
    t.after(() => {
      if (replacementDaemon && replacementDaemon.pid) {
        try { process.kill(replacementDaemon.pid, 'SIGKILL'); } catch (_) {}
      }
    });

    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    const stopOldAndSpawnNew = () => {
      try { process.kill(oldDaemon.pid, 'SIGTERM'); } catch (_) {}
      const deadline = Date.now() + 4000;
      while (isLiveProcess(oldDaemon.pid) && Date.now() < deadline) {
        Atomics.wait(sleeper, 0, 0, 25);
      }
      assert.equal(isLiveProcess(oldDaemon.pid), false, `old ${platformCase} daemon must exit before replacement starts`);
      const outFd = fs.openSync(path.join(paths.home, `managed-${platformCase}-new.log`), 'a');
      replacementDaemon = spawn(process.execPath, [BIN_PATH, 'serve'], {
        cwd: path.resolve(__dirname, '..'),
        env: daemonEnv,
        detached: true,
        stdio: ['ignore', outFd, outFd],
      });
      fs.closeSync(outFd);
      replacementDaemon.unref();
    };

    const execCalls = [];
    const execStub = (bin, argv) => {
      execCalls.push([bin, ...argv]);
      if (bin === 'systemctl' && argv.includes('is-active')) {
        return isLiveProcess(replacementDaemon && replacementDaemon.pid) || isLiveProcess(oldDaemon.pid)
          ? 'active\n'
          : 'inactive\n';
      }
      if (bin === 'systemctl' && argv.includes('show')) return 'process\n';
      if (bin === 'systemctl' && argv.includes('restart')) {
        stopOldAndSpawnNew();
        return '';
      }
      if (bin === 'launchctl' && argv[0] === 'bootout') {
        try { process.kill(oldDaemon.pid, 'SIGTERM'); } catch (_) {}
        const deadline = Date.now() + 4000;
        while (isLiveProcess(oldDaemon.pid) && Date.now() < deadline) {
          Atomics.wait(sleeper, 0, 0, 25);
        }
        return '';
      }
      if (bin === 'launchctl' && argv[0] === 'kickstart') {
        if (!replacementDaemon) {
          stopOldAndSpawnNew();
        }
        return '';
      }
      return '';
    };

    const lockToken = `real-lock-${platformCase}`;
    writeState(paths.statusPath, { phase: 'pending', current: '0.9.82', targetVersion: PKG_VERSION });
    assert.equal(acquireUpdateLock(paths.lockPath, process.pid, lockToken).ok, true);

    const result = await runUpdate({
      version: PKG_VERSION,
      home: paths.home,
      statusPath: paths.statusPath,
      lockPath: paths.lockPath,
      lockToken,
      npmPreflightImpl: async () => true,
      execImpl: execStub,
      readInstalledVersion: () => PKG_VERSION,
      preflightImpl: async () => true,
      healBootImpl: () => ({ regenerated: [], skipped: [], warnings: [], errors: [], activation: { applied: [], skipped: [], errors: [] } }),
      restartImpl: (o) => restartRuntime({
        ...o,
        platform: platformCase,
        port,
        token,
        healthAttempts: 80,
        healthDelayMs: 50,
        commands: {
          ...commands,
          isServiceRunning: ({ platform: p }) => {
            assert.equal(p, platformCase);
            return isLiveProcess(oldDaemon.pid) || isLiveProcess(replacementDaemon && replacementDaemon.pid);
          },
          restart: ({ platform: p, home: h, log }) => commands.restart({
            platform: p,
            home: h,
            log,
            execImpl: execStub,
            uid: 1000,
            stopTunnelsImpl: () => ({ stopped: 0 }),
          }),
        },
      }),
    });

    assert.equal(result.updated, true);
    assert.equal(result.restartMode, 'service');
    assert.equal(fs.existsSync(paths.lockPath), false);
    assert.equal(readState(paths.statusPath).phase, 'installed');
    assert.ok(replacementDaemon && replacementDaemon.pid !== oldDaemon.pid, 'replacement managed daemon must start with distinct PID');
    assert.match(
      oldErr.trim(),
      /^nexuscrew: ordered shutdown incomplete \(status=completed_with_residues, reason=signal, .*activeOps=1/,
      'old managed daemon shutting down while update lock is active must report active update residue',
    );
    const newCfg = await waitForHealth(port, token, 4000);
    assert.equal(newCfg.version, PKG_VERSION);

    if (platformCase === 'linux') {
      assert.ok(execCalls.some((c) => c[0] === 'systemctl' && c.includes('restart')));
    } else {
      assert.ok(execCalls.some((c) => c[0] === 'launchctl' && c[1] === 'kickstart'));
    }

    try { process.kill(replacementDaemon.pid, 'SIGTERM'); } catch (_) {}
  }
});
