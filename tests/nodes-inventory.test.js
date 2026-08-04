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

// --- NC-D: anche il nome di un nodo in TRANSITO deve viaggiare ---------------
// Senza label un nodo routed arriva come slug scelto da altri: oggi cinque
// installazioni si presentano tutte come "NexusCrew". Ma la label di un peer e'
// testo auto-dichiarato, quindi si accetta solo nella forma valida e resta un
// dato riferito, mai una prova di identita'.

test('inventario: un nodo routed porta la label riferita, marcata come tale', () => {
  const peer = inventory.routedPeer({
    instanceId: 'c'.repeat(32), name: 'nexus-crew-d6b8',
    route: ['hub', 'nexus-crew-d6b8'], label: 'Portatile di casa', lastSeen: 10,
  });
  assert.equal(peer.label, 'Portatile di casa');
  assert.equal(peer.labelReported, true, 'va distinto cio' + "' che sappiamo da cio' che ci e' stato riferito");
  // L'identita' resta l'instanceId: la label non la sostituisce.
  assert.equal(peer.instanceId, 'c'.repeat(32));
  assert.equal(peer.manageable, false);
});

test('inventario: senza label il nodo routed resta senza nome, non inventato', () => {
  const peer = inventory.routedPeer({
    instanceId: 'd'.repeat(32), name: 'nexus-crew-0e88', route: ['nexus-crew-0e88'],
  });
  assert.equal(peer.label, '');
});

test('inventario: una label non stringa non contamina la voce', () => {
  const peer = inventory.routedPeer({
    instanceId: 'e'.repeat(32), name: 'peer', route: ['peer'], label: { attacco: true },
  });
  assert.equal(peer.label, '');
});
