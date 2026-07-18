'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createLaunchBroker } = require('../lib/fleet/launch-broker.js');
const { receivePayload, validPayload, main } = require('../lib/fleet/cell-exec.js');

test('launch broker delivers a payload once over a private Unix socket and leaves no secret file', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncbroker-')); fs.chmodSync(home, 0o700);
  const broker = createLaunchBroker({ home, launchTokenTtlMs: 2000 });
  try {
    const payload = { command: '/bin/echo', args: ['ok'], env: { API_KEY: 'secret-value', PATH: '/bin' } };
    const ticket = await broker.issue(payload);
    assert.equal(ticket.socketPath.includes('secret-value'), false);
    assert.equal(ticket.nonce.includes('secret-value'), false);
    assert.equal(fs.statSync(path.dirname(ticket.socketPath)).mode & 0o777, 0o700);
    const received = await receivePayload(ticket.socketPath, ticket.nonce);
    assert.deepEqual(received, payload);
    assert.equal(broker.pendingCount(), 0);
    await assert.rejects(() => receivePayload(ticket.socketPath, ticket.nonce, 200), /closed early|timed out/);
    assert.equal(fs.readdirSync(path.dirname(ticket.socketPath)).some((name) => name.endsWith('.json')), false);
  } finally { await broker.close(); fs.rmSync(home, { recursive: true, force: true }); }
});

test('cell-exec payload validation rejects shell-shaped or malformed launch data', () => {
  assert.equal(validPayload({ command: '/bin/x', args: ['; rm -rf /'], env: { SAFE: 'value' } }), true,
    'argv is data and is never shell-evaluated');
  assert.equal(validPayload({ command: '/bin/x', args: 'bad', env: {} }), false);
  assert.equal(validPayload({ command: '/bin/x', args: [], env: { 'BAD-KEY': 'x' } }), false);
  assert.equal(validPayload({ command: '/bin/x', args: [], env: {}, supervise: { enabled: true, restartDelayMs: 1000 } }), true);
  assert.equal(validPayload({ command: '/bin/x', args: [], env: {}, supervise: { restartDelayMs: 1 } }), false);
});

function fakeChild(onStart) {
  const child = new EventEmitter();
  child.kill = () => {};
  setImmediate(() => onStart(child));
  return child;
}

test('cell-exec supervisor preserves early-failure gate and does not restart an invalid launch', async () => {
  let clock = 0; let launches = 0;
  const payload = {
    command: '/bin/fake', args: [], env: {},
    supervise: { enabled: true, initialReadyMs: 50, restartDelayMs: 50 },
  };
  const code = await main(['--socket', '/tmp/x', '--nonce', 'a'.repeat(64)], {
    receivePayload: async () => payload,
    spawn: () => { launches += 1; return fakeChild((child) => { clock += 10; child.emit('exit', 2, null); }); },
    now: () => clock,
    process: new EventEmitter(),
  });
  assert.equal(code, 2);
  assert.equal(launches, 1);
});

test('cell-exec restarts stable children with backoff, reinjects send-keys prompt and opens the circuit', async () => {
  let clock = 0; let launches = 0; const waits = []; const prompts = [];
  const proc = new EventEmitter();
  const payload = {
    command: '/bin/fake', args: ['--safe'], env: { SAFE: '1' },
    supervise: {
      enabled: true, initialReadyMs: 50, restartDelayMs: 50,
      maxRestartDelayMs: 100, resetAfterMs: 1000,
      rapidWindowMs: 1000, maxRapidRestarts: 1,
    },
    restartPrompt: { tmuxBin: 'tmux', tmuxSession: 'cloud-Dev', prompt: 'resume', readyMs: 0 },
  };
  const code = await main(['--socket', '/tmp/x', '--nonce', 'b'.repeat(64)], {
    receivePayload: async () => payload,
    spawn: () => {
      launches += 1;
      return fakeChild((child) => { clock += 100; child.emit('exit', 1, null); });
    },
    now: () => clock,
    sleep: async (ms) => { waits.push(ms); },
    process: proc,
    setTimeout: (fn) => { fn(); return 1; },
    clearTimeout: () => {},
    injectPrompt: async (_bin, session, prompt) => { prompts.push([session, prompt]); },
    writeError: () => {},
  });
  assert.equal(code, 1);
  assert.equal(launches, 2);
  assert.deepEqual(waits, [50]);
  assert.deepEqual(prompts, [['cloud-Dev', 'resume']]);
  assert.equal(proc.listenerCount('SIGTERM'), 0, 'signal handlers cleaned up');
});

test('cell-exec stop during backoff disarms relaunch', async () => {
  let clock = 0; let launches = 0;
  const proc = new EventEmitter();
  const payload = {
    command: '/bin/fake', args: [], env: {},
    supervise: {
      enabled: true, initialReadyMs: 50, restartDelayMs: 50,
      maxRestartDelayMs: 100, resetAfterMs: 1000,
      rapidWindowMs: 1000, maxRapidRestarts: 4,
    },
  };
  const code = await main(['--socket', '/tmp/x', '--nonce', 'c'.repeat(64)], {
    receivePayload: async () => payload,
    spawn: () => {
      launches += 1;
      return fakeChild((child) => { clock += 100; child.emit('exit', 1, null); });
    },
    now: () => clock,
    sleep: async () => { proc.emit('SIGTERM'); },
    process: proc,
  });
  assert.equal(code, 0);
  assert.equal(launches, 1, 'nessun client rilanciato dopo il segnale di stop');
});
