'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const inventory = require('../lib/nodes/inventory.js');

test('peer inventory distingue hub, client e transitivi con azioni contestuali', () => {
  const peers = inventory.buildInventory({
    direct: [
      { name: 'asus', nodeId: 'a'.repeat(32), direction: 'outbound' },
      { name: 'pixel', nodeId: 'b'.repeat(32), direction: 'inbound' },
    ],
    topology: [
      { name: 'pixel', instanceId: 'b'.repeat(32), route: ['asus', 'pixel'], lastSeen: 1 },
      { name: 'mac', instanceId: 'c'.repeat(32), route: ['asus', 'mac'], lastSeen: 2 },
    ],
  });
  assert.equal(peers.length, 3, 'il diretto non viene duplicato dalla topology cache');
  assert.equal(peers[0].relation, 'hub');
  assert.equal(peers[0].actions.disconnect, true);
  assert.equal(peers[1].relation, 'client');
  assert.equal(peers[1].actions.visibility, true);
  assert.equal(peers[1].actions.disconnect, undefined);
  assert.equal(peers[2].kind, 'transitive');
  assert.deepEqual(peers[2].actions, { inspect: true });
  assert.equal(peers[2].manageable, false);
});

test('resolvePeer preferisce identita stabile e rifiuta nomi transitivi ambigui', () => {
  const peers = [
    inventory.routedPeer({ name: 'node', instanceId: 'a'.repeat(32), route: ['hub-a', 'node'], lastSeen: 1 }),
    inventory.routedPeer({ name: 'node', instanceId: 'b'.repeat(32), route: ['hub-b', 'node'], lastSeen: 1 }),
  ];
  assert.match(inventory.resolvePeer(peers, 'node').error, /ambiguo/);
  assert.equal(inventory.resolvePeer(peers, 'b'.repeat(32)).peer.route[0], 'hub-b');
});
