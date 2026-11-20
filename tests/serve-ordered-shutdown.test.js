'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

const { serve, dispatch } = require('../lib/cli/commands.js');
const {
  DEFAULT_SERVE_SHUTDOWN_BUDGET_MS,
  createServeShutdownCoordinator,
  installServeSignalAdapter,
  captureNonTermuxPidfileIdentity,
  captureTermuxPidfileIdentity,
  removeOwnNonTermuxPidfile,
  removeOwnTermuxPidfile,
  formatIncompleteShutdownLine,
} = require('../lib/cli/shutdown-coordinator.js');
const { acquireGuard } = require('../lib/cli/service-guard.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const BIN_PATH = path.join(REPO_ROOT, 'bin', 'nexuscrew.js');

function makeTempDir(t, prefix = 'nc-serve-shutdown-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });
  return dir;
}

function writeIsolatedConfig(homeDir, extra = {}) {
  const cfgDir = path.join(homeDir, '.nexuscrew');
  fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
  const cfgPath = path.join(cfgDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({
    port: 0,
    panelPort: 0,
    fleetEnabled: false,
    protectSharedTmuxServer: false,
    liveBridgeEnabled: false,
    autoUpdate: false,
    ...extra,
  }, null, 2), { mode: 0o600 });
  return cfgPath;
}

function makeFakeServer({
  quiescent = true,
  timedOut = false,
  codes = [],
  counts = {},
  delayMs = 0,
  onDisarm,
  onCloseOrdered,
  throwOnClose,
} = {}) {
  let disarmed = false;
  const shutdownController = {
    disarm() {
      disarmed = true;
      if (typeof onDisarm === 'function') onDisarm();
    },
    isDisarmed: () => disarmed,
    async closeOrdered({ reason, deadlineMono } = {}) {
      if (typeof onCloseOrdered === 'function') {
        onCloseOrdered({ reason, deadlineMono, disarmedAtCloseCall: disarmed });
      }
      if (throwOnClose) throw throwOnClose;
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return {
        ok: quiescent && !timedOut && !throwOnClose,
        quiescent,
        timedOut,
        elapsedMs: delayMs,
        counts: {
          activeOps: counts.activeOps ?? 0,
          activeClaims: counts.activeClaims ?? 0,
          forcedConnections: counts.forcedConnections ?? 0,
          residues: counts.residues ?? (quiescent ? 0 : 1),
          ...(counts.unattestedClaimConsumers !== undefined
            ? { unattestedClaimConsumers: counts.unattestedClaimConsumers }
            : {}),
        },
        codes,
        fleet: null,
      };
    },
  };
  return {
    shutdownController,
    disarm: shutdownController.disarm,
    closeOrdered: shutdownController.closeOrdered,
  };
}

function spawnServeChild(t, { args = ['serve'], env = {} } = {}) {
  const proc = spawn(process.execPath, [BIN_PATH, ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let settled = false;
  const exitPromise = new Promise((resolve, reject) => {
    proc.once('error', (err) => {
      settled = true;
      reject(err);
    });
    proc.once('exit', (code, signal) => {
      settled = true;
      resolve({ code, signal });
    });
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  proc.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

  t.after(async () => {
    if (!settled && proc.exitCode === null && proc.signalCode === null) {
      try { proc.kill('SIGKILL'); } catch (_) {}
      await Promise.race([
        exitPromise.catch(() => {}),
        new Promise((r) => setTimeout(r, 2000)),
      ]);
    }
  });

  const waitListening = (timeoutMs = 15000) => new Promise((resolve, reject) => {
    const matchExisting = stdout.match(/nexuscrew on http:\/\/127\.0\.0\.1:(\d+)/);
    if (matchExisting) {
      resolve(Number(matchExisting[1]));
      return;
    }
    let timer = null;
    const cleanup = () => {
      if (timer) { clearTimeout(timer); timer = null; }
      proc.stdout.off('data', onData);
      proc.off('exit', onEarlyExit);
    };
    const onData = () => {
      const m = stdout.match(/nexuscrew on http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        cleanup();
        resolve(Number(m[1]));
      }
    };
    const onEarlyExit = (code, signal) => {
      cleanup();
      reject(new Error(`serve exited before listening (code=${code}, signal=${signal}): ${stderr}`));
    };
    timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for serve listening stdout=${stdout} stderr=${stderr}`));
    }, timeoutMs);
    proc.stdout.on('data', onData);
    proc.once('exit', onEarlyExit);
  });

  const waitExit = (timeoutMs = 10000) => {
    let timer = null;
    return Promise.race([
      exitPromise.then((res) => ({ ...res, stdout, stderr })),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out waiting for child exit stdout=${stdout} stderr=${stderr}`)),
          timeoutMs,
        );
      }),
    ]).finally(() => {
      if (timer) { clearTimeout(timer); timer = null; }
    });
  };

  return { proc, waitListening, waitExit, getStdout: () => stdout, getStderr: () => stderr };
}

test('ordered shutdown disarm happens synchronously before closeOrdered, pidCleanup, and exit', async (t) => {
  const home = makeTempDir(t, 'nc-serve-order-');
  const pidPath = path.join(home, 'nc.pid');
  const events = [];
  let releaseClose;
  const closeGate = new Promise((r) => { releaseClose = r; });

  const server = {
    shutdownController: {
      disarm() { events.push('disarm'); },
      async closeOrdered({ reason, deadlineMono }) {
        events.push(`closeOrdered:start:${reason}:${Number.isFinite(deadlineMono)}`);
        await closeGate;
        events.push('closeOrdered:end');
        return {
          ok: true,
          quiescent: true,
          timedOut: false,
          elapsedMs: 2,
          counts: { activeOps: 0, activeClaims: 0, forcedConnections: 0, residues: 0 },
          codes: [],
          fleet: null,
        };
      },
    },
    closeOrdered(args) { return this.shutdownController.closeOrdered(args); },
  };

  let exitedWith = null;
  const fakeProc = new EventEmitter();
  let coord = null;
  const r = dispatch(['serve', '--pidfile'], {
    home,
    pidPath,
    envPidfile: pidPath,
    fleetEnabled: false,
    platform: 'linux',
    proc: fakeProc,
    exitImpl: (code) => {
      events.push(`exit:${code}`);
      exitedWith = code;
    },
    writeShutdownLine: (line) => { events.push(`warn:${line}`); },
    serverStart: () => server,
    onShutdownCoordinator: (c) => { coord = c; },
    log: () => {},
  });
  // Override via shutdownCoordinator test seam cleanly while verifying dispatch also installs adapter.
  assert.ok(r.controller);
  r.disposeSignals();

  const home2 = makeTempDir(t, 'nc-serve-order2-');
  const pidPath2 = path.join(home2, 'nc.pid');
  const prevPidEnv = process.env.NEXUSCREW_PIDFILE;
  process.env.NEXUSCREW_PIDFILE = pidPath2;
  t.after(() => {
    if (prevPidEnv === undefined) delete process.env.NEXUSCREW_PIDFILE;
    else process.env.NEXUSCREW_PIDFILE = prevPidEnv;
  });

  events.length = 0;
  let now = 1000;
  const coordinator = createServeShutdownCoordinator({
    nowMono: () => now,
    exitImpl: (code) => { events.push(`exit:${code}`); },
    writeLine: (line) => { events.push(`warn:${line}`); },
    proc: fakeProc,
  });
  const adapter = installServeSignalAdapter(coordinator, { proc: fakeProc, exitOnSignal: true });
  t.after(() => adapter.dispose());

  serve({
    home: home2,
    pidfile: true,
    fleetEnabled: false,
    platform: 'linux',
    shutdownCoordinator: coordinator,
    serverStart: () => server,
  });
  assert.ok(fs.existsSync(pidPath2));

  fakeProc.emit('SIGTERM');
  // Synchronously right after signal, server must ALREADY be disarmed, before closeOrdered/pidCleanup/exit!
  assert.equal(coordinator.isDisarmed(), true);
  assert.equal(events[0], 'disarm');
  assert.ok(fs.existsSync(pidPath2), 'pidfile must remain while closeOrdered is still draining');

  await Promise.resolve();
  await Promise.resolve();
  assert.ok(events.includes('closeOrdered:start:signal:true'));
  assert.equal(events.some((e) => e.startsWith('exit:')), false);

  now = 1050;
  releaseClose();
  const outcome = await coordinator.shutdown({ reason: 'signal' });
  assert.equal(outcome.quiescent, true);
  assert.equal(outcome.pidfileRemoved, true);
  assert.equal(outcome.exitCode, 0);
  assert.ok(!fs.existsSync(pidPath2));
  assert.deepEqual(events, [
    'disarm',
    'closeOrdered:start:signal:true',
    'closeOrdered:end',
    'exit:0',
  ]);
  assert.equal(exitedWith, null);
});

test('listener hygiene: serve registers none; dispatch adapter is deduplicated, disposable, and adds no fatal error handlers', (t) => {
  const baseline = {
    SIGINT: process.listenerCount('SIGINT'),
    SIGTERM: process.listenerCount('SIGTERM'),
    exit: process.listenerCount('exit'),
    uncaughtException: process.listenerCount('uncaughtException'),
    unhandledRejection: process.listenerCount('unhandledRejection'),
  };

  // Programmatic serve() registers ZERO global listeners on process.
  const prog = serve({
    fleetEnabled: false,
    serverStart: () => makeFakeServer(),
  });
  assert.equal(process.listenerCount('SIGINT'), baseline.SIGINT);
  assert.equal(process.listenerCount('SIGTERM'), baseline.SIGTERM);
  assert.equal(process.listenerCount('exit'), baseline.exit);
  assert.equal(process.listenerCount('uncaughtException'), baseline.uncaughtException);
  assert.equal(process.listenerCount('unhandledRejection'), baseline.unhandledRejection);
  assert.equal(typeof prog.shutdown, 'function');

  // Mock proc adapter test: idempotent install, clean dispose, zero fatal handlers.
  const fakeProc = new EventEmitter();
  const c1 = createServeShutdownCoordinator({ exitImpl: () => {}, proc: fakeProc });
  const a1 = installServeSignalAdapter(c1, { proc: fakeProc, exitOnSignal: true });
  const a1Dup = installServeSignalAdapter(c1, { proc: fakeProc, exitOnSignal: true });
  assert.equal(fakeProc.listenerCount('SIGINT'), 1);
  assert.equal(fakeProc.listenerCount('SIGTERM'), 1);
  assert.equal(fakeProc.listenerCount('exit'), 1);
  assert.equal(fakeProc.listenerCount('uncaughtException'), 0);
  assert.equal(fakeProc.listenerCount('unhandledRejection'), 0);
  assert.equal(a1.dispose, a1Dup.dispose);

  // Installing for a new coordinator disposes the previous one rather than stacking.
  const c2 = createServeShutdownCoordinator({ exitImpl: () => {}, proc: fakeProc });
  const a2 = installServeSignalAdapter(c2, { proc: fakeProc, exitOnSignal: true });
  t.after(() => a2.dispose());
  assert.equal(fakeProc.listenerCount('SIGINT'), 1);
  assert.equal(fakeProc.listenerCount('SIGTERM'), 1);
  assert.equal(fakeProc.listenerCount('exit'), 1);

  a2.dispose();
  assert.equal(fakeProc.listenerCount('SIGINT'), 0);
  assert.equal(fakeProc.listenerCount('SIGTERM'), 0);
  assert.equal(fakeProc.listenerCount('exit'), 0);
});

