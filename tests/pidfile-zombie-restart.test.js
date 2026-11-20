'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const pidf = require('../lib/cli/pidfile.js');
const lifecycle = require('../lib/cli/runtime-lifecycle.js');
const commands = require('../lib/cli/commands.js');

function makeTempHome(t, prefix = 'nc-pid-z-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeTestPidfile(pidPath, meta) {
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, `${JSON.stringify({ v: 1, cmd: 'nexuscrew serve --pidfile', ts: Date.now(), ...meta })}\n`, { mode: 0o600 });
}

function makeFakeServeOpts(home, extra = {}) {
  return {
    home,
    pidfile: true,
    platform: 'linux',
    port: 0,
    installSignalHandlers: false,
    ensureFleetDefaultsImpl: () => {},
    serverStart: async () => ({
      server: { listening: true },
      port: 0,
      closeOrdered: async () => ({
        status: 'completed',
        reason: 'programmatic',
        quiescent: true,
        timedOut: false,
        codes: [],
        counts: { activeOps: 0, activeClaims: 0 },
      }),
    }),
    ...extra,
  };
}

test('parseProcStat handles comm containing spaces and parentheses cleanly', () => {
  const ticks = '987654';
  // fields after (comm): field 3 (state='Z'), fields 4..21 (18 fields), field 22 (starttime)
  const padding = Array.from({ length: 18 }, (_, i) => String(100 + i)).join(' ');
  const line = `43210 (node (worker 1) v2) Z ${padding} ${ticks} 0 0`;
  const parsed = pidf.parseProcStat(line);
  assert.ok(parsed);
  assert.equal(parsed.pid, 43210);
  assert.equal(parsed.comm, 'node (worker 1) v2');
  assert.equal(parsed.state, 'Z');
  assert.equal(parsed.startTicks, ticks);

  const statLine = pidf.readProcStat(43210, () => line);
  assert.deepEqual(statLine, parsed);
});

