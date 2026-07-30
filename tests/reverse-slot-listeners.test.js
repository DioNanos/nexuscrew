'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createReverseSlotListeners } = require('../lib/nodes/reverse-slot-listeners.js');
const proof = require('../lib/nodes/reverse-slot-proof.js');

test('reverse slot listeners: ogni slot ha un target loopback distinto e prova solo la propria porta', async () => {
  const app = express(); app.use(express.json());
  const slots = createReverseSlotListeners({ app });
  app.post('/reverse-slot-proof', (req, res) => {
    if (!slots.respond(req, res)) res.status(404).end();
  });
  const common = { nodeName: 'hub', generation: 2, instanceId: 'a'.repeat(32), secret: 'directional-secret' };
  const old = await slots.open({ ...common, remotePort: 44103 });
  const fresh = await slots.open({ ...common, remotePort: 44203 });
  assert.notEqual(old.localPort, fresh.localPort);
  const ok = await proof.probeReverseSlot({ port: old.localPort, secret: common.secret, expected: { remotePort: 44103, generation: 2, instanceId: common.instanceId } });
  assert.equal(ok.owned, true);
  const relay = await proof.probeReverseSlot({ port: fresh.localPort, secret: common.secret, expected: { remotePort: 44103, generation: 2, instanceId: common.instanceId } });
  assert.equal(relay.owned, false);
  assert.equal(await slots.closePort(old.localPort), true);
  await slots.closeAll();
  assert.equal(slots.size(), 0);
});