test('startup disarm before ensureFleetDefaults / claimService aborts startup and preserves pidfiles', async (t) => {
  const home = makeTempDir(t, 'nc-serve-disarm-start-');
  const pidPath = path.join(home, 'nc.pid');
  const prevCwd = process.cwd();
  const prevPidEnv = process.env.NEXUSCREW_PIDFILE;
  process.env.NEXUSCREW_PIDFILE = pidPath;
  t.after(() => {
    try { process.chdir(prevCwd); } catch (_) {}
    if (prevPidEnv === undefined) delete process.env.NEXUSCREW_PIDFILE;
    else process.env.NEXUSCREW_PIDFILE = prevPidEnv;
  });

  const fakeProc = new EventEmitter();
  const warnings = [];
  const exits = [];
  const coordinator = createServeShutdownCoordinator({
    proc: fakeProc,
    exitImpl: (c) => exits.push(c),
    writeLine: (line) => warnings.push(line),
  });
  let serverStartCalled = false;

  assert.throws(() => serve({
    home,
    pidfile: true,
    platform: 'linux',
    fleetEnabled: false,
    shutdownCoordinator: coordinator,
    ensureFleetDefaultsImpl: () => {
      // Simulate signal disarming coordinator mid-startup initialization.
      void coordinator.shutdown({ reason: 'signal', exitOnFinish: true });
    },
    serverStart: () => { serverStartCalled = true; },
  }), (err) => err && err.code === 'SERVE_DISARMED');

  assert.equal(serverStartCalled, false);
  assert.equal(fs.existsSync(pidPath), false);
  const outcome = await coordinator.shutdown({ reason: 'signal' });
  assert.equal(outcome.status, 'startup_failed');
  assert.equal(outcome.quiescent, false);
  assert.equal(outcome.pidfileRemoved, false);
  assert.equal(outcome.exitCode, 1);
  assert.deepEqual(exits, [1]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^nexuscrew: ordered shutdown incomplete \(/);
});

test('async serverStart timing out at single deadlineMono returns cleanly on bounded path, with late resolve/reject safety', async () => {
  // Case A: serverStart returns a never-settling Promise within budget -> bounded SERVER_PENDING_TIMEOUT
  let now = 5000;
  let delayedTimerFn = null;
  const warningsA = [];
  const cA = createServeShutdownCoordinator({
    budgetMs: DEFAULT_SERVE_SHUTDOWN_BUDGET_MS,
    nowMono: () => now,
    setTimer: (fn) => { delayedTimerFn = fn; return 1; },
    clearTimer: () => {},
    writeLine: (line) => warningsA.push(line),
    exitImpl: () => {},
  });
  let resolvePending;
  const pendingPromise = new Promise((r) => { resolvePending = r; });
  let lateDisarmCount = 0;
  let lateCloseCount = 0;

  cA.registerServer(pendingPromise);
  const pOut = cA.shutdown({ reason: 'signal', exitOnFinish: true });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(typeof delayedTimerFn, 'function');
  now = 5000 + DEFAULT_SERVE_SHUTDOWN_BUDGET_MS;
  delayedTimerFn();
  const outA = await pOut;
  assert.equal(outA.timedOut, true);
  assert.equal(outA.quiescent, false);
  assert.equal(outA.pidfileRemoved, false);
  assert.equal(outA.exitCode, 0);
  assert.ok(outA.codes.includes('SERVER_PENDING_TIMEOUT'));
  assert.equal(warningsA.length, 1);

  // Settling after timeout must still disarm late handle and must NOT call closeOrdered/flip outcome.
  resolvePending({
    shutdownController: {
      disarm() { lateDisarmCount += 1; },
      closeOrdered() { lateCloseCount += 1; return {}; },
    },
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(lateDisarmCount, 1);
  assert.equal(lateCloseCount, 0);

  // Case B: serverStart rejects asynchronously -> startup_failed, exitCode >= 1, pidfile conserved
  let cleanupCalled = 0;
  const cB = createServeShutdownCoordinator({
    nowMono: () => 100,
    writeLine: () => {},
    exitImpl: () => {},
  });
  cB.registerPidCleanup(() => { cleanupCalled += 1; return true; });
  const boom = new Error('bind EADDRINUSE');
  boom.exitCode = 2;
  cB.registerServer(Promise.reject(boom));
  const outB = await cB.shutdown({ reason: 'signal', exitOnFinish: true });
  assert.equal(outB.status, 'startup_failed');
  assert.equal(outB.quiescent, false);
  assert.equal(outB.pidfileRemoved, false);
  assert.equal(outB.exitCode, 2);
  assert.ok(outB.codes.includes('STARTUP_FAILED'));
  assert.equal(cleanupCalled, 0);
});

test('double signal shares single deadlineMono, single closeOrdered call, single warning, single exit; clock overrun preserves pidfile', async (t) => {
  const home = makeTempDir(t, 'nc-serve-double-');
  const pidPath = path.join(home, 'nc.pid');
  const prevCwd = process.cwd();
  const prevPidEnv = process.env.NEXUSCREW_PIDFILE;
  process.env.NEXUSCREW_PIDFILE = pidPath;
  t.after(() => {
    try { process.chdir(prevCwd); } catch (_) {}
    if (prevPidEnv === undefined) delete process.env.NEXUSCREW_PIDFILE;
    else process.env.NEXUSCREW_PIDFILE = prevPidEnv;
  });

  let clock = 10_000;
  let closeCalls = 0;
  const seenDeadlines = [];
  const warnings = [];
  const exits = [];
  const fakeProc = new EventEmitter();
  const c = createServeShutdownCoordinator({
    budgetMs: 1500,
    nowMono: () => clock,
    writeLine: (l) => warnings.push(l),
    exitImpl: (code) => exits.push(code),
    proc: fakeProc,
  });
  const adapter = installServeSignalAdapter(c, { proc: fakeProc, exitOnSignal: true });
  t.after(() => adapter.dispose());

  let releaseClose;
  const gate = new Promise((r) => { releaseClose = r; });
  const server = {
    shutdownController: {
      disarm() {},
      async closeOrdered({ deadlineMono }) {
        closeCalls += 1;
        seenDeadlines.push(deadlineMono);
        await gate;
        // Advance virtual clock right to the deadline -> overrun!
        clock = 11_500;
        return {
          ok: true,
          quiescent: true,
          timedOut: false,
          elapsedMs: 1500,
          counts: { activeOps: 0, activeClaims: 0, forcedConnections: 0, residues: 0 },
          codes: [],
          fleet: null,
        };
      },
    },
    closeOrdered(args) { return this.shutdownController.closeOrdered(args); },
  };

  serve({
    home,
    pidfile: true,
    platform: 'linux',
    fleetEnabled: false,
    shutdownCoordinator: c,
    serverStart: () => server,
  });
  assert.ok(fs.existsSync(pidPath));

  // First signal at clock = 10_000 sets deadlineMono = 11_500
  fakeProc.emit('SIGINT');
  const p1 = c.shutdown({ reason: 'signal' });
  clock = 10_900;
  // Duplicate SIGTERM must reuse the exact same promise and deadlineMono = 11_500!
  fakeProc.emit('SIGTERM');
  const p2 = c.shutdown({ reason: 'signal' });
  assert.equal(p1, p2);

  releaseClose();
  const out = await p1;
  assert.equal(closeCalls, 1);
  assert.deepEqual(seenDeadlines, [11_500]);
  assert.equal(out.quiescent, false);
  assert.equal(out.timedOut, true);
  assert.ok(out.codes.includes('SHUTDOWN_BUDGET_EXHAUSTED'));
  assert.equal(out.pidfileRemoved, false);
  assert.ok(fs.existsSync(pidPath), 'pidfile must be preserved when budget deadline expires');
  assert.equal(warnings.length, 1);
  assert.deepEqual(exits, [0]);
});

test('programmatic shutdown never exits, startup throw preserves pidfile & keeps non-zero exitCode, proc.exitCode preserved', async (t) => {
  const home = makeTempDir(t, 'nc-serve-programmatic-');
  const pidPath = path.join(home, 'nc.pid');
  const prevCwd = process.cwd();
  const prevPidEnv = process.env.NEXUSCREW_PIDFILE;
  process.env.NEXUSCREW_PIDFILE = pidPath;
  t.after(() => {
    try { process.chdir(prevCwd); } catch (_) {}
    if (prevPidEnv === undefined) delete process.env.NEXUSCREW_PIDFILE;
    else process.env.NEXUSCREW_PIDFILE = prevPidEnv;
  });

  // 1) Programmatic serve().shutdown() never calls exitImpl, even when non-quiescent.
  const progExits = [];
  const progCtl = serve({
    fleetEnabled: false,
    exitImpl: (code) => progExits.push(code),
    writeShutdownLine: () => {},
    serverStart: () => makeFakeServer({ quiescent: false, counts: { activeOps: 2, residues: 1 } }),
  });
  const progOut = await progCtl.shutdown({ reason: 'programmatic' });
  assert.equal(progOut.quiescent, false);
  assert.equal(progOut.exitCode, 0);
  assert.deepEqual(progExits, []);

  // 2) Synchronous serverStart throw after pidfile creation -> pidfile conserved, subsequent signal keeps exitCode = 1
  const fakeProc = new EventEmitter();
  let capturedCoord = null;
  const throwExits = [];
  const throwWarnings = [];
  assert.throws(() => serve({
    home,
    pidfile: true,
    platform: 'linux',
    fleetEnabled: false,
    proc: fakeProc,
    exitImpl: (code) => throwExits.push(code),
    writeShutdownLine: (l) => throwWarnings.push(l),
    onShutdownCoordinator: (c) => { capturedCoord = c; },
    serverStart: () => { throw new Error('listen EACCES'); },
  }), /listen EACCES/);
  assert.ok(fs.existsSync(pidPath), 'pidfile created before serverStart failure must remain on disk');
  const failOut = await capturedCoord.shutdown({ reason: 'signal', exitOnFinish: true });
  assert.equal(failOut.status, 'startup_failed');
  assert.equal(failOut.quiescent, false);
  assert.equal(failOut.pidfileRemoved, false);
  assert.equal(failOut.exitCode, 1);
  assert.deepEqual(throwExits, [1]);
  assert.equal(throwWarnings.length, 1);
  assert.ok(fs.existsSync(pidPath));

  // 3) Pre-set proc.exitCode > 0 is preserved on ordered stop
  const busyProc = { exitCode: 3 };
  const c3 = createServeShutdownCoordinator({ proc: busyProc, exitImpl: () => {}, writeLine: () => {} });
  c3.registerServer(makeFakeServer({ quiescent: true }));
  const out3 = await c3.shutdown({ reason: 'signal', exitOnFinish: true });
  assert.equal(out3.quiescent, true);
  assert.equal(out3.exitCode, 3);
});

test('own-generation pidfile cleanup matrix (non-Termux): replaced inode, wrong generationId/processStart, symlink, corrupt JSON, EACCES, indeterminate, double call', async (t) => {
  const dir = makeTempDir(t, 'nc-serve-pidmatrix-');
  const { writePidfile } = require('../lib/cli/pidfile.js');

  // Helper to create a valid own-generation pidfile
  const makeOwn = (name, generationId = 'a'.repeat(32), procStart = '987654') => {
    const pidPath = path.join(dir, name);
    writePidfile(pidPath, process.pid, 'node serve', { port: 4321, generationId });
    // Ensure processStart is stamped if platform lacked /proc lookup (still deterministic in unit test)
    const raw = JSON.parse(fs.readFileSync(pidPath, 'utf8'));
    raw.processStart = procStart;
    fs.writeFileSync(pidPath, JSON.stringify(raw));
    const snapshot = captureNonTermuxPidfileIdentity(pidPath, {
      generationId,
      pid: process.pid,
      impl: { currentUid: () => fs.lstatSync(pidPath).uid },
    });
    assert.ok(snapshot);
    return { pidPath, snapshot, raw };
  };

  // 1) Happy path + idempotency on double call (unlink invoked once)
  const own1 = makeOwn('own1.pid');
  let unlinkCount = 0;
  const removed1 = removeOwnNonTermuxPidfile(own1.snapshot, {
    readProcessStartImpl: () => own1.raw.processStart,
    unlinkSync: (p) => { unlinkCount += 1; fs.unlinkSync(p); },
  });
  assert.equal(removed1, true);
  assert.equal(unlinkCount, 1);
  assert.ok(!fs.existsSync(own1.pidPath));
  assert.equal(removeOwnNonTermuxPidfile(own1.snapshot), false);

  // Coordinator double finalization (shutdown + syncExitFallback) calls cleanup at most once
  const ownDouble = makeOwn('own-double.pid');
  let coordCleanupCalls = 0;
  const cDouble = createServeShutdownCoordinator({ writeLine: () => {}, exitImpl: () => {} });
  cDouble.registerServer(makeFakeServer({ quiescent: true }));
  cDouble.registerPidCleanup(() => {
    coordCleanupCalls += 1;
    return removeOwnNonTermuxPidfile(ownDouble.snapshot, { readProcessStartImpl: () => ownDouble.raw.processStart });
  });
  const dOut = await cDouble.shutdown({ reason: 'signal' });
  cDouble.syncExitFallback();
  assert.equal(dOut.pidfileRemoved, true);
  assert.equal(coordCleanupCalls, 1);
  assert.ok(!fs.existsSync(ownDouble.pidPath));

  // 2) Replaced inode via atomic rename (guarantees distinct inode even with same pid and generationId!) -> refused
  const own2 = makeOwn('own2.pid', 'b'.repeat(32));
  const own2Replacement = own2.pidPath + '.replacement';
  fs.writeFileSync(own2Replacement, JSON.stringify(own2.raw));
  fs.renameSync(own2Replacement, own2.pidPath);
  assert.notEqual(fs.lstatSync(own2.pidPath).ino, own2.snapshot.ino);
  assert.equal(removeOwnNonTermuxPidfile(own2.snapshot, { readProcessStartImpl: () => own2.raw.processStart }), false);
  assert.ok(fs.existsSync(own2.pidPath));

  // 3) Same inode, mismatched generationId -> refused
  const own3 = makeOwn('own3.pid', 'c'.repeat(32));
  fs.writeFileSync(own3.pidPath, JSON.stringify({ ...own3.raw, generationId: 'd'.repeat(32) }));
  assert.equal(removeOwnNonTermuxPidfile(own3.snapshot, { readProcessStartImpl: () => own3.raw.processStart }), false);
  assert.ok(fs.existsSync(own3.pidPath));

  // 4) Same inode, mismatched live processStart (PID recycled) -> refused
  const own4 = makeOwn('own4.pid', 'e'.repeat(32), '111111');
  assert.equal(removeOwnNonTermuxPidfile(own4.snapshot, { readProcessStartImpl: () => '222222' }), false);
  assert.ok(fs.existsSync(own4.pidPath));

  // 5) Symlink replacement -> refused, both symlink and decoy target remain intact
  const own5 = makeOwn('own5.pid', 'f'.repeat(32));
  const decoy = path.join(dir, 'decoy.txt');
  fs.writeFileSync(decoy, 'do-not-delete');
  fs.unlinkSync(own5.pidPath);
  fs.symlinkSync(decoy, own5.pidPath);
  assert.equal(removeOwnNonTermuxPidfile(own5.snapshot), false);
  assert.ok(fs.lstatSync(own5.pidPath).isSymbolicLink());
  assert.equal(fs.readFileSync(decoy, 'utf8'), 'do-not-delete');

  // 6) Corrupt JSON in place -> refused
  const own6 = makeOwn('own6.pid', '0'.repeat(32));
  fs.writeFileSync(own6.pidPath, '{corrupt');
  assert.equal(removeOwnNonTermuxPidfile(own6.snapshot), false);
  assert.ok(fs.existsSync(own6.pidPath));

  // 7) EACCES on unlink -> returns false, no throw
  const own7 = makeOwn('own7.pid', '1'.repeat(32));
  assert.equal(removeOwnNonTermuxPidfile(own7.snapshot, {
    readProcessStartImpl: () => own7.raw.processStart,
    unlinkSync: () => { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; },
  }), false);
  assert.ok(fs.existsSync(own7.pidPath));

  // 8) Indeterminate snapshot without generationId or processStart -> refused
  const own8 = makeOwn('own8.pid', '2'.repeat(32));
  assert.equal(removeOwnNonTermuxPidfile({
    pidPath: own8.pidPath,
    dev: own8.snapshot.dev,
    ino: own8.snapshot.ino,
    uid: own8.snapshot.uid,
    pid: process.pid,
    generationId: null,
    processStart: null,
  }), false);
  assert.ok(fs.existsSync(own8.pidPath));
});

test('service managers (systemd, launchd, Termux) & own-generation/guard lifecycle', async (t) => {
  const home = makeTempDir(t, 'nc-serve-mgrs-');

  // 1) systemd / launchd (non-Termux, no --pidfile): zero pidfiles touched, quiescent exit 0
  for (const mgrPlatform of ['linux', 'darwin']) {
    const coordinator = createServeShutdownCoordinator({
      proc: { exitCode: 0 },
      exitImpl: () => {},
      writeLine: () => {},
    });
    const s = serve({
      home,
      platform: mgrPlatform,
      fleetEnabled: false,
      shutdownCoordinator: coordinator,
      serverStart: () => makeFakeServer({ quiescent: true }),
    });
    const out = await s.shutdown({ reason: 'signal' });
    assert.equal(out.quiescent, true);
    assert.equal(out.pidfileRemoved, false);
    assert.equal(out.exitCode, 0);
  }

  // 2) Termux path: claimService holds real guard.fd lock during runtime; non-quiescent keeps pidfile; quiescent removes only own serviceRunId+inode
  const pidPath = path.join(home, 'termux-state', 'nc.pid');
  const runId = 'a1'.repeat(16);
  const flockBin = fs.existsSync('/usr/bin/flock') ? '/usr/bin/flock' : null;
  let guardRes;
  if (flockBin) {
    guardRes = acquireGuard(pidPath, { flockPath: flockBin, waitSec: 0 });
    assert.equal(guardRes.ok, true, 'guard lock must be acquirable before serve');
    t.after(() => { try { guardRes.release(); } catch (_) {} });

    // While held by Termux runtime, second acquireGuard fails cleanly with GUARD_BUSY
    const blocked = acquireGuard(pidPath, { flockPath: flockBin, waitSec: 0 });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, 'GUARD_BUSY');
  } else {
    fs.mkdirSync(path.dirname(pidPath), { recursive: true, mode: 0o700 });
    guardRes = { ok: true, fd: 99, dev: 1, ino: 1, release() {} };
  }

  const prevCwd = process.cwd();
  const prevPidEnv = process.env.NEXUSCREW_PIDFILE;
  process.env.NEXUSCREW_PIDFILE = pidPath;
  t.after(() => {
    try { process.chdir(prevCwd); } catch (_) {}
    if (prevPidEnv === undefined) delete process.env.NEXUSCREW_PIDFILE;
    else process.env.NEXUSCREW_PIDFILE = prevPidEnv;
  });

  // 2a) Non-quiescent Termux stop keeps pidfile on disk
  const writeFakeTermuxPid = (rid) => {
    fs.writeFileSync(pidPath, JSON.stringify({
      pid: process.pid,
      serviceRunId: rid,
      startTs: Date.now(),
      cmd: 'node serve',
    }), { mode: 0o644 });
  };
  const cTermuxFail = createServeShutdownCoordinator({ writeLine: () => {}, exitImpl: () => {} });
  serve({
    home,
    platform: 'termux',
    fleetEnabled: false,
    shutdownCoordinator: cTermuxFail,
    claimServiceImpl: () => {
      writeFakeTermuxPid(runId);
      return { runId, guard: guardRes };
    },
    serverStart: () => makeFakeServer({ quiescent: false, counts: { activeClaims: 1, residues: 1 } }),
  });
  const failOut = await cTermuxFail.shutdown({ reason: 'signal' });
  assert.equal(failOut.quiescent, false);
  assert.equal(failOut.pidfileRemoved, false);
  assert.ok(fs.existsSync(pidPath));

  // 2b) Replaced serviceRunId on disk -> removeOwnTermuxPidfile refuses removal
  const snapReplaced = captureTermuxPidfileIdentity(pidPath, { runId, pid: process.pid });
  fs.writeFileSync(pidPath, JSON.stringify({ pid: process.pid, serviceRunId: 'b2'.repeat(16) }));
  assert.equal(removeOwnTermuxPidfile(snapReplaced), false);
  assert.ok(fs.existsSync(pidPath));

  // 2c) Quiescent Termux stop removes matching own-run pidfile
  fs.unlinkSync(pidPath);
  const cTermuxOk = createServeShutdownCoordinator({ writeLine: () => {}, exitImpl: () => {} });
  serve({
    home,
    platform: 'termux',
    fleetEnabled: false,
    shutdownCoordinator: cTermuxOk,
    claimServiceImpl: () => {
      writeFakeTermuxPid(runId);
      return { runId, guard: guardRes };
    },
    serverStart: () => makeFakeServer({ quiescent: true }),
  });
  const okOut = await cTermuxOk.shutdown({ reason: 'signal' });
  assert.equal(okOut.quiescent, true);
  assert.equal(okOut.pidfileRemoved, true);
  assert.ok(!fs.existsSync(pidPath));

  // 2d) Read-back failure / missing dev-ino fails closed even if matching serviceRunId later appears on disk
  assert.equal(captureTermuxPidfileIdentity(pidPath, { runId, pid: process.pid }), null);
  writeFakeTermuxPid(runId);
  assert.equal(captureTermuxPidfileIdentity(pidPath, { runId: 'c3'.repeat(16), pid: process.pid }), null);
  assert.equal(removeOwnTermuxPidfile({ pidPath, runId, pid: process.pid, dev: null, ino: null }), false);
  assert.ok(fs.existsSync(pidPath), 'fail-closed check must leave unverified pidfile untouched');
  fs.unlinkSync(pidPath);

  const cTermuxNoSnap = createServeShutdownCoordinator({ writeLine: () => {}, exitImpl: () => {} });
  serve({
    home,
    platform: 'termux',
    fleetEnabled: false,
    shutdownCoordinator: cTermuxNoSnap,
    claimServiceImpl: () => ({ runId, guard: guardRes }),
    serverStart: () => makeFakeServer({ quiescent: true }),
  });
  writeFakeTermuxPid(runId);
  const noSnapOut = await cTermuxNoSnap.shutdown({ reason: 'signal' });
  assert.equal(noSnapOut.quiescent, true);
  assert.equal(noSnapOut.pidfileRemoved, false);
  assert.ok(fs.existsSync(pidPath), 'pidfile appearing after failed identity read-back must not be removed');
});

test('bounded warning line sanitization, single warning emission, and logger failure tolerance', async () => {
  const line = formatIncompleteShutdownLine({
    status: 'completed_with_residues',
    reason: 'signal',
    elapsedMs: 1502,
    counts: {
      skipped: 1,
      residues: 2,
      activeOpsRemaining: 3,
      activeClaimConsumers: 4,
    },
  });
  assert.equal(
    line,
    'nexuscrew: ordered shutdown incomplete (status=completed_with_residues, reason=signal, skipped=1, residues=2, activeOps=3, activeClaims=4, elapsedMs=1502)',
  );
  assert.ok(!line.includes(os.homedir()));
  assert.ok(!line.includes(os.tmpdir()));
  assert.ok(!line.includes(String(process.pid)));

  // Logger throw must never break outcome or block exitImpl
  const exits = [];
  const c = createServeShutdownCoordinator({
    proc: { exitCode: 0 },
    writeLine: () => { throw new Error('EPIPE stderr broken'); },
    exitImpl: (code) => exits.push(code),
  });
  c.registerServer(makeFakeServer({ quiescent: false, counts: { residues: 1 } }));
  const out = await c.shutdown({ reason: 'signal', exitOnFinish: true });
  assert.equal(out.quiescent, false);
  assert.equal(out.exitCode, 0);
  assert.deepEqual(exits, [0]);
});

test('startup failure keeps and publishes the bounded cause: guard code and rejected ancestor detail', async () => {
  const warnings = [];
  const exits = [];
  const c = createServeShutdownCoordinator({
    proc: { exitCode: 0 },
    writeLine: (line) => warnings.push(line),
    exitImpl: (code) => exits.push(code),
  });
  const ancestor = '/data/data/com.termux/files';
  const err = new Error(`GUARD_UNSAFE: service guard not acquired (${ancestor}/home/.nexuscrew/nexuscrew.pid; unsafe ancestor ${ancestor} mode 771)`);
  err.code = 'GUARD_UNSAFE';
  c.registerStartupFailure(err);
  // A later registration is a cascade of the disarm, never a replacement of the cause.
  c.registerStartupFailure(new Error('serve disarmed during startup'));
  const out = await c.shutdown({ reason: 'startup-error', exitOnFinish: true });
  assert.equal(out.status, 'startup_failed');
  assert.equal(out.startupErrorCode, 'GUARD_UNSAFE');
  assert.ok(out.startupErrorDetail.includes(`unsafe ancestor ${ancestor} mode 771`), out.startupErrorDetail);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('status=startup_failed'), warnings[0]);
  assert.ok(warnings[0].includes('startupError=GUARD_UNSAFE (GUARD_UNSAFE: service guard not acquired'), warnings[0]);
  assert.ok(warnings[0].includes(`unsafe ancestor ${ancestor} mode 771`), warnings[0]);

  // Bounds and normalization: a huge multi-line message survives as a single
  // 200-char fragment, an oversized code is cut at 64, and a code-less error
  // leaves the fields out of the outcome and of the line.
  const long = [];
  for (let i = 0; i < 30; i += 1) long.push(`fragment-${i}`);
  const loud = new Error(long.join('\n'));
  loud.code = 'X'.repeat(100);
  const warningsB = [];
  const cB = createServeShutdownCoordinator({
    proc: { exitCode: 0 },
    writeLine: (line) => warningsB.push(line),
    exitImpl: () => {},
  });
  cB.registerStartupFailure(loud);
  const outB = await cB.shutdown({ reason: 'startup-error' });
  assert.equal(outB.startupErrorCode.length, 64);
  assert.ok(outB.startupErrorDetail.length <= 200);
  assert.ok(!outB.startupErrorDetail.includes('\n'));
  assert.ok(warningsB[0].includes(`startupError=${'X'.repeat(64)}`), warningsB[0]);

  const warningsC = [];
  const cC = createServeShutdownCoordinator({
    proc: { exitCode: 0 },
    writeLine: (line) => warningsC.push(line),
    exitImpl: () => {},
  });
  cC.registerStartupFailure(new Error('no code at all'));
  const outC = await cC.shutdown({ reason: 'startup-error' });
  assert.equal('startupErrorCode' in outC, false);
  assert.ok(!warningsC[0].includes('startupError='), warningsC[0]);
});

test('startup failure cause rides the incomplete line even with server residues', async () => {
  // Field reports showed startup_failed printed as "ordered shutdown
  // incomplete (residues=1)" with the original exception nowhere in the log.
  // The bounded cause registered by registerStartupFailure must appear on
  // that same line even when the server still reports leftover residues.
  const warnings = [];
  const exits = [];
  const c = createServeShutdownCoordinator({
    proc: { exitCode: 0 },
    writeLine: (line) => warnings.push(line),
    exitImpl: (code) => exits.push(code),
  });
  c.registerServer(makeFakeServer({ quiescent: false, counts: { residues: 1 } }));
  const err = new Error('GUARD_UNSAFE: service guard not acquired (/home/u/.nexuscrew/nexuscrew.pid; unsafe ancestor /data/data/com.termux/files mode 771)');
  err.code = 'GUARD_UNSAFE';
  err.exitCode = 1;
  c.registerStartupFailure(err);
  const out = await c.shutdown({ reason: 'startup-error', exitOnFinish: true });
  assert.equal(out.status, 'startup_failed');
  // 1 server-reported residue + 1 implicit residue of the failed startup.
  assert.equal(out.counts.residues, 2);
  assert.equal(out.startupErrorCode, 'GUARD_UNSAFE');
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('status=startup_failed'), warnings[0]);
  assert.ok(warnings[0].includes('residues=2'), warnings[0]);
  assert.ok(warnings[0].includes('startupError=GUARD_UNSAFE ('), warnings[0]);
  assert.ok(warnings[0].includes('mode 771'), warnings[0]);
});

