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

test('local topology retains stale transitive nodes and purges after authoritative return', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-topology-live-'));
  const nodesPath = path.join(dir, 'nodes.json'); const cachePath = path.join(dir, 'topology-cache.json');
  let st = store.emptyStore('a'.repeat(32));
  st = store.addNode(st, { name: 'relay', ssh: 'relay', remotePort: 41820, localPort: 43001, nodeId: 'b'.repeat(32), token: 'to-relay', acceptToken: 'from-relay', direction: 'outbound', transport: 'auto', autostart: true, visibility: 'network' });
  store.atomicWriteStore(nodesPath, st);
  const response = (children) => async () => ({ ok: true, json: async () => ({ instanceId: 'b'.repeat(32), nodes: children }) });
  const child = { instanceId: 'c'.repeat(32), name: 'phone', route: ['phone'] };
  let out = await fed.collectLocalTopology({ nodesPath, cachePath, fetchImpl: response([child]), now: 100 });
  assert.deepEqual(out.nodes.map((n) => [n.route.join('/'), n.stale]), [['relay', false], ['relay/phone', false]]);
  out = await fed.collectLocalTopology({ nodesPath, cachePath, fetchImpl: async () => { throw new Error('down'); }, now: 200 });
  assert.deepEqual(out.nodes.map((n) => [n.route.join('/'), n.stale, n.lastSeen]), [['relay', false, 200], ['relay/phone', true, 100]]);
  out = await fed.collectLocalTopology({ nodesPath, cachePath, fetchImpl: response([]), now: 300 });
  assert.deepEqual(out.nodes.map((n) => n.route.join('/')), ['relay']);
  assert.deepEqual(cache.loadCache(cachePath).nodes, []);
  fs.rmSync(dir, { recursive: true, force: true });
});
