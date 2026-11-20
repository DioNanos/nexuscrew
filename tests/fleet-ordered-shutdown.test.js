'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');

const { createBuiltinFleet, backfillVlEngine } = require('../lib/fleet/builtin.js');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
const { fleetRoutes } = require('../lib/fleet/routes.js');
const { createDiagnostics } = require('../lib/diagnostics/store.js');
const { atomicWrite, loadDefinitions } = require('../lib/fleet/definitions.js');
const launchTarget = require('../lib/fleet/launch-target.js');
const launchWriterLock = require('../lib/fleet/launch-writer-lock.js');
const vlRoots = require('../lib/fleet/vl-roots.js');
const vlNodeRuntime = require('../lib/fleet/vl-node-runtime.js');

const shellQ = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

function createFakeClock(initialMs = 1000) {
  let now = initialMs;
  let nextId = 1;
  const timers = new Map();
  const scheduledDelays = [];

  const setTimer = (fn, delay) => {
    const id = nextId++;
    const ms = Math.max(0, Number(delay) || 0);
    scheduledDelays.push(ms);
    timers.set(id, { at: now + ms, fn });
    return id;
  };

  const clearTimer = (id) => {
    timers.delete(id);
  };

  const advanceTo = (targetMs) => {
    now = Math.max(now, targetMs);
    for (const [id, entry] of [...timers.entries()]) {
      if (entry.at <= now) {
        timers.delete(id);
        entry.fn();
      }
    }
  };

  const advanceBy = (deltaMs) => advanceTo(now + deltaMs);

  return {
    now: () => now,
    setTimer,
    clearTimer,
    advanceTo,
    advanceBy,
    pendingCount: () => timers.size,
    scheduledDelays: () => [...scheduledDelays],
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createFakeChild() {
  const child = new EventEmitter();
  const killSignals = [];
  let rawIn = '';
  let ended = false;
  const emitSuccess = () => {
    const req = JSON.parse(rawIn.trim());
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      v: 1,
      requestId: req.requestId,
      outcome: 'claimed',
      ok: true,
      lockHeld: true,
    })}\n`, 'utf8'));
    child.emit('close', 0);
  };
  child.stdin = {
    write(chunk) {
      rawIn += String(chunk);
    },
    end() {
      ended = true;
    },
  };
  child.completeClaim = () => {
    assert.equal(ended, true);
    emitSuccess();
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (sig) => {
    killSignals.push(sig);
  };
  child.killSignals = killSignals;
  return child;
}

function makeWorld(t, opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncosd-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const filesRoot = path.join(home, 'NexusFiles');
  fs.mkdirSync(filesRoot, { mode: 0o700 });
  const cwd = path.join(home, 'Dev');
  fs.mkdirSync(cwd, { mode: 0o700 });

  fs.mkdirSync(path.join(home, 'bin'), { mode: 0o700 });
  const command = path.join(home, 'bin', 'myagent');
  fs.writeFileSync(command, '#!/bin/sh\necho ok\n', { mode: 0o755 });
  fs.chmodSync(command, 0o755);

  const defsPath = path.join(root, 'fleet.json');
  const def = {
    schemaVersion: 1,
    engines: [
      {
        id: 'claude',
        label: 'Claude',
        rc: true,
        command,
        args: ['--safe'],
        env: { ANTHROPIC_API_KEY: 'sk-test-1' },
        promptMode: 'flag',
        promptFlag: '--prompt',
      },
    ],
    cells: [
      {
        id: 'Dev',
        tmuxSession: 'work-build',
        cwd,
        engine: 'claude',
        boot: true,
        prompt: 'test prompt',
      },
    ],
  };
  atomicWrite(defsPath, def);
  if (opts.withVlCell) {
    const withVl = backfillVlEngine(defsPath, loadDefinitions(defsPath));
    atomicWrite(defsPath, {
      ...withVl,
      cells: [
        ...withVl.cells,
        {
          id: 'VlCell',
          tmuxSession: 'work-vl',
          cwd,
          engine: 'vl.native',
          boot: false,
        },
      ],
    });
  }

  const log = path.join(root, 'tmux.log');
  fs.writeFileSync(log, '');
  const sessions = path.join(root, 'sessions');
  fs.writeFileSync(sessions, '');
  const alive = path.join(root, 'alive');
  fs.writeFileSync(alive, '1');
  const pane = path.join(root, 'pane');
  fs.writeFileSync(pane, '0');
  const exitStatus = path.join(root, 'exit-status');
  fs.writeFileSync(exitStatus, '0');
  const killed = path.join(root, 'killed');
  const tmuxBin = path.join(root, 'fake-tmux.sh');
  const script = `#!/bin/sh
LOG=${shellQ(log)}
SESS=${shellQ(sessions)}
ALIVE=${shellQ(alive)}
PANE=${shellQ(pane)}
STATUS=${shellQ(exitStatus)}
KILLED=${shellQ(killed)}
if [ "$1" = "-S" ] && [ "$3" = "-C" ]; then
  if [ "$4" = "new-session" ]; then
    errc="\${TMPDIR:-/tmp}/ncosd.$$"
    outc=$( ( shift 3; "$0" "$@" ) 2>"$errc" )
    rcc=$?
    printf '%%begin 1 0 1\\n'
    [ -n "$outc" ] && printf '%s\\n' "$outc"
    if [ "$rcc" = "0" ]; then printf '%%end 1 0 1\\n'
    else errtxt=$(cat "$errc" 2>/dev/null); [ -n "$errtxt" ] && printf '%s\\n' "$errtxt"; printf '%%error 1 0 1\\n'; fi
    rm -f "$errc"
  else
    printf '%%begin 1 0 1\\nnc-control-open\\n%%end 1 0 1\\n'
  fi
  sock="$2"
  n=0
  errf="\${TMPDIR:-/tmp}/ncosdcc.$$"
  while IFS= read -r riga; do
    n=$((n+1))
    [ -z "$riga" ] && continue
    [ "$riga" = "display-message -p nc-control-open" ] && continue
    out=$("$0" -S "$sock" $riga 2>"$errf")
    rc=$?
    printf '%%begin 1 %s 1\\n' "$n"
    [ -n "$out" ] && printf '%s\\n' "$out"
    if [ "$rc" = "0" ]; then printf '%%end 1 %s 1\\n' "$n"
    else cat "$errf" 2>/dev/null; printf '%%error 1 %s 1\\n' "$n"; fi
  done
  rm -f "$errf"
  exit 0
fi
if [ "$1" = "-S" ]; then shift 2; fi
cmd="\${1:-}"; [ $# -gt 0 ] && shift
case "$cmd" in
  has-session)
    for a in "$@"; do
      if [ "$a" = '$1' ] && [ -f "$KILLED" ]; then exit 1; fi
    done
    [ -f "$ALIVE" ] && [ "$(cat "$ALIVE" 2>/dev/null)" = "0" ] && exit 1
    exit 0 ;;
  list-sessions)
    [ -f "$SESS" ] && cat "$SESS"
    exit 0 ;;
  kill-session)
    echo "kill-session" >> "$LOG"; : > "$KILLED"; exit 0 ;;
  new-session)
    echo "new-session" >> "$LOG"
    rm -f "$KILLED"
    found_P=0; for a in "$@"; do [ "$a" = "-P" ] && found_P=1; done
    [ "$found_P" = "1" ] && printf '%s\\t%s\\t%s\\n' '$1' '@1' '%42'
    exit 0 ;;
  set-option|set-hook|respawn-pane|load-buffer|paste-buffer|delete-buffer)
    echo "$cmd" >> "$LOG"; exit 0 ;;
  display-message)
    last=""; for a in "$@"; do last="$a"; done
    case "$last" in *socket_path*) printf '/tmp/nc-fake/socket\\t4242\\n'; exit 0 ;; esac
    case "$last" in *pane_pid*) printf '4242\\t2222\\n'; exit 0 ;; esac
    printf '0\\t\\t%%42\\n'; exit 0 ;;
  capture-pane) exit 0 ;;
  *) echo "$cmd" >> "$LOG"; exit 0 ;;
