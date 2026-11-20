'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const vlRoots = require('../lib/fleet/vl-roots.js');
const vlNodeRuntime = require('../lib/fleet/vl-node-runtime.js');

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

  const flushNext = () => {
    let bestId = null;
    let best = null;
    for (const [id, entry] of timers.entries()) {
      if (!best || entry.at < best.at) {
        best = entry;
        bestId = id;
      }
    }
    if (!best) return null;
    timers.delete(bestId);
    now = Math.max(now, best.at);
    best.fn();
    return best.at;
  };

  return {
    now: () => now,
    setTimer,
    clearTimer,
    advanceTo,
    advanceBy,
    flushNext,
    pendingCount: () => timers.size,
    scheduledDelays: () => [...scheduledDelays],
  };
}

function createFakeChild({ emitResponseForRequest = false } = {}) {
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
      if (!emitResponseForRequest) return;
      queueMicrotask(() => {
        try {
          emitSuccess();
        } catch (err) {
          child.emit('error', err);
        }
      });
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

function makeFixtureHome(t, label = 'nc-claim-drain-') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), label));
  fs.chmodSync(base, 0o700);
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const binDir = path.join(base, 'bin');
  fs.mkdirSync(binDir, { mode: 0o700 });
  fs.chmodSync(binDir, 0o700);
  const execPath = path.join(binDir, 'node-stub');
  fs.writeFileSync(execPath, `#!/bin/sh\necho "v${process.versions.node}"\n`, { mode: 0o500 });
  fs.chmodSync(execPath, 0o500);
  t.after(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, home, execPath };
}

function claimOpts(home, cellId, extra = {}) {
  return {
    home,
    manifest: vlRoots.MANIFEST,
    launchId: 'aa'.repeat(8),
    ownerInstanceId: 'inst-1',
    cellId,
    budgetMs: 2000,
    ...extra,
  };
}