test('pidfile and exit-proof coherence across all lifecycle cases', async (t) => {
  const validBoot = '11111111-1111-4111-8111-111111111111';

  // Case 1: old process ESRCH -> stale ('esrch'), portableRuntimeState false, startPortable & serve succeed, zero signals sent
  {
    const home = makeTempHome(t, 'nc-pid-c1-');
    const pidPath = pidf.defaultPidfilePath(home);
    pidf.writePidfile(pidPath, 234567, 'nexuscrew serve --pidfile', {
      processStart: 'linux:555',
      bootId: validBoot,
    });
    const sentSignals = [];
    const killImpl = (_pid, sig) => {
      sentSignals.push(sig);
      const err = new Error('ESRCH');
      err.code = 'ESRCH';
      throw err;
    };
    const proof = pidf.evaluatePidExitProof(234567, {
      expectedProcessStart: 'linux:555',
      expectedBootId: validBoot,
      killImpl,
      bootIdImpl: () => validBoot,
    });
    assert.deepEqual(proof, { exited: true, proof: 'esrch' });

    const ins = pidf.inspectPidfile(pidPath, { killImpl, bootIdImpl: () => validBoot });
    assert.equal(ins.state, 'stale');
    assert.equal(ins.proof, 'esrch');
    assert.equal(lifecycle.portableRuntimeState({ home, pidImpl: { killImpl, bootIdImpl: () => validBoot } }).running, false);

    let spawned = 0;
    const started = commands.startPortable({
      home,
      platform: 'linux',
      pidImpl: { killImpl, bootIdImpl: () => validBoot },
      spawnImpl: () => {
        spawned += 1;
        return { pid: 345678, unref() {} };
      },
    });
    assert.equal(started.started, true);
    assert.equal(spawned, 1);
    assert.ok(sentSignals.every((s) => s === 0), 'inspect/start must never send termination signals');

    const res = await commands.serve(makeFakeServeOpts(home, { pidImpl: { killImpl, bootIdImpl: () => validBoot } }));
    assert.ok(res && res.server);
    assert.equal(pidf.readPidfile(pidPath).pid, process.pid);
    await res.shutdown('test', 0);
  }

  // Case 2: old zombie ('Z') with same identity and comm with spaces/parens -> waitForPidExit true, inspectPidfile stale ('zombie'), restart succeeds, zero signals sent
  {
    const home = makeTempHome(t, 'nc-pid-c2-');
    const pidPath = pidf.defaultPidfilePath(home);
    const statLine = `234568 (node (worker test) 2) Z ${Array.from({ length: 18 }, () => '1').join(' ')} 77777 0`;
    writeTestPidfile(pidPath, {
      pid: 234568,
      processStart: 'linux:77777',
      bootId: validBoot,
    });
    const signals = [];
    const killImpl = (_pid, sig) => {
      signals.push(sig);
      if (sig === 0) return;
      throw new Error(`unexpected signal ${sig}`);
    };
    const pidImpl = {
      killImpl,
      bootIdImpl: () => validBoot,
      readProcStatImpl: () => statLine,
    };

    assert.equal(lifecycle.waitForPidExit(234568, 50, {
      expectedProcessStart: 'linux:77777',
      expectedBootId: validBoot,
      ...pidImpl,
    }), true);

    const ins = pidf.inspectPidfile(pidPath, pidImpl);
    assert.equal(ins.state, 'stale');
    assert.equal(ins.proof, 'zombie');

    const rtState = lifecycle.portableRuntimeState({ home, pidImpl });
    assert.equal(rtState.running, false);
    assert.equal(rtState.reason, 'stale pidfile');

    let spawned = 0;
    const started = commands.startPortable({
      home,
      platform: 'linux',
      pidImpl,
      spawnImpl: () => {
        spawned += 1;
        return { pid: 345679, unref() {} };
      },
    });
    assert.equal(started.started, true);
    assert.equal(spawned, 1);

    const served = await commands.serve(makeFakeServeOpts(home, { pidImpl }));
    assert.ok(served && served.server);
    assert.equal(pidf.readPidfile(pidPath).pid, process.pid);
    assert.ok(signals.every((s) => s === 0), 'zero SIGTERM/SIGKILL allowed during zombie inspection/replacement');
    await served.shutdown('test', 0);
  }

  // Case 3: PID reused by a different birth (even if the new process is also Z) -> stale ('birth'), zero signals to reused PID
  {
    const home = makeTempHome(t, 'nc-pid-c3-');
    const pidPath = pidf.defaultPidfilePath(home);
    writeTestPidfile(pidPath, {
      pid: 234569,
      processStart: 'linux:1000',
      bootId: validBoot,
    });
    const signals = [];
    const killImpl = (_pid, sig) => { signals.push(sig); };
    const pidImpl = {
      killImpl,
      bootIdImpl: () => validBoot,
      readProcStatImpl: () => `234569 (other (app)) Z ${Array.from({ length: 18 }, () => '1').join(' ')} 2000 0`,
    };
    const ins = pidf.inspectPidfile(pidPath, pidImpl);
    assert.equal(ins.state, 'stale');
    assert.equal(ins.proof, 'birth');
    assert.ok(signals.every((s) => s === 0), 'reused PID must never receive termination signal');
  }

  // Case 4: live process -> inspectPidfile 'alive', startPortable & serve refuse, pidfile untouched
  {
    const home = makeTempHome(t, 'nc-pid-c4-');
    const pidPath = pidf.defaultPidfilePath(home);
    writeTestPidfile(pidPath, {
      pid: 234570,
      processStart: 'linux:8888',
      bootId: validBoot,
    });
    const pidImpl = {
      killImpl: () => {},
      bootIdImpl: () => validBoot,
      readProcStatImpl: () => `234570 (node server) S ${Array.from({ length: 18 }, () => '1').join(' ')} 8888 0`,
    };
    const ins = pidf.inspectPidfile(pidPath, pidImpl);
    assert.equal(ins.state, 'alive');
    const started = commands.startPortable({ home, platform: 'linux', pidImpl });
    assert.equal(started.started, false);
    assert.equal(started.reason, 'already running');
    await assert.rejects(async () => commands.serve(makeFakeServeOpts(home, { pidImpl })), /already running/);
    assert.equal(pidf.readPidfile(pidPath).pid, 234570);
  }

  // Case 5: Termux guard held vs mismatched guard inode
  {
    const home = makeTempHome(t, 'nc-pid-c5-');
    const pidPath = pidf.defaultPidfilePath(home);
    writeTestPidfile(pidPath, {
      pid: 234571,
      processStart: 'linux:9999',
      bootId: validBoot,
      serviceGuard: { v: 1, dev: 10, ino: 20 },
    });
    const killImpl = () => {};
    const readProcStatImpl = () => `234571 (node server) S ${Array.from({ length: 18 }, () => '1').join(' ')} 9999 0`;
    const insHeld = pidf.inspectPidfile(pidPath, {
      killImpl, bootIdImpl: () => validBoot, readProcStatImpl, guard: { dev: 10, ino: 20 },
    });
    assert.equal(insHeld.state, 'stale');
    assert.equal(insHeld.proof, 'guard');

    const insWrong = pidf.inspectPidfile(pidPath, {
      killImpl, bootIdImpl: () => validBoot, readProcStatImpl, guard: { dev: 10, ino: 99 },
    });
    assert.equal(insWrong.state, 'alive');
  }

  // Case 6: EPERM, unreadable start, and zombie without attestation -> indeterminate, refused, zero deletes/signals
  {
    const home = makeTempHome(t, 'nc-pid-c6-');
    const pidPath = pidf.defaultPidfilePath(home);
    writeTestPidfile(pidPath, {
      pid: 234572,
      processStart: 'linux:1234',
      bootId: validBoot,
    });

    const epermKill = () => { const e = new Error('EPERM'); e.code = 'EPERM'; throw e; };
    const insEperm = pidf.inspectPidfile(pidPath, { killImpl: epermKill, bootIdImpl: () => validBoot });
    assert.equal(insEperm.state, 'indeterminate');
    assert.equal(insEperm.reason, 'kill-foreign');
    assert.equal(pidf.removeStalePidfile(pidPath, insEperm), false);

    const unreadableImpl = { killImpl: () => {}, bootIdImpl: () => validBoot, readProcessStartImpl: () => null };
    const insUnreadable = pidf.inspectPidfile(pidPath, unreadableImpl);
    assert.equal(insUnreadable.state, 'indeterminate');
    assert.equal(insUnreadable.reason, 'start-unreadable');
    assert.equal(commands.startPortable({ home, platform: 'linux', pidImpl: unreadableImpl }).started, false);
    await assert.rejects(
      async () => commands.serve(makeFakeServeOpts(home, { pidImpl: unreadableImpl })),
      (err) => err && err.code === 'PIDFILE_UNVERIFIABLE',
    );
    assert.equal(pidf.readPidfile(pidPath).pid, 234572);

    // No-attestation pidfile must stay indeterminate even if /proc/<pid>/stat reports 'Z'
    const noAttestProof = pidf.evaluatePidExitProof(234572, {
      expectedProcessStart: null,
      expectedBootId: validBoot,
      killImpl: () => {},
      bootIdImpl: () => validBoot,
      readProcStatImpl: () => `234572 (node) Z ${Array.from({ length: 18 }, () => '1').join(' ')} 1234 0`,
    });
    assert.equal(noAttestProof.exited, false);
    assert.equal(noAttestProof.state, 'indeterminate');
    assert.equal(noAttestProof.reason, 'no-attestation');
  }

  // Case 7: malformed JSON and symlink pidfile -> invalid, refused, target untouched
  {
    const home = makeTempHome(t, 'nc-pid-c7-');
    const pidPath = pidf.defaultPidfilePath(home);
    fs.mkdirSync(path.dirname(pidPath), { recursive: true });
    fs.writeFileSync(pidPath, '{bad json');
    assert.equal(pidf.inspectPidfile(pidPath).state, 'invalid');
    await assert.rejects(
      async () => commands.serve(makeFakeServeOpts(home)),
      (err) => err && err.code === 'PIDFILE_INVALID',
    );
    assert.equal(fs.readFileSync(pidPath, 'utf8'), '{bad json');

    const target = path.join(home, 'victim.json');
    fs.writeFileSync(target, JSON.stringify({ keep: true }));
    fs.unlinkSync(pidPath);
    fs.symlinkSync(target, pidPath);
    const insSym = pidf.inspectPidfile(pidPath);
    assert.equal(insSym.state, 'invalid');
    await assert.rejects(
      async () => commands.serve(makeFakeServeOpts(home)),
      (err) => err && err.code === 'PIDFILE_INVALID',
    );
    assert.equal(fs.lstatSync(pidPath).isSymbolicLink(), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { keep: true });
  }

  // Case 8: pidfile replaced between inspectPidfile and removeStalePidfile -> returns false & serve throws PIDFILE_CONFLICT
  {
    const home = makeTempHome(t, 'nc-pid-c8-');
    const pidPath = pidf.defaultPidfilePath(home);
    writeTestPidfile(pidPath, {
      pid: 234573,
      processStart: 'linux:3333',
      bootId: validBoot,
      generationId: 'old-gen',
    });
    const staleIns = pidf.inspectPidfile(pidPath, {
      killImpl: () => { const e = new Error('ESRCH'); e.code = 'ESRCH'; throw e; },
      bootIdImpl: () => validBoot,
    });
    assert.equal(staleIns.state, 'stale');

    // Replace with new file before removal runs (atomic rename guarantees distinct inode and winner meta)
    const winnerTmp = `${pidPath}.winner`;
    writeTestPidfile(winnerTmp, {
      pid: 234574,
      processStart: 'linux:4444',
      bootId: validBoot,
      generationId: 'winner-gen',
    });
    fs.renameSync(winnerTmp, pidPath);
    assert.equal(pidf.removeStalePidfile(pidPath, staleIns), false);
    assert.equal(pidf.readPidfile(pidPath).generationId, 'winner-gen');

    // End-to-end inside commands.serve: swap file after inspect opens/stats old inode (boot mismatch runs after fstat)
    let swapped = false;
    await assert.rejects(
      async () => commands.serve(makeFakeServeOpts(home, {
        pidImpl: {
          killImpl: () => {},
          bootIdImpl: () => {
            if (!swapped) {
              swapped = true;
              const raceTmp = `${pidPath}.race`;
              writeTestPidfile(raceTmp, {
                pid: 234575,
                processStart: 'linux:5555',
                bootId: validBoot,
                generationId: 'race-winner',
              });
              fs.renameSync(raceTmp, pidPath);
              return '22222222-2222-4222-8222-222222222222';
            }
            return validBoot;
          },
        },
      })),
      (err) => err && err.code === 'PIDFILE_CONFLICT',
    );
    assert.equal(pidf.readPidfile(pidPath).generationId, 'race-winner');
  }
});