esac
`;
  fs.writeFileSync(tmuxBin, script, { mode: 0o755 });
  fs.chmodSync(tmuxBin, 0o755);

  return { root, home, filesRoot, cwd, defsPath, tmuxBin, log, sessions };
}

function makeFakeBroker(events, opts = {}) {
  let closeCalls = 0;
  let ticketN = 0;
  const revokedNonces = [];
  return {
    get closeCalls() { return closeCalls; },
    get revokedNonces() { return [...revokedNonces]; },
    async issue(payload) {
      if (events) events.push('broker.issue');
      if (opts.onIssue) await opts.onIssue(payload);
      ticketN += 1;
      return { ticket: `tk-${ticketN}`, nonce: `nonce-${ticketN}`, socketPath: '/tmp/fake-broker.sock' };
    },
    async revoke(nonce) {
      revokedNonces.push(nonce);
      if (events) events.push(`broker.revoke:${nonce}`);
    },
    async close() {
      closeCalls += 1;
      if (events) events.push('broker.close');
      if (opts.onClose) return await opts.onClose();
    },
  };
}

function makeFakeLease(events) {
  let closeCalls = 0;
  return {
    get closeCalls() { return closeCalls; },
    boot: async () => {},
    issueControl: () => ({ ok: true }),
    revokeControl: () => {},
    attachInitial: () => true,
    close() {
      closeCalls += 1;
      if (events) events.push('lease.close');
      return {
        closed: true,
        quiescent: true,
        pendingOpens: 0,
        unresolvedOpens: 0,
        pendingServers: 0,
        pendingSockets: 0,
        closeFailures: 0,
        historicalResiduals: 0,
      };
    },
  };
}

function runtimeFromWorld(world, overrides = {}) {
  const cfg = {
    home: world.home,
    filesRoot: world.filesRoot,
    fleetDefsPath: world.defsPath,
    tmuxBin: world.tmuxBin,
    sendKeysReadyMs: 1,
    protectSharedTmuxServer: false,
    ...(overrides.cfg || {}),
  };
  const boot = loadDefinitions(world.defsPath);
  const rt = createBuiltinRuntime({
    cfg,
    filesRoot: world.filesRoot,
    home: world.home,
    defsPath: world.defsPath,
    tmuxBin: world.tmuxBin,
    readonly: () => false,
    launchBroker: overrides.launchBroker || makeFakeBroker(overrides.events),
    leaseManager: overrides.leaseManager || null,
    boot,
    ensureProtection: () => {},
    ...(overrides.rtOpts || {}),
  });
  return { rt, cfg };
}

const nextTickImmediate = () => new Promise((resolve) => setImmediate(resolve));

test('disarm happens synchronously before any wait and orders broker/lease/claim shutdown', async (t) => {
  const world = makeWorld(t);
  const clock = createFakeClock(1000);
  const events = [];
  const gate = deferred();
  const paused = deferred();

  const broker = makeFakeBroker(events, {
    onIssue: async () => {
      events.push('op.paused');
      paused.resolve();
      await gate.promise;
    },
  });
  const leaseManager = makeFakeLease(events);

  const fleet = await createBuiltinFleet({
    home: world.home,
    filesRoot: world.filesRoot,
    fleetDefsPath: world.defsPath,
    tmuxBin: world.tmuxBin,
    protectSharedTmuxServer: false,
    ensureTmuxProtection: () => {},
    launchBroker: broker,
    nowMono: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    sendKeysReadyMs: 1,
  });

  const upPromise = fleet.up('Dev');
  await paused.promise;

  const origWaitIdle = fleet.claimTracker.waitIdle;
  fleet.claimTracker.waitIdle = (...args) => {
    events.push('claimTracker.waitIdle');
    return origWaitIdle(...args);
  };

  // Start close: disarm must be true synchronously BEFORE any await resolves.
  const closeP = fleet.close({ budgetMs: 1500 });
  assert.equal(fleet.isDisarmed(), true, 'fleet is disarmed synchronously before await');

  // Verify broker.close and claimTracker.waitIdle have NOT run before op drain resolves.
  await nextTickImmediate();
  assert.equal(events.includes('broker.close'), false);
  assert.equal(events.includes('claimTracker.waitIdle'), false);

  gate.resolve();
  await assert.rejects(upPromise, {
    status: 503,
    fleetCode: 'RUNTIME_DISARMED',
    fleetPhase: 'launch-broker',
  });
  assert.deepEqual(broker.revokedNonces, ['nonce-1']);
  assert.equal(fs.readFileSync(world.log, 'utf8').includes('new-session'), false);

  const closeOutcome = await closeP;
  assert.equal(closeOutcome.ok, true);
  assert.equal(closeOutcome.quiescent, true);
  assert.equal(closeOutcome.disarmed, true);
  assert.equal(closeOutcome.disarmedBeforeWait, true);
  assert.equal(closeOutcome.codes.length, 0);
  assert.ok(
    events.indexOf('broker.close') < events.indexOf('claimTracker.waitIdle'),
    'claim drain happens after broker close',
  );
  assert.equal(leaseManager.closeCalls, 0);
});

test('queued continuation on launch lock does not spawn or issue broker after disarm', async (t) => {
  const world = makeWorld(t);
  const events = [];
  const firstGate = deferred();
  const firstEntered = deferred();
  let issueCalls = 0;

  const broker = makeFakeBroker(events, {
    onIssue: async () => {
      issueCalls += 1;
      if (issueCalls === 1) {
        firstEntered.resolve();
        await firstGate.promise;
      }
    },
  });

  const fleet = await createBuiltinFleet({
    home: world.home,
    filesRoot: world.filesRoot,
    fleetDefsPath: world.defsPath,
    tmuxBin: world.tmuxBin,
    protectSharedTmuxServer: false,
    ensureTmuxProtection: () => {},
    launchBroker: broker,
    sendKeysReadyMs: 1,
  });

  // First op reaches broker.issue and holds launchLocks('Dev').
  const p1 = fleet.up('Dev');
  await firstEntered.promise;

  // Second op enters while still armed, passes entry gate, and awaits launchLocks('Dev').
  const p2 = fleet.up('Dev');
  await nextTickImmediate();
  assert.equal(issueCalls, 1);

  const countBeforeClose = fs.readFileSync(world.log, 'utf8').split('\n').filter(Boolean).length;

  // Now disarm via close(): p2 must reject cleanly after waking from launchLocks
  // WITHOUT issuing a second broker ticket or running tmux new-session.
  const closeP = fleet.close({ budgetMs: 1500 });
  firstGate.resolve();

  const [r1, r2, closed] = await Promise.allSettled([p1, p2, closeP]);
  assert.equal(r1.status, 'rejected');
  assert.equal(r1.reason.status, 503);
  assert.equal(r1.reason.fleetCode, 'RUNTIME_DISARMED');
  assert.equal(r1.reason.fleetPhase, 'launch-broker');
  assert.equal(r2.status, 'rejected');
  assert.equal(r2.reason.status, 503);
  assert.equal(r2.reason.fleetCode, 'RUNTIME_DISARMED');
  assert.equal(r2.reason.fleetPhase, 'preflight');
  assert.equal(issueCalls, 1, 'second queued op never reached launchBroker.issue');
  assert.deepEqual(broker.revokedNonces, ['nonce-1']);

  const newSessionLines = fs.readFileSync(world.log, 'utf8')
    .split('\n')
    .filter((l) => l === 'new-session');
  assert.equal(newSessionLines.length, 0, 'tmux new-session ran for neither disarmed op');
  assert.equal(countBeforeClose, 0);
  assert.equal(closed.status, 'fulfilled');
  assert.equal(closed.value.quiescent, true);
});

test('in-flight operation completing within deadline yields quiescent close and releases writer lock', async (t) => {
  const world = makeWorld(t);
  const clock = createFakeClock(5000);
  const opGate = deferred();
  const opEntered = deferred();
  const broker = makeFakeBroker(null, {
    onIssue: async () => {
      opEntered.resolve();
      await opGate.promise;
    },
  });

  const fleet = await createBuiltinFleet({
    home: world.home,
    filesRoot: world.filesRoot,
    fleetDefsPath: world.defsPath,
    tmuxBin: world.tmuxBin,
    protectSharedTmuxServer: false,
    ensureTmuxProtection: () => {},
    launchBroker: broker,
    nowMono: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    sendKeysReadyMs: 1,
  });

  const lockFile = path.join(world.filesRoot, 'launch-targets', '.writer-lock.json');
  const upPromise = fleet.up('Dev');
  await opEntered.promise;
  assert.equal(fs.existsSync(lockFile), true, 'writer lock created once op reaches launchBroker');

  const closePromise = fleet.close({ deadlineMono: clock.now() + 1000 });
  clock.advanceBy(250);
  opGate.resolve();
  await assert.rejects(upPromise, {
    status: 503,
    fleetCode: 'RUNTIME_DISARMED',
    fleetPhase: 'launch-broker',
  });

  const outcome = await closePromise;
  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.quiescent, true);
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.budgetExhausted, false);
  assert.equal(outcome.activeOpsRemaining, 0);
  assert.equal(outcome.activeRuntimeOpsRemaining, 0);
  assert.equal(outcome.activeMutationsRemaining, 0);
  assert.equal(outcome.writerLockHeld, false);
  assert.equal(outcome.writerLockReleased, true);
  assert.equal(outcome.brokerClosed, true);
  assert.equal(outcome.leaseClosed, true);
  assert.deepEqual(outcome.codes, []);
  assert.equal(fs.existsSync(lockFile), false, 'writer lock removed on disk once idle');
});

test('writer lock remains held if deadline expires with active op and releases once on late completion', async (t) => {
  const world = makeWorld(t);
  const clock = createFakeClock(10000);
  const opGate = deferred();
  const opEntered = deferred();
  const broker = makeFakeBroker(null, {
    onIssue: async () => {
      opEntered.resolve();
      await opGate.promise;
    },
  });

  const fleet = await createBuiltinFleet({
    home: world.home,
    filesRoot: world.filesRoot,
    fleetDefsPath: world.defsPath,
    tmuxBin: world.tmuxBin,
    protectSharedTmuxServer: false,
    ensureTmuxProtection: () => {},
    launchBroker: broker,
    nowMono: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    sendKeysReadyMs: 1,
  });

  const lockFile = path.join(world.filesRoot, 'launch-targets', '.writer-lock.json');
  const upPromise = fleet.up('Dev');
  await opEntered.promise;
  assert.equal(fs.existsSync(lockFile), true, 'writer lock held before close');

  const closePromise = fleet.close({ deadlineMono: clock.now() + 200 });
  await nextTickImmediate();
  assert.equal(fs.existsSync(lockFile), true, 'writer lock NOT released on close entry');

  clock.advanceBy(200);
  const outcome = await closePromise;

  assert.equal(outcome.ok, true);
  assert.equal(outcome.status, 'completed_with_residues');
  assert.equal(outcome.quiescent, false);
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.budgetExhausted, true);
  assert.equal(outcome.activeOpsRemaining, 1);
  assert.equal(outcome.activeRuntimeOpsRemaining, 1);
  assert.equal(outcome.writerLockHeld, true);
  assert.equal(outcome.writerLockReleased, false);
  assert.ok(outcome.codes.includes('WRITER_LOCK_HELD'));
  assert.ok(outcome.codes.includes('OPS_DRAIN_TIMEOUT'));
  assert.equal(fs.existsSync(lockFile), true, 'writer lock file remains on disk while op active');

  // Settle late op: writer lock must now be released once and removed on disk.
  opGate.resolve();
  await assert.rejects(upPromise, {
    status: 503,
    fleetCode: 'RUNTIME_DISARMED',
    fleetPhase: 'launch-broker',
  });
  assert.equal(fs.existsSync(lockFile), false, 'writer lock released on disk when last op finishes');
  const st = fleet.shutdownState();
  assert.equal(st.writerLockHeld, false);
  assert.equal(st.writerLockReleased, true);
  assert.equal(st.inFlightOps, 0);

  // Also verify direct rt.shutdown() behavior on fresh runtimes: synchronous
  // release when 0 ops, deferred release when > 0 ops until final op settles.
  const idleWorld = makeWorld(t);
  const idleLockFile = path.join(idleWorld.filesRoot, 'launch-targets', '.writer-lock.json');
  const { rt: rtIdle } = runtimeFromWorld(idleWorld);
  await rtIdle.up('Dev');
  assert.equal(fs.existsSync(idleLockFile), true);
  rtIdle.shutdown();
  assert.equal(fs.existsSync(idleLockFile), false, 'rt.shutdown() releases synchronously when 0 in-flight ops');
  assert.equal(rtIdle.shutdownState().writerLockReleased, true);

  const busyWorld = makeWorld(t);
  const busyLockFile = path.join(busyWorld.filesRoot, 'launch-targets', '.writer-lock.json');
  const busyGate = deferred();
  const busyEntered = deferred();
  const { rt: rtBusy } = runtimeFromWorld(busyWorld, {
    launchBroker: makeFakeBroker(null, {
      onIssue: async () => {
        busyEntered.resolve();
        await busyGate.promise;
      },
    }),
  });
  const busyUp = rtBusy.up('Dev');
  await busyEntered.promise;
  assert.equal(fs.existsSync(busyLockFile), true);
  rtBusy.shutdown();
  assert.equal(fs.existsSync(busyLockFile), true, 'rt.shutdown() defers release while op is in flight');
  assert.equal(rtBusy.shutdownState().writerLockHeld, true);
  busyGate.resolve();
  await assert.rejects(busyUp, {
    status: 503,
    fleetCode: 'RUNTIME_DISARMED',
    fleetPhase: 'launch-broker',
  });
  assert.equal(fs.existsSync(busyLockFile), false, 'deferred release fires once busy op completes');
  assert.equal(rtBusy.shutdownState().writerLockReleased, true);
});

test('two independent fleet/runtime instances isolate disarm and preserve shared node runtime cache', async (t) => {
  const world1 = makeWorld(t);
  const world2 = makeWorld(t);

  const fakeNode = path.join(world1.root, 'fake-node');
  fs.writeFileSync(fakeNode, `#!/bin/sh\necho "v${process.versions.node}"\n`, { mode: 0o500 });
  fs.chmodSync(fakeNode, 0o500);
  const cacheBefore = vlNodeRuntime.qualifica({ execPath: fakeNode });
  assert.equal(cacheBefore.ok, true);

  const f1 = await createBuiltinFleet({
    home: world1.home,
    filesRoot: world1.filesRoot,
    fleetDefsPath: world1.defsPath,
    tmuxBin: world1.tmuxBin,
    protectSharedTmuxServer: false,
    ensureTmuxProtection: () => {},
    launchBroker: makeFakeBroker(),
    sendKeysReadyMs: 1,
  });
  const f2 = await createBuiltinFleet({
    home: world2.home,
    filesRoot: world2.filesRoot,
    fleetDefsPath: world2.defsPath,
    tmuxBin: world2.tmuxBin,
    protectSharedTmuxServer: false,
    ensureTmuxProtection: () => {},
    launchBroker: makeFakeBroker(),
    sendKeysReadyMs: 1,
  });
  t.after(() => f2.close().catch(() => {}));

  const resClose1 = await f1.close();
  assert.equal(resClose1.quiescent, true);
  assert.equal(f1.isDisarmed(), true);
  assert.equal(f2.isDisarmed(), false, 'closing f1 does not disarm f2');

  const up2 = await f2.up('Dev');
  assert.equal(up2.ok, true, 'f2 continues serving launches after f1 closed');

  const cacheAfter = vlNodeRuntime.qualifica({ execPath: fakeNode });
  assert.equal(cacheAfter.ok, true);
  assert.equal(cacheAfter.hash, cacheBefore.hash);
  assert.equal(cacheAfter.path, cacheBefore.path);
});

test('repeated fleet.close() calls are idempotent and return the same promise without repeating actions', async (t) => {
  const world = makeWorld(t);
  const broker = makeFakeBroker();
  const fleet = await createBuiltinFleet({
    home: world.home,
    filesRoot: world.filesRoot,
    fleetDefsPath: world.defsPath,
    tmuxBin: world.tmuxBin,
    protectSharedTmuxServer: false,
    ensureTmuxProtection: () => {},
    launchBroker: broker,
    sendKeysReadyMs: 1,
  });

  let claimWaitCalls = 0;
  const origWaitIdle = fleet.claimTracker.waitIdle;
  fleet.claimTracker.waitIdle = (...args) => {
    claimWaitCalls += 1;
    return origWaitIdle(...args);
  };

  const p1 = fleet.close({ budgetMs: 1500 });
  const p2 = fleet.close({ budgetMs: 1500 });
  assert.equal(p1, p2, 'repeated close() shares the exact same promise');

  const [r1, r2] = await Promise.all([p1, p2]);
  const r3 = await fleet.close();
  assert.deepEqual(r1, r2);
  assert.deepEqual(r1, r3);
  assert.equal(broker.closeCalls, 1);
  assert.equal(claimWaitCalls, 1);
});

test('single shared caller deadline governs op wait, broker close, and single claim wait', async (t) => {
  const world = makeWorld(t);
  const clock = createFakeClock(20000);
  const opGate = deferred();
  const opEntered = deferred();
  const broker = makeFakeBroker(null, {
    onIssue: async () => {
      opEntered.resolve();
      await opGate.promise;
    },
  });

  const fleet = await createBuiltinFleet({
    home: world.home,
    filesRoot: world.filesRoot,
    fleetDefsPath: world.defsPath,
    tmuxBin: world.tmuxBin,
    protectSharedTmuxServer: false,
    ensureTmuxProtection: () => {},
    launchBroker: broker,
    nowMono: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    sendKeysReadyMs: 1,
  });

  const upPromise = fleet.up('Dev');
  await opEntered.promise;

  // Attach an active attested claim consumer that stays alive so waitIdle blocks
  // on whatever budget remains after op wait (1500 - 1350 = 150ms, NOT 300ms).
  const slowChild = createFakeChild();
  const admitted = fleet.claimTracker.beginAdmitted();
  assert.equal(admitted.ok, true);
  assert.equal(fleet.claimTracker.attachChild(admitted.token, slowChild), true);

  let claimWaitCalls = 0;
  const origWaitIdle = fleet.claimTracker.waitIdle;
  fleet.claimTracker.waitIdle = (...args) => {
    claimWaitCalls += 1;
    return origWaitIdle(...args);
  };

  const closePromise = fleet.close({ deadlineMono: clock.now() + 1500 });
  clock.advanceBy(1350);
  opGate.resolve();
  await assert.rejects(upPromise, {
    status: 503,
    fleetCode: 'RUNTIME_DISARMED',
    fleetPhase: 'launch-broker',
  });
  await nextTickImmediate();

  // At 1350ms, only 150ms remain before deadlineMono; claimTracker must wait at most 150ms.
  assert.equal(clock.scheduledDelays().includes(150), true, 'claim wait uses remaining 150ms budget');
  assert.equal(clock.scheduledDelays().includes(300), false, 'claim wait does not get a fresh 300ms phase');

  clock.advanceBy(150);
  const outcome = await closePromise;
  assert.equal(claimWaitCalls, 1, 'claimTracker.waitIdle invoked exactly once');
  assert.equal(outcome.elapsedMs, 1500, 'total elapsed matches single 1500ms budget');
  assert.equal(outcome.claims.code, 'CLAIM_DRAIN_TIMEOUT');
  assert.equal(outcome.claims.drainExpired, true);
  assert.equal(outcome.quiescent, false);
  assert.ok(outcome.codes.includes('CLAIM_DRAIN_TIMEOUT'));

  fleet.claimTracker.endConsumer(admitted.token, 'close');
});

test('already-exhausted deadline at close entry skips waits without scheduling timers', async (t) => {
  const world = makeWorld(t);
  const clock = createFakeClock(30000);
  const opGate = deferred();
  const opEntered = deferred();
  const broker = makeFakeBroker(null, {
    onIssue: async () => {
      opEntered.resolve();
      await opGate.promise;
    },
  });

  const fleet = await createBuiltinFleet({
    home: world.home,
    filesRoot: world.filesRoot,
    fleetDefsPath: world.defsPath,
    tmuxBin: world.tmuxBin,
    protectSharedTmuxServer: false,
    ensureTmuxProtection: () => {},
    launchBroker: broker,
    nowMono: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    sendKeysReadyMs: 1,
  });

  const upPromise = fleet.up('Dev');
  await opEntered.promise;

  const slowChild = createFakeChild();
  const admitted = fleet.claimTracker.beginAdmitted();
  assert.equal(admitted.ok, true);
  assert.equal(fleet.claimTracker.attachChild(admitted.token, slowChild), true);

  const outcome = await fleet.close({ deadlineMono: clock.now() });
  assert.equal(clock.scheduledDelays().length, 0, 'zero timers scheduled when budget already exhausted');
  assert.equal(fleet.isDisarmed(), true);
  assert.equal(broker.closeCalls, 1);
  assert.equal(outcome.elapsedMs, 0);
  assert.equal(outcome.budgetExhausted, true);
  assert.equal(outcome.status, 'completed_with_residues');
  assert.equal(outcome.writerLockHeld, true);
  assert.ok(outcome.codes.includes('WRITER_LOCK_HELD'));
  assert.ok(outcome.codes.includes('CLAIM_BUDGET_EXHAUSTED'));

  fleet.claimTracker.endConsumer(admitted.token, 'close');
  opGate.resolve();
  await assert.rejects(upPromise, {
    status: 503,
    fleetCode: 'RUNTIME_DISARMED',
    fleetPhase: 'launch-broker',
  });
});