test('consumer tracker drains a child closing within the 300ms budget without killing it', async (t) => {
  const { home } = makeFixtureHome(t);
  const clock = createFakeClock(5000);
  const tracker = vlRoots.creaTracciatoreClaim({
    nowMono: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  const child = createFakeChild();
  const promise = vlRoots.riserva(claimOpts(home, 'cell-fast', {
    consumerTracker: tracker,
    spawnImpl: () => child,
  }));

  assert.equal(tracker.snapshot().activeCount, 1);
  assert.equal(tracker.snapshot().attestedActive, 1);

  tracker.disarm();
  assert.equal(tracker.canCleanupOwnedResources(), false);

  const waitPromise = tracker.waitIdle(clock.now() + 1500);
  let settled = false;
  waitPromise.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);

  clock.advanceBy(120);
  child.completeClaim();

  const outcome = await waitPromise;
  const claimResult = await promise;
  assert.equal(claimResult.ok, true);
  assert.equal(outcome.idle, true);
  assert.equal(outcome.timedOut, false);
  assert.equal(outcome.activeCount, 0);
  assert.equal(outcome.code, null);
  assert.equal(clock.pendingCount(), 0);
  assert.equal(child.killSignals.length, 0);
  assert.equal(tracker.canCleanupOwnedResources(), true);
});

test('consumer tracker stops waiting after 300ms cap without sending SIGKILL when a child stays alive', async (t) => {
  const { home } = makeFixtureHome(t);
  const clock = createFakeClock(10000);
  const tracker = vlRoots.creaTracciatoreClaim({
    nowMono: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  const slowChild = createFakeChild();
  const claimPromise = vlRoots.riserva(claimOpts(home, 'cell-slow', {
    consumerTracker: tracker,
    spawnImpl: () => slowChild,
  }));

  tracker.disarm();
  const tStart = clock.now();
  const waitPromise = tracker.waitIdle(tStart + 1500);

  assert.deepEqual(clock.scheduledDelays(), [300]);
  clock.advanceBy(299);
  await Promise.resolve();
  assert.equal(tracker.snapshot().activeCount, 1);

  clock.advanceBy(1);
  const outcome = await waitPromise;
  assert.equal(clock.now() - tStart, 300);
  assert.equal(outcome.idle, false);
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.activeCount, 1);
  assert.equal(outcome.code, 'CLAIM_DRAIN_TIMEOUT');
  assert.equal(slowChild.killSignals.length, 0);
  assert.equal(tracker.canCleanupOwnedResources(), false);

  // An expired drain keeps cleanup blocked for the rest of the tracker lifetime even after late close.
  slowChild.emit('close', 1);
  await claimPromise;
  assert.equal(tracker.snapshot().activeCount, 0);
  assert.equal(tracker.snapshot().drainExpired, true);
  assert.equal(tracker.canCleanupOwnedResources(), false);
});

test('two slow children share one 300ms overall drain budget rather than 300ms per child', async (t) => {
  const { home } = makeFixtureHome(t);
  const clock = createFakeClock(20000);
  const tracker = vlRoots.creaTracciatoreClaim({
    nowMono: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  const c1 = createFakeChild();
  const c2 = createFakeChild();
  let spawnIdx = 0;
  const p1 = vlRoots.riserva(claimOpts(home, 'cell-1', {
    consumerTracker: tracker,
    spawnImpl: () => { spawnIdx += 1; return c1; },
  }));
  const p2 = vlRoots.riserva(claimOpts(home, 'cell-2', {
    consumerTracker: tracker,
    spawnImpl: () => { spawnIdx += 1; return c2; },
  }));
  assert.equal(spawnIdx, 2);
  assert.equal(tracker.snapshot().activeCount, 2);

  tracker.disarm();
  const start = clock.now();
  const waitPromise = tracker.waitIdle(start + 1500);
  assert.deepEqual(clock.scheduledDelays(), [300]);

  // First child closes partway through; remaining wait for second child does not reset to 300ms.
  clock.advanceBy(200);
  c1.emit('close', 0);
  await Promise.resolve();
  assert.equal(tracker.snapshot().activeCount, 1);

  clock.advanceBy(100);
  const outcome = await waitPromise;
  assert.equal(clock.now() - start, 300);
  assert.equal(clock.scheduledDelays().length, 1);
  assert.equal(outcome.idle, false);
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.activeCount, 1);
  assert.equal(outcome.code, 'CLAIM_DRAIN_TIMEOUT');
  assert.equal(c1.killSignals.length, 0);
  assert.equal(c2.killSignals.length, 0);

  c2.emit('close', 1);
  await Promise.all([p1, p2]);
});

test('error event without close leaves consumer active past caller promise settlement', async (t) => {
  const { home } = makeFixtureHome(t);
  const clock = createFakeClock(30000);
  const tracker = vlRoots.creaTracciatoreClaim({
    nowMono: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  const child = createFakeChild();
  const claimPromise = vlRoots.riserva(claimOpts(home, 'cell-err', {
    consumerTracker: tracker,
    spawnImpl: () => child,
  }));

  // Emitting 'error' settles eseguiSottoLock's caller promise, but child has not closed yet.
  child.emit('error', new Error('spawn error without close'));
  const res = await claimPromise;
  assert.equal(res.ok, false);
  assert.equal(res.code, 'LOCK_UNAVAILABLE');

  assert.equal(tracker.snapshot().activeCount, 1);
  assert.equal(tracker.canCleanupOwnedResources(), false);

  tracker.disarm();
  const waitPromise = tracker.waitIdle(clock.now() + 1500);
  clock.flushNext();
  const drained = await waitPromise;
  assert.equal(drained.idle, false);
  assert.equal(drained.timedOut, true);
  assert.equal(drained.activeCount, 1);
  assert.equal(tracker.canCleanupOwnedResources(), false);

  // Delayed close clears the active count, while expired drain keeps cleanup disabled.
  child.emit('close', 1);
  assert.equal(tracker.snapshot().activeCount, 0);
  assert.equal(tracker.snapshot().drainExpired, true);
  assert.equal(tracker.canCleanupOwnedResources(), false);
});

test('child handle without EventEmitter interface becomes unattested and never idle', async (t) => {
  const { home } = makeFixtureHome(t);
  const clock = createFakeClock(40000);
  const tracker = vlRoots.creaTracciatoreClaim({
    nowMono: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  const res = await vlRoots.riserva(claimOpts(home, 'cell-unattested', {
    consumerTracker: tracker,
    spawnImpl: () => ({ pid: 99999 }),
  }));
  assert.equal(res.ok, false);
  assert.equal(res.outcome, 'uncertain');
  assert.equal(res.code, 'CONSUMER_UNATTESTED');

  const snap = tracker.snapshot();
  assert.equal(snap.activeCount, 1);
  assert.equal(snap.attestedActive, 0);
  assert.equal(snap.unattestedCount, 1);

  tracker.disarm();
  const waitRes = await tracker.waitIdle(clock.now() + 1500);
  assert.equal(waitRes.idle, false);
  assert.equal(waitRes.timedOut, false);
  assert.equal(waitRes.unattestedCount, 1);
  assert.equal(waitRes.code, 'CONSUMER_UNATTESTED');
  assert.equal(clock.scheduledDelays().length, 0);
  assert.equal(tracker.canCleanupOwnedResources(), false);
});

test('admitted claim operation is counted before pin qualification and cleaned up on pre-spawn refusal', async (t) => {
  const { home, execPath } = makeFixtureHome(t);
  const tracker = vlRoots.creaTracciatoreClaim();

  let countsDuringPinPrep = null;
  let spawnCalls = 0;
  const failed = await vlRoots.riserva(claimOpts(home, 'cell-admitted', {
    consumerTracker: tracker,
    pinDeps: {
      execPath,
      nodeProbe: () => {
        countsDuringPinPrep = tracker.snapshot();
        return { status: 1, stdout: '', stderr: 'probe refused' };
      },
    },
    spawnImpl: () => {
      spawnCalls += 1;
      return createFakeChild();
    },
  }));

  assert.equal(failed.ok, false);
  assert.equal(failed.code, 'PIN_VERSION');
  assert.equal(spawnCalls, 0);
  assert.ok(countsDuringPinPrep);
  assert.equal(countsDuringPinPrep.activeCount, 1);
  assert.equal(countsDuringPinPrep.attestedActive, 1);
  assert.equal(tracker.snapshot().activeCount, 0);

  // Also verify counting holds right before spawn returns the child handle.
  let countsPreSpawn = null;
  const child2 = createFakeChild({ emitResponseForRequest: true });
  const okRes = await vlRoots.riserva(claimOpts(home, 'cell-admitted-ok', {
    consumerTracker: tracker,
    spawnImpl: () => {
      countsPreSpawn = tracker.snapshot();
      return child2;
    },
  }));
  assert.equal(okRes.ok, true);
  assert.equal(countsPreSpawn.activeCount, 1);
  assert.equal(tracker.snapshot().activeCount, 0);
});

test('disarmed tracker refuses immediately before creating claim dirs or preparing node pins', async (t) => {
  const { home, execPath } = makeFixtureHome(t);
  const tracker = vlRoots.creaTracciatoreClaim();
  tracker.disarm();

  let probeCalls = 0;
  let spawnCalls = 0;
  const res = await vlRoots.riserva(claimOpts(home, 'cell-disarmed', {
    consumerTracker: tracker,
    pinDeps: {
      execPath,
      nodeProbe: () => {
        probeCalls += 1;
        return { status: 0, stdout: `${process.versions.node}\n`, stderr: '' };
      },
    },
    spawnImpl: () => {
      spawnCalls += 1;
      return createFakeChild();
    },
  }));

  assert.equal(res.ok, false);
  assert.equal(res.outcome, 'refused');
  assert.equal(res.code, 'CLAIM_DISARMED');
  assert.equal(probeCalls, 0);
  assert.equal(spawnCalls, 0);
  assert.equal(tracker.snapshot().activeCount, 0);
  assert.equal(fs.existsSync(path.join(home, '.nexuscrew', 'vl-claim-pin')), false);
  assert.equal(fs.existsSync(path.join(home, '.nexuscrew', 'vl-root-claims')), false);

  const stagingDir = path.join(home, 'staging-disarmed');
  const qDisarmed = vlNodeRuntime.qualifica({ execPath, isDisarmed: () => tracker.isDisarmed() });
  assert.equal(qDisarmed.ok, false);
  assert.equal(qDisarmed.code, 'PIN_REREAD');
  assert.equal(qDisarmed.motivo, 'disarmed');
  const pDisarmed = vlNodeRuntime.pubblica(
    { ok: true, path: execPath, hash: 'a'.repeat(64) },
    stagingDir,
    { isDisarmed: () => tracker.isDisarmed() },
  );
  assert.equal(pDisarmed.ok, false);
  assert.equal(pDisarmed.code, 'PIN_REREAD');
  assert.equal(fs.existsSync(stagingDir), false);
});

test('zero remaining budget skips consumer wait immediately without scheduling timers', async (t) => {
  const { home } = makeFixtureHome(t);
  const clock = createFakeClock(50000);
  const tracker = vlRoots.creaTracciatoreClaim({
    nowMono: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  const child = createFakeChild();
  const claimPromise = vlRoots.riserva(claimOpts(home, 'cell-zero', {
    consumerTracker: tracker,
    spawnImpl: () => child,
  }));

  tracker.disarm();
  const zeroRes = await tracker.waitIdle(clock.now());
  assert.equal(zeroRes.idle, false);
  assert.equal(zeroRes.timedOut, false);
  assert.equal(zeroRes.activeCount, 1);
  assert.equal(zeroRes.code, 'CLAIM_BUDGET_EXHAUSTED');
  assert.deepEqual(clock.scheduledDelays(), []);

  const expiredRes = await tracker.waitIdle(clock.now() - 25);
  assert.equal(expiredRes.idle, false);
  assert.equal(expiredRes.code, 'CLAIM_BUDGET_EXHAUSTED');
  assert.deepEqual(clock.scheduledDelays(), []);

  child.emit('close', 0);
  await claimPromise;
});

test('two independent trackers on the same module isolate disarm state and preserve shared node runtime cache', async (t) => {
  const { home: home1, execPath } = makeFixtureHome(t, 'nc-claim-iso-1-');
  const { home: home2 } = makeFixtureHome(t, 'nc-claim-iso-2-');
  const t1 = vlRoots.creaTracciatoreClaim();
  const t2 = vlRoots.creaTracciatoreClaim();

  t1.disarm();
  assert.equal(t1.isDisarmed(), true);
  assert.equal(t2.isDisarmed(), false);

  const r1 = await vlRoots.riserva(claimOpts(home1, 'cell-a', {
    consumerTracker: t1,
    spawnImpl: () => createFakeChild(),
  }));
  assert.equal(r1.ok, false);
  assert.equal(r1.code, 'CLAIM_DISARMED');

  const qBlocked = vlNodeRuntime.qualifica({ execPath, isDisarmed: () => t1.isDisarmed() });
  assert.equal(qBlocked.ok, false);
  assert.equal(qBlocked.motivo, 'disarmed');

  const child2 = createFakeChild();
  const r2Promise = vlRoots.riserva(claimOpts(home2, 'cell-b', {
    consumerTracker: t2,
    spawnImpl: () => child2,
  }));
  assert.equal(t2.snapshot().activeCount, 1);

  const qOpen = vlNodeRuntime.qualifica({ execPath, isDisarmed: () => t2.isDisarmed() });
  assert.equal(qOpen.ok, true);
  const qNoGate = vlNodeRuntime.qualifica({ execPath });
  assert.equal(qNoGate.ok, true);
  assert.equal(qNoGate.hash, qOpen.hash);

  const staging2 = path.join(home2, 'stage-2');
  fs.mkdirSync(staging2, { mode: 0o700 });
  fs.chmodSync(staging2, 0o700);
  const p2 = vlNodeRuntime.pubblica(qOpen, staging2, { isDisarmed: () => t2.isDisarmed() });
  assert.equal(p2.ok, true);
  assert.equal(fs.lstatSync(p2.path).isFile(), true);

  child2.emit('close', 0);
  await r2Promise;
  assert.equal(t2.snapshot().activeCount, 0);
});

test('calls without consumerTracker retain legacy behavior even after another tracker disarms', async (t) => {
  const { home, execPath } = makeFixtureHome(t);
  const tracker = vlRoots.creaTracciatoreClaim();
  tracker.disarm();

  const child = createFakeChild({ emitResponseForRequest: true });
  const res = await vlRoots.riserva(claimOpts(home, 'cell-legacy', {
    spawnImpl: () => child,
  }));
  assert.equal(res.ok, true);
  assert.equal(res.outcome, 'claimed');
  assert.equal(res.lockHeld, true);
  assert.equal(tracker.snapshot().activeCount, 0);

  const qLegacy = vlNodeRuntime.qualifica({ execPath });
  assert.equal(qLegacy.ok, true);
});

test('disarm between admission and pin publication returns CLAIM_DISARMED with disarmed reason instead of PIN_REREAD', async (t) => {
  const { home, execPath } = makeFixtureHome(t, 'nc-claim-mid-disarm-');
  const tracker = vlRoots.creaTracciatoreClaim();

  let spawnCalls = 0;
  let observedDuringProbe = null;
  const res = await vlRoots.riserva(claimOpts(home, 'cell-mid-disarm', {
    consumerTracker: tracker,
    pinDeps: {
      execPath,
      nodeProbe: () => {
        observedDuringProbe = tracker.snapshot();
        tracker.disarm();
        return { status: 0, stdout: `${process.versions.node}\n`, stderr: '' };
      },
    },
    spawnImpl: () => {
      spawnCalls += 1;
      return createFakeChild();
    },
  }));

  assert.ok(observedDuringProbe);
  assert.equal(observedDuringProbe.activeCount, 1);
  assert.equal(res.ok, false);
  assert.equal(res.outcome, 'refused');
  assert.equal(res.code, 'CLAIM_DISARMED');
  assert.equal(res.motivo, 'disarmed');
  assert.equal(spawnCalls, 0);
  assert.equal(tracker.snapshot().activeCount, 0);
});

test('canCleanupOwnedResources stays permanently false once waitIdle expires on timeout or exhausted budget', async (t) => {
  // 1. Timeout expiration latches drainExpired even if the consumer closes later and a second waitIdle sees 0 active.
  const { home: home1 } = makeFixtureHome(t, 'nc-claim-expire-tmo-');
  const clock1 = createFakeClock(60000);
  const tTimedOut = vlRoots.creaTracciatoreClaim({
    nowMono: clock1.now,
    setTimer: clock1.setTimer,
    clearTimer: clock1.clearTimer,
  });
  const child1 = createFakeChild();
  const p1 = vlRoots.riserva(claimOpts(home1, 'cell-exp-1', {
    consumerTracker: tTimedOut,
    spawnImpl: () => child1,
  }));
  tTimedOut.disarm();
  assert.equal(tTimedOut.snapshot().drainExpired, false);
  const w1 = tTimedOut.waitIdle(clock1.now() + 1500);
  clock1.advanceBy(300);
  const out1 = await w1;
  assert.equal(out1.timedOut, true);
  assert.equal(out1.code, 'CLAIM_DRAIN_TIMEOUT');
  assert.equal(tTimedOut.snapshot().drainExpired, true);
  assert.equal(tTimedOut.canCleanupOwnedResources(), false);

  child1.emit('close', 0);
  await p1;
  const followUp1 = await tTimedOut.waitIdle(clock1.now() + 1500);
  assert.equal(followUp1.idle, true);
  assert.equal(tTimedOut.snapshot().activeCount, 0);
  assert.equal(tTimedOut.snapshot().drainExpired, true);
  assert.equal(tTimedOut.canCleanupOwnedResources(), false);

  // 2. Zero remaining budget with attested active consumers also latches drainExpired permanently.
  const { home: home2 } = makeFixtureHome(t, 'nc-claim-expire-zero-');
  const clock2 = createFakeClock(70000);
  const tExhausted = vlRoots.creaTracciatoreClaim({
    nowMono: clock2.now,
    setTimer: clock2.setTimer,
    clearTimer: clock2.clearTimer,
  });
  const child2 = createFakeChild();
  const p2 = vlRoots.riserva(claimOpts(home2, 'cell-exp-2', {
    consumerTracker: tExhausted,
    spawnImpl: () => child2,
  }));
  tExhausted.disarm();
  const out2 = await tExhausted.waitIdle(clock2.now());
  assert.equal(out2.timedOut, false);
  assert.equal(out2.code, 'CLAIM_BUDGET_EXHAUSTED');
  assert.equal(tExhausted.snapshot().drainExpired, true);
  assert.equal(tExhausted.canCleanupOwnedResources(), false);

  child2.emit('close', 0);
  await p2;
  const followUp2 = await tExhausted.waitIdle(clock2.now() + 1500);
  assert.equal(followUp2.idle, true);
  assert.equal(followUp2.timedOut, false);
  assert.equal(tExhausted.snapshot().activeCount, 0);
  assert.equal(tExhausted.snapshot().drainExpired, true);
  assert.equal(tExhausted.canCleanupOwnedResources(), false);

  // 2b. drainExpired latch is isolated per tracker instance.
  const tIsolated = vlRoots.creaTracciatoreClaim();
  tIsolated.disarm();
  assert.equal(tIsolated.snapshot().drainExpired, false);
  assert.equal(tIsolated.canCleanupOwnedResources(), true);

  // 3. Unattested-only consumers and clean idle waits do not set drainExpired.
  const { home: home3 } = makeFixtureHome(t, 'nc-claim-unatt-noexp-');
  const tUnatt = vlRoots.creaTracciatoreClaim();
  await vlRoots.riserva(claimOpts(home3, 'cell-unatt-noexp', {
    consumerTracker: tUnatt,
    spawnImpl: () => ({ pid: 12345 }),
  }));
  tUnatt.disarm();
  const out3 = await tUnatt.waitIdle(performance.now() + 500);
  assert.equal(out3.code, 'CONSUMER_UNATTESTED');
  assert.equal(tUnatt.snapshot().drainExpired, false);
  assert.equal(tUnatt.canCleanupOwnedResources(), false);

  const tClean = vlRoots.creaTracciatoreClaim();
  tClean.disarm();
  const outClean = await tClean.waitIdle(performance.now() + 500);
  assert.equal(outClean.idle, true);
  assert.equal(tClean.snapshot().drainExpired, false);
  assert.equal(tClean.canCleanupOwnedResources(), true);
});

test('endConsumer and attachChild enforce token object identity across trackers', () => {
  const trackerA = vlRoots.creaTracciatoreClaim();
  const trackerB = vlRoots.creaTracciatoreClaim();

  const admA = trackerA.beginAdmitted();
  const admB = trackerB.beginAdmitted();
  assert.equal(admA.ok, true);
  assert.equal(admB.ok, true);
  assert.equal(admA.token.id, admB.token.id);

  const childA = createFakeChild();
  const childB = createFakeChild();
  assert.equal(trackerA.attachChild(admA.token, childA), true);

  // Passing trackerA's token (same numeric id) or a cloned duplicate to trackerB must fail without mutating trackerB.
  assert.equal(trackerB.attachChild(admA.token, childB), false);
  assert.equal(trackerB.attachChild({ ...admB.token }, childB), false);
  assert.equal(admB.token.stage, 'admitted');
  assert.equal(admB.token.child, null);
  assert.equal(trackerB.snapshot().activeCount, 1);

  assert.equal(trackerB.endConsumer(admA.token, 'close'), false);
  assert.equal(trackerB.endConsumer({ ...admB.token }, 'close'), false);
  assert.equal(trackerB.snapshot().activeCount, 1);
  assert.equal(trackerB.snapshot().attestedActive, 1);

  const admUnatt = trackerB.beginAdmitted();
  assert.equal(admUnatt.ok, true);
  assert.equal(trackerB.attachChild(admUnatt.token, { pid: 9999 }), false);
  assert.equal(admUnatt.token.stage, 'unattested');

  assert.equal(trackerB.attachChild(admB.token, childB), true);
  trackerB.disarm();
  assert.equal(trackerB.canCleanupOwnedResources(), false);

  // Foreign, duplicated, already-ended, and unattested tokens leave disarmed B's live child protected.
  assert.equal(trackerB.endConsumer(admA.token, 'close'), false);
  assert.equal(trackerB.endConsumer({ ...admB.token }, 'close'), false);
  assert.equal(trackerB.endConsumer(admUnatt.token, 'close'), false);
  assert.equal(trackerB.attachChild(admUnatt.token, childB), false);

  childA.emit('close', 0);
  assert.equal(trackerA.snapshot().activeCount, 0);
  assert.equal(trackerB.endConsumer(admA.token, 'close'), false);
  assert.equal(trackerB.attachChild(admA.token, childB), false);
  assert.equal(trackerB.snapshot().attestedActive, 1);
  assert.equal(trackerB.canCleanupOwnedResources(), false);

  // Even ending its own other finished token leaves B waiting on childB (and ended token cannot be re-ended/attached).
  const trackerC = vlRoots.creaTracciatoreClaim();
  const admDone = trackerC.beginAdmitted();
  assert.equal(trackerC.endConsumer(admDone.token, 'pre-spawn-refused'), true);
  assert.equal(trackerC.endConsumer(admDone.token, 'close'), false);
  assert.equal(trackerC.attachChild(admDone.token, createFakeChild()), false);

  childB.emit('close', 0);
  assert.equal(trackerB.snapshot().attestedActive, 0);
  assert.equal(trackerB.snapshot().unattestedCount, 1);
  assert.equal(trackerB.canCleanupOwnedResources(), false);
});

test('disarmed tracker still drains its legitimate token and child close cleanly to canCleanupOwnedResources=true', () => {
  const trackerA = vlRoots.creaTracciatoreClaim();
  const trackerB = vlRoots.creaTracciatoreClaim();
  const admA = trackerA.beginAdmitted();
  const admB = trackerB.beginAdmitted();
  const childA = createFakeChild();
  const childB = createFakeChild();
  assert.equal(trackerA.attachChild(admA.token, childA), true);
  assert.equal(trackerB.attachChild(admB.token, childB), true);

  trackerB.disarm();
  assert.equal(trackerB.endConsumer(admA.token, 'close'), false);
  assert.equal(trackerB.canCleanupOwnedResources(), false);

  childB.emit('close', 0);
  assert.equal(trackerB.snapshot().activeCount, 0);
  assert.equal(trackerB.canCleanupOwnedResources(), true);
  childA.emit('close', 0);
});

test('attachChild succeeds only once while token is in admitted stage', () => {
  const tracker = vlRoots.creaTracciatoreClaim();
  const adm = tracker.beginAdmitted();
  assert.equal(adm.ok, true);

  const firstChild = createFakeChild();
  const secondChild = createFakeChild();
  assert.equal(tracker.attachChild(adm.token, firstChild), true);
  assert.equal(adm.token.stage, 'spawned');

  // Second attach on spawned token must fail, leave child/counts intact, and ignore secondChild close.
  assert.equal(tracker.attachChild(adm.token, secondChild), false);
  assert.equal(adm.token.child, firstChild);
  assert.equal(tracker.snapshot().activeCount, 1);
  assert.equal(tracker.snapshot().attestedActive, 1);

  secondChild.emit('close', 0);
  assert.equal(tracker.snapshot().activeCount, 1);
  assert.equal(adm.token.stage, 'spawned');

  firstChild.emit('close', 0);
  assert.equal(tracker.snapshot().activeCount, 0);
  assert.equal(tracker.attachChild(adm.token, secondChild), false);
});

test('waitIdle checks monotonic clock on drain wakeup so late close before timer still latches expiry', async () => {
  // Case A: child closes after effective deadline before the timer callback runs -> expired + latch active.
  let now1 = 10000;
  let cleared1 = false;
  const timers1 = new Map();
  let nextTid1 = 1;
  const tLate = vlRoots.creaTracciatoreClaim({
    nowMono: () => now1,
    setTimer: (fn) => {
      const id = nextTid1++;
      timers1.set(id, fn);
      return id;
    },
    clearTimer: (id) => {
      if (timers1.delete(id)) cleared1 = true;
    },
  });
  const admLate = tLate.beginAdmitted();
  const childLate = createFakeChild();
  assert.equal(tLate.attachChild(admLate.token, childLate), true);
  tLate.disarm();

  const waitLate = tLate.waitIdle(now1 + 1500);
  assert.equal(timers1.size, 1);
  // Advance clock past effective deadline (10000 + 300) WITHOUT firing timer callback.
  now1 = 10305;
  childLate.emit('close', 0);
  const outLate = await waitLate;
  assert.equal(cleared1, true);
  assert.equal(outLate.idle, true);
  assert.equal(outLate.activeCount, 0);
  assert.equal(outLate.timedOut, true);
  assert.equal(outLate.code, 'CLAIM_DRAIN_TIMEOUT');
  assert.equal(tLate.snapshot().drainExpired, true);
  assert.equal(tLate.canCleanupOwnedResources(), false);
  assert.deepEqual(childLate.killSignals, []);
  const repeatLate = await tLate.waitIdle(now1 + 1500);
  assert.equal(repeatLate.idle, true);
  assert.equal(tLate.snapshot().drainExpired, true);
  assert.equal(tLate.canCleanupOwnedResources(), false);

  // Case A2: external deadline shorter than 300ms cap, clock crosses external deadline without timer running.
  let nowShort = 15000;
  let clearedShort = false;
  let scheduledShortDelay = null;
  const timersShort = new Map();
  let nextTidShort = 1;
  const tShort = vlRoots.creaTracciatoreClaim({
    nowMono: () => nowShort,
    setTimer: (fn, delay) => {
      scheduledShortDelay = delay;
      const id = nextTidShort++;
      timersShort.set(id, fn);
      return id;
    },
    clearTimer: (id) => {
      if (timersShort.delete(id)) clearedShort = true;
    },
  });
  const admShort = tShort.beginAdmitted();
  const childShort = createFakeChild();
  assert.equal(tShort.attachChild(admShort.token, childShort), true);
  tShort.disarm();

  const waitShort = tShort.waitIdle(nowShort + 80);
  assert.equal(scheduledShortDelay, 80);
  assert.equal(timersShort.size, 1);
  nowShort = 15085;
  childShort.emit('close', 0);
  const outShort = await waitShort;
  assert.equal(clearedShort, true);
  assert.equal(outShort.idle, true);
  assert.equal(outShort.activeCount, 0);
  assert.equal(outShort.timedOut, true);
  assert.equal(outShort.code, 'CLAIM_DRAIN_TIMEOUT');
  assert.equal(tShort.snapshot().drainExpired, true);
  assert.equal(tShort.canCleanupOwnedResources(), false);
  assert.deepEqual(childShort.killSignals, []);

  // Case B: child closes strictly before effective deadline -> clean completion, latch off.
  let now2 = 20000;
  let cleared2 = false;
  const timers2 = new Map();
  let nextTid2 = 1;
  const tEarly = vlRoots.creaTracciatoreClaim({
    nowMono: () => now2,
    setTimer: (fn) => {
      const id = nextTid2++;
      timers2.set(id, fn);
      return id;
    },
    clearTimer: (id) => {
      if (timers2.delete(id)) cleared2 = true;
    },
  });
  const admEarly = tEarly.beginAdmitted();
  const childEarly = createFakeChild();
  assert.equal(tEarly.attachChild(admEarly.token, childEarly), true);
  tEarly.disarm();

  const waitEarly = tEarly.waitIdle(now2 + 1500);
  now2 = 20299;
  childEarly.emit('close', 0);
  const outEarly = await waitEarly;
  assert.equal(cleared2, true);
  assert.equal(outEarly.idle, true);
  assert.equal(outEarly.timedOut, false);
  assert.equal(outEarly.code, null);
  assert.equal(tEarly.snapshot().drainExpired, false);
  assert.equal(tEarly.canCleanupOwnedResources(), true);
  assert.deepEqual(childEarly.killSignals, []);
});

test('genuine PIN_REREAD failure keeps its code when tracker remains armed while pre-publish/pre-spawn disarm returns CLAIM_DISARMED', async (t) => {
  const { base, home, execPath } = makeFixtureHome(t, 'nc-claim-pin-genuine-');
  const untrustedExec = path.join(base, 'bin', 'node-untrusted');
  fs.writeFileSync(untrustedExec, `#!/bin/sh\necho "v${process.versions.node}"\n`, { mode: 0o777 });
  fs.chmodSync(untrustedExec, 0o777);
  const execPathPub = path.join(base, 'bin', 'node-stub-pub');
  fs.writeFileSync(execPathPub, `#!/bin/sh\necho "v${process.versions.node}"\n`, { mode: 0o500 });
  fs.chmodSync(execPathPub, 0o500);

  const tracker = vlRoots.creaTracciatoreClaim();
  let spawnCalls = 0;

  const genuine = await vlRoots.riserva(claimOpts(home, 'cell-pin-genuine', {
    consumerTracker: tracker,
    pinDeps: {
      execPath: untrustedExec,
    },
    spawnImpl: () => {
      spawnCalls += 1;
      return createFakeChild();
    },
  }));
  assert.equal(genuine.ok, false);
  assert.equal(genuine.outcome, 'refused');
  assert.equal(genuine.code, 'PIN_REREAD');
  assert.notEqual(genuine.motivo, 'disarmed');
  assert.equal(spawnCalls, 0);
  assert.equal(tracker.snapshot().activeCount, 0);

  // Disarm after pin preparation right before spawn blocks spawn with CLAIM_DISARMED and zero active count.
  const tracker2 = vlRoots.creaTracciatoreClaim();
  let disarmChecks = 0;
  let spawn2 = 0;
  const wrappedTracker2 = {
    ...tracker2,
    isDisarmed() {
      disarmChecks += 1;
      if (disarmChecks >= 3) tracker2.disarm();
      return tracker2.isDisarmed();
    },
  };
  const resPreSpawnDisarm = await vlRoots.riserva(claimOpts(home, 'cell-pin-prespawn', {
    consumerTracker: wrappedTracker2,
    pinDeps: {
      execPath,
      nodeProbe: () => ({ status: 0, stdout: `${process.versions.node}\n`, stderr: '' }),
    },
    spawnImpl: () => {
      spawn2 += 1;
      return createFakeChild();
    },
  }));
  assert.equal(spawn2, 0);
  assert.equal(disarmChecks, 3);
  assert.equal(resPreSpawnDisarm.ok, false);
  assert.equal(resPreSpawnDisarm.outcome, 'refused');
  assert.equal(resPreSpawnDisarm.code, 'CLAIM_DISARMED');
  assert.equal(resPreSpawnDisarm.motivo, 'disarmed');
  assert.equal(tracker2.snapshot().activeCount, 0);

  // Also cover disarm mid-qualifica / before publication with a fresh uncached execPath:
  const tracker3 = vlRoots.creaTracciatoreClaim();
  let spawn3 = 0;
  let qualCalls = 0;
  const resPubDisarm = await vlRoots.riserva(claimOpts(home, 'cell-pin-pubdisarm', {
    consumerTracker: tracker3,
    pinDeps: {
      execPath: execPathPub,
      nodeProbe: () => {
        qualCalls += 1;
        tracker3.disarm();
        return { status: 0, stdout: `${process.versions.node}\n`, stderr: '' };
      },
    },
    spawnImpl: () => {
      spawn3 += 1;
      return createFakeChild();
    },
  }));
  assert.equal(qualCalls, 1);
  assert.equal(spawn3, 0);
  assert.equal(resPubDisarm.ok, false);
  assert.equal(resPubDisarm.code, 'CLAIM_DISARMED');
  assert.equal(resPubDisarm.motivo, 'disarmed');
  assert.equal(tracker3.snapshot().activeCount, 0);
});

test('rilascia enforces consumerTracker before pin, tracks child until close even after error, rejects unattested, and blocks when disarmed', async (t) => {
  const { home, base } = makeFixtureHome(t, 'nc-claim-release-track-');
  const exec1 = path.join(base, 'bin', 'node-rel-1');
  const exec2 = path.join(base, 'bin', 'node-rel-2');
  const exec3 = path.join(base, 'bin', 'node-rel-3');
  const exec4 = path.join(base, 'bin', 'node-rel-4');
  for (const p of [exec1, exec2, exec3, exec4]) {
    fs.writeFileSync(p, `#!/bin/sh\necho "v${process.versions.node}"\n`, { mode: 0o500 });
    fs.chmodSync(p, 0o500);
  }

  const makeReleaseChild = () => {
    const c = new EventEmitter();
    let raw = '';
    c.stdin = {
      write(chunk) { raw += String(chunk); },
      end() {},
    };
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.kill = () => {};
    c.completeRelease = (outcome = 'released') => {
      const req = JSON.parse(raw.trim());
      c.stdout.emit('data', Buffer.from(`${JSON.stringify({
        v: 1,
        requestId: req.requestId,
        outcome,
        ok: true,
        lockHeld: false,
      })}\n`, 'utf8'));
      c.emit('close', 0);
    };
    return c;
  };

  // 1. Normal release observes activeCount === 1 BEFORE pin probe runs,
  //    attestedActive === 1 after spawn, and enables cleanup only after attested close.
  const tracker1 = vlRoots.creaTracciatoreClaim();
  const observedInPin = [];
  let spawnCalls1 = 0;
  const child1 = makeReleaseChild();
  const rel1P = vlRoots.rilascia(claimOpts(home, 'cell-rel-normal', {
    consumerTracker: tracker1,
    pinDeps: {
      execPath: exec1,
      nodeProbe: () => {
        observedInPin.push({ ...tracker1.snapshot() });
        return { status: 0, stdout: `${process.versions.node}\n`, stderr: '' };
      },
    },
    spawnImpl: () => {
      spawnCalls1 += 1;
      return child1;
    },
  }));
  assert.equal(observedInPin.length, 1);
  assert.equal(observedInPin[0].activeCount, 1);
  assert.equal(observedInPin[0].attestedActive, 1);
  assert.equal(spawnCalls1, 1);
  assert.equal(tracker1.snapshot().attestedActive, 1);
  tracker1.disarm();
  assert.equal(tracker1.canCleanupOwnedResources(), false);
  child1.completeRelease('released');
  const res1 = await rel1P;
  assert.equal(res1.ok, true);
  assert.equal(res1.outcome, 'released');
  assert.equal(tracker1.snapshot().activeCount, 0);
  assert.equal(tracker1.canCleanupOwnedResources(), true);

  // 2. Child 'error' without 'close': rilascia Promise resolves LOCK_UNAVAILABLE,
  //    while tracker keeps activeCount === 1 and blocks cleanup until 'close' arrives.
  const tracker2 = vlRoots.creaTracciatoreClaim();
  const child2 = makeReleaseChild();
  const rel2P = vlRoots.rilascia(claimOpts(home, 'cell-rel-err-no-close', {
    consumerTracker: tracker2,
    pinDeps: {
      execPath: exec2,
      nodeProbe: () => ({ status: 0, stdout: `${process.versions.node}\n`, stderr: '' }),
    },
    spawnImpl: () => child2,
  }));
  child2.emit('error', new Error('spawn write EIO'));
  const res2 = await rel2P;
  assert.equal(res2.ok, false);
  assert.equal(res2.code, 'LOCK_UNAVAILABLE');
  tracker2.disarm();
  assert.equal(tracker2.snapshot().activeCount, 1);
  assert.equal(tracker2.snapshot().attestedActive, 1);
  assert.equal(tracker2.canCleanupOwnedResources(), false);
  child2.emit('close', 1);
  assert.equal(tracker2.snapshot().activeCount, 0);
  assert.equal(tracker2.canCleanupOwnedResources(), true);

  // 3. Unattested child (lacking .once) blocks cleanup permanently as unattestedCount === 1.
  const tracker3 = vlRoots.creaTracciatoreClaim();
  const rel3 = await vlRoots.rilascia(claimOpts(home, 'cell-rel-unattested', {
    consumerTracker: tracker3,
    pinDeps: {
      execPath: exec3,
      nodeProbe: () => ({ status: 0, stdout: `${process.versions.node}\n`, stderr: '' }),
    },
    spawnImpl: () => ({ stdin: { write() {}, end() {} } }),
  }));
  assert.equal(rel3.ok, false);
  assert.equal(rel3.outcome, 'uncertain');
  assert.equal(rel3.code, 'CONSUMER_UNATTESTED');
  tracker3.disarm();
  assert.equal(tracker3.snapshot().unattestedCount, 1);
  assert.equal(tracker3.canCleanupOwnedResources(), false);

  // 4. Already-disarmed tracker refuses release before pin and spawn; isolated tracker4 stays armed.
  const tracker4Armed = vlRoots.creaTracciatoreClaim();
  let probeDisarmedCalls = 0;
  let spawnDisarmedCalls = 0;
  const relDisarmed = await vlRoots.rilascia(claimOpts(home, 'cell-rel-disarmed', {
    consumerTracker: tracker1, // disarmed above
    pinDeps: {
      execPath: exec4,
      nodeProbe: () => {
        probeDisarmedCalls += 1;
        return { status: 0, stdout: `${process.versions.node}\n`, stderr: '' };
      },
    },
    spawnImpl: () => {
      spawnDisarmedCalls += 1;
      return makeReleaseChild();
    },
  }));
  assert.equal(relDisarmed.ok, false);
  assert.equal(relDisarmed.outcome, 'refused');
  assert.equal(relDisarmed.code, 'CLAIM_DISARMED');
  assert.equal(probeDisarmedCalls, 0);
  assert.equal(spawnDisarmedCalls, 0);
  assert.equal(tracker4Armed.isDisarmed(), false);
  const child4 = makeReleaseChild();
  const relArmedP = vlRoots.rilascia(claimOpts(home, 'cell-rel-isolated', {
    consumerTracker: tracker4Armed,
    pinDeps: {
      execPath: exec4,
      nodeProbe: () => ({ status: 0, stdout: `${process.versions.node}\n`, stderr: '' }),
    },
    spawnImpl: () => child4,
  }));
  child4.completeRelease('not-held');
  const res4 = await relArmedP;
  assert.equal(res4.ok, true);
  assert.equal(res4.outcome, 'not-held');
  assert.equal(tracker4Armed.snapshot().activeCount, 0);
});
