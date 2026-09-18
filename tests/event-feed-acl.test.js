'use strict';
// tests/event-feed-acl.test.js — per-peer projection: cell/node scope rules,
// visibility modes, and the rule that nodeEventsAccess never bypasses
// cellVisibility. Unconfigured peers are denied everywhere.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/nodes/store.js');
const accessPresets = require('../lib/nodes/access-presets.js');
const acl = require('../lib/notify/event-feed-acl.js');

const NODE_ID = 'c'.repeat(32);
const PEER_ID = 'd'.repeat(32);

function boot(t, preset = 'user') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncfeedacl-'));
  const nodesPath = path.join(dir, 'nodes.json');
  store.initStore(nodesPath);
  let st = store.addNode(store.loadStoreStrict(nodesPath), {
    name: 'peer', remotePort: 41999, localPort: 44777, nodeId: PEER_ID,
    acceptToken: 'ACC', direction: 'inbound', shared: true, visibility: 'network',
  });
  st = store.setPeerAccessPreset(st, 'peer', preset);
  store.atomicWriteStore(nodesPath, st);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return nodesPath;
}

const cellEnv = (cellId) => ({ v: 1, ownerId: NODE_ID, eventId: 'e', scope: 'cell', cellId, hop: 1, emittedAt: 1, frame: { type: 'notify', title: 'x' } });
const nodeEnv = () => ({ v: 1, ownerId: NODE_ID, eventId: 'e', scope: 'node', cellId: null, hop: 1, emittedAt: 1, frame: { type: 'notify', title: 'x' } });

test('user preset: cell events of visible cells and node events pass', (t) => {
  const st = store.loadStoreStrict(boot(t, 'user'));
  const peer = acl.resolvePeer(st, PEER_ID);
  assert.equal(peer.allows(cellEnv('dev')), true);
  assert.equal(peer.allows(nodeEnv()), true);
});

test('nexushost preset: no events at all, in either scope', (t) => {
  const st = store.loadStoreStrict(boot(t, 'nexushost'));
  const peer = acl.resolvePeer(st, PEER_ID);
  assert.equal(peer.allows(cellEnv('dev')), false);
  assert.equal(peer.allows(nodeEnv()), false);
});

test('selected visibility: a granted cell passes, another cell is denied before the ring', (t) => {
  const nodesPath = boot(t, 'user');
  let st = store.loadStoreStrict(nodesPath);
  st = store.setPeerAccessGrants(st, 'peer', {
    cellVisibility: 'selected', cells: ['dev'], eventsAccess: true, nodeEventsAccess: true,
    askReplyAccess: false, filesReadAccess: false, liveHostAccess: false, panelAccess: false, peerOperatorAccess: false,
  });
  store.atomicWriteStore(nodesPath, st);
  const peer = acl.resolvePeer(store.loadStoreStrict(nodesPath), PEER_ID);
  assert.equal(peer.allows(cellEnv('dev')), true);
  assert.equal(peer.allows(cellEnv('secret')), false);
});

test('nodeEventsAccess never bypasses cellVisibility: hidden cells project to nothing', (t) => {
  const nodesPath = boot(t, 'user');
  let st = store.loadStoreStrict(nodesPath);
  st = store.setPeerAccessGrants(st, 'peer', {
    cellVisibility: 'selected', cells: ['dev'], eventsAccess: true, nodeEventsAccess: true,
    askReplyAccess: false, filesReadAccess: false, liveHostAccess: false, panelAccess: false, peerOperatorAccess: false,
  });
  store.atomicWriteStore(nodesPath, st);
  const peer = acl.resolvePeer(store.loadStoreStrict(nodesPath), PEER_ID);
  const projected = peer.projectCells([{ cell: 'dev', active: true }, { cell: 'secret', active: false }]);
  assert.deepEqual(projected, [{ cell: 'dev', active: true }], 'no names and no counts of hidden cells');
  // A fake cell event using the node grant as a Trojan horse is still denied.
  assert.equal(peer.allows(cellEnv('secret')), false);
});

test('an unconfigured (legacy) peer is denied everywhere', (t) => {
  const nodesPath = boot(t, 'user');
  let st = store.loadStoreStrict(nodesPath);
  st = store.updateNode(st, 'peer', {
    eventsAccess: undefined, accessConfigured: false,
  });
  store.atomicWriteStore(nodesPath, st);
  const st2 = store.loadStoreStrict(nodesPath);
  const grants = acl.peerGrants(st2, PEER_ID);
  // simulate a legacy record: strip the grant fields entirely
  const raw = st2.nodes.find((n) => n.name === 'peer');
  delete raw.eventsAccess; delete raw.nodeEventsAccess; delete raw.accessConfigured;
  const grantsLegacy = acl.peerGrants({ ...st2, nodes: [raw] }, PEER_ID);
  assert.equal(acl.allowsEnvelope(grantsLegacy, cellEnv('dev')), false);
  assert.equal(acl.allowsEnvelope(grantsLegacy, nodeEnv()), false);
});

test('a grant change moves the signature: the publisher can detect and reset the view', (t) => {
  const nodesPath = boot(t, 'user');
  const st = store.loadStoreStrict(nodesPath);
  const before = acl.peerGrants(st, PEER_ID).signature;
  const st2 = store.setPeerAccessPreset(st, 'peer', 'nexushost');
  const after = acl.peerGrants(st2, PEER_ID).signature;
  assert.notEqual(before, after);
});