test('disarmed fleet rejects all mutating HTTP routes with 503 RUNTIME_DISARMED while keeping GET routes active', async (t) => {
  const world = makeWorld(t, { withVlCell: true });
  const fleet = await createBuiltinFleet({
    home: world.home,
    filesRoot: world.filesRoot,
    fleetDefsPath: world.defsPath,
    tmuxBin: world.tmuxBin,
    protectSharedTmuxServer: false,
    ensureTmuxProtection: () => {},
    launchBroker: makeFakeBroker(),
    sendKeysReadyMs: 1,
  });

  const diagnostics = createDiagnostics();
  const app = express();
  app.use(express.json());
  app.use('/api/fleet', fleetRoutes(Promise.resolve(fleet), { diagnostics }));
  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/fleet`;

  await fleet.close();

  const postRoutes = [
    ['/up', { cell: 'Dev' }],
    ['/down', { cell: 'Dev' }],
    ['/restart', { cell: 'Dev' }],
    ['/define-cell', { def: { id: 'c2', cwd: world.cwd, engine: 'claude' } }],
    ['/reconcile', { cell: 'Dev', launchId: 'ab'.repeat(16) }],
    ['/vl-new-session', { cell: 'VlCell' }],
  ];
  for (const [route, payload] of postRoutes) {
    const res = await fetch(`${baseUrl}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 503, `POST ${route} returns 503`);
    const body = await res.json();
    assert.equal(body.code, 'RUNTIME_DISARMED', `POST ${route} exposes RUNTIME_DISARMED (not UNKNOWN)`);
    assert.equal(body.phase, 'preflight');
    assert.equal(body.error.includes(world.home), false, `POST ${route} error contains no path`);
    assert.equal(body.error.includes(world.root), false, `POST ${route} error contains no temp root`);
  }

  for (const getRoute of ['/status', '/definitions', '/launch-state?cell=Dev', '/vl-new-session-state?cell=VlCell']) {
    const res = await fetch(`${baseUrl}${getRoute}`);
    assert.equal(res.status, 200, `GET ${getRoute} remains served after disarm`);
  }
});

test('runtime translates internal mid-pin claim disarm into 503 RUNTIME_DISARMED without paths', async (t) => {
  const world = makeWorld(t, { withVlCell: true });
  let rtRef = null;
  const { rt } = runtimeFromWorld(world, {
    rtOpts: {
      cellLeaseRequired: false,
      identityOwnerInstanceId: 'aa'.repeat(16),
      riservaRootClaim: (opts) => {
        // Trigger runtime disarm while reservation is between admission and completion.
        const admission = opts.consumerTracker.beginAdmitted();
        rtRef.disarm();
        if (opts.consumerTracker.isDisarmed()) {
          opts.consumerTracker.endConsumer(admission.token, 'disarmed');
          return {
            ok: false,
            outcome: 'refused',
            code: 'CLAIM_DISARMED',
            motivo: 'disarmed',
          };
        }
        opts.consumerTracker.endConsumer(admission.token, 'close');
        return { ok: true, holder: 'test', lockFile: 'lock' };
      },
    },
  });
  rtRef = rt;

  await assert.rejects(
    () => rt.up('VlCell'),
    (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.fleetCode, 'RUNTIME_DISARMED');
      assert.equal(err.fleetPhase, 'preflight');
      assert.notEqual(err.fleetCode, 'CLAIM_DISARMED');
      assert.notEqual(err.fleetCode, 'PIN_REREAD');
      assert.equal(String(err.message).includes(world.home), false);
      assert.equal(String(err.message).includes(world.root), false);
      return true;
    },
  );
  rt.shutdown();
});

test('HTTP POST /api/fleet/up exposes PIN_REREAD for genuine failure and 503 RUNTIME_DISARMED on claim disarm without CLAIM_DISARMED or raw motivo', async (t) => {
  const world = makeWorld(t, { withVlCell: true });
  let disarmNext = false;
  let rtRef = null;
  const { rt } = runtimeFromWorld(world, {
    rtOpts: {
      cellLeaseRequired: false,
      identityOwnerInstanceId: 'aa'.repeat(16),
      riservaRootClaim: (opts) => {
        if (disarmNext) {
          const adm = opts.consumerTracker.beginAdmitted();
          rtRef.disarm();
          opts.consumerTracker.endConsumer(adm.token, 'disarmed');
          return {
            ok: false,
            outcome: 'refused',
            code: 'CLAIM_DISARMED',
            motivo: 'raw-disarmed-internal-reason',
          };
        }
        return {
          ok: false,
          outcome: 'refused',
          code: 'PIN_REREAD',
          component: 'node',
          platform: 'linux-x64',
          motivo: 'raw-fotografia-secret',
        };
      },
    },
  });
  rtRef = rt;

  const fleetSurface = {
    available: true,
    provider: 'builtin',
    status: rt.status,
    up: rt.up,
    down: rt.down,
    restart: rt.restart,
    isDisarmed: rt.isDisarmed,
    disarm: rt.disarm,
  };
  const diagnostics = createDiagnostics();
  const app = express();
  app.use(express.json());
  app.use('/api/fleet', fleetRoutes(Promise.resolve(fleetSurface), { diagnostics }));
  const server = await new Promise((resolve) => {
    const s = http.createServer(app);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  t.after(() => rt.shutdown());
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/fleet`;

  // 1. Genuine PIN_REREAD keeps HTTP 500 + PIN_REREAD without leaking raw motivo or paths.
  const resPin = await fetch(`${baseUrl}/up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cell: 'VlCell' }),
  });
  assert.equal(resPin.status, 500);
  const bodyPin = await resPin.json();
  assert.equal(bodyPin.code, 'PIN_REREAD');
  assert.equal(bodyPin.phase, 'preflight');
  assert.notEqual(bodyPin.code, 'RUNTIME_DISARMED');
  assert.equal(JSON.stringify(bodyPin).includes('raw-fotografia-secret'), false);
  assert.equal(JSON.stringify(bodyPin).includes('CLAIM_DISARMED'), false);
  assert.equal(JSON.stringify(bodyPin).includes(world.home), false);
  assert.equal(JSON.stringify(bodyPin).includes(world.root), false);

  // 2. Claim disarm during pin/claim produces HTTP 503 RUNTIME_DISARMED without CLAIM_DISARMED or raw motivo.
  disarmNext = true;
  const resDisarm = await fetch(`${baseUrl}/up`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cell: 'VlCell' }),
  });
  assert.equal(resDisarm.status, 503);
  const bodyDisarm = await resDisarm.json();
  assert.equal(bodyDisarm.code, 'RUNTIME_DISARMED');
  assert.equal(bodyDisarm.phase, 'preflight');
  assert.equal(JSON.stringify(bodyDisarm).includes('CLAIM_DISARMED'), false);
  assert.equal(JSON.stringify(bodyDisarm).includes('raw-disarmed-internal-reason'), false);
  assert.equal(JSON.stringify(bodyDisarm).includes(world.home), false);
  assert.equal(JSON.stringify(bodyDisarm).includes(world.root), false);
});

function createSeparateClockAndTimers(initialMs = 40000) {
  let now = initialMs;
  let nextId = 1;
  const timers = new Map();
  const scheduledDelays = [];
  return {
    now: () => now,
    advanceClockOnly(deltaMs) {
      now += deltaMs;
    },
    setTimer(fn, delay) {
      const id = nextId++;
      const ms = Math.max(0, Number(delay) || 0);
      scheduledDelays.push(ms);
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    pendingCount: () => timers.size,
    scheduledDelays: () => [...scheduledDelays],
  };
}

test('late child close after deadline before timer fires yields non-quiescent completed_with_residues', async (t) => {
  const world = makeWorld(t);
  const clock = createSeparateClockAndTimers(40000);
  const fleet = await createBuiltinFleet({
    home: world.home,
    filesRoot: world.filesRoot,
    fleetDefsPath: world.defsPath,
    tmuxBin: world.tmuxBin,
    protectSharedTmuxServer: false,
    ensureTmuxProtection: () => {},
    launchBroker: makeFakeBroker(),
    nowMono: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    sendKeysReadyMs: 1,
  });

  const slowChild = createFakeChild();
  const admitted = fleet.claimTracker.beginAdmitted();
  assert.equal(admitted.ok, true);
  assert.equal(fleet.claimTracker.attachChild(admitted.token, slowChild), true);

  const closeP = fleet.close({ deadlineMono: clock.now() + 200 });
  await nextTickImmediate();
  assert.equal(clock.pendingCount(), 1, 'waitIdle timer is armed before deadline expires');

  // Advance monotonic clock past deadline WITHOUT firing the timer.
  clock.advanceClockOnly(250);
  assert.equal(clock.pendingCount(), 1, 'timer has not fired yet');

  // Child closes late (after deadline, before timer callback).
  slowChild.emit('close', 0);

  const outcome = await closeP;
  assert.equal(clock.pendingCount(), 0, 'waitIdle cleared timer on drain wakeup');
  assert.equal(outcome.ok, true);
  assert.equal(outcome.quiescent, false);
  assert.equal(outcome.status, 'completed_with_residues');
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.budgetExhausted, true);
  assert.deepEqual(outcome.codes, ['CLAIM_DRAIN_TIMEOUT']);
  assert.equal(outcome.claims.idle, true);
  assert.equal(outcome.claims.timedOut, true);
  assert.equal(outcome.claims.drainExpired, true);
  assert.equal(outcome.claims.code, 'CLAIM_DRAIN_TIMEOUT');
  assert.equal(outcome.claims.activeCount, 0);
  assert.equal(fleet.claimTracker.canCleanupOwnedResources(), false);
});

test('child close before deadline yields quiescent completed and permits resource cleanup', async (t) => {
  const world = makeWorld(t);
  const clock = createSeparateClockAndTimers(41000);
  const fleet = await createBuiltinFleet({
    home: world.home,
    filesRoot: world.filesRoot,
    fleetDefsPath: world.defsPath,
    tmuxBin: world.tmuxBin,
    protectSharedTmuxServer: false,
    ensureTmuxProtection: () => {},
    launchBroker: makeFakeBroker(),
    nowMono: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    sendKeysReadyMs: 1,
  });

  const child = createFakeChild();
  const admitted = fleet.claimTracker.beginAdmitted();
  assert.equal(admitted.ok, true);
  assert.equal(fleet.claimTracker.attachChild(admitted.token, child), true);

  const closeP = fleet.close({ deadlineMono: clock.now() + 200 });
  await nextTickImmediate();
  assert.equal(clock.pendingCount(), 1);

  clock.advanceClockOnly(50);
  child.emit('close', 0);

  const outcome = await closeP;
  assert.equal(clock.pendingCount(), 0);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.quiescent, true);
  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.budgetExhausted, false);
  assert.deepEqual(outcome.codes, []);
  assert.equal(outcome.claims.idle, true);
  assert.equal(outcome.claims.timedOut, false);
  assert.equal(outcome.claims.drainExpired, false);
  assert.equal(outcome.claims.code, null);
  assert.equal(outcome.claims.activeCount, 0);
  assert.equal(fleet.claimTracker.canCleanupOwnedResources(), true);
});

test('queued down after disarm rejects with 503 RUNTIME_DISARMED and executes zero teardown', async (t) => {
  const world = makeWorld(t);
  const firstGate = deferred();
  const firstEntered = deferred();
  let issueCalls = 0;

  const broker = makeFakeBroker(null, {
    onIssue: async () => {
      issueCalls += 1;
      if (issueCalls === 1) {
        firstEntered.resolve();
        await firstGate.promise;
      }
    },
  });

  const fleet = await createBuiltinFleet({
    home: world.home,
    filesRoot: world.filesRoot,
    fleetDefsPath: world.defsPath,
    tmuxBin: world.tmuxBin,
    protectSharedTmuxServer: false,
    ensureTmuxProtection: () => {},
    launchBroker: broker,
    sendKeysReadyMs: 1,
  });

  const p1 = fleet.up('Dev');
  await firstEntered.promise;

  // Enter down() while armed, then wait on launchLocks('Dev') behind p1.
  const p2 = fleet.down('Dev');
  await nextTickImmediate();

  const closeP = fleet.close({ budgetMs: 1500 });
  firstGate.resolve();

  const [r1, r2, closed] = await Promise.allSettled([p1, p2, closeP]);
  assert.equal(r1.status, 'rejected');
  assert.equal(r1.reason.status, 503);
  assert.equal(r1.reason.fleetCode, 'RUNTIME_DISARMED');
  assert.equal(r1.reason.fleetPhase, 'launch-broker');
  assert.equal(r2.status, 'rejected');
  assert.equal(r2.reason.status, 503);
  assert.equal(r2.reason.fleetCode, 'RUNTIME_DISARMED');
  assert.equal(r2.reason.fleetPhase, 'preflight');

  const logLines = fs.readFileSync(world.log, 'utf8').split('\n').filter(Boolean);
  assert.equal(logLines.filter((l) => l === 'kill-session').length, 0, 'queued down executed zero kill-session');
  assert.equal(logLines.filter((l) => l === 'new-session').length, 0);
  assert.equal(closed.status, 'fulfilled');
  assert.equal(closed.value.quiescent, true);
});