test('Real child process CLI bin/nexuscrew.js serve: SIGINT/SIGTERM without and with --pidfile, startup conflict', async (t) => {
  // 1) Without --pidfile on SIGINT -> exit 0
  const h1 = makeTempDir(t, 'nc-serve-cli-sigint-');
  const cfg1 = writeIsolatedConfig(h1);
  const pid1 = path.join(h1, 'unused.pid');
  const c1 = spawnServeChild(t, {
    args: ['serve'],
    env: {
      HOME: h1,
      NEXUSCREW_CONFIG_FILE: cfg1,
      NEXUSCREW_PORT: '0',
      NEXUSCREW_PANEL_PORT: '0',
      NEXUSCREW_FLEET: '0',
      NEXUSCREW_PROTECT_SHARED_TMUX_SERVER: '0',
      NEXUSCREW_LIVE_BRIDGE: '0',
      NEXUSCREW_AUTO_UPDATE: '0',
      NEXUSCREW_PIDFILE: pid1,
    },
  });
  await c1.waitListening();
  assert.equal(fs.existsSync(pid1), false);
  c1.proc.kill('SIGINT');
  const res1 = await c1.waitExit();
  assert.equal(res1.code, 0);
  assert.equal(res1.signal, null);
  assert.equal(fs.existsSync(pid1), false);

  // 2) With --pidfile on SIGTERM -> pidfile exists while running, removed on clean quiescent exit
  const h2 = makeTempDir(t, 'nc-serve-cli-pid-');
  const cfg2 = writeIsolatedConfig(h2);
  const pid2 = path.join(h2, 'serve.pid');
  const c2 = spawnServeChild(t, {
    args: ['serve', '--pidfile'],
    env: {
      HOME: h2,
      NEXUSCREW_CONFIG_FILE: cfg2,
      NEXUSCREW_PORT: '0',
      NEXUSCREW_PANEL_PORT: '0',
      NEXUSCREW_FLEET: '0',
      NEXUSCREW_PROTECT_SHARED_TMUX_SERVER: '0',
      NEXUSCREW_LIVE_BRIDGE: '0',
      NEXUSCREW_AUTO_UPDATE: '0',
      NEXUSCREW_PIDFILE: pid2,
    },
  });
  await c2.waitListening();
  assert.ok(fs.existsSync(pid2), 'serve --pidfile must create pidfile on disk while running');
  const meta2 = JSON.parse(fs.readFileSync(pid2, 'utf8'));
  assert.equal(meta2.pid, c2.proc.pid);
  assert.match(String(meta2.generationId || ''), /^[0-9a-f]{32}$/);
  c2.proc.kill('SIGTERM');
  const res2 = await c2.waitExit();
  assert.equal(res2.code, 0);
  assert.equal(res2.signal, null);
  assert.ok(!fs.existsSync(pid2), 'quiescent child signal exit must remove own pidfile');

  // 3) Startup failure with already-running alive pidfile -> exit 1 and foreign pidfile untouched
  const h3 = makeTempDir(t, 'nc-serve-cli-conflict-');
  const cfg3 = writeIsolatedConfig(h3);
  const pid3 = path.join(h3, 'conflict.pid');
  const { writePidfile } = require('../lib/cli/pidfile.js');
  writePidfile(pid3, process.pid, 'existing-owner', { generationId: 'f'.repeat(32) });
  const c3 = spawnServeChild(t, {
    args: ['serve', '--pidfile'],
    env: {
      HOME: h3,
      NEXUSCREW_CONFIG_FILE: cfg3,
      NEXUSCREW_PORT: '0',
      NEXUSCREW_PANEL_PORT: '0',
      NEXUSCREW_FLEET: '0',
      NEXUSCREW_PROTECT_SHARED_TMUX_SERVER: '0',
      NEXUSCREW_LIVE_BRIDGE: '0',
      NEXUSCREW_AUTO_UPDATE: '0',
      NEXUSCREW_PIDFILE: pid3,
    },
  });
  const res3 = await c3.waitExit();
  assert.equal(res3.code, 1);
  assert.ok(fs.existsSync(pid3), 'conflict startup failure must conserve existing pidfile');
});

