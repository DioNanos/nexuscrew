'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const nodesHealth = require('../lib/nodes/health.js');

const NODE_ID = 'a'.repeat(32);
const node = {
  name: 'mobile-peer', direction: 'inbound', shared: true,
  localPort: 44001, token: 'peer-token', nodeId: NODE_ID,
  roles: { client: true, node: true }, rolesKnown: true,
};

function response(mode) {
  if (mode === 'timeout') {
    const error = new Error('health timeout'); error.name = 'AbortError';
    throw error;
  }
  return { status: 200, json: async () => ({ ok: true, instanceId: NODE_ID }) };
}

test('node health: un timeout non fa down, tre consecutivi fanno down, il ritorno è immediato', async () => {
  let mode = 'up';
  const fetchImpl = async () => response(mode);
  const home = `/tmp/nc-hysteresis-${process.pid}`;
  nodesHealth.clearHealthCache();

  const healthy = await nodesHealth.nodeHealth({ node, home, fetchImpl, force: true, now: 1000, failureThreshold: 3 });
  assert.equal(healthy.status, 'healthy');

  mode = 'timeout';
  const firstFailure = await nodesHealth.nodeHealth({ node, home, fetchImpl, force: true, now: 2000, failureThreshold: 3 });
  assert.equal(firstFailure.status, 'healthy', "un singolo timeout conserva l'ultimo stato");
  assert.equal(firstFailure.probePending, true);
  assert.equal(firstFailure.consecutiveFailures, 1);
  assert.notEqual(firstFailure.transport, 'down');

  const secondFailure = await nodesHealth.nodeHealth({ node, home, fetchImpl, force: true, now: 3000, failureThreshold: 3 });
  assert.equal(secondFailure.status, 'healthy');
  assert.equal(secondFailure.consecutiveFailures, 2);

  const thirdFailure = await nodesHealth.nodeHealth({ node, home, fetchImpl, force: true, now: 4000, failureThreshold: 3 });
  assert.equal(thirdFailure.status, 'down');
  assert.equal(thirdFailure.transport, 'down');
  assert.equal(thirdFailure.consecutiveFailures, 3);

  mode = 'up';
  const recovered = await nodesHealth.nodeHealth({ node, home, fetchImpl, force: true, now: 5000, failureThreshold: 3 });
  assert.equal(recovered.status, 'healthy', 'il primo probe buono ripristina subito lo stato');
  assert.equal(recovered.probePending, undefined);
});
