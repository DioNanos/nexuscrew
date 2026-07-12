'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const peering = require('../lib/nodes/peering.js');
const store = require('../lib/nodes/store.js');

test('PWA invite -> public one-time join creates an inbound scoped peer', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pair-api-'));
  const configDir = path.join(home, '.nexuscrew');
  const nodesPath = path.join(configDir, 'nodes.json');
  store.atomicWriteStore(nodesPath, store.emptyStore('a'.repeat(32)));
  const configPath = path.join(configDir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify({ roles: { client: true, node: false } }));
  const made = createServer({ home, configDir, configPath, nodesPath, tokenPath: path.join(configDir, 'token'), filesRoot: path.join(home, 'files'), fleetEnabled: false, port: 41820 });
  await new Promise((resolve) => made.server.listen(0, '127.0.0.1', resolve));
  t.after(() => { made.server.close(); fs.rmSync(home, { recursive: true, force: true }); });
  made.cfg.port = made.server.address().port;
  const base = `http://127.0.0.1:${made.server.address().port}`;
  const fullInviteRes = await fetch(`${base}/api/settings/peering/invite`, {
    method: 'POST',
    headers: { authorization: `Bearer ${made.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'VPS 3 Relay', ssh: 'relay-alias' }),
  });
  assert.equal(fullInviteRes.status, 200);
  const fullInvite = peering.parsePairingUrl((await fullInviteRes.json()).pairingUrl);
  assert.equal(fullInvite.v, 2);
  assert.equal(fullInvite.name, 'vps-3-relay');
  assert.equal(fullInvite.ssh, 'relay-alias');
  const badPortOnly = await fetch(`${base}/api/settings/peering/invite`, {
    method: 'POST',
    headers: { authorization: `Bearer ${made.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sshPort: 2222 }),
  });
  assert.equal(badPortOnly.status, 400, 'sshPort senza target SSH non deve sparire silenziosamente');
  const inviteRes = await fetch(`${base}/api/settings/peering/invite`, { method: 'POST', headers: { authorization: `Bearer ${made.token}` } });
  assert.equal(inviteRes.status, 200);
  const invite = peering.parsePairingUrl((await inviteRes.json()).pairingUrl);
  const body = { invite: invite.invite, instanceId: 'b'.repeat(32), name: 'pixel', port: 41821, acceptToken: 'pixel-accept-secret', roles: { client: true, node: false } };
  const joined = await fetch(`${base}/pair/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(joined.status, 200);
  const j = await joined.json();
  assert.ok(j.credential && !JSON.stringify(j).includes(made.token));
  assert.deepEqual(j.roles, { client: true, node: false });
  assert.equal(store.getNode(store.loadStore(nodesPath), 'pixel'), null, 'phase 1 does not expose a half-paired peer');
  const confirmed = await fetch(`${base}/pair/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: j.credential }) });
  assert.equal(confirmed.status, 200);
  const peer = store.getNode(store.loadStore(nodesPath), 'pixel');
  assert.equal(peer.direction, 'inbound');
  assert.equal(peer.token, body.acceptToken);
  assert.equal(peer.acceptToken, j.credential);
  assert.deepEqual(peer.roles, body.roles);
  assert.equal(peer.rolesKnown, true);
  const confirmAgain = await fetch(`${base}/pair/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: j.credential }) });
  assert.equal(confirmAgain.status, 200, 'confirm is idempotent after a lost response');
  const replay = await fetch(`${base}/pair/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(replay.status, 410);
});

test('PWA invite uses rendezvous published HTTP port without inventing sshPort', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pair-rdv-'));
  const configDir = path.join(home, '.nexuscrew');
  const nodesPath = path.join(configDir, 'nodes.json');
  let st = store.emptyStore('c'.repeat(32));
  st = store.setRendezvous(st, { ssh: 'user@relay.example', publishedPort: 43001, localPort: 41820, keyPath: path.join(configDir, 'rdv') });
  store.atomicWriteStore(nodesPath, st);
  const made = createServer({ home, configDir, configPath: path.join(configDir, 'config.json'), nodesPath,
    tokenPath: path.join(configDir, 'token'), filesRoot: path.join(home, 'files'), fleetEnabled: false, port: 41820 });
  await new Promise((resolve) => made.server.listen(0, '127.0.0.1', resolve));
  t.after(() => { made.server.close(); fs.rmSync(home, { recursive: true, force: true }); });
  made.cfg.port = made.server.address().port;
  const base = `http://127.0.0.1:${made.server.address().port}`;
  const response = await fetch(`${base}/api/settings/peering/invite`, {
    method: 'POST', headers: { authorization: `Bearer ${made.token}`, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(response.status, 200);
  const parsed = peering.parsePairingUrl((await response.json()).pairingUrl);
  assert.equal(parsed.ssh, 'user@relay.example');
  assert.equal(parsed.port, 43001);
  assert.equal(parsed.sshPort, undefined);
});