test('Real child dispatch(serve --pidfile) with non-quiescent drain on SIGTERM: bounded exit 0, pidfile conserved, single sanitized warning', async (t) => {
  const h = makeTempDir(t, 'nc-serve-child-incomplete-');
  const pidPath = path.join(h, 'incomplete.pid');
  const scriptPath = path.join(h, 'harness.js');
  const commandsPath = path.join(REPO_ROOT, 'lib', 'cli', 'commands.js');

  fs.writeFileSync(scriptPath, `'use strict';
const { dispatch } = require(${JSON.stringify(commandsPath)});
const r = dispatch(['serve', '--pidfile'], {
  home: ${JSON.stringify(h)},
  fleetEnabled: false,
  shutdownBudgetMs: 250,
  log: () => {},
  serverStart: () => ({
    shutdownController: {
      disarm() {},
      async closeOrdered() {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return {
          ok: false,
          quiescent: false,
          timedOut: true,
          elapsedMs: 60,
          counts: { activeOps: 1, activeClaims: 2, forcedConnections: 0, residues: 2 },
          codes: ['CLAIM_DRAIN_TIMEOUT', 'SENSITIVE_PATH /tmp/secret'],
          fleet: { status: 'draining', skipped: true },
        };
      },
    },
  }),
});
if (!r || !r.keepAlive) process.exit(9);
const keepAliveTimer = setInterval(() => {}, 10000);
process.stdout.write('HARNESS_READY\\n');
// Keep event loop alive until SIGTERM adapter triggers process.exit(0)
void keepAliveTimer;
`);

  const child = spawn(process.execPath, [scriptPath], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: h,
      NEXUSCREW_PIDFILE: pidPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d.toString('utf8'); });
  child.stderr.on('data', (d) => { err += d.toString('utf8'); });

  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch (_) {}
      await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 1000))]);
    }
  });

  await new Promise((resolve, reject) => {
    if (out.includes('HARNESS_READY')) { resolve(); return; }
    const timer = setTimeout(() => reject(new Error(`harness not ready: ${err}`)), 5000);
    child.stdout.on('data', () => {
      if (out.includes('HARNESS_READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`harness exited early (${code}): ${err}`));
    });
  });

  const t0 = performance.now();
  child.kill('SIGTERM');
  let exitTimer = null;
  const res = await Promise.race([
    exitPromise,
    new Promise((_, reject) => {
      exitTimer = setTimeout(() => reject(new Error('child did not exit within budget')), 3000);
    }),
  ]).finally(() => {
    if (exitTimer) { clearTimeout(exitTimer); exitTimer = null; }
  });
  const elapsedMs = performance.now() - t0;

  assert.equal(res.code, 0, `signal shutdown with residues exits 0; stderr=${err}`);
  assert.equal(res.signal, null);
  assert.ok(elapsedMs < 1500, `expected bounded shutdown, got ${elapsedMs}ms`);
  assert.ok(fs.existsSync(pidPath), 'non-quiescent shutdown must preserve pidfile on disk');

  const lines = err.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(
    lines[0],
    /^nexuscrew: ordered shutdown incomplete \(status=completed_with_residues, reason=signal, skipped=1, residues=2, activeOps=1, activeClaims=2, elapsedMs=\d+\)$/,
  );
  assert.ok(!err.includes(h));
  assert.ok(!err.includes('secret'));
  assert.ok(!err.includes(String(child.pid)));
});

test('CLI shutdown coordinator bounds closeOrdered wait to shared deadlineMono and ignores late completion', async (t) => {
  // 1. Pending/never-returning closeOrdered times out at original deadlineMono, preserves pidfile, exits once with single warning
  {
    const home = makeTempDir(t, 'nc-cli-bound-');
    const pidPath = path.join(home, 'nc.pid');
    fs.writeFileSync(pidPath, JSON.stringify({ pid: process.pid, generationId: 'b'.repeat(32) }));
    const exits = [];
    const warnings = [];
    let resolvedLate = null;
    const seenDeadlines = [];
    const coord = createServeShutdownCoordinator({
      budgetMs: 60,
      nowMono: () => performance.now(),
      exitImpl: (code) => exits.push(code),
      writeLine: (l) => warnings.push(l),
    });
    coord.registerPidCleanup(() => {
      try { fs.unlinkSync(pidPath); } catch (_) {}
      return true;
    });
    coord.registerServer({
      disarm: () => {},
      closeOrdered: ({ deadlineMono }) => {
        seenDeadlines.push(deadlineMono);
        return new Promise((resolve) => {
          resolvedLate = resolve;
        });
      },
    });

    const out = await coord.shutdown({ reason: 'signal', exitOnFinish: true });
    assert.equal(seenDeadlines.length, 1);
    assert.equal(out.deadlineMono, undefined);
    assert.equal(out.timedOut, true);
    assert.equal(out.quiescent, false);
    assert.equal(out.status, 'completed_with_residues');
    assert.ok(out.codes.includes('SERVER_CLOSE_TIMEOUT'));
    assert.equal(out.pidfileRemoved, false);
    assert.ok(fs.existsSync(pidPath), 'pidfile must be conserved on coordinator closeOrdered timeout');
    assert.deepEqual(exits, [0]);
    assert.equal(warnings.length, 1);

    // Late resolution returning quiescent=true must never rewrite finalized outcome or remove pidfile
    resolvedLate({
      ok: true,
      quiescent: true,
      timedOut: false,
      counts: { activeOps: 0, activeClaims: 0, forcedConnections: 0, residues: 0 },
      codes: [],
    });
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(coord.getState().outcome.quiescent, false);
    assert.equal(coord.getState().outcome.pidfileRemoved, false);
    assert.ok(fs.existsSync(pidPath), 'late closeOrdered resolution must not delete conserved pidfile');
    assert.deepEqual(exits, [0]);
    assert.equal(warnings.length, 1);
  }

  // 2. Positive completion strictly within shared deadlineMono succeeds and removes pidfile
  {
    const home = makeTempDir(t, 'nc-cli-bound-ok-');
    const pidPath = path.join(home, 'nc.pid');
    fs.writeFileSync(pidPath, JSON.stringify({ pid: process.pid }));
    const exits = [];
    const warnings = [];
    const coord = createServeShutdownCoordinator({
      budgetMs: 400,
      nowMono: () => performance.now(),
      exitImpl: (code) => exits.push(code),
      writeLine: (l) => warnings.push(l),
    });
    coord.registerPidCleanup(() => {
      fs.unlinkSync(pidPath);
      return true;
    });
    coord.registerServer(makeFakeServer({ quiescent: true, delayMs: 15 }));

    const out = await coord.shutdown({ reason: 'signal', exitOnFinish: true });
    assert.equal(out.timedOut, false);
    assert.equal(out.quiescent, true);
    assert.equal(out.status, 'completed');
    assert.equal(out.pidfileRemoved, true);
    assert.ok(!fs.existsSync(pidPath));
    assert.deepEqual(exits, [0]);
    assert.equal(warnings.length, 0);
  }
});

test('CLI real subprocess exits within 2000ms cap even when closeOrdered never settles, conserving pidfile', async (t) => {
  const h = makeTempDir(t, 'nc-cli-hung-close-');
  const pidPath = path.join(h, 'service.pid');
  const scriptPath = path.join(h, 'hung-close-harness.js');

  fs.writeFileSync(scriptPath, `
const { dispatch } = require(${JSON.stringify(path.join(REPO_ROOT, 'lib/cli/commands.js'))});
const r = dispatch(['serve', '--pidfile'], {
  fleetEnabled: false,
  shutdownBudgetMs: 250,
  serverStart: () => ({
    disarm() {},
    closeOrdered() {
      return new Promise(() => {});
    },
  }),
});
if (!r || !r.keepAlive) process.exit(9);
const keepAliveTimer = setInterval(() => {}, 10000);
process.stdout.write('HUNG_CLOSE_READY\\n');
void keepAliveTimer;
`);

  const child = spawn(process.execPath, [scriptPath], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      HOME: h,
      NEXUSCREW_PIDFILE: pidPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d.toString('utf8'); });
  child.stderr.on('data', (d) => { err += d.toString('utf8'); });

  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill('SIGKILL'); } catch (_) {}
      await Promise.race([exitPromise, new Promise((r) => setTimeout(r, 1000))]);
    }
  });

  await new Promise((resolve, reject) => {
    if (out.includes('HUNG_CLOSE_READY')) { resolve(); return; }
    const timer = setTimeout(() => reject(new Error(`harness not ready: ${err}`)), 5000);
    child.stdout.on('data', () => {
      if (out.includes('HUNG_CLOSE_READY')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`harness exited early (${code}): ${err}`));
    });
  });

  const t0 = performance.now();
  child.kill('SIGTERM');
  let exitTimer = null;
  const res = await Promise.race([
    exitPromise,
    new Promise((_, reject) => {
      exitTimer = setTimeout(() => reject(new Error('child did not exit within 2000ms cap')), 2000);
    }),
  ]).finally(() => {
    if (exitTimer) { clearTimeout(exitTimer); exitTimer = null; }
  });
  const elapsedMs = performance.now() - t0;

  assert.equal(res.code, 0, `hung closeOrdered must exit 0 cleanly; stderr=${err}`);
  assert.equal(res.signal, null);
  assert.ok(elapsedMs < 2000, `expected exit < 2000ms outer cap, got ${elapsedMs}ms`);
  assert.ok(fs.existsSync(pidPath), 'pidfile must stay conserved when closeOrdered times out');
  const lines = err.trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^nexuscrew: ordered shutdown incomplete /);
});

