'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { main } = require('../lib/fleet/cell-exec.js');

const hexId = () => crypto.randomBytes(8).toString('hex');

function socketFinto() {
  const s = new EventEmitter();
  s.writable = true;
  s.destroyed = false;
  s.write = () => true;
  s.destroy = () => { s.destroyed = true; s.emit('close'); };
  return s;
}

function createHarness(options = {}) {
  const launchId = hexId();
  const token = `token-${hexId()}`;
  const sock = socketFinto();
  const written = [];
  sock.write = (line) => { written.push(String(line)); return true; };
  const proc = new EventEmitter();
  const kills = [];
  const stderr = [];
  let spawnCount = 0;
  let childExited = false;
  let child = null;
  let clock = 0;

  const sendFrame = (frame) => {
    sock.emit('data', Buffer.from(`${JSON.stringify(frame)}\n`, 'utf8'));
  };

  const payload = {
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    env: { HOME: '/tmp', PATH: '/usr/bin' },
    supervise: { enabled: true, initialReadyMs: 0, ...(options.supervise || {}) },
    lease: { cellId: 'CellPrep', launchEpoch: hexId(), stablePath: '/tmp/test-prep.sock' },
    control: { launchId, token },
    restartPrompt: {
      client: 'claude', prompt: 'x', tmuxBin: '/bin/true', tmuxSession: 's', readyMs: 60000,
      ...(options.restartPrompt || {}),
    },
  };

  const seams = {
    receivePayload: async () => ({ payload, socket: sock }),
    spawn: () => {
      spawnCount += 1;
      child = new EventEmitter();
      child.pid = 4000 + spawnCount;
      child.kill = () => true;
      child.stdio = [];
      return child;
    },
    killGruppo: (sig) => {
      kills.push(sig);
      proc.emit('SIGTERM');
      if (sig === 'SIGTERM' && child && !childExited) {
        setImmediate(() => { childExited = true; child.emit('exit', 0, null); });
      }
    },
    osserva: () => ((childExited || kills.some((s) => s === 'SIGTERM' || s === 'SIGKILL'))
      ? { inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' }
      : { inGruppo: 1, fuoriGruppo: 0, qualita: 'noti' }),
    process: proc,
    sleep: async (ms) => {
      clock += ms;
      await new Promise((r) => setTimeout(r, ms));
    },
    monoNow: () => clock,
    now: () => 1000,
    writeError: (m) => { stderr.push(m); },
    tmuxExec: async () => ({ err: null, stdout: '' }),
    ...(options.seams || {}),
  };

  const frames = () => written.map((r) => r.trim()).filter(Boolean)
    .map((r) => { try { return JSON.parse(r); } catch (_) { return null; } })
    .filter((f) => f && f.op);

  return {
    launchId,
    seams,
    stderr,
    kills,
    spawnCount: () => spawnCount,
    frames,
    sendFrame,
    child: () => child,
    terminateChild: (code = 0, signal = null) => {
      if (child && !childExited) {
        childExited = true;
        child.emit('exit', code, signal);
      }
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('prepare with alive child: acknowledment, hold, then authorized stop completes cleanly', async () => {
  const h = createHarness();
  const outcome = main(['--socket', '/tmp/x', '--nonce', 'ab'.repeat(32)], h.seams);
  await sleep(50);

  h.sendFrame({ op: 'prepare', requestId: hexId(), launchId: h.launchId, epoch: 1, payload: {} });
  await sleep(100);

  assert.deepEqual(h.kills, [], 'no signals sent during preparation');
  assert.equal(h.spawnCount(), 1, 'child remains alive without respawn');
  assert.ok(h.frames().some((f) => f.op === 'prepare-ack'), 'coordinator acknowledged preparation');

  h.sendFrame({ op: 'stop', requestId: hexId(), launchId: h.launchId, epoch: 2, payload: { deadlineMs: 300 } });
  const code = await outcome;

  assert.equal(code, 0, 'clean exit after stop authorization');
  assert.equal(h.spawnCount(), 1, 'no extra spawn between prepare and stop');
  assert.ok(h.frames().some((f) => f.op === 'stop-ack'));
  assert.ok(h.frames().some((f) => f.op === 'ready-to-exit'));
  assert.equal(h.stderr.some((r) => r.includes('Cannot read properties of null')), false);
});

test('prepare with child natural exit: holds respawn without decision and without signals', async () => {
  const h = createHarness();
  const outcome = main(['--socket', '/tmp/x', '--nonce', 'ab'.repeat(32)], h.seams);
  await sleep(50);

  h.sendFrame({ op: 'prepare', requestId: hexId(), launchId: h.launchId, epoch: 1, payload: {} });
  await sleep(80);

  h.terminateChild(0);
  await sleep(150);

  assert.equal(h.spawnCount(), 1, 'no respawn after child exit while in prepared state');
  assert.deepEqual(h.kills, [], 'no signals sent while waiting for decision');

  let settled = false;
  outcome.then(() => { settled = true; }, () => { settled = true; });
  await sleep(50);
  assert.equal(settled, false, 'supervisor stays pending awaiting decision');
  assert.equal(h.stderr.some((r) => r.includes('Cannot read properties of null')), false);

  h.sendFrame({ op: 'stop', requestId: hexId(), launchId: h.launchId, epoch: 2, payload: { deadlineMs: 300 } });
  const code = await outcome;
  assert.equal(code, 0);
  assert.equal(h.spawnCount(), 1);
});

test('prepare during backoff: wakes sleep, freezes respawn, and waits for stop', async () => {
  const h = createHarness();
  const outcome = main(['--socket', '/tmp/x', '--nonce', 'ab'.repeat(32)], h.seams);
  await sleep(50);

  // Terminate initial child immediately to enter supervise backoff
  h.terminateChild(1);
  await sleep(80);

  // While in backoff sleep, issue prepare
  h.sendFrame({ op: 'prepare', requestId: hexId(), launchId: h.launchId, epoch: 1, payload: {} });
  await sleep(100);

  assert.ok(h.frames().some((f) => f.op === 'prepare-ack'));
  assert.equal(h.spawnCount(), 1, 'respawn remained frozen during backoff preparation');

  h.sendFrame({ op: 'stop', requestId: hexId(), launchId: h.launchId, epoch: 2, payload: { deadlineMs: 300 } });
  const code = await outcome;
  assert.equal(code, 0);
  assert.equal(h.spawnCount(), 1, 'did not spawn subsequent generation after prepare');
});

test('prepare during prompt delivery: cancels delivery, acknowledges, and holds respawn', async () => {
  let deliveryCancelled = false;
  let deliverySettled = false;
  const h = createHarness({
    restartPrompt: {
      client: 'claude', prompt: 'test-prompt', tmuxBin: '/bin/true', tmuxSession: 's', readyMs: 0,
    },
    seams: {
      deliverBootstrapPrompt: async ({ isCancelled }) => {
        while (!isCancelled()) {
          await sleep(20);
        }
        deliveryCancelled = true;
        deliverySettled = true;
        return { state: 'cancelled' };
      },
    },
  });
  const outcome = main(['--socket', '/tmp/x', '--nonce', 'ab'.repeat(32)], h.seams);
  await sleep(50);

  h.sendFrame({ op: 'prepare', requestId: hexId(), launchId: h.launchId, epoch: 1, payload: {} });
  await sleep(100);

  assert.ok(deliveryCancelled, 'in-flight prompt delivery was cancelled');
  assert.ok(deliverySettled, 'in-flight prompt delivery settled');
  assert.ok(h.frames().some((f) => f.op === 'prepare-ack'));
  assert.equal(h.spawnCount(), 1);

  h.sendFrame({ op: 'stop', requestId: hexId(), launchId: h.launchId, epoch: 2, payload: { deadlineMs: 300 } });
  const code = await outcome;
  assert.equal(code, 0);
});

test('prepare followed by timeout: supervisor retains channel and child without premature teardown', async () => {
  const h = createHarness();
  const outcome = main(['--socket', '/tmp/x', '--nonce', 'ab'.repeat(32)], h.seams);
  await sleep(50);

  h.sendFrame({ op: 'prepare', requestId: hexId(), launchId: h.launchId, epoch: 1, payload: {} });
  await sleep(120);

  assert.equal(h.spawnCount(), 1);
  assert.deepEqual(h.kills, []);

  let settled = false;
  outcome.then(() => { settled = true; }, () => { settled = true; });
  await sleep(50);
  assert.equal(settled, false, 'supervisor did not abort or crash on timeout');

  h.sendFrame({ op: 'stop', requestId: hexId(), launchId: h.launchId, epoch: 2, payload: { deadlineMs: 300 } });
  const code = await outcome;
  assert.equal(code, 0);
});
