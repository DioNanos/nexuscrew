'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/nodes/store.js');
const cache = require('../lib/nodes/topology-cache.js');
const fed = require('../lib/proxy/federation.js');

test('topology cache is strict, atomic 0600 and rejects symlinks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-topology-cache-'));
  const file = path.join(dir, 'topology-cache.json');
  const value = { schemaVersion: 1, nodes: [{ instanceId: 'b'.repeat(32), name: 'phone', route: ['relay', 'phone'], lastSeen: 123 }] };
  cache.atomicWriteCache(file, value);
  assert.deepEqual(cache.loadCache(file), value);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(cache.parseCache({ ...value, nodes: [{ ...value.nodes[0], token: 'secret' }] }), null);
  const link = path.join(dir, 'link.json'); fs.symlinkSync(file, link);
  assert.equal(cache.loadCache(link), null);
  assert.throws(() => cache.atomicWriteCache(link, value), /symlink/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('viewer -> hub -> Pixel timeout retains the last authorized route offline', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-topology-offline-'));
  const nodesPath = path.join(dir, 'nodes.json'); const cachePath = path.join(dir, 'topology-cache.json');
  let st = store.emptyStore('a'.repeat(32));
  st = store.addNode(st, { name: 'relay', ssh: 'relay', remotePort: 41820, localPort: 43001, nodeId: 'b'.repeat(32), token: 'to-relay', acceptToken: 'from-relay', direction: 'outbound', transport: 'auto', autostart: true, visibility: 'network' });
  store.atomicWriteStore(nodesPath, st);
  const child = { instanceId: 'c'.repeat(32), name: 'pixel', route: ['pixel'] };
  await fed.collectLocalTopology({
    nodesPath, cachePath,
    fetchImpl: async () => ({ ok: true, json: async () => ({ instanceId: 'b'.repeat(32), nodes: [child] }) }),
    now: 100,
  });
  const offline = await fed.collectLocalTopology({
    nodesPath, cachePath, fetchImpl: async () => { throw new Error('timeout'); }, now: 200,
  });
  assert.deepEqual(offline.nodes.map((node) => [node.route.join('/'), node.stale]), [
    ['relay', false], ['relay/pixel', true],
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('viewer -> hub -> Pixel authoritative revoke purges cache, then re-shares fresh', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-topology-live-'));
  const nodesPath = path.join(dir, 'nodes.json'); const cachePath = path.join(dir, 'topology-cache.json');
  let st = store.emptyStore('a'.repeat(32));
  st = store.addNode(st, { name: 'relay', ssh: 'relay', remotePort: 41820, localPort: 43001, nodeId: 'b'.repeat(32), token: 'to-relay', acceptToken: 'from-relay', direction: 'outbound', transport: 'auto', autostart: true, visibility: 'network' });
  store.atomicWriteStore(nodesPath, st);
  const response = (children) => async () => ({ ok: true, json: async () => ({ instanceId: 'b'.repeat(32), nodes: children }) });
  const child = { instanceId: 'c'.repeat(32), name: 'pixel', route: ['pixel'] };
  let out = await fed.collectLocalTopology({ nodesPath, cachePath, fetchImpl: response([child]), now: 100 });
  assert.deepEqual(out.nodes.map((n) => [n.route.join('/'), n.stale]), [['relay', false], ['relay/pixel', false]]);
  out = await fed.collectLocalTopology({ nodesPath, cachePath, fetchImpl: async () => { throw new Error('down'); }, now: 200 });
  assert.deepEqual(out.nodes.map((n) => [n.route.join('/'), n.stale, n.lastSeen]), [['relay', false, 200], ['relay/pixel', true, 100]],
    'availability failure retains the last authorized owner as stale');
  out = await fed.collectLocalTopology({ nodesPath, cachePath, fetchImpl: response([]), now: 300 });
  assert.deepEqual(out.nodes.map((n) => n.route.join('/')), ['relay']);
  assert.deepEqual(cache.loadCache(cachePath).nodes, []);
  out = await fed.collectLocalTopology({ nodesPath, cachePath, fetchImpl: response([child]), now: 400 });
  assert.deepEqual(out.nodes.map((n) => [n.route.join('/'), n.stale, n.lastSeen]), [
    ['relay', false, 400], ['relay/pixel', false, 400],
  ], 'a later authorized re-share is fresh and does not resurrect stale cache state');
  fs.rmSync(dir, { recursive: true, force: true });
});