test('CLI async serverStart rejection without signal triggers bounded failure shutdown, preserves exitCode/pidfile, and leaves programmatic serve untouched', async (t) => {
  // 1) In-process CLI dispatch(['serve', '--pidfile']) with custom err.exitCode = 3 and no signal
  const h1 = makeTempDir(t, 'nc-serve-shutdown-async-');
  const pid1 = path.join(h1, 'async-fail.pid');
  const prevPid = process.env.NEXUSCREW_PIDFILE;
  process.env.NEXUSCREW_PIDFILE = pid1;
  t.after(() => {
    if (prevPid === undefined) delete process.env.NEXUSCREW_PIDFILE;
    else process.env.NEXUSCREW_PIDFILE = prevPid;
  });

  const fakeProc = new EventEmitter();
  const exits1 = [];
  const warns1 = [];
  let doneExitResolve;
  const doneExit = new Promise((resolve) => { doneExitResolve = resolve; });

  const res = dispatch(['serve', '--pidfile'], {
    home: h1,
    platform: 'linux',
    fleetEnabled: false,
    proc: fakeProc,
    writeShutdownLine: (line) => warns1.push(line),
    exitImpl: (code) => {
      exits1.push(code);
      doneExitResolve(code);
    },
    serverStart: () => new Promise((_, reject) => {
      setTimeout(() => {
        const err = new Error('listen EADDRINUSE');
        err.exitCode = 3;
        reject(err);
      }, 15);
    }),
  });
  assert.equal(res.keepAlive, true);
  t.after(() => res.disposeSignals());
  assert.ok(fs.existsSync(pid1), 'pidfile must exist while async serverStart is pending');

  let exitWaitTimer = null;
  const exitedCode = await Promise.race([
    doneExit,
    new Promise((resolve) => {
      exitWaitTimer = setTimeout(() => resolve('NO_EXIT'), 250);
    }),
  ]).finally(() => {
    if (exitWaitTimer) { clearTimeout(exitWaitTimer); exitWaitTimer = null; }
  });
  assert.equal(exitedCode, 3);
  assert.deepEqual(exits1, [3]);
  assert.equal(warns1.length, 1);
  assert.match(warns1[0], /^nexuscrew: ordered shutdown incomplete \(status=startup_failed, reason=startup-error, /);
  assert.ok(fs.existsSync(pid1), 'pidfile must stay conserved when async serverStart rejects');
  assert.equal(res.controller.getState().completed, true);
  assert.equal(res.controller.getState().outcome.exitCode, 3);
  await new Promise((r) => setImmediate(r));
  assert.equal(fakeProc.listenerCount('SIGTERM'), 0);

  // 2) Programmatic serve() without CLI signal adapter does NOT auto-shutdown or call exitImpl on async rejection
  const h2 = makeTempDir(t, 'nc-serve-shutdown-prog-');
  const pid2 = path.join(h2, 'prog-fail.pid');
  process.env.NEXUSCREW_PIDFILE = pid2;
  const progExits = [];
  const progWarns = [];
  const asyncErr = new Error('programmatic bind failed');
  const prog = serve({
    home: h2,
    pidfile: true,
    platform: 'linux',
    fleetEnabled: false,
    writeShutdownLine: (line) => progWarns.push(line),
    exitImpl: (code) => progExits.push(code),
    serverStart: () => Promise.reject(asyncErr),
  });
  await assert.rejects(prog.server, /programmatic bind failed/);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(progExits, []);
  assert.deepEqual(progWarns, []);
  assert.equal(prog.getState().completed, false);
  assert.equal(prog.getState().state, 'startup_failed');
  assert.ok(fs.existsSync(pid2));

  // 3) Real child subprocess without OS signal exits >= 1, emits single incomplete line, conserves pidfile
  const h3 = makeTempDir(t, 'nc-serve-shutdown-child-');
  const pid3 = path.join(h3, 'child-fail.pid');
  const failScript = path.join(h3, 'async-reject-cli.js');
  const commandsPath = path.join(REPO_ROOT, 'lib', 'cli', 'commands.js');
  fs.writeFileSync(failScript, `'use strict';
const { dispatch } = require(${JSON.stringify(commandsPath)});
const r = dispatch(['serve', '--pidfile'], {
  home: ${JSON.stringify(h3)},
  fleetEnabled: false,
  shutdownBudgetMs: 300,
  log: () => {},
  serverStart: () => new Promise((_, reject) => {
    setTimeout(() => reject(new Error('bind EADDRINUSE')), 25);
  }),
});
if (!r || !r.keepAlive) process.exit(9);
setInterval(() => {}, 10000);
`);

  const child = spawn(process.execPath, [failScript], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: h3, NEXUSCREW_PIDFILE: pid3 },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childErr = '';
  child.stderr.on('data', (d) => { childErr += d.toString('utf8'); });
  const childExit = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      resolve({ code: -1, signal: 'TIMEOUT' });
    }, 3000);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.equal(childExit.code, 1, `async serverStart reject without signal must exit >= 1; stderr=${childErr}`);
  assert.equal(childExit.signal, null);
  assert.ok(fs.existsSync(pid3), 'child async startup failure must conserve pidfile');
  const errLines = childErr.trim().split('\n').filter(Boolean);
  assert.equal(errLines.length, 1);
  assert.match(errLines[0], /^nexuscrew: ordered shutdown incomplete \(status=startup_failed, reason=startup-error, /);

  // 4) Positive case: a really async serverStart resolving the REAL server
  // handle stays alive until SIGTERM and removes the pidfile on a clean,
  // attested owned shutdown. The dispatch keeps minting the process owner
  // (no injected coordinator): the binding, the hook invocation and the
  // cleanup validation all travel the production code. A double with
  // hand-added shutdownController/cleanup fields would prove nothing here.
  const h4 = makeTempDir(t, 'nc-serve-shutdown-child-ok-');
  const pid4 = path.join(h4, 'child-ok.pid');
  const okScript = path.join(h4, 'async-ok-cli.js');
  const serverPath = path.join(REPO_ROOT, 'lib', 'server.js');
  const hookPath = path.join(REPO_ROOT, 'lib', 'cli', 'vl-node-cleanup-hook.js');
  fs.writeFileSync(okScript, `'use strict';
const { dispatch } = require(${JSON.stringify(commandsPath)});
const { start } = require(${JSON.stringify(serverPath)});
const hookMod = require(${JSON.stringify(hookPath)});
let handleRef = null;
let exits = 0;
const r = dispatch(['serve', '--pidfile'], {
  home: ${JSON.stringify(h4)},
  port: 0,
  panelPort: 0,
  fleetEnabled: false,
  protectSharedTmuxServer: false,
  liveBridgeEnabled: false,
  autoUpdate: false,
  log: () => {},
  serverStart: (serveOpts) => new Promise((resolve) => {
    // Really async resolution of the production handle: the received
    // options — the shared nowMono included — are forwarded verbatim to
    // lib/server.js start, and its handle is what resolves.
    setTimeout(() => {
      const handle = start(serveOpts);
      handleRef = handle;
      resolve(handle);
    }, 20);
  }),
  exitImpl: (code) => {
    exits += 1;
    const coord = r && r.controller ? r.controller.getState() : null;
    const so = handleRef && handleRef.shutdownController
      ? handleRef.shutdownController.state().outcome : null;
    process.stdout.write('WIRE4|' + JSON.stringify({
      cleanup: so && so.cleanup ? { outcome: so.cleanup.outcome, reason: so.cleanup.reason } : null,
      serverOk: so ? so.ok : null,
      coordQuiescent: coord ? coord.quiescent : null,
      coordResidues: coord && coord.outcome ? coord.outcome.counts.residues : null,
      completed: coord ? coord.completed : null,
      exits,
    }) + '\\n');
    process.exit(code);
  },
});
if (!r || !r.keepAlive) process.exit(9);
(async () => {
  // Readiness ATTESTS the resolution and registration of the handle: the
  // owned binding for its shutdownController exists only after the
  // coordinator registered the resolved handle. A time delay alone would
  // prove nothing.
  const handle = await r.server;
  const binding = handle && handle.shutdownController
    ? hookMod.readOwnedHook(handle.shutdownController) : null;
  if (!binding) { process.stdout.write('NO_BINDING\\n'); process.exit(8); }
  await new Promise((res) => { if (handle.listening) res(); else handle.once('listening', res); });
  process.stdout.write('ASYNC_OK_READY\\n');
})().catch((e) => { console.error(String((e && e.message) || e)); process.exit(7); });
setInterval(() => {}, 10000);
`);

  const okChild = spawn(process.execPath, [okScript], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: h4, NEXUSCREW_PIDFILE: pid4 },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let okOut = '';
  let okErr = '';
  okChild.stdout.on('data', (d) => { okOut += d.toString('utf8'); });
  okChild.stderr.on('data', (d) => { okErr += d.toString('utf8'); });
  t.after(() => {
    if (okChild.exitCode === null && okChild.signalCode === null) {
      try { okChild.kill('SIGKILL'); } catch (_) {}
    }
  });
  await new Promise((resolve, reject) => {
    if (okOut.includes('ASYNC_OK_READY')) { resolve(); return; }
    const timer = setTimeout(() => reject(new Error(`okChild timeout: ${okErr}`)), 3000);
    okChild.stdout.on('data', () => {
      if (okOut.includes('ASYNC_OK_READY')) { clearTimeout(timer); resolve(); }
    });
    okChild.once('exit', (code) => { clearTimeout(timer); reject(new Error(`okChild early exit ${code}: ${okErr}`)); });
  });
  okChild.kill('SIGTERM');
  const okExit = await new Promise((resolve) => {
    okChild.once('exit', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(okExit.code, 0, `stderr=${okErr}`);
  assert.equal(okExit.signal, null);
  assert.ok(!fs.existsSync(pid4), 'resolved async serverStart must remove pidfile on clean SIGTERM');
  assert.equal(okErr.trim(), '');
  // Before the exit the child observed the validated cleanup done in the
  // server outcome and a quiescent coordinator outcome with zero residues,
  // finalized exactly once.
  const wireLine = okOut.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('WIRE4|')).pop();
  assert.ok(wireLine, `missing observation line: stdout=${okOut} stderr=${okErr}`);
  const observed = JSON.parse(wireLine.slice('WIRE4|'.length));
  assert.equal(observed.cleanup && observed.cleanup.outcome, 'done', `the real server outcome must attest the validated cleanup: ${wireLine}`);
  assert.equal(observed.cleanup.reason, null);
  assert.equal(observed.serverOk, true);
  assert.equal(observed.coordQuiescent, true);
  assert.equal(observed.coordResidues, 0);
  assert.equal(observed.completed, true);
  assert.equal(observed.exits, 1, 'exactly one finalization through the exit path');
});

test('CLI owned shutdown over a closeOrdered-only handle keeps its own conservative judgement and conserves the pidfile', async (t) => {
  // Distinct negative, in its own isolated process: the same real dispatch
  // mints the process owner, the async serverStart resolves the legacy
  // closeOrdered-only handle with NO shutdownController. The server is
  // allowed to drain and return its old green result; the COORDINATOR must
  // keep a conservative judgement of its own: not quiescent, CLEANUP_REFUSED,
  // at least one residue, pidfile of the same identity and content conserved,
  // no cleanup round, one finalization and one single warning line, exit
  // policy unchanged.
  const h5 = makeTempDir(t, 'nc-serve-shutdown-legacy-');
  const pid5 = path.join(h5, 'legacy-ops.pid');
  const negScript = path.join(h5, 'legacy-handle-cli.js');
  const commandsPath = path.join(REPO_ROOT, 'lib', 'cli', 'commands.js');
  const vRuntimePath = path.join(REPO_ROOT, 'lib', 'fleet', 'vl-node-runtime.js');
  fs.writeFileSync(negScript, `'use strict';
const { dispatch } = require(${JSON.stringify(commandsPath)});
const v = require(${JSON.stringify(vRuntimePath)});
let exits = 0;
const r = dispatch(['serve', '--pidfile'], {
  home: ${JSON.stringify(h5)},
  fleetEnabled: false,
  log: () => {},
  serverStart: () => new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        disarm() {},
        async closeOrdered() {
          return {
            ok: true,
            quiescent: true,
            timedOut: false,
            counts: { activeOps: 0, activeClaims: 0, forcedConnections: 0, residues: 0 },
            codes: [],
          };
        },
      });
    }, 20);
  }),
  exitImpl: (code) => {
    exits += 1;
    const coord = r && r.controller ? r.controller.getState() : null;
    // Capture the registry BEFORE the qualification probe: the probe itself
    // creates entries when V is still armed.
    const reg = v.getCreationRegistry();
    const ancoraArmed = v.qualifica({ execPath: process.execPath });
    process.stdout.write('NEG5|' + JSON.stringify({
      coordQuiescent: coord ? coord.quiescent : null,
      coordCodes: coord && coord.outcome ? coord.outcome.codes : null,
      coordResidues: coord && coord.outcome ? coord.outcome.counts.residues : null,
      pidfileRemoved: coord ? coord.pidfileRemoved : null,
      exits,
      armed: ancoraArmed.ok,
      regEntries: reg.entries.length,
      regNonce: reg.nonce,
    }) + '\\n');
    process.exit(code);
  },
});
if (!r || !r.keepAlive) process.exit(9);
r.server.then((handle) => {
  if (!handle || typeof handle.closeOrdered !== 'function') process.exit(8);
  process.stdout.write('NEG5_READY\\n');
}).catch(() => process.exit(7));
setInterval(() => {}, 10000);
`);

  const negChild = spawn(process.execPath, [negScript], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: h5, NEXUSCREW_PIDFILE: pid5 },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let negOut = '';
  let negErr = '';
  negChild.stdout.on('data', (d) => { negOut += d.toString('utf8'); });
  negChild.stderr.on('data', (d) => { negErr += d.toString('utf8'); });
  t.after(() => {
    if (negChild.exitCode === null && negChild.signalCode === null) {
      try { negChild.kill('SIGKILL'); } catch (_) {}
    }
  });
  await new Promise((resolve, reject) => {
    if (negOut.includes('NEG5_READY')) { resolve(); return; }
    const timer = setTimeout(() => reject(new Error(`negChild timeout: ${negErr}`)), 3000);
    negChild.stdout.on('data', () => {
      if (negOut.includes('NEG5_READY')) { clearTimeout(timer); resolve(); }
    });
    negChild.once('exit', (code) => { clearTimeout(timer); reject(new Error(`negChild early exit ${code}: ${negErr}`)); });
  });
  const before = fs.statSync(pid5);
  const beforeContent = fs.readFileSync(pid5, 'utf8');
  negChild.kill('SIGTERM');
  const negExit = await new Promise((resolve) => {
    negChild.once('exit', (code, signal) => resolve({ code, signal }));
  });
  assert.equal(negExit.code, 0, `a refused cleanup keeps the existing exit policy: stderr=${negErr}`);
  assert.equal(negExit.signal, null);
  const after = fs.statSync(pid5);
  assert.equal(after.dev, before.dev, 'pidfile must keep its filesystem identity');
  assert.equal(after.ino, before.ino, 'pidfile must keep its filesystem identity (generation)');
  assert.equal(fs.readFileSync(pid5, 'utf8'), beforeContent, 'pidfile content must be unchanged');
  const errLines = negErr.trim().split('\n').filter(Boolean);
  assert.equal(errLines.length, 1, `exactly one warning line, got: ${negErr}`);
  assert.match(errLines[0], /^nexuscrew: ordered shutdown incomplete /);
  const negLine = negOut.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('NEG5|')).pop();
  assert.ok(negLine, `missing observation line: stdout=${negOut}`);
  const neg = JSON.parse(negLine.slice('NEG5|'.length));
  assert.equal(neg.coordQuiescent, false, 'the coordinator judgement must not be quiescent');
  assert.ok(neg.coordCodes.includes('CLEANUP_REFUSED'), `codes must carry CLEANUP_REFUSED: ${negLine}`);
  assert.ok(neg.coordResidues >= 1, 'at least one logical residue');
  assert.equal(neg.pidfileRemoved, false);
  assert.equal(neg.exits, 1, 'exactly one finalization');
  assert.equal(neg.armed, true, 'no V disarm may happen: no cleanup round may start');
  assert.equal(neg.regEntries, 0, 'no cleanup round may start');
  assert.equal(neg.regNonce, null, 'no cleanup round may start');
});

test('synchronous CLI serve startup throw triggers bounded ordered shutdown and preserves err.exitCode in bin/nexuscrew.js', async (t) => {
  const prevPidEnv = process.env.NEXUSCREW_PIDFILE;
  t.after(() => {
    if (prevPidEnv === undefined) delete process.env.NEXUSCREW_PIDFILE;
    else process.env.NEXUSCREW_PIDFILE = prevPidEnv;
  });

  // 1) In-process dispatch(['serve', '--pidfile']) synchronous throw with custom err.exitCode = 4:
  //    starts ordered shutdown, keeps signal adapter alive until drain finishes, exits with 4, and conserves pidfile.
  const h1 = makeTempDir(t, 'nc-startup-inproc-');
  const pid1 = path.join(h1, 'sync-fail.pid');
  process.env.NEXUSCREW_PIDFILE = pid1;
  const fakeProc = new EventEmitter();
  const warns1 = [];
  const exits1 = [];
  let resolveExit = null;
  const doneExit = new Promise((resolve) => { resolveExit = resolve; });
  const coordinator = createServeShutdownCoordinator({
    budgetMs: 300,
    proc: fakeProc,
    writeLine: (line) => warns1.push(line),
    exitImpl: (code) => {
      exits1.push(code);
      if (resolveExit) resolveExit(code);
    },
  });
  const syncErr = new Error('sync startup boom');
  syncErr.exitCode = 4;

  assert.throws(() => {
    dispatch(['serve', '--pidfile'], {
      home: h1,
      fleetEnabled: false,
      proc: fakeProc,
      shutdownCoordinator: coordinator,
      log: () => {},
      serverStart: () => {
        throw syncErr;
      },
    });
  }, /sync startup boom/);

  // Signal arriving immediately after sync throw during drain must be handled by the active adapter, not unhandled
  assert.equal(fakeProc.listenerCount('SIGTERM'), 1, 'adapter must stay armed until shutdown drain completes');
  fakeProc.emit('SIGTERM');

  const exitedCode = await doneExit;
  assert.equal(exitedCode, 4);
  assert.deepEqual(exits1, [4]);
  await new Promise((r) => setImmediate(r));
  assert.equal(fakeProc.listenerCount('SIGTERM'), 0, 'adapter must dispose after shutdown finishes');
  assert.equal(coordinator.getState().completed, true);
  assert.equal(coordinator.getState().state, 'startup_failed');
  assert.equal(coordinator.getState().outcome.exitCode, 4);
  assert.equal(warns1.length, 1);
  assert.match(warns1[0], /^nexuscrew: ordered shutdown incomplete \(status=startup_failed, reason=startup-error, /);
  assert.ok(fs.existsSync(pid1), 'sync startup failure must conserve pidfile');

  // 2) Real bin/nexuscrew.js CLI subprocess with synchronous throw (exitCode=7) AND a ref'ed open handle:
  //    ordered shutdown exits deterministically with code 7 and emits bounded startup_failed diagnostic.
  const h2 = makeTempDir(t, 'nc-startup-bin-sync-');
  const pid2 = path.join(h2, 'bin-sync-fail.pid');
  const preload2 = path.join(h2, 'preload-sync-fail.js');
  const commandsPath = path.join(REPO_ROOT, 'lib', 'cli', 'commands.js');
  fs.writeFileSync(preload2, `'use strict';
const cmds = require(${JSON.stringify(commandsPath)});
const origDispatch = cmds.dispatch;
cmds.dispatch = (argv, opts = {}) => origDispatch(argv, {
  ...opts,
  home: ${JSON.stringify(h2)},
  fleetEnabled: false,
  shutdownBudgetMs: 300,
  log: () => {},
  serverStart: () => {
    setInterval(() => {}, 10000); // ref'ed handle left open by failed startup
    const err = new Error('sync bind EADDRINUSE');
    err.exitCode = 7;
    throw err;
  },
});
`);

  const child2 = spawn(process.execPath, ['-r', preload2, BIN_PATH, 'serve', '--pidfile'], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: h2, NEXUSCREW_PIDFILE: pid2 },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err2 = '';
  child2.stderr.on('data', (d) => { err2 += d.toString('utf8'); });
  const exit2 = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child2.kill('SIGKILL'); } catch (_) {}
      resolve({ code: -1, signal: 'TIMEOUT' });
    }, 3000);
    child2.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.equal(exit2.signal, null, `bin/nexuscrew.js must exit cleanly on sync throw; stderr=${err2}`);
  assert.equal(exit2.code, 7, `bin/nexuscrew.js must preserve err.exitCode=7; stderr=${err2}`);
  assert.match(err2, /status=startup_failed, reason=startup-error/);
  assert.ok(fs.existsSync(pid2), 'bin/nexuscrew.js sync throw must conserve pidfile');

  // 3) Direct bin/nexuscrew.js catch preserves err.exitCode even when a non-serve command rejects with exitCode
  const h3 = makeTempDir(t, 'nc-startup-bin-catch-');
  const preload3 = path.join(h3, 'preload-catch.js');
  fs.writeFileSync(preload3, `'use strict';
const cmds = require(${JSON.stringify(commandsPath)});
cmds.dispatch = () => {
  const err = new Error('custom command error');
  err.exitCode = 5;
  throw err;
};
`);
  const child3 = spawn(process.execPath, ['-r', preload3, BIN_PATH, 'status'], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: h3 },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let err3 = '';
  child3.stderr.on('data', (d) => { err3 += d.toString('utf8'); });
  const exit3 = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child3.kill('SIGKILL'); } catch (_) {}
      resolve({ code: -1, signal: 'TIMEOUT' });
    }, 3000);
    child3.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
  assert.equal(exit3.code, 5, `bin/nexuscrew.js catch must preserve err.exitCode=5; stderr=${err3}`);
  assert.match(err3, /nexuscrew: custom command error/);

  // 4) Programmatic serve() throwing synchronously still throws directly without auto-exit or signal adapters
  const h4 = makeTempDir(t, 'nc-startup-prog-sync-');
  const pid4 = path.join(h4, 'prog-sync-fail.pid');
  process.env.NEXUSCREW_PIDFILE = pid4;
  const progExits = [];
  const progWarns = [];
  assert.throws(() => {
    serve({
      home: h4,
      pidfile: true,
      platform: 'linux',
      fleetEnabled: false,
      writeShutdownLine: (line) => progWarns.push(line),
      exitImpl: (code) => progExits.push(code),
      serverStart: () => {
        const err = new Error('programmatic sync fail');
        err.exitCode = 9;
        throw err;
      },
    });
  }, /programmatic sync fail/);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(progExits, []);
  assert.deepEqual(progWarns, []);
  assert.ok(fs.existsSync(pid4));
});