test('queued restart disarmed before down step rejects with 503 RUNTIME_DISARMED and executes zero teardown or relaunch', async (t) => {
  const world = makeWorld(t);
  const firstGate = deferred();
  const firstEntered = deferred();
  let issueCalls = 0;

  const broker = makeFakeBroker(null, {
    onIssue: async () => {
      issueCalls += 1;
      if (issueCalls === 1) {
        firstEntered.resolve();
        await firstGate.promise;
      }
    },
  });

  const fleet = await createBuiltinFleet({
    home: world.home,
    filesRoot: world.filesRoot,
    fleetDefsPath: world.defsPath,
    tmuxBin: world.tmuxBin,
    protectSharedTmuxServer: false,
    ensureTmuxProtection: () => {},
    launchBroker: broker,
    sendKeysReadyMs: 1,
  });

  const p1 = fleet.up('Dev');
  await firstEntered.promise;

  const p2 = fleet.restart('Dev');
  await nextTickImmediate();
  assert.equal(issueCalls, 1);

  const closeP = fleet.close({ budgetMs: 1500 });
  firstGate.resolve();

  const [r1, r2, closed] = await Promise.allSettled([p1, p2, closeP]);
  assert.equal(r1.status, 'rejected');
  assert.equal(r1.reason.status, 503);
  assert.equal(r1.reason.fleetCode, 'RUNTIME_DISARMED');
  assert.equal(r1.reason.fleetPhase, 'launch-broker');
  assert.equal(r2.status, 'rejected');
  assert.equal(r2.reason.status, 503);
  assert.equal(r2.reason.fleetCode, 'RUNTIME_DISARMED');
  assert.equal(r2.reason.fleetPhase, 'preflight');
  assert.equal(issueCalls, 1, 'queued restart never entered upSerializzato / broker.issue');

  const logLines = fs.readFileSync(world.log, 'utf8').split('\n').filter(Boolean);
  assert.equal(logLines.filter((l) => l === 'kill-session').length, 0, 'queued restart never entered downSerializzato');
  assert.equal(logLines.filter((l) => l === 'new-session').length, 0);
  assert.equal(closed.status, 'fulfilled');
  assert.equal(closed.value.quiescent, true);
});

test('queued restart disarmed after down step before up step rejects with 503 RUNTIME_DISARMED without relaunch', async (t) => {
  const world = makeWorld(t);
  const firstGate = deferred();
  const firstEntered = deferred();
  let issueCalls = 0;
  let revokeCalls = 0;

  const broker = makeFakeBroker(null, {
    onIssue: async () => {
      issueCalls += 1;
      if (issueCalls === 1) {
        firstEntered.resolve();
        await firstGate.promise;
      }
    },
  });

  let rtRef = null;
  const leaseManager = {
    ...makeFakeLease(),
    revokeControl() {
      revokeCalls += 1;
      // Disarm synchronously at the end of downSerializzato, right before
      // restart() checks `if (disarmed)` ahead of upSerializzato().
      rtRef.disarm();
    },
  };

  const { rt } = runtimeFromWorld(world, {
    launchBroker: broker,
    leaseManager,
  });
  rtRef = rt;
  t.after(() => { try { rt.shutdown(); } catch (_) {} });

  const p1 = rt.up('Dev');
  await firstEntered.promise;

  // Queue restart behind p1 while still armed, then release p1 so restart passes
  // the first post-await check, executes downSerializzato(), and sees disarm before upSerializzato().
  const p2 = rt.restart('Dev');
  await nextTickImmediate();
  firstGate.resolve();

  const [r1, r2] = await Promise.allSettled([p1, p2]);
  assert.equal(r1.status, 'fulfilled');
  assert.equal(r2.status, 'rejected');
  assert.equal(r2.reason.status, 503);
  assert.equal(r2.reason.fleetCode, 'RUNTIME_DISARMED');
  assert.equal(r2.reason.fleetPhase, 'preflight');
  assert.equal(revokeCalls, 1, 'downSerializzato ran and triggered mid-restart disarm');
  assert.equal(issueCalls, 1, 'second post-await guard blocked upSerializzato / broker.issue');

  const logLines = fs.readFileSync(world.log, 'utf8').split('\n').filter(Boolean);
  assert.equal(logLines.filter((l) => l === 'kill-session').length, 1);
  assert.equal(logLines.filter((l) => l === 'new-session').length, 1, 'no second new-session spawned');
});

test('queued reconcile after disarm rejects with 503 RUNTIME_DISARMED and performs zero reconciliation', async (t) => {
  const world = makeWorld(t);
  const firstGate = deferred();
  const firstEntered = deferred();
  let issueCalls = 0;

  const broker = makeFakeBroker(null, {
    onIssue: async () => {
      issueCalls += 1;
      if (issueCalls === 1) {
        firstEntered.resolve();
        await firstGate.promise;
      }
    },
  });

  const fleet = await createBuiltinFleet({
    home: world.home,
    filesRoot: world.filesRoot,
    fleetDefsPath: world.defsPath,
    tmuxBin: world.tmuxBin,
    protectSharedTmuxServer: false,
    ensureTmuxProtection: () => {},
    launchBroker: broker,
    sendKeysReadyMs: 1,
  });

  const p1 = fleet.up('Dev');
  await firstEntered.promise;

  // Queue reconcile behind active up() while armed.
  const p2 = fleet.reconcile('Dev', '0123456789abcdef');
  await nextTickImmediate();

  const closeP = fleet.close({ budgetMs: 1500 });
  firstGate.resolve();

  const [r1, r2, closed] = await Promise.allSettled([p1, p2, closeP]);
  assert.equal(r1.status, 'rejected');
  assert.equal(r1.reason.status, 503);
  assert.equal(r1.reason.fleetCode, 'RUNTIME_DISARMED');
  assert.equal(r1.reason.fleetPhase, 'launch-broker');
  assert.equal(r2.status, 'rejected');
  assert.equal(r2.reason.status, 503);
  assert.equal(r2.reason.fleetCode, 'RUNTIME_DISARMED');
  assert.equal(r2.reason.fleetPhase, 'preflight');
  assert.equal(issueCalls, 1);
  assert.equal(fs.existsSync(path.join(world.filesRoot, 'launch-targets', 'reconciled')), false, 'reconcile created no quarantine directory');

  const logLines = fs.readFileSync(world.log, 'utf8').split('\n').filter(Boolean);
  assert.equal(logLines.filter((l) => l === 'kill-session').length, 0);
  assert.equal(logLines.filter((l) => l === 'new-session').length, 0);
  assert.equal(closed.status, 'fulfilled');
  assert.equal(closed.value.quiescent, true);
});

test('disarm during pending launchBroker.issue refuses with 503 RUNTIME_DISARMED, revokes ticket, and performs zero spawn', async (t) => {
  // 1. Non-VL launch paused in launchBroker.issue
  const world = makeWorld(t);
  const issueEntered = deferred();
  const issueGate = deferred();
  const broker = makeFakeBroker(null, {
    onIssue: async () => {
      issueEntered.resolve();
      await issueGate.promise;
    },
  });
  const { rt } = runtimeFromWorld(world, { launchBroker: broker });
  t.after(() => { try { rt.shutdown(); } catch (_) {} });

  const upP = rt.up('Dev');
  await issueEntered.promise;
  rt.disarm();
  issueGate.resolve();

  await assert.rejects(upP, {
    status: 503,
    fleetCode: 'RUNTIME_DISARMED',
    fleetPhase: 'launch-broker',
  });
  assert.deepEqual(broker.revokedNonces, ['nonce-1']);
  const logLines = fs.readFileSync(world.log, 'utf8').split('\n').filter(Boolean);
  assert.equal(logLines.filter((l) => l === 'new-session').length, 0);
  assert.equal(logLines.filter((l) => l === 'respawn-pane').length, 0);
  const targetDir = path.join(world.filesRoot, 'launch-targets');
  const leftover = fs.existsSync(targetDir)
    ? fs.readdirSync(targetDir).filter((n) => n.endsWith('.json') && !n.startsWith('.'))
    : [];
  assert.deepEqual(leftover, []);

  // 2. Positive armed control succeeds with zero interference.
  const armedWorld = makeWorld(t);
  const { rt: rtArmed } = runtimeFromWorld(armedWorld);
  t.after(() => { try { rtArmed.shutdown(); } catch (_) {} });
  const armedRes = await rtArmed.up('Dev');
  assert.equal(armedRes.ok, true);
});

test('disarm during final ensureProtection before creating refuses with 503 RUNTIME_DISARMED, revokes ticket, and never starts session', async (t) => {
  const world = makeWorld(t);
  const protEntered = deferred();
  const protGate = deferred();
  let protCalls = 0;
  const broker = makeFakeBroker();

  const { rt } = runtimeFromWorld(world, {
    launchBroker: broker,
    rtOpts: {
      ensureProtection: async () => {
        protCalls += 1;
        if (protCalls === 2) {
          protEntered.resolve();
          await protGate.promise;
        }
      },
    },
  });
  t.after(() => { try { rt.shutdown(); } catch (_) {} });

  const upP = rt.up('Dev');
  await protEntered.promise;
  assert.equal(protCalls, 2);
  rt.disarm();
  protGate.resolve();

  await assert.rejects(upP, {
    status: 503,
    fleetCode: 'RUNTIME_DISARMED',
    fleetPhase: 'new-session',
  });
  assert.deepEqual(broker.revokedNonces, ['nonce-1']);
  const logLines = fs.readFileSync(world.log, 'utf8').split('\n').filter(Boolean);
  assert.equal(logLines.filter((l) => l === 'new-session').length, 0);
  assert.equal(logLines.filter((l) => l === 'respawn-pane').length, 0);
  const targetDir = path.join(world.filesRoot, 'launch-targets');
  const leftover = fs.existsSync(targetDir)
    ? fs.readdirSync(targetDir).filter((n) => n.endsWith('.json') && !n.startsWith('.'))
    : [];
  assert.deepEqual(leftover, []);

  // Positive control when armed through final ensureProtection.
  const armedWorld = makeWorld(t);
  const { rt: rtArmed } = runtimeFromWorld(armedWorld);
  t.after(() => { try { rtArmed.shutdown(); } catch (_) {} });
  const armedRes = await rtArmed.up('Dev');
  assert.equal(armedRes.ok, true);
});

