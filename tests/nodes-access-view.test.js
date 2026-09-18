'use strict';
// tests/nodes-access-view.test.js — read view of the peer access policy in
// GET /api/nodes (and the same fields on /api/peers, which the settings UI
// consumes). For every direct peer the response exposes the derived label,
// the configured marker and the EFFECTIVE grant vector; the store-root
// access revision travels at the top level, because it is the CAS value the
// UI must send back with every preset write.
//
// A record written before the grant fields existed is "unconfigured" with
// every grant denied: being paired is not, by itself, a permission.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const accessPresets = require('../lib/nodes/access-presets.js');

const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

const GRANT_KEYS = ['cellVisibility', 'eventsAccess', 'nodeEventsAccess', 'askReplyAccess',
  'filesReadAccess', 'liveHostAccess', 'panelAccess', 'peerOperatorAccess'];

function boot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaccessview-'));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir,
    configDir,
    configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'),
    tokenPath: path.join(configDir, 'token'),
  };
  nodesStore.initStore(paths.nodesPath);
  const settingsSeams = {
    platform: 'linux',
    uid: 1000,
    execImpl: () => { throw new Error('exec disabled in test'); },
    serviceInstallPath: path.join(dir, 'systemd', 'nexuscrew.service'),
    keygen: (_kp, name) => `ssh-ed25519 AAAAC3FAKEKEY nexuscrew-tunnel-${name}`,
    spawnImpl: () => ({ pid: 4193999, unref() {} }),
    sshVersion: () => ({ major: 9, minor: 6 }),
  };
  const { server, token, watcher } = createServer({
    ...paths,
    filesRoot: path.join(dir, 'files'),
    port: 41999,
    fleetEnabled: false,
    settingsSeams,
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => {
    t.after(() => { server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    res({ base: `http://127.0.0.1:${server.address().port}`, token, ...paths });
  }));
}

const addNode = (base, token, name) => fetch(`${base}/api/settings/nodes`, {
  method: 'POST', headers: H(token),
  body: JSON.stringify({ name, ssh: `user@host-${name}` }),
});

test('GET /api/nodes exposes the derived label, the configured marker, the effective grants and the revision', async (t) => {
  const { base, token, nodesPath } = await boot(t);
  assert.equal((await addNode(base, token, 'asus')).status, 200);
  // Set up the state through the SHIPPED write path (preset + CAS), never by
  // hand-crafting the store: what the read view shows must be what the write
  // path actually persists.
  const revBefore = nodesStore.accessRevisionOf(nodesStore.loadStoreStrict(nodesPath));
  const patch = await fetch(`${base}/api/settings/nodes/asus`, {
    method: 'PATCH', headers: H(token),
    body: JSON.stringify({ accessRole: 'admin', accessRevision: revBefore }),
  });
  assert.equal(patch.status, 200, 'the shipped preset write must succeed');

  const res = await fetch(`${base}/api/nodes`, { headers: H(token) });
  assert.equal(res.status, 200);
  const body = await res.json();

  const asus = body.nodes.find((n) => n.name === 'asus');
  assert.ok(asus, 'the direct peer is listed');
  assert.equal(asus.accessLabel, 'admin', 'the label is derived from the grants');
  assert.equal(asus.accessConfigured, true);
  assert.deepEqual(Object.keys(asus.access).sort(), [...GRANT_KEYS].sort(), 'exactly the eight effective grants');
  assert.equal(asus.access.cellVisibility, 'all');
  assert.equal(asus.access.liveHostAccess, true);
  assert.deepEqual(asus.access.eventsAccess, true);
  assert.equal(asus.access.panelAccess, true);

  assert.ok(Number.isInteger(body.accessRevision), 'the store-root revision is an integer');
  assert.ok(body.accessRevision > revBefore, 'the preset write bumped the revision');
  assert.ok(!JSON.stringify(body).includes('ACC'), 'no token material in the response');
});

test('a peer without grants is "unconfigured" with every grant denied, and the revision is present from zero', async (t) => {
  const { base, token } = await boot(t);
  assert.equal((await addNode(base, token, 'legacy')).status, 200);

  const body = await (await fetch(`${base}/api/nodes`, { headers: H(token) })).json();
  const legacy = body.nodes.find((n) => n.name === 'legacy');
  assert.ok(legacy, 'the direct peer is listed');
  assert.equal(legacy.accessLabel, 'unconfigured', 'a legacy record is never mistaken for a preset');
  assert.equal(legacy.accessConfigured, false);
  assert.deepEqual(Object.keys(legacy.access).sort(), [...GRANT_KEYS].sort());
  assert.ok(GRANT_KEYS.every((k) => legacy.access[k] === (k === 'cellVisibility' ? 'none' : false)),
    'an unconfigured record is denied everywhere');
  assert.equal(body.accessRevision, 0, 'a store that never wrote grants reads revision 0');
});

test('GET /api/peers carries the same read view for the settings UI', async (t) => {
  const { base, token, nodesPath } = await boot(t);
  assert.equal((await addNode(base, token, 'asus')).status, 200);
  const st = nodesStore.setPeerAccessPreset(nodesStore.loadStoreStrict(nodesPath), 'asus', 'user');
  nodesStore.atomicWriteStore(nodesPath, st);

  const body = await (await fetch(`${base}/api/peers`, { headers: H(token) })).json();
  const asus = body.peers.find((p) => p.name === 'asus');
  assert.ok(asus, 'the direct peer is listed');
  assert.equal(asus.kind, 'direct');
  assert.equal(asus.accessLabel, 'user');
  assert.equal(asus.accessConfigured, true);
  assert.deepEqual(Object.keys(asus.access).sort(), [...GRANT_KEYS].sort());
  assert.equal(asus.access.filesReadAccess, true);
  assert.equal(asus.access.askReplyAccess, false);
  assert.ok(Number.isInteger(body.accessRevision), 'the revision travels at the top level here too');
});