test('shutdown coordinator accounts tri-state pidfile cleanup outcome across failed, skipped, not_requested, and removed', async (t) => {
  const prevPidEnv = process.env.NEXUSCREW_PIDFILE;
  t.after(() => {
    if (prevPidEnv === undefined) delete process.env.NEXUSCREW_PIDFILE;
    else process.env.NEXUSCREW_PIDFILE = prevPidEnv;
  });

  // 1) Cleanup returns false on real quiescent serve --pidfile (e.g. pidfile replaced by another inode/gen):
  //    status='completed_with_residues', pidfileStatus='failed', residues >= 1, PIDFILE_CLEANUP_FAILED, warning emitted.
  const h1 = makeTempDir(t, 'nc-pidclean-replaced-');
  const pid1 = path.join(h1, 'replaced.pid');
  process.env.NEXUSCREW_PIDFILE = pid1;
  const warns1 = [];
  const coord1 = createServeShutdownCoordinator({
    writeLine: (line) => warns1.push(line),
    exitImpl: () => {},
  });
  serve({
    home: h1,
    pidfile: true,
    platform: 'linux',
    fleetEnabled: false,
    shutdownCoordinator: coord1,
    serverStart: () => makeFakeServer({ quiescent: true }),
  });
  // Replace pidfile with another generation so own-generation cleanup refuses with false
  fs.writeFileSync(pid1, JSON.stringify({ pid: process.pid, cmd: 'nexuscrew serve --pidfile', generationId: 'foreign-gen' }), { mode: 0o600 });
  const out1 = await coord1.shutdown({ reason: 'signal' });
  assert.equal(out1.quiescent, true);
  assert.equal(out1.status, 'completed_with_residues');
  assert.equal(out1.pidfileRemoved, false);
  assert.equal(out1.pidfileStatus, 'failed');
  assert.ok(out1.counts.residues >= 1);
  assert.ok(out1.codes.includes('PIDFILE_CLEANUP_FAILED'));
  assert.equal(out1.warningEmitted, true);
  assert.equal(warns1.length, 1);
  assert.match(warns1[0], /^nexuscrew: ordered shutdown incomplete \(status=completed_with_residues, reason=signal, skipped=0, residues=1,/);
  assert.equal(coord1.getState().pidfileStatus, 'failed');
  assert.ok(fs.existsSync(pid1), 'foreign replacement pidfile must survive');

  // 2) Registered pidCleanup throws -> pidfileStatus='failed', completed_with_residues, warning emitted
  const warns2 = [];
  const coord2 = createServeShutdownCoordinator({
    writeLine: (line) => warns2.push(line),
    exitImpl: () => {},
  });
  coord2.registerServer(makeFakeServer({ quiescent: true }));
  coord2.registerPidCleanup(() => { throw new Error('EACCES unlink'); });
  const out2 = await coord2.shutdown({ reason: 'signal' });
  assert.equal(out2.quiescent, true);
  assert.equal(out2.status, 'completed_with_residues');
  assert.equal(out2.pidfileRemoved, false);
  assert.equal(out2.pidfileStatus, 'failed');
  assert.equal(out2.counts.residues, 1);
  assert.ok(out2.codes.includes('PIDFILE_CLEANUP_FAILED'));
  assert.equal(out2.warningEmitted, true);
  assert.equal(warns2.length, 1);

  // 3) Non-quiescent shutdown skips pidfile cleanup -> pidfileStatus='skipped', PIDFILE_CLEANUP_SKIPPED
  const warns3 = [];
  let cleanupCalled3 = false;
  const coord3 = createServeShutdownCoordinator({
    writeLine: (line) => warns3.push(line),
    exitImpl: () => {},
  });
  coord3.registerServer(makeFakeServer({ quiescent: false, forcedConnections: 1, codes: ['CONNECTIONS_FORCED'] }));
  coord3.registerPidCleanup(() => { cleanupCalled3 = true; return true; });
  const out3 = await coord3.shutdown({ reason: 'signal' });
  assert.equal(cleanupCalled3, false);
  assert.equal(out3.quiescent, false);
  assert.equal(out3.status, 'completed_with_residues');
  assert.equal(out3.pidfileRemoved, false);
  assert.equal(out3.pidfileStatus, 'skipped');
  assert.ok(out3.codes.includes('PIDFILE_CLEANUP_SKIPPED'));
  assert.equal(warns3.length, 1);

  // 4) No pidCleanup registered -> pidfileStatus='not_requested', clean 'completed', zero warnings/residues
  const warns4 = [];
  const coord4 = createServeShutdownCoordinator({
    writeLine: (line) => warns4.push(line),
    exitImpl: () => {},
  });
  coord4.registerServer(makeFakeServer({ quiescent: true }));
  const out4 = await coord4.shutdown({ reason: 'signal' });
  assert.equal(out4.quiescent, true);
  assert.equal(out4.status, 'completed');
  assert.equal(out4.pidfileRemoved, false);
  assert.equal(out4.pidfileStatus, 'not_requested');
  assert.equal(out4.counts.residues, 0);
  assert.equal(out4.warningEmitted, false);
  assert.equal(warns4.length, 0);
  assert.ok(!out4.codes.includes('PIDFILE_CLEANUP_FAILED'));
  assert.ok(!out4.codes.includes('PIDFILE_CLEANUP_SKIPPED'));

  // 5) Positive removed case -> pidfileStatus='removed', pidfileRemoved=true, status='completed', zero warnings
  const h5 = makeTempDir(t, 'nc-pidclean-ok-');
  const pid5 = path.join(h5, 'ok.pid');
  process.env.NEXUSCREW_PIDFILE = pid5;
  const warns5 = [];
  const coord5 = createServeShutdownCoordinator({
    writeLine: (line) => warns5.push(line),
    exitImpl: () => {},
  });
  serve({
    home: h5,
    pidfile: true,
    platform: 'linux',
    fleetEnabled: false,
    shutdownCoordinator: coord5,
    serverStart: () => makeFakeServer({ quiescent: true }),
  });
  const out5 = await coord5.shutdown({ reason: 'signal' });
  assert.equal(out5.status, 'completed');
  assert.equal(out5.pidfileRemoved, true);
  assert.equal(out5.pidfileStatus, 'removed');
  assert.equal(out5.counts.residues, 0);
  assert.equal(out5.warningEmitted, false);
  assert.equal(warns5.length, 0);
  assert.ok(!fs.existsSync(pid5));
});

test('direct server.close on real serve and dispatch handles converges on a single deadline with coordinator', async (t) => {
  const prevPidEnv = process.env.NEXUSCREW_PIDFILE;
  t.after(() => {
    if (prevPidEnv === undefined) delete process.env.NEXUSCREW_PIDFILE;
    else process.env.NEXUSCREW_PIDFILE = prevPidEnv;
  });

  // 1) dispatch(['serve', '--pidfile']) with real server.start: direct server.close() -> SIGTERM
  {
    const h1 = makeTempDir(t, 'nc-single-close-sig-');
    writeIsolatedConfig(h1);
    const pid1 = path.join(h1, 'srv1.pid');
    process.env.NEXUSCREW_PIDFILE = pid1;
    const fakeProc = new EventEmitter();
    const warns = [];
    const exits = [];
    let resolveExit = null;
    const exitedP = new Promise((resolve) => { resolveExit = resolve; });

    // This file runs several dispatch serves in one process, and the owned
    // cleanup admission fence is per process and permanent: an internally
    // created owner here would conservatively refuse after the earlier
    // dispatch shutdowns already sealed it. The deadline convergence under
    // test belongs to the coordinator, which stays fully exercised when
    // injected explicitly.
    const coord1 = createServeShutdownCoordinator({
      budgetMs: 1200,
      proc: fakeProc,
      writeLine: (line) => warns.push(line),
      exitImpl: (code) => {
        exits.push(code);
        resolveExit(code);
      },
    });
    const r = dispatch(['serve', '--pidfile'], {
      home: h1,
      port: 0,
      panelPort: 0,
      fleetEnabled: false,
      protectSharedTmuxServer: false,
      liveBridgeEnabled: false,
      autoUpdate: false,
      shutdownBudgetMs: 1200,
      proc: fakeProc,
      log: () => {},
      shutdownCoordinator: coord1,
    });
    t.after(() => {
      try { r.disposeSignals(); } catch (_) {}
      try { r.server.close(); } catch (_) {}
    });

    await new Promise((resolve) => {
      if (r.server.listening) resolve();
      else r.server.once('listening', resolve);
    });

    const serverClosedP = new Promise((resolve) => r.server.once('close', resolve));
    r.server.close();
    await serverClosedP;

    const serverDl = r.server.shutdownController.state().deadlineMono;
    const coordDl = r.controller.getState().deadlineMono;
    assert.ok(Number.isFinite(serverDl), 'server closeOrdered must record deadlineMono');
    assert.equal(coordDl, serverDl, 'coordinator must adopt exact deadlineMono of direct server.close');
    assert.equal(r.controller.getState().disarmed, true);
    assert.deepEqual(exits, [], 'direct server.close alone must not invoke exitImpl');

    fakeProc.emit('SIGTERM');
    const exitCode = await exitedP;
    assert.equal(exitCode, 0);
    assert.deepEqual(exits, [0]);
    assert.equal(r.controller.getState().deadlineMono, serverDl, 'late SIGTERM must preserve original deadlineMono');
    assert.equal(r.controller.getState().state, 'completed');
    assert.equal(r.controller.getState().outcome.reason, 'server-close');
    assert.equal(r.controller.getState().outcome.pidfileRemoved, true);
    assert.equal(r.controller.getState().outcome.pidfileStatus, 'removed');
    assert.equal(warns.length, 0);
    assert.ok(!fs.existsSync(pid1));
  }

  // 2) dispatch(['serve', '--pidfile']) with real server.start: SIGTERM -> direct server.close()
  {
    const h2 = makeTempDir(t, 'nc-single-sig-close-');
    writeIsolatedConfig(h2);
    const pid2 = path.join(h2, 'srv2.pid');
    process.env.NEXUSCREW_PIDFILE = pid2;
    const fakeProc = new EventEmitter();
    const warns = [];
    const exits = [];
    let resolveExit = null;
    const exitedP = new Promise((resolve) => { resolveExit = resolve; });

    const coord2 = createServeShutdownCoordinator({
      budgetMs: 1200,
      proc: fakeProc,
      writeLine: (line) => warns.push(line),
      exitImpl: (code) => {
        exits.push(code);
        resolveExit(code);
      },
    });
    const r = dispatch(['serve', '--pidfile'], {
      home: h2,
      port: 0,
      panelPort: 0,
      fleetEnabled: false,
      protectSharedTmuxServer: false,
      liveBridgeEnabled: false,
      autoUpdate: false,
      shutdownBudgetMs: 1200,
      proc: fakeProc,
      log: () => {},
      shutdownCoordinator: coord2,
    });
    t.after(() => {
      try { r.disposeSignals(); } catch (_) {}
      try { r.server.close(); } catch (_) {}
    });

    await new Promise((resolve) => {
      if (r.server.listening) resolve();
      else r.server.once('listening', resolve);
    });

    fakeProc.emit('SIGTERM');
    const firstDl = r.controller.getState().deadlineMono;
    assert.ok(Number.isFinite(firstDl));
    try { r.server.close(); } catch (_) {}

    const exitCode = await exitedP;
    assert.equal(exitCode, 0);
    assert.deepEqual(exits, [0]);
    assert.equal(r.server.shutdownController.state().deadlineMono, firstDl);
    assert.equal(r.controller.getState().deadlineMono, firstDl);
    assert.equal(r.controller.getState().state, 'completed');
    assert.equal(r.controller.getState().outcome.reason, 'signal');
    assert.equal(r.controller.getState().outcome.pidfileRemoved, true);
    assert.equal(warns.length, 0);
    assert.ok(!fs.existsSync(pid2));
  }

  // 3) Programmatic serve() with real server.start: direct server.close() finalizes coordinator & pidfile without exitImpl
  {
    const h3 = makeTempDir(t, 'nc-single-prog-close-');
    writeIsolatedConfig(h3);
    const pid3 = path.join(h3, 'srv3.pid');
    process.env.NEXUSCREW_PIDFILE = pid3;
    const progExits = [];
    const progWarns = [];
    const s3 = serve({
      home: h3,
      pidfile: true,
      platform: 'linux',
      port: 0,
      panelPort: 0,
      fleetEnabled: false,
      protectSharedTmuxServer: false,
      liveBridgeEnabled: false,
      autoUpdate: false,
      shutdownBudgetMs: 1200,
      log: () => {},
      writeShutdownLine: (line) => progWarns.push(line),
      exitImpl: (code) => progExits.push(code),
    });
    t.after(() => { try { s3.server.close(); } catch (_) {} });

    await new Promise((resolve) => {
      if (s3.server.listening) resolve();
      else s3.server.once('listening', resolve);
    });

    const closedEvP = new Promise((resolve) => s3.server.once('close', resolve));
    s3.server.close();
    await closedEvP;

    const outcome = await s3.shutdown({ reason: 'programmatic', exitOnFinish: false });
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.reason, 'server-close');
    assert.equal(outcome.quiescent, true);
    assert.equal(outcome.pidfileRemoved, true);
    assert.equal(outcome.pidfileStatus, 'removed');
    assert.deepEqual(progExits, [], 'programmatic serve().server.close() must never invoke exitImpl');
    assert.equal(progWarns.length, 0);
    assert.ok(!fs.existsSync(pid3));
  }
});

