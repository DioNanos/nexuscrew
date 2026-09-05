'use strict';
// Il mount produttivo di /api/lease è l'unico punto che può fornire al bridge
// l'instanceId del nodo. Un test sul router isolato non vede un cablaggio
// mancato in server.js: qui si avvia createServer con il node store reale.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const { createLeaseManager } = require('../lib/fleet/cell-lease-server.js');
const { createIdentityAuthority } = require('../lib/fleet/identity-authority.js');

test('server reale: lease introspect live espone il nodeId del node store', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-lease-server-node-'));
  const configDir = path.join(home, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const nodesPath = path.join(configDir, 'nodes.json');
  const tokenPath = path.join(configDir, 'token');
  nodesStore.initStore(nodesPath);
  const nodeId = nodesStore.loadStore(nodesPath).nodeId;
  assert.ok(nodeId, 'il node store deve generare una identità stabile');

  const clock = { t: 10_000 };
  const manager = createLeaseManager({ home, log: () => {} }, { now: () => clock.t });
  await manager.track('Dev');
  const authority = createIdentityAuthority({
    dir: path.join(home, 'identity'),
    serviceCredential: 'fixture-service-credential',
    now: () => 10_000,
  });
  const tuple = {
    ownerInstanceId: nodeId, cellId: 'Dev', audience: 'nexuscrew-lease',
    incarnationId: 'incarnation-server-real', launchEpoch: 'epoch-server-real',
    daemonBootId: 'boot-server-real', connectionId: 'connection-server-real',
  };
  const challenge = authority.registerDaemonChallenge({
    serviceCredential: 'fixture-service-credential', ...tuple,
  });
  const grant = authority.issueLaunchGrant({
    serviceCredential: 'fixture-service-credential', challenge: challenge.challenge, ...tuple,
  });
  const identity = authority.issueChallengeProof({
    launchGrant: grant.grant, challenge: challenge.challenge,
  });

  const { server, token, watcher } = createServer({
    home,
    configPath: path.join(configDir, 'config.json'),
    nodesPath,
    tokenPath,
    filesRoot: path.join(home, 'files'),
    port: 0,
    autoUpdate: false,
    fleetIdentityMode: 'authority',
    fleetSeam: {
      available: true,
      provider: 'seam',
      lease: manager,
      identityAuthority: authority,
      isCellSession: (session) => session === 'cloud-Dev',
      capabilities: () => [],
      status: async () => ({ available: true, cells: [] }),
    },
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (watcher) watcher.close();
    try { manager.close(); } catch (_) {}
    fs.rmSync(home, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (route, body) => fetch(`${base}${route}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const registered = await call('/api/lease/register', { proof: identity.proof });
  assert.equal(registered.status, 200);
  const registration = await registered.json();
  assert.equal(registration.status, 'registered');

  const introspected = await call('/api/lease/introspect', { proof: registration.proof });
  assert.equal(introspected.status, 200);
  const live = await introspected.json();
  assert.equal(live.status, 'live');
  assert.equal(live.instanceId, nodeId, 'il bridge shared riceve il nodeId autorevole del mount reale');
});