test('real Linux zombie subprocess is judged exited by both waitForPidExit and inspectPidfile', async (t) => {
  if (process.platform !== 'linux') return;
  const home = makeTempHome(t, 'nc-pid-real-z-');
  const pidPath = pidf.defaultPidfilePath(home);

  // Holder process spawns a grandchild that exits immediately, then blocks synchronously in Atomics.wait
  // without spinning libuv's event loop so the grandchild remains a kernel zombie ('Z') for inspection.
  const holderCode = `
    const { spawn } = require('node:child_process');
    const gc = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
    process.stdout.write(String(gc.pid) + '\\n');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000);
  `;
  const holder = spawn(process.execPath, ['-e', holderCode], { stdio: ['ignore', 'pipe', 'inherit'] });
  t.after(() => { try { holder.kill('SIGKILL'); } catch (_) {} });

  const zombiePid = await new Promise((resolve, reject) => {
    let out = '';
    holder.stdout.on('data', (d) => {
      out += d.toString();
      const m = out.match(/(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    holder.on('exit', (c) => reject(new Error(`holder exited early: ${c}`)));
  });

  let proc = null;
  for (let i = 0; i < 100; i += 1) {
    proc = pidf.readProcStat(zombiePid);
    if (proc && proc.state === 'Z') break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(proc && proc.state === 'Z', `expected child ${zombiePid} in zombie state Z, got ${proc && proc.state}`);

  const processStart = `linux:${proc.startTicks}`;
  const bootId = pidf.readBootId();
  pidf.writePidfile(pidPath, zombiePid, 'nexuscrew serve --pidfile', { processStart, bootId });

  assert.equal(lifecycle.waitForPidExit(zombiePid, 200, { expectedProcessStart: processStart, expectedBootId: bootId }), true);
  const ins = pidf.inspectPidfile(pidPath);
  assert.equal(ins.state, 'stale');
  assert.equal(ins.proof, 'zombie');
  assert.equal(lifecycle.portableRuntimeState({ home }).running, false);
  assert.equal(pidf.removeStalePidfile(pidPath, ins), true);
  assert.equal(fs.existsSync(pidPath), false);
});

test('stopPortableRuntime binds exit wait to killPidfile verified identity and rejects A->B pidfile substitution', (t) => {
  const hostBootId = pidf.readBootId();

  // Case 1: pidfile replaced A -> B (different pid/generationId) between inspectPidfile and killPidfile
  {
    const home = makeTempHome(t, 'nc-pidswap-sub-');
    const pidPath = pidf.defaultPidfilePath(home);
    writeTestPidfile(pidPath, {
      pid: 11111,
      processStart: 'linux:100',
      bootId: hostBootId,
      generationId: 'gen-A',
    });

    const termSignals = [];
    let inspectedOnce = false;
    const pidImpl = {
      bootIdImpl: () => hostBootId,
      readProcessStartImpl: (pid) => {
        if (pid === 11111 && !inspectedOnce) {
          inspectedOnce = true;
          // Race substitution between inspectPidfile and killPidfile
          writeTestPidfile(pidPath, {
            pid: 22222,
            processStart: 'linux:200',
            bootId: hostBootId,
            generationId: 'gen-B',
          });
          return 'linux:100';
        }
        return pid === 22222 ? 'linux:200' : 'linux:100';
      },
      readCmdlineImpl: () => 'nexuscrew serve --pidfile',
      killImpl: (pid, sig) => {
        if (sig === 0) return true;
        termSignals.push({ pid, sig });
      },
    };

    const res = lifecycle.stopPortableRuntime({ home, platform: 'linux', stopWaitMs: 100, pidImpl });
    assert.equal(res.killed, false);
    assert.match(res.reason, /identity changed before signal/i);
    assert.deepEqual(termSignals, [], 'must never send SIGTERM to replacement process B');
    assert.equal(pidf.readPidfile(pidPath).generationId, 'gen-B', 'replacement pidfile B must remain intact');
    assert.equal(pidf.readPidfile(pidPath).pid, 22222);
  }

  // Case 2: same PID reused with different processStart/generationId between inspectPidfile and killPidfile
  {
    const home = makeTempHome(t, 'nc-pidswap-samepid-');
    const pidPath = pidf.defaultPidfilePath(home);
    writeTestPidfile(pidPath, {
      pid: 33333,
      processStart: 'linux:300',
      bootId: hostBootId,
      generationId: 'gen-A',
    });

    const termSignals = [];
    let swapped = false;
    const pidImpl = {
      bootIdImpl: () => hostBootId,
      readProcessStartImpl: () => {
        if (!swapped) {
          swapped = true;
          writeTestPidfile(pidPath, {
            pid: 33333,
            processStart: 'linux:301',
            bootId: hostBootId,
            generationId: 'gen-B',
          });
          return 'linux:300';
        }
        return 'linux:301';
      },
      readCmdlineImpl: () => 'nexuscrew serve --pidfile',
      killImpl: (pid, sig) => {
        if (sig === 0) return true;
        termSignals.push({ pid, sig });
      },
    };

    const res = lifecycle.stopPortableRuntime({ home, platform: 'linux', stopWaitMs: 100, pidImpl });
    assert.equal(res.killed, false);
    assert.match(res.reason, /identity changed before signal/i);
    assert.deepEqual(termSignals, []);
    assert.equal(pidf.readPidfile(pidPath).generationId, 'gen-B');
  }

  // Case 3: positive same-generation stop binds waitForPidExit to killPidfile's signaled identity
  //         (and detects exit cleanly even if PID is immediately reused by a newer birth)
  {
    const home = makeTempHome(t, 'nc-pidswap-ok-');
    const pidPath = pidf.defaultPidfilePath(home);
    writeTestPidfile(pidPath, {
      pid: 44444,
      processStart: 'linux:400',
      bootId: hostBootId,
      generationId: 'gen-same',
    });

    let signaled = false;
    const pidImpl = {
      bootIdImpl: () => hostBootId,
      readProcessStartImpl: () => (signaled ? 'linux:499' : 'linux:400'),
      readCmdlineImpl: () => 'nexuscrew serve --pidfile',
      readProcStatImpl: () => null,
      killImpl: (_pid, sig) => {
        if (sig === 0) return true;
        signaled = true;
      },
    };

    const res = lifecycle.stopPortableRuntime({ home, platform: 'linux', stopWaitMs: 100, pidImpl });
    assert.equal(res.killed, true);
    assert.equal(res.pid, 44444);
    assert.equal(res.processStart, 'linux:400');
    assert.equal(res.bootId, hostBootId);
    assert.equal(res.generationId, 'gen-same');
  }
});