test('close-event fallback without onCloseStart always stays unattested, rejects generic deadlines, and preserves signal-opened deadline', async (t) => {
  function createFallbackHandle({ clock, handleBudgetMs = 500, deadlineMode = 'controller-state' }) {
    const emitter = new EventEmitter();
    let releaseBarrier = null;
    const barrierP = new Promise((resolve) => {
      releaseBarrier = resolve;
    });
    let activeDeadlineMono = null;
    let firstPromise = null;
    let uniqueCloses = 0;
    const closeCalls = [];

    emitter.closeOrdered = ({ reason, deadlineMono } = {}) => {
      closeCalls.push({ reason, deadlineMono });
      if (firstPromise) return firstPromise;
      uniqueCloses += 1;
      activeDeadlineMono = Number.isFinite(deadlineMono)
        ? deadlineMono
        : (clock.now + handleBudgetMs);
      firstPromise = barrierP.then((outcome) => outcome);
      return firstPromise;
    };

    if (deadlineMode === 'controller-state') {
      emitter.shutdownController = {
        closeOrdered: emitter.closeOrdered,
        disarm() {},
        state: () => ({ deadlineMono: activeDeadlineMono }),
      };
    } else if (deadlineMode === 'handle-state') {
      emitter.state = () => ({ deadlineMono: activeDeadlineMono });
    } else if (deadlineMode === 'foreign-and-throwing-getter') {
      const foreignClose = () => Promise.resolve({
        ok: true,
        quiescent: true,
        timedOut: false,
        counts: { residues: 0 },
        codes: [],
      });
      emitter.shutdownController = {
        closeOrdered: foreignClose,
        disarm() {},
        state: () => ({ deadlineMono: clock.now + 9000 }),
        deadlineMono: clock.now + 9000,
      };
      Object.defineProperty(emitter, 'deadlineMono', {
        enumerable: true,
        get() {
          throw new Error('getter failed');
        },
      });
      emitter.state = () => ({ deadlineMono: clock.now + 8500 });
    } else if (deadlineMode === 'generic-future') {
      emitter.deadlineMono = clock.now + 6500;
      emitter.state = () => ({ deadlineMono: clock.now + 6500 });
      emitter.shutdownController = {
        closeOrdered: emitter.closeOrdered,
        disarm() {},
        state: () => ({ deadlineMono: clock.now + 6500 }),
        deadlineMono: clock.now + 6500,
      };
    }

    return {
      handle: emitter,
      closeCalls,
      startDirectClose() {
        return emitter.closeOrdered({ reason: 'server-close' });
      },
      emitClose() {
        emitter.emit('close');
      },
      resolveBarrier(outcome) {
        releaseBarrier(outcome);
      },
      getDeadlineMono() {
        return activeDeadlineMono;
      },
      getUniqueCloses() {
        return uniqueCloses;
      },
    };
  }

  function createPidFixture(prefix) {
    const dir = makeTempDir(t, prefix);
    const pidFile = path.join(dir, 'serve.pid');
    fs.writeFileSync(pidFile, JSON.stringify({ pid: process.pid }) + '\n');
    let cleanupCalls = 0;
    const cleanup = () => {
      cleanupCalls += 1;
      try {
        fs.unlinkSync(pidFile);
        return true;
      } catch (_) {
        return false;
      }
    };
    return {
      pidFile,
      cleanup,
      getCleanupCalls: () => cleanupCalls,
    };
  }

  // 1) Direct close before signal on handle without onCloseStart: always unattested, keeps pidfile, finalizes once
  {
    const clock = { now: 1000 };
    const exits = [];
    const warns = [];
    const fakeProc = new EventEmitter();
    const { pidFile, cleanup, getCleanupCalls } = createPidFixture('nc-fb-close-sig-');
    const mock = createFallbackHandle({ clock, handleBudgetMs: 600, deadlineMode: 'controller-state' });
    const coord = createServeShutdownCoordinator({
      budgetMs: 800,
      nowMono: () => clock.now,
      writeLine: (line) => warns.push(line),
      exitImpl: (code) => exits.push(code),
      proc: fakeProc,
    });
    const adapter = installServeSignalAdapter(coord, { proc: fakeProc, exitOnSignal: true });
    t.after(() => adapter.dispose());

    coord.registerPidCleanup(cleanup);
    coord.registerServer(mock.handle);

    const directP = mock.startDirectClose();
    assert.equal(mock.getDeadlineMono(), 1600);
    clock.now = 1100;
    mock.emitClose();
    await Promise.resolve();

    assert.equal(
      coord.getState().deadlineMono,
      1900,
      'fallback without onCloseStart never trusts non-onCloseStart deadlineMono fields'
    );
    assert.deepEqual(exits, []);

    clock.now = 1200;
    fakeProc.emit('SIGTERM');
    assert.equal(coord.getState().deadlineMono, 1900);
    assert.equal(mock.closeCalls.length, 1);

    clock.now = 1350;
    mock.resolveBarrier({
      ok: true,
      quiescent: true,
      timedOut: false,
      counts: { residues: 0 },
      codes: [],
    });

    const outcome = await coord.shutdown({ reason: 'programmatic', exitOnFinish: false });
    await directP;
    assert.equal(outcome.status, 'completed_with_residues');
    assert.equal(outcome.quiescent, false);
    assert.ok(outcome.codes.includes('SERVER_CLOSE_DEADLINE_UNATTESTED'));
    assert.ok(outcome.codes.includes('PIDFILE_CLEANUP_SKIPPED'));
    assert.equal(outcome.pidfileRemoved, false);
    assert.equal(outcome.pidfileStatus, 'skipped');
    assert.equal(mock.getUniqueCloses(), 1);
    assert.equal(getCleanupCalls(), 0);
    assert.deepEqual(exits, [0]);
    assert.equal(warns.length, 1);
    assert.ok(fs.existsSync(pidFile));
  }

  // 2) Signal before direct close on fallback handle: keeps signal-opened D0, single drain, cleans pidfile
  {
    const clock = { now: 2000 };
    const exits = [];
    const warns = [];
    const fakeProc = new EventEmitter();
    const { pidFile, cleanup, getCleanupCalls } = createPidFixture('nc-fb-sig-close-');
    const mock = createFallbackHandle({ clock, handleBudgetMs: 900, deadlineMode: 'controller-state' });
    const coord = createServeShutdownCoordinator({
      budgetMs: 500,
      nowMono: () => clock.now,
      writeLine: (line) => warns.push(line),
      exitImpl: (code) => exits.push(code),
      proc: fakeProc,
    });
    const adapter = installServeSignalAdapter(coord, { proc: fakeProc, exitOnSignal: true });
    t.after(() => adapter.dispose());

    coord.registerPidCleanup(cleanup);
    coord.registerServer(mock.handle);

    fakeProc.emit('SIGTERM');
    assert.equal(coord.getState().deadlineMono, 2500);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(mock.closeCalls.length, 1);
    assert.equal(mock.getUniqueCloses(), 1);
    assert.equal(mock.getDeadlineMono(), 2500);

    clock.now = 2200;
    mock.startDirectClose();
    mock.emitClose();
    assert.equal(coord.getState().deadlineMono, 2500);
    assert.equal(mock.closeCalls.length, 2, 'subsequent closeOrdered hits idempotent server promise cleanly');

    clock.now = 2300;
    mock.resolveBarrier({
      ok: true,
      quiescent: true,
      timedOut: false,
      counts: { residues: 0 },
      codes: [],
    });

    const outcome = await coord.shutdown({ reason: 'programmatic', exitOnFinish: false });
    assert.equal(outcome.status, 'completed');
    assert.equal(outcome.reason, 'signal');
    assert.equal(outcome.quiescent, true);
    assert.equal(outcome.pidfileRemoved, true);
    assert.equal(getCleanupCalls(), 1);
    assert.deepEqual(exits, [0]);
    assert.equal(warns.length, 0);
    assert.ok(!fs.existsSync(pidFile));
  }

  // 3) Generic future deadline (9500) on fallback with expired real D0 (3500) and memoized quiescent outcome stays unattested
  {
    const clock = { now: 3000 };
    const exits = [];
    const warns = [];
    const fakeProc = new EventEmitter();
    const { pidFile, cleanup, getCleanupCalls } = createPidFixture('nc-fb-late-quiescent-');
    const mock = createFallbackHandle({ clock, handleBudgetMs: 500, deadlineMode: 'generic-future' });
    const coord = createServeShutdownCoordinator({
      budgetMs: 900,
      nowMono: () => clock.now,
      writeLine: (line) => warns.push(line),
      exitImpl: (code) => exits.push(code),
      proc: fakeProc,
    });
    const adapter = installServeSignalAdapter(coord, { proc: fakeProc, exitOnSignal: true });
    t.after(() => adapter.dispose());

    coord.registerPidCleanup(cleanup);
    coord.registerServer(mock.handle);

    const directP = mock.startDirectClose();
    assert.equal(mock.getDeadlineMono(), 3500);
    clock.now = 3200;
    mock.resolveBarrier({
      ok: true,
      quiescent: true,
      timedOut: false,
      counts: { residues: 0 },
      codes: [],
    });
    await directP;

    // Close event arrives after D0=3500 while generic deadlineMono=9500 is still far in the future.
    clock.now = 3600;
    mock.emitClose();
    clock.now = 3610;
    fakeProc.emit('SIGTERM');

    const outcome = await coord.shutdown({ reason: 'programmatic', exitOnFinish: false });
    assert.notEqual(coord.getState().deadlineMono, 9500, 'generic future field/state deadline must never be adopted');
    assert.equal(outcome.quiescent, false, 'fallback without onCloseStart must never pass as quiescent');
    assert.equal(outcome.status, 'completed_with_residues');
    assert.ok(outcome.codes.includes('SERVER_CLOSE_DEADLINE_UNATTESTED'));
    assert.ok(outcome.codes.includes('PIDFILE_CLEANUP_SKIPPED'));
    assert.equal(outcome.pidfileRemoved, false);
    assert.equal(outcome.pidfileStatus, 'skipped');
    assert.equal(getCleanupCalls(), 0);
    assert.ok(fs.existsSync(pidFile), 'pidfile must be kept when close fallback is unattested');
    assert.equal(warns.length, 1);
    assert.deepEqual(exits, [0]);
  }

  // 4) Missing deadline, foreign controller state, and throwing getter alongside generic numeric state all stay unattested
  for (const mode of ['none', 'foreign-and-throwing-getter']) {
    const clock = { now: 4000 };
    const exits = [];
    const warns = [];
    const fakeProc = new EventEmitter();
    const { pidFile, cleanup, getCleanupCalls } = createPidFixture(`nc-fb-${mode}-`);
    const mock = createFallbackHandle({ clock, handleBudgetMs: 500, deadlineMode: mode });
    const coord = createServeShutdownCoordinator({
      budgetMs: 600,
      nowMono: () => clock.now,
      writeLine: (line) => warns.push(line),
      exitImpl: (code) => exits.push(code),
      proc: fakeProc,
    });
    const adapter = installServeSignalAdapter(coord, { proc: fakeProc, exitOnSignal: true });
    t.after(() => adapter.dispose());

    coord.registerPidCleanup(cleanup);
    coord.registerServer(mock.handle);

    mock.startDirectClose();
    mock.resolveBarrier({
      ok: true,
      quiescent: true,
      timedOut: false,
      counts: { residues: 0 },
      codes: [],
    });
    clock.now = 4100;
    mock.emitClose();
    fakeProc.emit('SIGTERM');

    const outcome = await coord.shutdown({ reason: 'programmatic', exitOnFinish: false });
    assert.equal(outcome.status, 'completed_with_residues');
    assert.equal(outcome.quiescent, false);
    assert.ok(outcome.codes.includes('SERVER_CLOSE_DEADLINE_UNATTESTED'));
    assert.ok(outcome.codes.includes('PIDFILE_CLEANUP_SKIPPED'));
    assert.equal(outcome.pidfileRemoved, false);
    assert.equal(outcome.pidfileStatus, 'skipped');
    assert.equal(getCleanupCalls(), 0);
    assert.ok(fs.existsSync(pidFile), `pidfile must remain for mode=${mode}`);
    assert.equal(warns.length, 1);
    assert.deepEqual(exits, [0]);
  }

  // 5) Programmatic usage without onCloseStart or signal adapter installs no process listeners, never exits, and refuses cleanup
  {
    const clock = { now: 5000 };
    const exits = [];
    const warns = [];
    const fakeProc = new EventEmitter();
    const { pidFile, cleanup, getCleanupCalls } = createPidFixture('nc-fb-programmatic-');
    const mock = createFallbackHandle({ clock, handleBudgetMs: 700, deadlineMode: 'handle-state' });
    const coord = createServeShutdownCoordinator({
      budgetMs: 900,
      nowMono: () => clock.now,
      writeLine: (line) => warns.push(line),
      exitImpl: (code) => exits.push(code),
      proc: fakeProc,
    });

    coord.registerPidCleanup(cleanup);
    coord.registerServer(mock.handle);
    assert.equal(fakeProc.listenerCount('SIGINT'), 0);
    assert.equal(fakeProc.listenerCount('SIGTERM'), 0);
    assert.equal(fakeProc.listenerCount('exit'), 0);

    mock.startDirectClose();
    clock.now = 5150;
    mock.emitClose();
    await Promise.resolve();

    clock.now = 5250;
    mock.resolveBarrier({
      ok: true,
      quiescent: true,
      timedOut: false,
      counts: { residues: 0 },
      codes: [],
    });

    const outcome = await coord.shutdown({ reason: 'programmatic', exitOnFinish: false });
    assert.equal(outcome.status, 'completed_with_residues');
    assert.equal(outcome.reason, 'server-close');
    assert.equal(outcome.quiescent, false);
    assert.ok(outcome.codes.includes('SERVER_CLOSE_DEADLINE_UNATTESTED'));
    assert.ok(outcome.codes.includes('PIDFILE_CLEANUP_SKIPPED'));
    assert.equal(outcome.pidfileRemoved, false);
    assert.equal(outcome.pidfileStatus, 'skipped');
    assert.equal(getCleanupCalls(), 0);
    assert.deepEqual(exits, []);
    assert.equal(warns.length, 1);
    assert.ok(fs.existsSync(pidFile));
    assert.equal(fakeProc.listenerCount('SIGINT'), 0);
    assert.equal(fakeProc.listenerCount('SIGTERM'), 0);
    assert.equal(fakeProc.listenerCount('exit'), 0);
  }
});
