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

// 2b (A2): la capability statica non esiste piu' nel payload. Il lease porta
// solo i dati di routing; il proof arriva sul canale, non nel payload.
test('validLease: accetta lease ben formato (senza capability), rifiuta il resto (fail-closed)', () => {
  assert.equal(validLease(undefined), true);
  assert.equal(validLease({ cellId: 'Dev', launchEpoch: 'ep', stablePath: '/tmp/x.sock' }), true);
  assert.equal(validLease({ launchEpoch: 'ep', stablePath: '/tmp/x.sock' }), true);
  // capability: revocata — la sua presenza e' un payload non valido
  assert.equal(validLease({ launchEpoch: 'ep', capability: 'ab'.repeat(32), stablePath: '/tmp/x.sock' }), false, 'capability revocata (A2): rifiutata');
  assert.equal(validLease({ launchEpoch: 'ep', stablePath: '/tmp/x.sock', extra: 1 }), false, 'chiavi non ammesse');
  assert.equal(validLease({ launchEpoch: '', stablePath: '/tmp/x.sock' }), false);
  assert.equal(validLease(null), false);
});

test('validPayload: accetta payload con lease opzionale', () => {
  const base = { command: '/bin/true', args: [], env: { A: 'b' } };
  assert.equal(validPayload({ ...base }), true);
  assert.equal(validPayload({ ...base, lease: { launchEpoch: 'ep', stablePath: '/tmp/x.sock' } }), true);
  assert.equal(validPayload({ ...base, lease: { launchEpoch: 'ep' } }), false, 'lease parziale rifiutato');
});

test('main: nessun dato di lease compare nell\'env passato allo spawn del child (R3.1.2)', async () => {
  const launchEpoch = 'cd'.repeat(8);
  const stablePath = '/tmp/cell-Dev-lease-test.sock';
  const payload = {
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],
    env: { HOME: '/tmp', PATH: process.env.PATH || '' },
    lease: { cellId: 'Dev', launchEpoch, stablePath },
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
  // R3.1.2: nessun segreto/dato di lease nell'env del child. In 2b il proof non
  // transita nemmeno nel payload: vive solo nel lease-client del supervisore.
  assert.equal(Object.values(captured.env).some((v) => String(v).includes(launchEpoch)), false, 'launchEpoch assente dai valori env');
  assert.equal(Object.values(captured.env).some((v) => String(v).includes(stablePath)), false, 'stablePath assente dai valori env');
  assert.equal(Object.keys(captured.env).some((k) => /lease|capability|proof|launchepoch|stablepath/i.test(k)), false, 'nessuna chiave di lease nell\'env');
  // spawnImpl passa solo env + stdio inherit: nessun bearer/canale extra al child
  assert.equal(captured.stdio, 'inherit');
  assert.equal(typeof code, 'number');
});
