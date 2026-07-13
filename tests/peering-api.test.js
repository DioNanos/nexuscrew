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
  const made = createServer({
    home, configDir, configPath, nodesPath, tokenPath: path.join(configDir, 'token'),
    filesRoot: path.join(home, 'files'), fleetEnabled: false, port: 41820,
    fetchImpl: async () => ({ status: 200, json: async () => ({ ok: true, instanceId: 'b'.repeat(32) }) }),
  });
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
  assert.equal(fullInvite.port, made.server.address().port,
    'an invite minted by the hub always targets the hub single entry port');
  const identityBeforeJoin = await peering.probeTransportReady({
    port: made.server.address().port, capability: fullInvite.invite,
    expectedInstanceId: 'a'.repeat(32), attempts: 1,
  });
  assert.equal(identityBeforeJoin.ready, true, 'il listener prova capability + identita prima di consumare il link');
  const badPortOnly = await fetch(`${base}/api/settings/peering/invite`, {
    method: 'POST',
    headers: { authorization: `Bearer ${made.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ sshPort: 2222 }),
  });
  assert.equal(badPortOnly.status, 400, 'sshPort senza target SSH non deve sparire silenziosamente');
  const body = { invite: fullInvite.invite, instanceId: 'b'.repeat(32), name: 'pixel', port: 41821, acceptToken: 'pixel-accept-secret', roles: { client: true, node: false } };
  const escalation = await fetch(`${base}/pair/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, shared: true }),
  });
  assert.equal(escalation.status, 400, 'un invito non puo auto-pubblicare il client');
  const joined = await fetch(`${base}/pair/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(joined.status, 200);
  const j = await joined.json();
  assert.ok(j.credential && !JSON.stringify(j).includes(made.token));
  const identityPending = await peering.probeTransportReady({
    port: made.server.address().port, capability: j.credential,
    expectedInstanceId: 'a'.repeat(32), attempts: 1,
  });
  assert.equal(identityPending.ready, true, 'la credential pending prova il peer durante il restart finale');
  assert.deepEqual(j.roles, { client: true, node: false });
  assert.equal(store.getNode(store.loadStore(nodesPath), 'pixel'), null, 'phase 1 does not expose a half-paired peer');
  const confirmed = await fetch(`${base}/pair/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: j.credential }) });
  assert.equal(confirmed.status, 200);
  const identityConsumed = await peering.probeTransportReady({
    port: made.server.address().port, capability: j.credential,
    expectedInstanceId: 'a'.repeat(32), attempts: 1,
  });
  assert.equal(identityConsumed.ready, false, 'la prova pubblica scade quando pending viene confermato');
  const peer = store.getNode(store.loadStore(nodesPath), 'pixel');
  assert.equal(peer.direction, 'inbound');
  assert.equal(peer.token, body.acceptToken);
  assert.equal(peer.acceptToken, j.credential);
  assert.deepEqual(peer.roles, body.roles);
  assert.equal(peer.rolesKnown, true);
  assert.equal(peer.shared, false, 'il client appena associato non e pubblicato nella rete');
  const share = (shared, credential = j.credential) => fetch(`${base}/federation/share`, {
    method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
    body: JSON.stringify({ shared }),
  });
  assert.equal((await share(true, 'wrong')).status, 401);
  assert.equal((await share(true)).status, 200);
  assert.equal(store.getNode(store.loadStore(nodesPath), 'pixel').shared, true);
  assert.equal(store.getNode(store.loadStore(nodesPath), 'pixel').roles.node, true);
  assert.equal((await share(false)).status, 200);
  assert.equal(store.getNode(store.loadStore(nodesPath), 'pixel').shared, false);
  const confirmAgain = await fetch(`${base}/pair/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: j.credential }) });
  assert.equal(confirmAgain.status, 200, 'confirm is idempotent after a lost response');
  const replay = await fetch(`${base}/pair/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(replay.status, 410);
});

test('PWA invite ignores retired rendezvous state and requires an explicit reachable SSH endpoint', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pair-rdv-'));
  const configDir = path.join(home, '.nexuscrew');
  const nodesPath = path.join(configDir, 'nodes.json');
  let st = store.emptyStore('c'.repeat(32));
  st = store.parseStore({ ...st, rendezvous: { ssh: 'user@relay.example', publishedPort: 43001, localPort: 41820, keyPath: path.join(configDir, 'rdv') } });
  store.atomicWriteStore(nodesPath, st);
  const made = createServer({ home, configDir, configPath: path.join(configDir, 'config.json'), nodesPath,
    tokenPath: path.join(configDir, 'token'), filesRoot: path.join(home, 'files'), fleetEnabled: false, port: 41820 });
  await new Promise((resolve) => made.server.listen(0, '127.0.0.1', resolve));
  t.after(() => { made.server.close(); fs.rmSync(home, { recursive: true, force: true }); });
  made.cfg.port = made.server.address().port;
  const base = `http://127.0.0.1:${made.server.address().port}`;
  const legacyFallback = await fetch(`${base}/api/settings/peering/invite`, {
    method: 'POST', headers: { authorization: `Bearer ${made.token}`, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(legacyFallback.status, 400, 'lo stato rendezvous legacy non deve inventare un tunnel');
  const response = await fetch(`${base}/api/settings/peering/invite`, {
    method: 'POST', headers: { authorization: `Bearer ${made.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ ssh: 'user@relay.example' }),
  });
  assert.equal(response.status, 200);
  const parsed = peering.parsePairingUrl((await response.json()).pairingUrl);
  assert.equal(parsed.ssh, 'user@relay.example');
  assert.equal(parsed.port, made.server.address().port, 'il tunnel punta alla porta HTTP realmente in ascolto');
  assert.equal(parsed.sshPort, undefined);
});
