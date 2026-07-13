'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/nodes/store.js');
const fed = require('../lib/proxy/federation.js');

function peer(name, id, over = {}) {
  return { name, ssh: name, remotePort: 41820, localPort: 43001, nodeId: id,
    token: `to-${name}`, acceptToken: `from-${name}`, direction: 'outbound',
    transport: 'auto', autostart: true, shared: true, visibility: 'network', roles: { client: true, node: false }, ...over };
}

test('federation route parser has an explicit capability allowlist and hop cap', () => {
  assert.deepEqual(fed.parseRoute('/vps/phone/_/sessions'), { route: ['vps', 'phone'], resource: '/sessions' });
  assert.deepEqual(fed.parseRoute('/sessions/_/sessions'), { route: ['sessions'], resource: '/sessions' });
  assert.deepEqual(fed.parseRoute('/vps/_/sessions/files'), { route: ['vps'], resource: '/sessions/files' });
  assert.deepEqual(fed.parseRoute('/vps/_/sessions/_'), { route: ['vps'], resource: '/sessions/_' });
  assert.equal(fed.parseRoute('/a/b/a/_/sessions'), null, 'repeated route segment is a cycle');
  assert.equal(fed.parseRoute('/vps/_/settings/token/rotate'), null);
  assert.equal(fed.parseRoute('/a/b/c/d/e/_/sessions'), null);
  assert.equal(fed.parseRoute('/vps/sessions'), null, 'explicit delimiter is mandatory');
  assert.equal(fed.allowedResource('/sessions', 'POST'), true);
  assert.equal(fed.allowedResource('/fleet/status', 'GET'), true);
  assert.equal(fed.allowedResource('/fleet/define-cell', 'POST'), true);
  assert.equal(fed.allowedResource('/fleet/define-cell', 'GET'), false);
  assert.equal(fed.allowedResource('/settings', 'GET'), false);
  assert.deepEqual(fed.parseRoute('/vps/_/settings/peering/invite'), { route: ['vps'], resource: '/settings/peering/invite' });
  assert.equal(fed.allowedResource('/settings/peering/invite', 'POST'), true);
  assert.equal(fed.allowedResource('/settings/peering/invite', 'GET'), false);
  assert.equal(fed.parseRoute('/vps/_/settings/token/rotate'), null);
  assert.equal(fed.allowedResource('/files/outbox', 'POST'), false);
  assert.equal(fed.allowedResource('/files/upload', 'POST'), true);
});

test('relay ACL is symmetric and peer credentials identify only their peer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-fed-'));
  const p = path.join(dir, 'nodes.json');
  let st = store.emptyStore('f'.repeat(32));
  st = store.addNode(st, peer('pixel', 'a'.repeat(32)));
  st = store.addNode(st, peer('mac', 'b'.repeat(32), { visibility: 'relay-only', localPort: 43002 }));
  store.atomicWriteStore(p, st);
  assert.equal(fed.peerFromToken(p, 'from-pixel').name, 'pixel');
  assert.equal(fed.peerFromToken(p, 'wrong'), null);
  assert.equal(fed.canTransit(st.nodes[0], st.nodes[1]), false);
  const openMac = { ...st.nodes[1], visibility: 'network' };
  assert.equal(fed.canTransit(st.nodes[0], openMac), true);
  assert.equal(fed.canTransit(st.nodes[0], { ...openMac, shared: false }), false, 'un peer privato non diventa transitabile per la sola ACL');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('topology prepends relay route, deduplicates cycles, never accepts ports from advertisements', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-topo-'));
  const p = path.join(dir, 'nodes.json');
  let st = store.emptyStore('f'.repeat(32));
  st = store.addNode(st, peer('relay', 'a'.repeat(32)));
  store.atomicWriteStore(p, st);
  const out = await fed.collectTopology({ nodesPath: p, fetchImpl: async () => ({ ok: true, json: async () => ({ instanceId: 'a'.repeat(32), nodes: [
    { instanceId: 'b'.repeat(32), name: 'pixel', route: ['pixel'], localPort: 1 },
    { instanceId: 'f'.repeat(32), name: 'cycle', route: ['cycle'] },
    { instanceId: 'c'.repeat(32), name: 'evil', route: ['../evil'] },
    { instanceId: 'e'.repeat(32), name: 'repeat', route: ['x', 'x'] },
    { instanceId: '1'.repeat(32), name: 'empty', route: [] },
    { instanceId: '2'.repeat(32), name: 'mismatch', route: ['actual'] },
    { instanceId: '3'.repeat(32), name: 'pixel', route: ['pixel'] },
  ] }) }) });
  assert.deepEqual(out.nodes.map((n) => n.route), [['relay'], ['relay', 'pixel']]);
  assert.equal(out.nodes[1].localPort, undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('topology rejects a response not bound to the paired instance ID', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-topo-bind-'));
  const p = path.join(dir, 'nodes.json');
  let st = store.emptyStore('f'.repeat(32)); st = store.addNode(st, peer('relay', 'a'.repeat(32))); store.atomicWriteStore(p, st);
  const out = await fed.collectTopology({ nodesPath: p, fetchImpl: async () => ({ ok: true, json: async () => ({ instanceId: 'e'.repeat(32), nodes: [{ instanceId: 'b'.repeat(32), name: 'pixel', route: ['pixel'] }] }) }) });
  assert.deepEqual(out.nodes.map((n) => n.route), [['relay']]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('federated raw WS rejects a server-tracked instance cycle before dialing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ws-cycle-')); const p = path.join(dir, 'nodes.json');
  store.atomicWriteStore(p, store.emptyStore('a'.repeat(32)));
  let response = '';
  fed.forwardUpgrade({
    req: { url: '/federation/route/_/ws', headers: { 'x-nexuscrew-visited': 'a'.repeat(32) } },
    socket: { end: (s) => { response = s; } }, head: Buffer.alloc(0), nodesPath: p,
    localPort: 1, localCredential: () => 'local', ingress: { name: 'peer' },
  });
  assert.match(response, /^HTTP\/1\.1 409/);
  fs.rmSync(dir, { recursive: true, force: true });
});
