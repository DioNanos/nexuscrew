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
  assert.equal(fed.parseRoute('/vps/_/settings/node-aliases'), null, 'viewer-local aliases never cross federation');
  assert.equal(fed.parseRoute(`/vps/_/settings/node-aliases/${'a'.repeat(32)}`), null);
  assert.equal(fed.allowedResource('/settings/node-aliases', 'GET'), false);
  assert.deepEqual(fed.parseRoute('/vps/_/diagnostics/status'), { route: ['vps'], resource: '/diagnostics/status' });
  assert.deepEqual(fed.parseRoute('/vps/_/diagnostics/logs?after=1&limit=20'), { route: ['vps'], resource: '/diagnostics/logs' });
  assert.equal(fed.allowedResource('/diagnostics/status', 'GET'), true);
  assert.equal(fed.allowedResource('/diagnostics/status', 'PATCH'), false);
  assert.equal(fed.allowedResource('/diagnostics/logs', 'GET'), true);
  assert.equal(fed.allowedResource('/diagnostics/logs', 'DELETE'), true);
  assert.equal(fed.allowedResource('/diagnostics/verbose', 'PATCH'), true);
  assert.equal(fed.allowedResource('/diagnostics/verbose', 'GET'), false);
  assert.equal(fed.allowedQuery('/diagnostics/logs', 'GET', '/vps/_/diagnostics/logs?after=1&limit=200'), true);
  assert.equal(fed.allowedQuery('/diagnostics/logs', 'GET', '/vps/_/diagnostics/logs?raw=/home/user'), false);
  assert.equal(fed.allowedQuery('/diagnostics/logs', 'GET', '/vps/_/diagnostics/logs?after=1&after=2'), false);
  assert.equal(fed.allowedQuery('/diagnostics/status', 'GET', '/vps/_/diagnostics/status?verbose=1'), false);
  assert.equal(fed.parseRoute('/a/b/c/d/e/_/sessions'), null);
  assert.equal(fed.parseRoute('/vps/sessions'), null, 'explicit delimiter is mandatory');
  assert.equal(fed.allowedResource('/sessions', 'POST'), true);
  assert.equal(fed.allowedResource('/sessions/dev/visibility', 'PATCH'), true);
  assert.equal(fed.allowedResource('/sessions/dev/visibility', 'GET'), false);
  assert.equal(fed.allowedResource('/fleet/status', 'GET'), true);
  assert.equal(fed.allowedResource('/fleet/define-cell', 'POST'), true);
  assert.equal(fed.allowedResource('/fleet/restore-engines', 'POST'), true);
  assert.equal(fed.allowedResource('/fleet/credentials/status', 'GET'), true);
  assert.equal(fed.allowedResource('/fleet/credentials/set', 'POST'), true);
  assert.deepEqual(fed.parseRoute('/vps/_/fleet/restore-engines'), { route: ['vps'], resource: '/fleet/restore-engines' });
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

test('topology probes peers in parallel and returns partial results within a per-peer budget', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-topo-timeout-'));
  const p = path.join(dir, 'nodes.json');
  let st = store.emptyStore('f'.repeat(32));
  st = store.addNode(st, peer('silent', 'a'.repeat(32), { localPort: 43001 }));
  st = store.addNode(st, peer('fast', 'b'.repeat(32), { localPort: 43002 }));
  store.atomicWriteStore(p, st);
  const started = [];
  const before = Date.now();
  const out = await fed.collectTopologyDetailed({
    nodesPath: p, timeoutMs: 25,
    fetchImpl: async (url) => {
      started.push(url);
      if (url.includes(':43001/')) return new Promise(() => {});
      return { ok: true, json: async () => ({
        instanceId: 'b'.repeat(32),
        nodes: [{ instanceId: 'c'.repeat(32), name: 'pixel', route: ['pixel'] }],
      }) };
    },
  });
  assert.equal(started.length, 2, 'both peer probes start without waiting for the silent peer');
  assert.ok(Date.now() - before < 300, 'silent peer is bounded independently of the OS TCP timeout');
  assert.deepEqual(out.nodes.map((n) => n.route.join('/')), ['silent', 'fast', 'fast/pixel']);
  assert.deepEqual(out.authoritative, ['fast']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Share reconciliation waits for authenticated health and republishes desired state', async () => {
  const calls = [];
  let shareAttempts = 0;
  const node = peer('hub', 'a'.repeat(32), { localPort: 43009, shared: true });
  const result = await fed.reconcilePeerShare({
    node, shared: true, healthAttempts: 1, notifyAttempts: 2, delay: async () => {},
    fetchImpl: async (url, opts = {}) => {
      calls.push(String(url));
      if (String(url).endsWith('/federation/health')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, instanceId: node.nodeId }) };
      }
      assert.equal(String(url).endsWith('/federation/share'), true);
      assert.deepEqual(JSON.parse(opts.body), { shared: true });
      shareAttempts += 1;
      return { ok: shareAttempts > 1, status: shareAttempts > 1 ? 200 : 409 };
    },
  });
  assert.equal(result.shared, true);
  assert.equal(calls.filter((url) => url.endsWith('/federation/health')).length, 1);
  assert.equal(shareAttempts, 2, 'reverse channel race is retried within a bounded budget');
});

