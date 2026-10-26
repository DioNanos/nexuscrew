'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const net = require('node:net');
const gruppo = require('../lib/fleet/group-stop.js');
const { startLeaseClient } = require('../lib/fleet/lease-client.js');

function hexId() { return crypto.randomBytes(8).toString('hex'); }

test('escalation must not signal after drain overruns deadline', async () => {
  let clock = 0;
  const signals = [];
  const esito = await gruppo.eseguiFaseStop({
    frame: { payload: { deadlineMs: 100 }, requestId: hexId(), epoch: 1 },
    tokenHash: 'a'.repeat(64),
    launchId: hexId(),
    monoNow: () => clock,
    sleep: async (n) => { clock += n; },
    killGruppo: (s) => signals.push({ s, at: clock }),
    osserva: () => ({ inGruppo: 1, fuoriGruppo: 0, qualita: 'noti' }),
    invia: () => {},
    svuota: async () => { clock = 1000; },
    cancellaDelivery: async () => {},
  });
  assert.equal(signals.some((x) => x.at > 100), false, 'no signal sent after deadline');
  assert.equal(esito.outcome, 'stop-unknown');
});

test('pending drain must not block stop forever', async () => {
  const result = await Promise.race([
    gruppo.eseguiFaseStop({
      frame: { payload: { deadlineMs: 20 }, requestId: hexId(), epoch: 1 },
      tokenHash: 'a'.repeat(64),
      launchId: hexId(),
      monoNow: () => 0,
      sleep: async () => {},
      killGruppo: () => {},
      osserva: () => ({ inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' }),
      invia: () => {},
      svuota: () => new Promise(() => {}),
      cancellaDelivery: async () => {},
    }).then(() => 'bounded'),
    new Promise((r) => setTimeout(() => r('pending'), 100)),
  ]);
  assert.equal(result, 'bounded');
});

test('lease-client svuota bounds drain with timeout and handles closed socket', async () => {
  const { EventEmitter } = require('node:events');
  const fakeSocket = new EventEmitter();
  fakeSocket.destroyed = false;
  fakeSocket.writable = true;
  fakeSocket.writableNeedDrain = true;
  fakeSocket.write = () => true;

  const client = startLeaseClient(fakeSocket, {
    stablePath: '/tmp/test.sock',
    launchEpoch: '11'.repeat(8),
  });
  assert.ok(client);
  assert.equal(typeof client.svuota, 'function');

  // Trigger close while waiting for drain
  const svuotaPromise = client.svuota(200);
  fakeSocket.emit('close');
  const res = await svuotaPromise;
  assert.equal(res, false, 'socket close resolves svuota to false without hanging');

  if (typeof client.stop === 'function') client.stop();
});

test('pending cancel delivery must be bounded by stop deadline', async () => {
  const result = await Promise.race([
    gruppo.eseguiFaseStop({
      frame: { payload: { deadlineMs: 20 }, requestId: hexId(), epoch: 1 },
      tokenHash: 'a'.repeat(64),
      launchId: hexId(),
      monoNow: () => 0,
      sleep: async () => {},
      killGruppo: () => {},
      osserva: () => ({ inGruppo: 0, fuoriGruppo: 0, qualita: 'noti' }),
      invia: () => {},
      svuota: async () => true,
      cancellaDelivery: () => new Promise(() => {}),
    }).then(() => 'bounded'),
    new Promise((r) => setTimeout(() => r('pending'), 100)),
  ]);
  assert.equal(result, 'bounded');
});
