'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createFleetExec } = require('../lib/fleet/exec.js');

const FAKE = path.join(__dirname, 'fixtures', 'fake-fleet.sh');

test('run: stdout risolto, argomenti passati', async () => {
  const fx = createFleetExec(FAKE);
  const out = await fx.run(['up', 'Dev', '--engine', 'glm']);
  assert.match(out, /fake-fleet:up Dev --engine glm/);
});

test('run: errori includono stderr', async () => {
  const fx = createFleetExec(FAKE);
  process.env.FAKE_FLEET_MODE = 'fail';
  await assert.rejects(() => fx.run(['up', 'Nope']), /boom: cella non valida/);
  delete process.env.FAKE_FLEET_MODE;
});

test('run: serializzato FIFO (mai due in volo)', async () => {
  const fx = createFleetExec(FAKE);
  const order = [];
  await Promise.all([
    fx.run(['a']).then(() => order.push('a')),
    fx.run(['b']).then(() => order.push('b')),
    fx.run(['c']).then(() => order.push('c')),
  ]);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('run: timeout', async () => {
  const fx = createFleetExec(FAKE, { timeoutMs: 300 });
  process.env.FAKE_FLEET_MODE = 'slow';
  await assert.rejects(() => fx.run(['status']), /fleet timeout/);
  delete process.env.FAKE_FLEET_MODE;
});
