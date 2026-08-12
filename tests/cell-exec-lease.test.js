'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const { main, validPayload, validLease } = require('../lib/fleet/cell-exec.js');

function mockSocket() {
  const e = new EventEmitter();
  e.setEncoding = () => {};
  e.write = () => true;
  e.destroy = () => { e.destroyed = true; };
  e.writable = true;
  e.destroyed = false;
  return e;
}

test('validLease: accetta lease ben formato, rifiuta il resto (fail-closed)', () => {
  assert.equal(validLease(undefined), true);
  assert.equal(validLease({ launchEpoch: 'ep', capability: 'ab'.repeat(32), stablePath: '/tmp/x.sock' }), true);
  assert.equal(validLease({ launchEpoch: 'ep', capability: 'nothex', stablePath: '/tmp/x.sock' }), false);
  assert.equal(validLease({ launchEpoch: 'ep', capability: 'ab'.repeat(32), stablePath: '/tmp/x.sock', extra: 1 }), false, 'chiavi non ammesse');
  assert.equal(validLease({ launchEpoch: '', capability: 'ab'.repeat(32), stablePath: '/tmp/x.sock' }), false);
  assert.equal(validLease(null), false);
});

test('validPayload: accetta payload con lease opzionale', () => {
  const base = { command: '/bin/true', args: [], env: { A: 'b' } };
  assert.equal(validPayload({ ...base }), true);
  assert.equal(validPayload({ ...base, lease: { launchEpoch: 'ep', capability: 'ab'.repeat(32), stablePath: '/tmp/x.sock' } }), true);
  assert.equal(validPayload({ ...base, lease: { launchEpoch: 'ep' } }), false, 'lease parziale rifiutato');
});

test('main: capability di lease NON compare nell\'env passato allo spawn del child (R3.1.2)', async () => {
  const capability = 'ab'.repeat(32);
  const launchEpoch = 'cd'.repeat(8);
  const stablePath = '/tmp/cell-Dev-lease-test.sock';
  const payload = {
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    env: { HOME: '/tmp', PATH: process.env.PATH || '' },
    lease: { launchEpoch, capability, stablePath },
  };
  const sock = mockSocket();
  const captured = {};
  let spawned = 0;
  const seams = {
    receivePayload: async () => ({ payload, socket: sock }),
    spawn: (cmd, args, opts) => {
      spawned += 1;
      captured.env = opts && opts.env ? { ...opts.env } : {};
      captured.stdio = opts && opts.stdio;
      const child = new EventEmitter();
      child.kill = () => {};
      child.pid = 12345;
      setTimeout(() => child.emit('exit', 0, null), 5);
      return child;
    },
    sleep: () => Promise.resolve(),
    now: () => 1000,
    setTimeout: () => 0,
    clearTimeout: () => {},
  };
  const code = await main(['--socket', '/tmp/x', '--nonce', '0'.repeat(64)], seams);
  assert.equal(spawned, 1, 'child spawnato una volta');
  // R3.1.2: la capability (e qualunque segreto di lease) NON e' nell'env del child
  assert.equal(Object.values(captured.env).some((v) => String(v).includes(capability)), false, 'capability assente dai valori env');
  assert.equal(Object.values(captured.env).some((v) => String(v).includes(launchEpoch)), false, 'launchEpoch assente dai valori env');
  assert.equal(Object.keys(captured.env).some((k) => /lease|capability|launchepoch|stablepath/i.test(k)), false, 'nessuna chiave di lease nell\'env');
  // spawnImpl passa solo env + stdio inherit: nessun bearer/canale extra al child
  assert.equal(captured.stdio, 'inherit');
  assert.equal(typeof code, 'number');
});