test('disarm during placeholder setup before respawn-pane kills placeholder, revokes ticket, and performs zero respawn-pane', async (t) => {
  const world = makeWorld(t);
  const armEnteredFile = path.join(world.root, 'arm-entered');
  const armReleaseFile = path.join(world.root, 'arm-release');
  const gatedTmux = path.join(world.root, 'fake-tmux-gated.sh');
  const baseTmuxContent = fs.readFileSync(world.tmuxBin, 'utf8');
  const gatedContent = baseTmuxContent.replace(
    'set-option|set-hook|respawn-pane|load-buffer|paste-buffer|delete-buffer)',
    `set-option)
    echo "$cmd" >> "$LOG"
    case " $* " in
      *" remain-on-exit "*)
        : > ${shellQ(armEnteredFile)}
        i=0
        while [ ! -f ${shellQ(armReleaseFile)} ] && [ "$i" -lt 400 ]; do
          i=$((i+1))
          sleep 0.01
        done
        ;;
    esac
    exit 0 ;;
  set-hook|respawn-pane|load-buffer|paste-buffer|delete-buffer)`,
  );
  assert.notEqual(gatedContent, baseTmuxContent);
  fs.writeFileSync(gatedTmux, gatedContent, { mode: 0o755 });
  fs.chmodSync(gatedTmux, 0o755);

  const broker = makeFakeBroker();
  const { rt } = runtimeFromWorld({ ...world, tmuxBin: gatedTmux }, { launchBroker: broker });
  t.after(() => { try { rt.shutdown(); } catch (_) {} });

  const upP = rt.up('Dev');
  for (let i = 0; i < 400 && !fs.existsSync(armEnteredFile); i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(fs.existsSync(armEnteredFile), true, 'reached placeholder remain-on-exit setup');

  rt.disarm();
  fs.writeFileSync(armReleaseFile, 'go');

  await assert.rejects(upP, {
    status: 503,
    fleetCode: 'RUNTIME_DISARMED',
    fleetPhase: 'new-session',
  });
  assert.deepEqual(broker.revokedNonces, ['nonce-1']);
  const logLines = fs.readFileSync(world.log, 'utf8').split('\n').filter(Boolean);
  assert.equal(logLines.filter((l) => l === 'new-session').length, 1, 'placeholder session created');
  assert.equal(logLines.filter((l) => l === 'kill-session').length, 1, 'placeholder session killed on owned channel');
  assert.equal(logLines.filter((l) => l === 'respawn-pane').length, 0, 'zero respawn-pane executed after disarm');

  // Positive armed control through remain-on-exit gate completes respawn-pane normally.
  const armedWorld = makeWorld(t);
  const { rt: rtArmed } = runtimeFromWorld(armedWorld);
  t.after(() => { try { rtArmed.shutdown(); } catch (_) {} });
  const armedRes = await rtArmed.up('Dev');
  assert.equal(armedRes.ok, true);
  const armedLog = fs.readFileSync(armedWorld.log, 'utf8').split('\n').filter(Boolean);
  assert.equal(armedLog.filter((l) => l === 'respawn-pane').length, 1);
});

test('runtime rollback (rilasciaClaimPre) and down (rilasciaRadiceDown) pass claimTracker to real rilascia and refuse release after disarm leaving claim/record intact', async (t) => {
  // 1a. Armed rollback (rilasciaClaimPre) tracks release child until close via rt.claimTracker.
  const ownerId = 'aa'.repeat(16);
  const worldRbArmed = makeWorld(t, { withVlCell: true });
  const binDirRbArmed = path.join(worldRbArmed.root, 'pin-bin-rb-armed');
  fs.mkdirSync(binDirRbArmed, { mode: 0o700 });
  const fakeNodeRbArmed = path.join(binDirRbArmed, 'node-rel');
  fs.writeFileSync(fakeNodeRbArmed, `#!/bin/sh\necho "v${process.versions.node}"\n`, { mode: 0o500 });
  fs.chmodSync(fakeNodeRbArmed, 0o500);

  let armedChild = null;
  const armedChildSpawned = deferred();
  let rtRbArmedRef = null;
  const { rt: rtRbArmed } = runtimeFromWorld(worldRbArmed, {
    rtOpts: {
      cellLeaseRequired: false,
      identityOwnerInstanceId: ownerId,
      riservaRootClaim: async () => ({ ok: true, outcome: 'claimed' }),
      rilasciaRootClaim: (opts) => vlRoots.rilascia({
        ...opts,
        pinDeps: {
          execPath: fakeNodeRbArmed,
          nodeProbe: () => ({ status: 0, stdout: `${process.versions.node}\n`, stderr: '' }),
        },
        spawnImpl: () => {
          const c = new EventEmitter();
          let raw = '';
          c.stdin = { write(ch) { raw += String(ch); }, end() {} };
          c.stdout = new EventEmitter();
          c.stderr = new EventEmitter();
          c.kill = () => {};
          c.completeRelease = () => {
            const req = JSON.parse(raw.trim());
            c.stdout.emit('data', Buffer.from(`${JSON.stringify({
              v: 1, requestId: req.requestId, outcome: 'released', ok: true, lockHeld: false,
            })}\n`, 'utf8'));
            c.emit('close', 0);
          };
          armedChild = c;
          assert.equal(opts.consumerTracker, rtRbArmedRef.claimTracker);
          armedChildSpawned.resolve();
          return c;
        },
      }),
    },
  });
  rtRbArmedRef = rtRbArmed;
  t.after(() => { try { rtRbArmed.shutdown(); } catch (_) {} });

  const upRbArmedP = rtRbArmed.up('VlCell');
  await armedChildSpawned.promise;
  assert.equal(rtRbArmed.claimTracker.snapshot().activeCount, 1);
  armedChild.completeRelease();
  await assert.rejects(upRbArmedP, { status: 400, fleetCode: 'ENGINE_UNCONFIGURED' });
  assert.equal(rtRbArmed.claimTracker.snapshot().activeCount, 0);

  // 1b. Rollback (rilasciaClaimPre) after disarm:
  //     real vlRoots.rilascia receives rt.claimTracker, refuses with CLAIM_DISARMED before pin/spawn,
  //     and leaves the VL prepared record on disk without spawning any release child.
  const worldRb = makeWorld(t, { withVlCell: true });
  const binDirRb = path.join(worldRb.root, 'pin-bin-rb');
  fs.mkdirSync(binDirRb, { mode: 0o700 });
  const fakeNodeRb = path.join(binDirRb, 'node-rel');
  fs.writeFileSync(fakeNodeRb, `#!/bin/sh\necho "v${process.versions.node}"\n`, { mode: 0o500 });
  fs.chmodSync(fakeNodeRb, 0o500);

  let rbReleaseCalls = 0;
  let rbSpawnCalls = 0;
  let rbProbeCalls = 0;
  let rtRbRef = null;
  const { rt: rtRb } = runtimeFromWorld(worldRb, {
    rtOpts: {
      cellLeaseRequired: false,
      identityOwnerInstanceId: ownerId,
      riservaRootClaim: async () => {
        rtRbRef.disarm();
        return { ok: true, outcome: 'claimed' };
      },
      rilasciaRootClaim: (opts) => {
        rbReleaseCalls += 1;
        assert.equal(opts.consumerTracker, rtRbRef.claimTracker, 'rilasciaClaimPre passes claimTracker');
        return vlRoots.rilascia({
          ...opts,
          pinDeps: {
            execPath: fakeNodeRb,
            nodeProbe: () => {
              rbProbeCalls += 1;
              return { status: 0, stdout: `${process.versions.node}\n`, stderr: '' };
            },
          },
          spawnImpl: () => {
            rbSpawnCalls += 1;
            return createFakeChild();
          },
        });
      },
    },
  });
  rtRbRef = rtRb;
  t.after(() => { try { rtRb.shutdown(); } catch (_) {} });

  await assert.rejects(rtRb.up('VlCell'), {
    status: 503,
    fleetCode: 'RUNTIME_DISARMED',
    fleetPhase: 'preflight',
  });
  assert.equal(rbReleaseCalls, 1);
  assert.equal(rbProbeCalls, 0, 'disarmed rilasciaClaimPre did not probe pin');
  assert.equal(rbSpawnCalls, 0, 'disarmed rilasciaClaimPre did not spawn helper');
  const recAfterRb = launchTarget.leggi(worldRb.filesRoot, 'work-vl');
  assert.equal(recAfterRb.stato, 'presente', 'prepared record preserved when release disarmed');
  assert.equal(recAfterRb.record.phase, 'prepared');

  // 2. Down (rilasciaRadiceDown) on dead prepared VL record paused in pre-release probe and then disarmed:
  //    real vlRoots.rilascia receives rt.claimTracker, refuses with CLAIM_DISARMED before pin/spawn,
  //    rejects down with 503 RUNTIME_DISARMED, and keeps prepared record intact.
  const worldDown = makeWorld(t, { withVlCell: true });
  fs.writeFileSync(path.join(worldDown.root, 'alive'), '0');
  const hsEnteredFile = path.join(worldDown.root, 'hs-entered');
  const hsReleaseFile = path.join(worldDown.root, 'hs-release');
  const gatedHsTmux = path.join(worldDown.root, 'fake-tmux-hs-gated.sh');
  const baseTmuxDown = fs.readFileSync(worldDown.tmuxBin, 'utf8');
  const gatedHsContent = baseTmuxDown.replace(
    '    [ -f "$ALIVE" ] && [ "$(cat "$ALIVE" 2>/dev/null)" = "0" ] && exit 1',
    `    : > ${shellQ(hsEnteredFile)}
    i=0
    while [ ! -f ${shellQ(hsReleaseFile)} ] && [ "$i" -lt 400 ]; do
      i=$((i+1))
      sleep 0.01
    done
    [ -f "$ALIVE" ] && [ "$(cat "$ALIVE" 2>/dev/null)" = "0" ] && { echo "can't find session" >&2; exit 1; }`,
  );
  assert.notEqual(gatedHsContent, baseTmuxDown);
  fs.writeFileSync(gatedHsTmux, gatedHsContent, { mode: 0o755 });
  fs.chmodSync(gatedHsTmux, 0o755);

  const binDirDown = path.join(worldDown.root, 'pin-bin-down');
  fs.mkdirSync(binDirDown, { mode: 0o700 });
  const fakeNodeDown = path.join(binDirDown, 'node-rel');
  fs.writeFileSync(fakeNodeDown, `#!/bin/sh\necho "v${process.versions.node}"\n`, { mode: 0o500 });
  fs.chmodSync(fakeNodeDown, 0o500);

  const prepDown = launchTarget.registraPrepared(worldDown.filesRoot, 'work-vl', {
    launchId: 'aa11223344556677',
    family: 'vl',
    cellId: 'VlCell',
    ownerInstanceId: ownerId,
    tmuxSocket: '/tmp/nonexistent-nc-sock-down',
    bootId: '11111111-1111-4111-8111-111111111111',
    pidNs: '4026531836',
    daemonInc: 'stale-daemon-inc',
    res: {
      vlOwner: ownerId,
      vlRoot: vlRoots.radiceServer(worldDown.home, ownerId, 'VlCell'),
    },
    ora: Date.now(),
  });
  assert.equal(prepDown.ok, true);

  let downReleaseCalls = 0;
  let downSpawnCalls = 0;
  let downProbeCalls = 0;
  let rtDownRef = null;
  const { rt: rtDown } = runtimeFromWorld({ ...worldDown, tmuxBin: gatedHsTmux }, {
    rtOpts: {
      cellLeaseRequired: false,
      identityOwnerInstanceId: ownerId,
      rilasciaRootClaim: (opts) => {
        downReleaseCalls += 1;
        assert.equal(opts.consumerTracker, rtDownRef.claimTracker, 'rilasciaRadiceDown passes claimTracker');
        return vlRoots.rilascia({
          ...opts,
          pinDeps: {
            execPath: fakeNodeDown,
            nodeProbe: () => {
              downProbeCalls += 1;
              return { status: 0, stdout: `${process.versions.node}\n`, stderr: '' };
            },
          },
          spawnImpl: () => {
            downSpawnCalls += 1;
            return createFakeChild();
          },
        });
      },
    },
  });
  rtDownRef = rtDown;
  t.after(() => { try { rtDown.shutdown(); } catch (_) {} });

  const downP = rtDown.down('VlCell');
  for (let i = 0; i < 400 && !fs.existsSync(hsEnteredFile); i += 1) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.equal(fs.existsSync(hsEnteredFile), true, 'down reached pre-release evaluation');
  rtDown.disarm();
  fs.writeFileSync(hsReleaseFile, 'go');

  await assert.rejects(downP, {
    status: 503,
    fleetCode: 'RUNTIME_DISARMED',
    fleetPhase: 'preflight',
  });
  assert.equal(downReleaseCalls, 1);
  assert.equal(downProbeCalls, 0, 'disarmed rilasciaRadiceDown did not probe pin');
  assert.equal(downSpawnCalls, 0, 'disarmed rilasciaRadiceDown did not spawn helper');
  const recAfterDown = launchTarget.leggi(worldDown.filesRoot, 'work-vl');
  assert.equal(recAfterDown.stato, 'presente', 'prepared record preserved when down release disarmed');

  // 3. Independent armed runtime tracks child error-without-close on rilasciaRadiceDown until close,
  //    keeping cleanup blocked even after down() rejects LOCK_UNAVAILABLE -> CLAIM_UNCERTAIN.
  const worldErr = makeWorld(t, { withVlCell: true });
  fs.writeFileSync(path.join(worldErr.root, 'alive'), '0');
  const absentTmuxErr = path.join(worldErr.root, 'fake-tmux-absent.sh');
  const baseTmuxErr = fs.readFileSync(worldErr.tmuxBin, 'utf8');
  fs.writeFileSync(
    absentTmuxErr,
    baseTmuxErr.replace(
      '    [ -f "$ALIVE" ] && [ "$(cat "$ALIVE" 2>/dev/null)" = "0" ] && exit 1',
      '    [ -f "$ALIVE" ] && [ "$(cat "$ALIVE" 2>/dev/null)" = "0" ] && { echo "can\'t find session" >&2; exit 1; }',
    ),
    { mode: 0o755 },
  );
  fs.chmodSync(absentTmuxErr, 0o755);
  const binDirErr = path.join(worldErr.root, 'pin-bin-err');
  fs.mkdirSync(binDirErr, { mode: 0o700 });
  const fakeNodeErr = path.join(binDirErr, 'node-rel');
  fs.writeFileSync(fakeNodeErr, `#!/bin/sh\necho "v${process.versions.node}"\n`, { mode: 0o500 });
  fs.chmodSync(fakeNodeErr, 0o500);
  const prepErr = launchTarget.registraPrepared(worldErr.filesRoot, 'work-vl', {
    launchId: 'bb11223344556677',
    family: 'vl',
    cellId: 'VlCell',
    ownerInstanceId: ownerId,
    tmuxSocket: '/tmp/nonexistent-nc-sock-err',
    bootId: '11111111-1111-4111-8111-111111111111',
    pidNs: '4026531836',
    daemonInc: 'stale-daemon-inc',
    res: {
      vlOwner: ownerId,
      vlRoot: vlRoots.radiceServer(worldErr.home, ownerId, 'VlCell'),
    },
    ora: Date.now(),
  });
  assert.equal(prepErr.ok, true);

  let spawnedErrChild = null;
  const errChildSpawned = deferred();
  const { rt: rtErr } = runtimeFromWorld({ ...worldErr, tmuxBin: absentTmuxErr }, {
    rtOpts: {
      cellLeaseRequired: false,
      identityOwnerInstanceId: ownerId,
      rilasciaRootClaim: (opts) => vlRoots.rilascia({
        ...opts,
        pinDeps: {
          execPath: fakeNodeErr,
          nodeProbe: () => ({ status: 0, stdout: `${process.versions.node}\n`, stderr: '' }),
        },
        spawnImpl: () => {
          spawnedErrChild = new EventEmitter();
          spawnedErrChild.stdin = { write() {}, end() {} };
          spawnedErrChild.stdout = new EventEmitter();
          spawnedErrChild.stderr = new EventEmitter();
          spawnedErrChild.kill = () => {};
          errChildSpawned.resolve();
          return spawnedErrChild;
        },
      }),
    },
  });
  t.after(() => { try { rtErr.shutdown(); } catch (_) {} });

  const downErrP = rtErr.down('VlCell');
  await Promise.race([
    errChildSpawned.promise,
    downErrP.then((r) => { throw new Error(`downErrP resolved early: ${JSON.stringify(r)}`); }),
  ]);
  spawnedErrChild.emit('error', new Error('eio before close'));
  await assert.rejects(downErrP, {
    status: 500,
    fleetCode: 'CLAIM_UNCERTAIN',
  });
  rtErr.disarm();
  assert.equal(rtErr.claimTracker.snapshot().activeCount, 1);
  assert.equal(rtErr.claimTracker.canCleanupOwnedResources(), false, 'cleanup forbidden until close fires');
  spawnedErrChild.emit('close', 1);
  assert.equal(rtErr.claimTracker.snapshot().activeCount, 0);
  assert.equal(rtErr.claimTracker.canCleanupOwnedResources(), true);
});

test('writer lock ack distinguishes unlink failure, replaced/unreadable file, double shutdown, and multi-quota refcount', async (t) => {
  // 1. Unlink failure (0500 dir): close reports non-quiescent residue, preserves lockfile and ownership,
  //    double shutdown retries without false ack, and fixing dir permissions lets subsequent shutdown release.
  const worldUnlink = makeWorld(t);
  const targetDir1 = path.join(worldUnlink.filesRoot, 'launch-targets');
  t.after(() => { try { fs.chmodSync(targetDir1, 0o700); } catch (_) {} });
  const fleet1 = await createBuiltinFleet({
    home: worldUnlink.home,
    filesRoot: worldUnlink.filesRoot,
    fleetDefsPath: worldUnlink.defsPath,
    tmuxBin: worldUnlink.tmuxBin,
    protectSharedTmuxServer: false,
    ensureTmuxProtection: () => {},
    launchBroker: makeFakeBroker(),
    sendKeysReadyMs: 1,
  });
  await fleet1.up('Dev');
  const lockFile1 = path.join(targetDir1, '.writer-lock.json');
  assert.equal(fs.existsSync(lockFile1), true);
  const initialLockRaw = fs.readFileSync(lockFile1, 'utf8');
  const initialToken = JSON.parse(initialLockRaw).token;

  fs.chmodSync(targetDir1, 0o500);
  const close1 = await fleet1.close({ budgetMs: 500 });
  assert.equal(close1.ok, true);
  assert.equal(close1.status, 'completed_with_residues');
  assert.equal(close1.quiescent, false);
  assert.equal(close1.writerLockHeld, true);
  assert.equal(close1.writerLockReleaseAttempted, true);
  assert.equal(close1.writerLockReleased, false);
  assert.equal(close1.writerLockReleaseFailed, true);
  assert.equal(close1.writerLockReleaseOutcome, 'unlink-failed');
  assert.ok(close1.codes.includes('WRITER_LOCK_HELD'));
  assert.ok(close1.codes.includes('WRITER_LOCK_RELEASE_FAILED'));
  assert.equal(fs.existsSync(lockFile1), true);

  // Double close returns same cached outcome without false ack; restoring permissions allows retry release.
  const close1Repeat = await fleet1.close({ budgetMs: 500 });
  assert.equal(close1Repeat, close1);
  assert.equal(launchWriterLock.verifica(worldUnlink.filesRoot, initialToken), true);
  fs.chmodSync(targetDir1, 0o700);
  assert.equal(launchWriterLock.rilascia(worldUnlink.filesRoot, initialToken), true);
  assert.equal(fs.existsSync(lockFile1), false);

  // Also test double rt.shutdown() on unlink failure then retry after chmod 0700.
  const worldDouble = makeWorld(t);
  const targetDirD = path.join(worldDouble.filesRoot, 'launch-targets');
  t.after(() => { try { fs.chmodSync(targetDirD, 0o700); } catch (_) {} });
  const { rt: rtDouble } = runtimeFromWorld(worldDouble);
  await rtDouble.up('Dev');
  const lockFileD = path.join(targetDirD, '.writer-lock.json');
  fs.chmodSync(targetDirD, 0o500);
  rtDouble.shutdown();
  assert.equal(rtDouble.shutdownState().writerLockReleased, false);
  assert.equal(rtDouble.shutdownState().writerLockReleaseFailed, true);
  assert.equal(rtDouble.shutdownState().writerLockHeld, true);
  assert.equal(rtDouble.shutdownState().writerLockReleaseOutcome, 'unlink-failed');
  rtDouble.shutdown();
  assert.equal(rtDouble.shutdownState().writerLockReleased, false);
  assert.equal(rtDouble.shutdownState().writerLockReleaseFailed, true);
  assert.equal(fs.existsSync(lockFileD), true);
  fs.chmodSync(targetDirD, 0o700);
  rtDouble.shutdown();
  assert.equal(rtDouble.shutdownState().writerLockReleased, true);
  assert.equal(rtDouble.shutdownState().writerLockReleaseFailed, false);
  assert.equal(rtDouble.shutdownState().writerLockHeld, false);
  assert.equal(fs.existsSync(lockFileD), false);

  // 2. Replaced lockfile on disk: never unlinked, reported as residue, double shutdown keeps non-released.
  const worldRep = makeWorld(t);
  const { rt: rtRep } = runtimeFromWorld(worldRep);
  await rtRep.up('Dev');
  const lockFileRep = path.join(worldRep.filesRoot, 'launch-targets', '.writer-lock.json');
  const foreignPayload = `${JSON.stringify({ v: 1, pid: process.pid + 99999, starttime: 1, token: 'foreign-token' })}\n`;
  fs.writeFileSync(lockFileRep, foreignPayload, { mode: 0o600 });
  fs.chmodSync(lockFileRep, 0o600);
  rtRep.shutdown();
  assert.equal(fs.existsSync(lockFileRep), true, 'replaced lockfile not unlinked');
  assert.equal(fs.readFileSync(lockFileRep, 'utf8'), foreignPayload, 'replaced lockfile untouched');
  assert.equal(rtRep.shutdownState().writerLockReleaseAttempted, true);
  assert.equal(rtRep.shutdownState().writerLockReleased, false);
  assert.equal(rtRep.shutdownState().writerLockReleaseFailed, true);
  assert.equal(rtRep.shutdownState().writerLockReleaseOutcome, 'replaced');
  rtRep.shutdown();
  assert.equal(rtRep.shutdownState().writerLockReleased, false);
  assert.equal(rtRep.shutdownState().writerLockReleaseFailed, true);
  assert.equal(fs.readFileSync(lockFileRep, 'utf8'), foreignPayload);

  // 3. Unreadable lockfile (mode 0644 instead of 0600) reported via fleet.close() as WRITER_LOCK_RELEASE_FAILED.
  const worldUnr = makeWorld(t);
  const fleetUnr = await createBuiltinFleet({
    home: worldUnr.home,
    filesRoot: worldUnr.filesRoot,
    fleetDefsPath: worldUnr.defsPath,
    tmuxBin: worldUnr.tmuxBin,
    protectSharedTmuxServer: false,
    ensureTmuxProtection: () => {},
    launchBroker: makeFakeBroker(),
    sendKeysReadyMs: 1,
  });
  await fleetUnr.up('Dev');
  const lockFileUnr = path.join(worldUnr.filesRoot, 'launch-targets', '.writer-lock.json');
  fs.chmodSync(lockFileUnr, 0o644);
  const closeUnr = await fleetUnr.close({ budgetMs: 500 });
  assert.equal(closeUnr.status, 'completed_with_residues');
  assert.equal(closeUnr.quiescent, false);
  assert.equal(closeUnr.writerLockReleaseAttempted, true);
  assert.equal(closeUnr.writerLockReleased, false);
  assert.equal(closeUnr.writerLockReleaseFailed, true);
  assert.equal(closeUnr.writerLockReleaseOutcome, 'unreadable');
  assert.ok(closeUnr.codes.includes('WRITER_LOCK_RELEASE_FAILED'));
  assert.equal(fs.existsSync(lockFileUnr), true, 'unreadable lockfile not unlinked');

  // 4. Positive release + two quotas in the same process sharing filesRoot:
  //    instance 1 releases its own quota (quota-released, quiescent: true) while lockfile stays valid for instance 2;
  //    instance 2 later releases and unlinks the file cleanly.
  const worldShared = makeWorld(t);
  // Give a second distinct cell in the same world so rtA and rtB can both run up() concurrently/sequentially.
  const defsShared = loadDefinitions(worldShared.defsPath);
  const cwdB = path.join(worldShared.home, 'DevB');
  fs.mkdirSync(cwdB, { mode: 0o700 });
  atomicWrite(worldShared.defsPath, {
    ...defsShared,
    cells: [
      ...defsShared.cells,
      { id: 'DevB', tmuxSession: 'work-build-b', cwd: cwdB, engine: 'claude', boot: false, prompt: 'test b' },
    ],
  });
  const fleetA = await createBuiltinFleet({
    home: worldShared.home,
    filesRoot: worldShared.filesRoot,
    fleetDefsPath: worldShared.defsPath,
    tmuxBin: worldShared.tmuxBin,
    protectSharedTmuxServer: false,
    ensureTmuxProtection: () => {},
    launchBroker: makeFakeBroker(),
    sendKeysReadyMs: 1,
  });
  const { rt: rtB } = runtimeFromWorld(worldShared);
  t.after(() => { try { rtB.shutdown(); } catch (_) {} });

  await fleetA.up('Dev');
  await rtB.up('DevB');
  const sharedLockFile = path.join(worldShared.filesRoot, 'launch-targets', '.writer-lock.json');
  const sharedToken = JSON.parse(fs.readFileSync(sharedLockFile, 'utf8')).token;
  assert.equal(launchWriterLock.verifica(worldShared.filesRoot, sharedToken), true);

  const closeA = await fleetA.close({ budgetMs: 500 });
  assert.equal(closeA.status, 'completed');
  assert.equal(closeA.quiescent, true);
  assert.equal(closeA.writerLockReleaseAttempted, true);
  assert.equal(closeA.writerLockReleased, true);
  assert.equal(closeA.writerLockReleaseFailed, false);
  assert.equal(closeA.writerLockReleaseOutcome, 'quota-released');
  assert.deepEqual(closeA.codes, []);
  assert.equal(fs.existsSync(sharedLockFile), true, 'lockfile kept on disk for remaining holder');
  assert.equal(launchWriterLock.verifica(worldShared.filesRoot, sharedToken), true);

  rtB.shutdown();
  assert.equal(rtB.shutdownState().writerLockReleased, true);
  assert.equal(rtB.shutdownState().writerLockReleaseFailed, false);
  assert.equal(rtB.shutdownState().writerLockReleaseOutcome, 'released');
  assert.equal(fs.existsSync(sharedLockFile), false, 'last holder unlinks lockfile on disk');
});

test('deadline re-checked on late broker, op/mutation wake, and final boundary using separate clock/timers', async (t) => {
  // 1. Late broker close resolving after clock > deadlineMono before timer callback.
  const world1 = makeWorld(t);
  const clock1 = createSeparateClockAndTimers(40000);
  const brokerEntered1 = deferred();
  const brokerGate1 = deferred();
  const broker1 = makeFakeBroker(null, {
    onClose: async () => {
      brokerEntered1.resolve();
      await brokerGate1.promise;
    },
  });
  const fleet1 = await createBuiltinFleet({
    home: world1.home,
    filesRoot: world1.filesRoot,
    fleetDefsPath: world1.defsPath,
    tmuxBin: world1.tmuxBin,
    protectSharedTmuxServer: false,
    ensureTmuxProtection: () => {},
    launchBroker: broker1,
    nowMono: clock1.now,
    setTimer: clock1.setTimer,
    clearTimer: clock1.clearTimer,
    sendKeysReadyMs: 1,
  });

  const closeP1 = fleet1.close({ deadlineMono: clock1.now() + 200 });
  await brokerEntered1.promise;
  clock1.advanceClockOnly(250);
  brokerGate1.resolve();

  const out1 = await closeP1;
  assert.equal(out1.ok, true);
  assert.equal(out1.status, 'completed_with_residues');
  assert.equal(out1.quiescent, false);
  assert.equal(out1.timedOut, true);
  assert.equal(out1.budgetExhausted, true);
  assert.equal(out1.elapsedMs, 250);
  assert.ok(out1.codes.includes('BROKER_CLOSE_TIMEOUT'));
  assert.equal(out1.canCleanupOwnedResources, false);
  assert.equal(fleet1.claimTracker.canCleanupOwnedResources(), false);
  assert.equal(fleet1.shutdownState().canCleanupOwnedResources, false);

  // 2. Late runtime op + fleet mutation waking after clock > deadlineMono before timer callback.
  const world2 = makeWorld(t);
  const clock2 = createSeparateClockAndTimers(50000);
  const opEntered2 = deferred();
  const opGate2 = deferred();
  const broker2 = makeFakeBroker(null, {
    onIssue: async () => {
      opEntered2.resolve();
      await opGate2.promise;
    },
  });
  const fleet2 = await createBuiltinFleet({
    home: world2.home,
    filesRoot: world2.filesRoot,
    fleetDefsPath: world2.defsPath,
    tmuxBin: world2.tmuxBin,
    protectSharedTmuxServer: false,
    ensureTmuxProtection: () => {},
    launchBroker: broker2,
    nowMono: clock2.now,
    setTimer: clock2.setTimer,
    clearTimer: clock2.clearTimer,
    sendKeysReadyMs: 1,
  });

  const upP2 = fleet2.up('Dev');
  await opEntered2.promise;
  const mutP2 = fleet2.boot('Dev', true);
  const closeP2 = fleet2.close({ deadlineMono: clock2.now() + 200 });
  clock2.advanceClockOnly(220);
  await mutP2;
  opGate2.resolve();
  await assert.rejects(upP2, { status: 503, fleetCode: 'RUNTIME_DISARMED', fleetPhase: 'launch-broker' });

  const out2 = await closeP2;
  assert.equal(out2.status, 'completed_with_residues');
  assert.equal(out2.quiescent, false);
  assert.equal(out2.timedOut, true);
  assert.equal(out2.budgetExhausted, true);
  assert.ok(out2.codes.includes('OPS_DRAIN_TIMEOUT'));
  assert.ok(out2.codes.includes('MUTATIONS_DRAIN_TIMEOUT'));
  assert.equal(out2.activeOpsRemaining, 0);
  assert.equal(out2.canCleanupOwnedResources, false);
  assert.equal(fleet2.claimTracker.canCleanupOwnedResources(), false);
  assert.equal(fleet2.shutdownState().canCleanupOwnedResources, false);

  // 3. Final coordinator boundary overrun during synchronous close step (leaseManager.close).
  const world3 = makeWorld(t);
  const clock3 = createSeparateClockAndTimers(60000);
  const lease3 = {
    ...makeFakeLease(),
    close() {
      clock3.advanceClockOnly(250);
      return {
        closed: true,
        quiescent: true,
        pendingOpens: 0,
        unresolvedOpens: 0,
        pendingServers: 0,
        pendingSockets: 0,
        closeFailures: 0,
        historicalResiduals: 0,
      };
    },
  };
  const fleet3 = await createBuiltinFleet({
    home: world3.home,
    filesRoot: world3.filesRoot,
    fleetDefsPath: world3.defsPath,
    tmuxBin: world3.tmuxBin,
    protectSharedTmuxServer: false,
    ensureTmuxProtection: () => {},
    launchBroker: makeFakeBroker(),
    leaseManager: lease3,
    nowMono: clock3.now,
    setTimer: clock3.setTimer,
    clearTimer: clock3.clearTimer,
    sendKeysReadyMs: 1,
  });
  const out3 = await fleet3.close({ deadlineMono: clock3.now() + 200 });
  assert.equal(out3.status, 'completed_with_residues');
  assert.equal(out3.quiescent, false);
  assert.equal(out3.budgetExhausted, true);
  assert.ok(out3.codes.includes('SHUTDOWN_BUDGET_EXHAUSTED'));
  assert.equal(out3.canCleanupOwnedResources, false);
  assert.equal(fleet3.claimTracker.canCleanupOwnedResources(), false);
  assert.equal(fleet3.shutdownState().canCleanupOwnedResources, false);

  // 4. Positive control strictly before deadline yields completed, quiescent, and cleanup-eligible.
  const world4 = makeWorld(t);
  const clock4 = createSeparateClockAndTimers(70000);
  const opEntered4 = deferred();
  const opGate4 = deferred();
  const fleet4 = await createBuiltinFleet({
    home: world4.home,
    filesRoot: world4.filesRoot,
    fleetDefsPath: world4.defsPath,
    tmuxBin: world4.tmuxBin,
    protectSharedTmuxServer: false,
    ensureTmuxProtection: () => {},
    launchBroker: makeFakeBroker(null, {
      onIssue: async () => {
        opEntered4.resolve();
        await opGate4.promise;
      },
    }),
    nowMono: clock4.now,
    setTimer: clock4.setTimer,
    clearTimer: clock4.clearTimer,
    sendKeysReadyMs: 1,
  });
  const upP4 = fleet4.up('Dev');
  await opEntered4.promise;
  const closeP4 = fleet4.close({ deadlineMono: clock4.now() + 200 });
  clock4.advanceClockOnly(199);
  opGate4.resolve();
  await assert.rejects(upP4, { status: 503, fleetCode: 'RUNTIME_DISARMED', fleetPhase: 'launch-broker' });

  const out4 = await closeP4;
  assert.equal(out4.status, 'completed');
  assert.equal(out4.quiescent, true);
  assert.equal(out4.timedOut, false);
  assert.equal(out4.budgetExhausted, false);
  assert.deepEqual(out4.codes, []);
  assert.equal(out4.canCleanupOwnedResources, true);
  assert.equal(fleet4.claimTracker.canCleanupOwnedResources(), true);
  assert.equal(fleet4.shutdownState().canCleanupOwnedResources, true);
});

test('real lease cleanup residual makes Fleet close non-quiescent with LEASE_CLOSE_ERROR despite clean ops and claims; clean close is positive control', async (t) => {
  // 1) Settled open/cleanup error before stop leaves unresolved lease residual -> Fleet close non-quiescent
  const world1 = makeWorld(t);
  const runDir1 = path.join(world1.home, 'run-residual');
  let failPerm = true;
  const leaseMgr1 = createLeaseManager(
    { home: world1.home, launchRuntimeDir: runDir1, leaseStateDir: path.join(world1.home, 'state-1') },
    {
      fs: {
        ...fs,
        chmodSync(p, mode) {
          if (failPerm && path.dirname(p) === runDir1) {
            const err = new Error('chmod denied');
            err.code = 'EPERM';
            throw err;
          }
          return fs.chmodSync(p, mode);
        },
        unlinkSync(p) {
          if (failPerm && path.dirname(p) === runDir1) {
            const err = new Error('unlink blocked');
            err.code = 'EPERM';
            throw err;
          }
          return fs.unlinkSync(p);
        },
      },
      net: {
        ...net,
        createServer(...args) {
          const srv = net.createServer(...args);
          const realClose = srv.close.bind(srv);
          t.after(() => { try { realClose(); } catch (_) {} });
          srv.close = () => {
            if (failPerm) throw new Error('close refused');
            return realClose();
          };
          return srv;
        },
      },
    },
  );
  t.after(() => { try { failPerm = false; leaseMgr1.close(); } catch (_) {} });

  // Settled failure before stop; no ops or claims in flight.
  await assert.rejects(() => leaseMgr1.track('Dev'), /chmod denied/);
  assert.equal(leaseMgr1.readiness().unresolvedOpens, 1);

  const fleet1 = await createBuiltinFleet({
    home: world1.home,
    filesRoot: world1.filesRoot,
    fleetDefsPath: world1.defsPath,
    tmuxBin: world1.tmuxBin,
    protectSharedTmuxServer: false,
    ensureTmuxProtection: () => {},
    launchBroker: makeFakeBroker(),
    cellLeaseEnabled: true,
    launchRuntimeDir: runDir1,
    leaseManager: leaseMgr1,
    sendKeysReadyMs: 1,
    log: () => {},
  });

  const out1 = await fleet1.close({ budgetMs: 100 });
  assert.equal(out1.status, 'completed_with_residues');
  assert.equal(out1.leaseClosed, false);
  assert.equal(out1.quiescent, false);
  assert.equal(out1.activeOpsRemaining, 0);
  assert.equal(out1.claims.idle, true);
  assert.equal(out1.canCleanupOwnedResources, false);
  assert.ok(out1.codes.includes('LEASE_CLOSE_ERROR'));

  // 2) Positive control without lease residuals -> quiescent completed and cleanup-eligible.
  const world2 = makeWorld(t);
  const runDir2 = path.join(world2.home, 'run-clean');
  const leaseMgr2 = createLeaseManager({
    home: world2.home,
    launchRuntimeDir: runDir2,
    leaseStateDir: path.join(world2.home, 'state-2'),
  });
  t.after(() => { try { leaseMgr2.close(); } catch (_) {} });
  await leaseMgr2.track('Dev');

  const fleet2 = await createBuiltinFleet({
    home: world2.home,
    filesRoot: world2.filesRoot,
    fleetDefsPath: world2.defsPath,
    tmuxBin: world2.tmuxBin,
    protectSharedTmuxServer: false,
    ensureTmuxProtection: () => {},
    launchBroker: makeFakeBroker(),
    cellLeaseEnabled: true,
    launchRuntimeDir: runDir2,
    leaseManager: leaseMgr2,
    sendKeysReadyMs: 1,
    log: () => {},
  });

  const out2 = await fleet2.close({ budgetMs: 100 });
  assert.equal(out2.status, 'completed');
  assert.equal(out2.leaseClosed, true);
  assert.equal(out2.quiescent, true);
  assert.equal(out2.canCleanupOwnedResources, true);
  assert.deepEqual(out2.codes, []);
  assert.equal(fleet2.claimTracker.canCleanupOwnedResources(), true);
  assert.equal(fleet2.shutdownState().canCleanupOwnedResources, true);
});

test('missing or malformed leaseManager.close() summary in Fleet yields leaseClosed false and LEASE_CLOSE_ERROR', async (t) => {
  for (const returnValue of [undefined, { closed: true, quiescent: false }, { closed: 'yes', quiescent: true }]) {
    const world = makeWorld(t);
    const fleet = await createBuiltinFleet({
      home: world.home,
      filesRoot: world.filesRoot,
      fleetDefsPath: world.defsPath,
      tmuxBin: world.tmuxBin,
      protectSharedTmuxServer: false,
      ensureTmuxProtection: () => {},
      launchBroker: makeFakeBroker(),
      leaseManager: {
        ...makeFakeLease(),
        close() {
          return returnValue;
        },
      },
      sendKeysReadyMs: 1,
      log: () => {},
    });
    const out = await fleet.close({ budgetMs: 100 });
    assert.equal(out.leaseClosed, false);
    assert.equal(out.quiescent, false);
    assert.equal(out.canCleanupOwnedResources, false);
    assert.ok(out.codes.includes('LEASE_CLOSE_ERROR'));
  }
});

test('Fleet awaits leaseManager.whenClosed on live UDS handshake socket and enforces server close barrier within shared deadline', async (t) => {
  // 1) Real UDS client stuck in incomplete handshake: Fleet destroys owned socket and drains cleanly within budget
  {
    const world = makeWorld(t);
    const runDir = path.join(world.home, 'run-hs');
    const leaseMgr = createLeaseManager({
      home: world.home,
      launchRuntimeDir: runDir,
      leaseStateDir: path.join(world.home, 'state-hs'),
    });
    t.after(() => { try { leaseMgr.close(); } catch (_) {} });
    const tracked = await leaseMgr.track('Dev');
    const hsClient = await new Promise((resolve, reject) => {
      const c = net.createConnection(tracked.stablePath, () => resolve(c));
      c.once('error', reject);
    });
    t.after(() => { try { hsClient.destroy(); } catch (_) {} });
    // Wait briefly so onStableConnection accepts the handshake socket before close()
    await new Promise((r) => setTimeout(r, 20));

    const fleet = await createBuiltinFleet({
      home: world.home,
      filesRoot: world.filesRoot,
      fleetDefsPath: world.defsPath,
      tmuxBin: world.tmuxBin,
      protectSharedTmuxServer: false,
      ensureTmuxProtection: () => {},
      launchBroker: makeFakeBroker(),
      cellLeaseEnabled: true,
      launchRuntimeDir: runDir,
      leaseManager: leaseMgr,
      sendKeysReadyMs: 1,
      log: () => {},
    });

    const out = await fleet.close({ budgetMs: 400 });
    assert.equal(out.status, 'completed');
    assert.equal(out.leaseClosed, true);
    assert.equal(out.quiescent, true);
    assert.equal(out.canCleanupOwnedResources, true);
    assert.deepEqual(out.codes, []);
    assert.equal((await leaseMgr.whenClosed()).pendingSockets, 0);
  }

  // 2) Server close() returns normally without throwing but withholds 'close' beyond deadlineMono -> non-quiescent
  {
    const world = makeWorld(t);
    const clock = createFakeClock(80000);
    const runDir = path.join(world.home, 'run-barrier');
    let releaseCloseEvent = null;
    const leaseMgr = createLeaseManager(
      { home: world.home, launchRuntimeDir: runDir, leaseStateDir: path.join(world.home, 'state-barrier') },
      {
        net: {
          ...net,
          createServer(...args) {
            const srv = net.createServer(...args);
            const origClose = srv.close.bind(srv);
            srv.close = () => {
              releaseCloseEvent = () => origClose();
              return srv;
            };
            t.after(() => { try { origClose(); } catch (_) {} });
            return srv;
          },
        },
      },
    );
    t.after(() => { try { if (releaseCloseEvent) releaseCloseEvent(); leaseMgr.close(); } catch (_) {} });
    await leaseMgr.track('Dev');

    const fleet = await createBuiltinFleet({
      home: world.home,
      filesRoot: world.filesRoot,
      fleetDefsPath: world.defsPath,
      tmuxBin: world.tmuxBin,
      protectSharedTmuxServer: false,
      ensureTmuxProtection: () => {},
      launchBroker: makeFakeBroker(),
      cellLeaseEnabled: true,
      launchRuntimeDir: runDir,
      leaseManager: leaseMgr,
      nowMono: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      sendKeysReadyMs: 1,
      log: () => {},
    });

    const closeP = fleet.close({ deadlineMono: clock.now() + 200 });
    await nextTickImmediate();
    assert.equal(clock.pendingCount(), 1, 'must race whenClosed with single caller deadline timer');

    // Expire deadlineMono via fake timer
    clock.advanceBy(200);
    const out = await closeP;
    assert.equal(out.status, 'completed_with_residues');
    assert.equal(out.leaseClosed, false);
    assert.equal(out.timedOut, true);
    assert.equal(out.budgetExhausted, true);
    assert.equal(out.quiescent, false);
    assert.equal(out.canCleanupOwnedResources, false);
    assert.ok(out.codes.includes('LEASE_CLOSE_ERROR'));

    // Late physical close completion must NOT rewrite the first delivered outcome or re-trigger close
    releaseCloseEvent();
    await nextTickImmediate();
    assert.equal(fleet.close(), closeP);
    assert.equal(out.quiescent, false);
    assert.equal(out.canCleanupOwnedResources, false);
  }
});

test('Fleet whenClosed handles clock wake expiry, rejection, incomplete resolution, late rejection without unhandledRejection, and claim drain residual budget', async (t) => {
  const unhandled = [];
  const onUnhandled = (err) => unhandled.push(err);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));

  // 1) Clock advances >= deadlineMono right when whenClosed resolves positive -> rejected at wake check
  {
    const world = makeWorld(t);
    const clock = createSeparateClockAndTimers(90000);
    const leaseDrain = deferred();
    let seenClaimWaitDeadline = null;
    let markExpiredCalls = 0;
    const fleet = await createBuiltinFleet({
      home: world.home,
      filesRoot: world.filesRoot,
      fleetDefsPath: world.defsPath,
      tmuxBin: world.tmuxBin,
      protectSharedTmuxServer: false,
      ensureTmuxProtection: () => {},
      launchBroker: makeFakeBroker(),
      leaseManager: {
        boot: async () => {},
        close() {
          return {
            closed: true, quiescent: false, pendingOpens: 0, unresolvedOpens: 0,
            pendingServers: 1, pendingSockets: 0, closeFailures: 0, historicalResiduals: 0,
          };
        },
        whenClosed: () => leaseDrain.promise,
      },
      nowMono: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      sendKeysReadyMs: 1,
      log: () => {},
    });
    fleet.claimTracker.waitIdle = async (deadline) => {
      seenClaimWaitDeadline = deadline;
      return {
        idle: false, timedOut: false, drainExpired: false,
        activeCount: 1, attestedActive: 1, unattestedCount: 0, code: 'CLAIM_BUDGET_EXHAUSTED',
      };
    };
    fleet.claimTracker.markDrainExpired = () => { markExpiredCalls += 1; };
    fleet.claimTracker.canCleanupOwnedResources = () => false;

    const targetDeadline = clock.now() + 200;
    const closeP = fleet.close({ deadlineMono: targetDeadline });
    await nextTickImmediate();
    clock.advanceClockOnly(200);
    leaseDrain.resolve({
      closed: true, quiescent: true, pendingOpens: 0, unresolvedOpens: 0,
      pendingServers: 0, pendingSockets: 0, closeFailures: 0, historicalResiduals: 0,
    });

    const out = await closeP;
    assert.equal(out.leaseClosed, false);
    assert.equal(out.timedOut, true);
    assert.equal(out.budgetExhausted, true);
    assert.equal(out.quiescent, false);
    assert.equal(out.canCleanupOwnedResources, false);
    assert.ok(out.codes.includes('LEASE_CLOSE_ERROR'));
    assert.equal(seenClaimWaitDeadline, targetDeadline, 'claim drain must receive the exact shared caller deadlineMono');
    assert.equal(markExpiredCalls, 1);
  }

  // 2) Early rejection & incomplete summary & late rejection after deadline with zero unhandledRejection
  {
    for (const mode of ['reject-early', 'incomplete-summary', 'reject-late']) {
      const world = makeWorld(t);
      const clock = createFakeClock(95000);
      const drain = deferred();
      const fleet = await createBuiltinFleet({
        home: world.home,
        filesRoot: world.filesRoot,
        fleetDefsPath: world.defsPath,
        tmuxBin: world.tmuxBin,
        protectSharedTmuxServer: false,
        ensureTmuxProtection: () => {},
        launchBroker: makeFakeBroker(),
        leaseManager: {
          boot: async () => {},
          close() {
            return {
              closed: true, quiescent: false, pendingOpens: 0, unresolvedOpens: 0,
              pendingServers: 1, pendingSockets: 0, closeFailures: 0, historicalResiduals: 0,
            };
          },
          whenClosed: () => drain.promise,
        },
        nowMono: clock.now,
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
        sendKeysReadyMs: 1,
        log: () => {},
      });

      const closeP = fleet.close({ deadlineMono: clock.now() + 100 });
      await nextTickImmediate();
      if (mode === 'reject-early') {
        drain.reject(new Error('lease drain rejected'));
      } else if (mode === 'incomplete-summary') {
        drain.resolve({
          closed: true, quiescent: false, pendingOpens: 0, unresolvedOpens: 0,
          pendingServers: 0, pendingSockets: 1, closeFailures: 0, historicalResiduals: 0,
        });
      } else {
        clock.advanceBy(100);
      }
      const out = await closeP;
      if (mode === 'reject-late') {
        drain.reject(new Error('late rejection after deadline'));
        await nextTickImmediate();
      }
      assert.equal(out.leaseClosed, false);
      assert.equal(out.quiescent, false);
      assert.equal(out.canCleanupOwnedResources, false);
      assert.ok(out.codes.includes('LEASE_CLOSE_ERROR'));
    }
    assert.equal(unhandled.length, 0, 'late/early lease whenClosed rejections must never become unhandled');
  }
});

