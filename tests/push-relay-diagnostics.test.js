'use strict';
// tests/push-relay-diagnostics.test.js — the LOCAL observability surface of the
// imported-alert relay: the counters in the authenticated diagnostics payload
// and the single line the CLI prints for one peer. Both are read-only views:
// numbers and reasons, never an endpoint, a subscription or a key.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const nodesCmds = require('../lib/nodes/commands.js');

const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

function boot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncrelaydiag-'));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir, configDir,
    configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'),
    tokenPath: path.join(configDir, 'token'),
  };
  nodesStore.initStore(paths.nodesPath);
  const { server, token, watcher } = createServer({
    ...paths,
    filesRoot: path.join(dir, 'files'),
    port: 41999,
    fleetEnabled: false,
    sessionExistsSeam: () => true,
    settingsSeams: {
      platform: 'linux', uid: 1000,
      execImpl: () => { throw new Error('exec disabled in test'); },
      serviceInstallPath: path.join(dir, 'systemd', 'nexuscrew.service'),
      keygen: (_kp, name) => `ssh-ed25519 AAAAC3FAKEKEY nexuscrew-tunnel-${name}`,
      spawnImpl: () => ({ pid: 4193999, unref() {} }),
      sshVersion: () => ({ major: 9, minor: 6 }),
    },
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => {
    t.after(() => { server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    res({ base: `http://127.0.0.1:${server.address().port}`, port: server.address().port, token, tokenPath: paths.tokenPath });
  }));
}

test('the diagnostics payload exposes the relay counters and nothing else', async (t) => {
  const { base, token } = await boot(t);
  const r = await fetch(`${base}/api/diagnostics/events`, { headers: H(token) });
  assert.equal(r.status, 200, 'the local diagnostics route answers');
  const body = await r.json();
  assert.ok(body.pushRelay, 'the relay section is present');
  assert.equal(typeof body.pushRelay.global.queued, 'number', 'the queue depth is a number');
  for (const key of ['pushed', 'dropped', 'sendFailed', 'since']) {
    assert.ok(key in body.pushRelay.global, `the global counters carry ${key}`);
  }
  assert.equal(typeof body.pushRelay.byOwner, 'object', 'the per-owner view is an object');
  const raw = JSON.stringify(body);
  for (const forbidden of ['endpoint', 'subscription', 'vapid', 'authorization', 'p256dh', 'auth']) {
    assert.equal(raw.includes(forbidden), false, `${forbidden} must never appear in the payload`);
  }
});

test('the CLI reads the feed diagnostics from the real local route', async (t) => {
  const { base, token, tokenPath, port } = await boot(t);
  // The path the CLI asks for must be the one the server actually answers: a
  // one-prefix mistake here reads the static handler and looks like an
  // unreachable server, which is exactly what an operator would believe.
  const diag = await nodesCmds.fetchFeedDiagnostics({ localAppPort: port, tokenPath });
  assert.equal(diag.ok, true, 'the local diagnostics answered: ' + JSON.stringify(diag).slice(0, 200));
  assert.ok(Array.isArray(diag.body.peers), 'the payload carries the peer list');
  assert.ok(diag.body.pushRelay, 'and the relay counters');
  const r = await fetch(`${base}/api/diagnostics/events`, { headers: H(token) });
  assert.equal(r.status, 200);
});

test('the CLI prints ONE relay line per peer, counters and last reason included', () => {
  const peer = 'd'.repeat(32);
  const body = {
    enabled: true,
    peers: [{ nodeId: peer, name: 'peer', accessLabel: 'user', accessRevision: 1, grants: {}, feed: { counters: {} } }],
    pushRelay: {
      global: { pushed: 7, dropped: 3, sendFailed: 1 },
      byOwner: { [peer]: { queued: 2, pushed: 7, dropped: 3, sendFailed: 1, lastReason: 'alert-budget' } },
    },
  };
  const line = nodesCmds.feedLinesFor({ ok: true, body }, peer).find((l) => l.startsWith('relay:'));
  assert.ok(line, 'the relay line exists');
  assert.ok(line.includes('in coda 2'), line);
  assert.ok(line.includes('inviati 7'), line);
  assert.ok(line.includes('scartati 3'), line);
  assert.ok(line.includes('errori 1'), line);
  assert.ok(line.includes('ultimo motivo alert-budget'), line);

  // A peer nobody tried to alert still gets its line, with zeros.
  const quietBody = {
    enabled: true,
    peers: [{ nodeId: 'e'.repeat(32), grants: {}, feed: { counters: {} } }],
    pushRelay: { global: {}, byOwner: {} },
  };
  const quiet = nodesCmds.feedLinesFor({ ok: true, body: quietBody }, 'e'.repeat(32)).find((l) => l.startsWith('relay:'));
  assert.ok(quiet && quiet.includes('in coda 0'), quiet);
});