test('Share OFF reconciliation defaults to three bounded notification attempts', async () => {
  let shareAttempts = 0;
  const node = peer('hub', 'a'.repeat(32), { localPort: 43009, shared: false });
  await assert.rejects(() => fed.reconcilePeerShare({
    node, shared: false, healthAttempts: 1, delay: async () => {},
    fetchImpl: async (url) => {
      if (String(url).endsWith('/federation/health')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, instanceId: node.nodeId }) };
      }
      shareAttempts += 1;
      return { ok: false, status: 503 };
    },
  }), /HTTP 503/);
  assert.equal(shareAttempts, 3);
});

test('boot Share OFF runner is no-overlap, retries with minimum budgets and records transitions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-share-revoke-'));
  const nodesPath = path.join(dir, 'nodes.json');
  let st = store.emptyStore('b'.repeat(32));
  const node = peer('hub', 'a'.repeat(32), { localPort: 43009, shared: false });
  st = store.addNode(st, node); store.atomicWriteStore(nodesPath, st);
  const runningSet = new Set(); const records = []; const calls = [];
  const diagnostics = { record: (level, component, code, message, meta) => {
    records.push({ level, component, code, message, meta });
  } };
  let attempt = 0;
  const first = fed.runShareRevokeBoot({
    node, nodesPath, runningSet, diagnostics, backoff: [0, 0, 0], delay: async () => {},
    healthAttempts: 1, notifyAttempts: 1,
    reconcileImpl: async (input) => {
      calls.push(input); attempt += 1;
      if (attempt === 1) throw new Error('Bearer TOPSECRET should not escape');
      return { shared: false };
    },
  });
  const overlapping = await fed.runShareRevokeBoot({
    node, nodesPath, runningSet, diagnostics, reconcileImpl: async () => {
      throw new Error('must not run');
    },
  });
  assert.equal(overlapping.status, 'already-running');
  const result = await first;
  assert.deepEqual(result, { status: 'recovered', rounds: 2 });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((input) => input.shared === false
    && input.healthAttempts >= 3 && input.notifyAttempts >= 3));
  assert.deepEqual(records.map((record) => record.code), [
    'SHARE_REVOKE_PENDING', 'SHARE_REVOKE_RECOVERED',
  ]);
  assert.equal(JSON.stringify(records).includes('TOPSECRET'), false);
  assert.equal(runningSet.size, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('boot Share OFF runner aborts on desired-state change and exhausts exactly three rounds otherwise', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-share-revoke-state-'));
  const nodesPath = path.join(dir, 'nodes.json');
  let st = store.emptyStore('b'.repeat(32));
  const node = peer('hub', 'a'.repeat(32), { localPort: 43009, shared: false });
  st = store.addNode(st, node); store.atomicWriteStore(nodesPath, st);
  const abortRecords = []; let abortCalls = 0;
  const aborted = await fed.runShareRevokeBoot({
    node, nodesPath, runningSet: new Set(), backoff: [0, 0, 0], delay: async () => {},
    diagnostics: { record: (_level, _component, code) => abortRecords.push(code) },
    reconcileImpl: async () => {
      abortCalls += 1;
      let current = store.loadStoreStrict(nodesPath);
      current = store.updateNode(current, 'hub', { shared: true });
      store.atomicWriteStore(nodesPath, current);
      throw new Error('first round failed');
    },
  });
  assert.deepEqual(aborted, { status: 'aborted', reason: 'desired-state-changed' });
  assert.equal(abortCalls, 1);
  assert.deepEqual(abortRecords, ['SHARE_REVOKE_PENDING']);

  st = store.loadStoreStrict(nodesPath);
  st = store.updateNode(st, 'hub', { shared: false }); store.atomicWriteStore(nodesPath, st);
  const exhaustedRecords = []; let exhaustCalls = 0;
  const exhausted = await fed.runShareRevokeBoot({
    node, nodesPath, runningSet: new Set(), backoff: [0, 0, 0], delay: async () => {},
    diagnostics: { record: (_level, _component, code) => exhaustedRecords.push(code) },
    reconcileImpl: async () => { exhaustCalls += 1; throw new Error('still down'); },
  });
  assert.deepEqual(exhausted, { status: 'exhausted', rounds: 3 });
  assert.equal(exhaustCalls, 3);
  assert.deepEqual(exhaustedRecords, ['SHARE_REVOKE_PENDING', 'SHARE_REVOKE_EXHAUSTED']);
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