test('Fleet conservatively rejects missing/invalid whenClosed and bare Promise resolution without qualified summary, and blocks Node cleanup while consumer stays active', async (t) => {
  // 1) Missing or non-thenable whenClosed when close() returns quiescent: false
  for (const badWhenClosed of [undefined, () => 'not-a-promise', () => ({ then: 123 })]) {
    const world = makeWorld(t);
    const fleet = await createBuiltinFleet({
      home: world.home,
      filesRoot: world.filesRoot,
      fleetDefsPath: world.defsPath,
      tmuxBin: world.tmuxBin,
      protectSharedTmuxServer: false,
      ensureTmuxProtection: () => {},
      launchBroker: makeFakeBroker(),
      leaseManager: {
        boot: async () => {},
        close: () => ({
          closed: true, quiescent: false, pendingOpens: 0, unresolvedOpens: 0,
          pendingServers: 1, pendingSockets: 0, closeFailures: 0, historicalResiduals: 0,
        }),
        ...(badWhenClosed ? { whenClosed: badWhenClosed } : {}),
      },
      sendKeysReadyMs: 1,
      log: () => {},
    });
    const out = await fleet.close({ budgetMs: 100 });
    assert.equal(out.leaseClosed, false);
    assert.equal(out.quiescent, false);
    assert.equal(out.canCleanupOwnedResources, false);
    assert.ok(out.codes.includes('LEASE_CLOSE_ERROR'));
  }

  // 2) Resolved whenClosed() Promise whose resolved value is missing/malformed or shows pendingServers/pendingSockets
  for (const resolvedBad of [
    undefined,
    null,
    { ok: true },
    { closed: true, quiescent: false, pendingOpens: 0, unresolvedOpens: 0, closeFailures: 0 },
    { closed: true, quiescent: true, pendingOpens: 0, unresolvedOpens: 0, pendingServers: 1, closeFailures: 0 },
    { closed: true, quiescent: true, pendingOpens: 0, unresolvedOpens: 0, pendingSockets: 1, closeFailures: 0 },
  ]) {
    const world = makeWorld(t);
    const fleet = await createBuiltinFleet({
      home: world.home,
      filesRoot: world.filesRoot,
      fleetDefsPath: world.defsPath,
      tmuxBin: world.tmuxBin,
      protectSharedTmuxServer: false,
      ensureTmuxProtection: () => {},
      launchBroker: makeFakeBroker(),
      leaseManager: {
        boot: async () => {},
        close: () => ({
          closed: true, quiescent: false, pendingOpens: 0, unresolvedOpens: 0,
          pendingServers: 1, pendingSockets: 0, closeFailures: 0, historicalResiduals: 0,
        }),
        whenClosed: () => Promise.resolve(resolvedBad),
      },
      sendKeysReadyMs: 1,
      log: () => {},
    });
    const out = await fleet.close({ budgetMs: 100 });
    assert.equal(out.leaseClosed, false);
    assert.equal(out.quiescent, false);
    assert.equal(out.canCleanupOwnedResources, false);
    assert.ok(out.codes.includes('LEASE_CLOSE_ERROR'));
  }

  // 3) Real leaseManager closes cleanly (leaseClosed: true), yet active child consumer preserves canCleanupOwnedResources=false
  {
    const world = makeWorld(t);
    const runDir = path.join(world.home, 'run-consumer-alive');
    const leaseMgr = createLeaseManager({
      home: world.home,
      launchRuntimeDir: runDir,
      leaseStateDir: path.join(world.home, 'state-ca'),
    });
    t.after(() => { try { leaseMgr.close(); } catch (_) {} });
    await leaseMgr.track('Dev');

    const fleet = await createBuiltinFleet({
      home: world.home,
      filesRoot: world.filesRoot,
      fleetDefsPath: world.defsPath,
      tmuxBin: world.tmuxBin,
      protectSharedTmuxServer: false,
      ensureTmuxProtection: () => {},
      launchBroker: makeFakeBroker(),
      cellLeaseEnabled: true,
      launchRuntimeDir: runDir,
      leaseManager: leaseMgr,
      sendKeysReadyMs: 1,
      log: () => {},
    });

    const child = createFakeChild();
    const admitted = fleet.claimTracker.beginAdmitted();
    assert.equal(admitted.ok, true);
    assert.equal(fleet.claimTracker.attachChild(admitted.token, child), true);
    t.after(() => { try { child.emit('close', 0); } catch (_) {} });

    const out = await fleet.close({ budgetMs: 80 });
    assert.equal(out.leaseClosed, true, 'lease transport drained cleanly');
    assert.equal(out.quiescent, false);
    assert.equal(out.canCleanupOwnedResources, false, 'active consumer must keep Node cleanup ineligible');
    assert.equal(fleet.claimTracker.canCleanupOwnedResources(), false);
  }
});

test('Fleet rejects same-dispatch server close callback error delivered after initial close listener', async (t) => {
  // 1) Physical 'close' removes last server before same-dispatch cb(error) records failure and residual
  {
    const world = makeWorld(t);
    const runDir = path.join(world.home, 'run-sd-err');
    const leaseMgr = createLeaseManager(
      {
        home: world.home,
        launchRuntimeDir: runDir,
        leaseStateDir: path.join(world.home, 'state-sd-err'),
      },
      {
        net: {
          ...net,
          createServer(...args) {
            const srv = net.createServer(...args);
            const origClose = srv.close.bind(srv);
            srv.close = (cb) => {
              if (typeof cb === 'function') {
                srv.once('close', () => cb(new Error('same-dispatch fleet close failure')));
              }
              return origClose();
            };
            t.after(() => { try { origClose(); } catch (_) {} });
            return srv;
          },
        },
      },
    );
    t.after(() => { try { leaseMgr.close(); } catch (_) {} });
    await leaseMgr.track('Dev');

    const fleet = await createBuiltinFleet({
      home: world.home,
      filesRoot: world.filesRoot,
      fleetDefsPath: world.defsPath,
      tmuxBin: world.tmuxBin,
      protectSharedTmuxServer: false,
      ensureTmuxProtection: () => {},
      launchBroker: makeFakeBroker(),
      cellLeaseEnabled: true,
      launchRuntimeDir: runDir,
      leaseManager: leaseMgr,
      sendKeysReadyMs: 1,
      log: () => {},
    });

    const out = await fleet.close({ budgetMs: 400 });
    assert.equal(out.leaseClosed, false);
    assert.equal(out.quiescent, false);
    assert.equal(out.canCleanupOwnedResources, false);
    assert.ok(out.codes.includes('LEASE_CLOSE_ERROR'));

    const settled = await leaseMgr.whenClosed();
    const state = leaseMgr.closeState();
    assert.equal(settled.quiescent, false);
    assert.ok(settled.closeFailures >= 1);
    assert.ok(settled.unresolvedOpens >= 1);
    assert.deepEqual(settled, state);
  }

  // 2) Positive control without callback error settles clean and permits cleanup
  {
    const world = makeWorld(t);
    const runDir = path.join(world.home, 'run-sd-ok');
    const leaseMgr = createLeaseManager(
      {
        home: world.home,
        launchRuntimeDir: runDir,
        leaseStateDir: path.join(world.home, 'state-sd-ok'),
      },
      {
        net: {
          ...net,
          createServer(...args) {
            const srv = net.createServer(...args);
            const origClose = srv.close.bind(srv);
            srv.close = (cb) => {
              if (typeof cb === 'function') {
                srv.once('close', () => cb());
              }
              return origClose();
            };
            t.after(() => { try { origClose(); } catch (_) {} });
            return srv;
          },
        },
      },
    );
    t.after(() => { try { leaseMgr.close(); } catch (_) {} });
    await leaseMgr.track('Dev');

    const fleet = await createBuiltinFleet({
      home: world.home,
      filesRoot: world.filesRoot,
      fleetDefsPath: world.defsPath,
      tmuxBin: world.tmuxBin,
      protectSharedTmuxServer: false,
      ensureTmuxProtection: () => {},
      launchBroker: makeFakeBroker(),
      cellLeaseEnabled: true,
      launchRuntimeDir: runDir,
      leaseManager: leaseMgr,
      sendKeysReadyMs: 1,
      log: () => {},
    });

    const out = await fleet.close({ budgetMs: 400 });
    assert.equal(out.leaseClosed, true);
    assert.equal(out.quiescent, true);
    assert.equal(out.canCleanupOwnedResources, true);
    assert.deepEqual(out.codes, []);

    const settled = await leaseMgr.whenClosed();
    const state = leaseMgr.closeState();
    assert.equal(settled.quiescent, true);
    assert.deepEqual(settled, state);
  }
});

test('Fleet requires pendingServers and pendingSockets to be safe zero integers on both immediate close() and whenClosed() paths', async (t) => {
  const incompleteOrInvalid = [
    {
      label: 'missing pendingServers',
      summary: { closed: true, quiescent: true, pendingOpens: 0, unresolvedOpens: 0, pendingSockets: 0, closeFailures: 0 },
    },
    {
      label: 'missing pendingSockets',
      summary: { closed: true, quiescent: true, pendingOpens: 0, unresolvedOpens: 0, pendingServers: 0, closeFailures: 0 },
    },
    {
      label: 'string pendingServers',
      summary: { closed: true, quiescent: true, pendingOpens: 0, unresolvedOpens: 0, pendingServers: '0', pendingSockets: 0, closeFailures: 0 },
    },
    {
      label: 'NaN pendingSockets',
      summary: { closed: true, quiescent: true, pendingOpens: 0, unresolvedOpens: 0, pendingServers: 0, pendingSockets: Number.NaN, closeFailures: 0 },
    },
    {
      label: 'string pendingSockets',
      summary: { closed: true, quiescent: true, pendingOpens: 0, unresolvedOpens: 0, pendingServers: 0, pendingSockets: '0', closeFailures: 0 },
    },
    {
      label: 'NaN pendingServers',
      summary: { closed: true, quiescent: true, pendingOpens: 0, unresolvedOpens: 0, pendingServers: Number.NaN, pendingSockets: 0, closeFailures: 0 },
    },
  ];

  // 1) Immediate leaseManager.close() path
  for (const { label, summary } of incompleteOrInvalid) {
    const world = makeWorld(t);
    const fleet = await createBuiltinFleet({
      home: world.home,
      filesRoot: world.filesRoot,
      fleetDefsPath: world.defsPath,
      tmuxBin: world.tmuxBin,
      protectSharedTmuxServer: false,
      ensureTmuxProtection: () => {},
      launchBroker: makeFakeBroker(),
      leaseManager: {
        boot: async () => {},
        close: () => summary,
        whenClosed: () => Promise.resolve({
          closed: true, quiescent: true, pendingOpens: 0, unresolvedOpens: 0,
          pendingServers: 0, pendingSockets: 0, closeFailures: 0,
        }),
      },
      sendKeysReadyMs: 1,
      log: () => {},
    });
    const out = await fleet.close({ budgetMs: 100 });
    assert.equal(out.leaseClosed, false, `immediate ${label}: leaseClosed must be false`);
    assert.equal(out.quiescent, false, `immediate ${label}: quiescent must be false`);
    assert.equal(out.canCleanupOwnedResources, false, `immediate ${label}: canCleanupOwnedResources must be false`);
    assert.ok(out.codes.includes('LEASE_CLOSE_ERROR'), `immediate ${label}: missing LEASE_CLOSE_ERROR`);
  }

  // 2) Deferred whenClosed() resolution path
  for (const { label, summary } of incompleteOrInvalid) {
    const world = makeWorld(t);
    const fleet = await createBuiltinFleet({
      home: world.home,
      filesRoot: world.filesRoot,
      fleetDefsPath: world.defsPath,
      tmuxBin: world.tmuxBin,
      protectSharedTmuxServer: false,
      ensureTmuxProtection: () => {},
      launchBroker: makeFakeBroker(),
      leaseManager: {
        boot: async () => {},
        close: () => ({
          closed: true, quiescent: false, pendingOpens: 0, unresolvedOpens: 0,
          pendingServers: 1, pendingSockets: 0, closeFailures: 0,
        }),
        whenClosed: () => Promise.resolve(summary),
      },
      sendKeysReadyMs: 1,
      log: () => {},
    });
    const out = await fleet.close({ budgetMs: 100 });
    assert.equal(out.leaseClosed, false, `whenClosed ${label}: leaseClosed must be false`);
    assert.equal(out.quiescent, false, `whenClosed ${label}: quiescent must be false`);
    assert.equal(out.canCleanupOwnedResources, false, `whenClosed ${label}: canCleanupOwnedResources must be false`);
    assert.ok(out.codes.includes('LEASE_CLOSE_ERROR'), `whenClosed ${label}: missing LEASE_CLOSE_ERROR`);
  }

  // 3) Positive controls on both immediate close() and deferred whenClosed() with pendingServers=0, pendingSockets=0
  for (const mode of ['immediate', 'whenClosed']) {
    const world = makeWorld(t);
    const completeSummary = {
      closed: true, quiescent: true, pendingOpens: 0, unresolvedOpens: 0,
      pendingServers: 0, pendingSockets: 0, closeFailures: 0,
    };
    const fleet = await createBuiltinFleet({
      home: world.home,
      filesRoot: world.filesRoot,
      fleetDefsPath: world.defsPath,
      tmuxBin: world.tmuxBin,
      protectSharedTmuxServer: false,
      ensureTmuxProtection: () => {},
      launchBroker: makeFakeBroker(),
      leaseManager: {
        boot: async () => {},
        close: () => (mode === 'immediate'
          ? completeSummary
          : {
              closed: true, quiescent: false, pendingOpens: 0, unresolvedOpens: 0,
              pendingServers: 1, pendingSockets: 0, closeFailures: 0,
            }),
        whenClosed: () => Promise.resolve(completeSummary),
      },
      sendKeysReadyMs: 1,
      log: () => {},
    });
    const out = await fleet.close({ budgetMs: 100 });
    assert.equal(out.leaseClosed, true, `${mode} positive: leaseClosed must be true`);
    assert.equal(out.quiescent, true, `${mode} positive: quiescent must be true`);
    assert.equal(out.canCleanupOwnedResources, true, `${mode} positive: canCleanupOwnedResources must be true`);
    assert.deepEqual(out.codes, [], `${mode} positive: unexpected codes`);
  }
});
