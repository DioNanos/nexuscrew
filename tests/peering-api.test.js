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
  // A stale/same-name peer is rejected without consuming the invite. The
  // caller must choose an explicit unique name; no silent `-2` record.
  const secondInviteRes = await fetch(`${base}/api/settings/peering/invite`, {
    method: 'POST',
    headers: { authorization: `Bearer ${made.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Second Relay', ssh: 'relay-alias' }),
  });
  const secondInvite = peering.parsePairingUrl((await secondInviteRes.json()).pairingUrl);
  const body2 = { invite: secondInvite.invite, instanceId: 'c'.repeat(32), name: 'pixel', port: 41822, acceptToken: 'second-accept-secret' };
  const sameName = await fetch(`${base}/pair/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body2),
  });
  assert.equal(sameName.status, 409);
  const sameNameBody = await sameName.json();
  assert.equal(sameNameBody.code, 'peer-name-conflict');
  assert.ok(sameNameBody.hint);
  const joined2 = await fetch(`${base}/pair/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body2, name: 'tablet' }),
  });
  assert.equal(joined2.status, 200);
  const j2 = await joined2.json();
  assert.notEqual(j2.reversePort, j.reversePort);
  const identityPending = await peering.probeTransportReady({
    port: made.server.address().port, capability: j.credential,
    expectedInstanceId: 'a'.repeat(32), attempts: 1,
  });
  assert.equal(identityPending.ready, true, 'la credential pending prova il peer durante il restart finale');
  assert.deepEqual(j.roles, { client: true, node: false });
  assert.equal(store.getNode(store.loadStore(nodesPath), 'pixel'), null, 'phase 1 does not expose a half-paired peer');
  const confirmed = await fetch(`${base}/pair/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: j.credential }) });
  assert.equal(confirmed.status, 200);
  const confirmed2 = await fetch(`${base}/pair/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: j2.credential }) });
  assert.equal(confirmed2.status, 200);
  const peersAfterConcurrentConfirm = store.loadStore(nodesPath).nodes;
  assert.equal(new Set(peersAfterConcurrentConfirm.map((node) => node.localPort)).size, 2);
  assert.deepEqual(peersAfterConcurrentConfirm.map((node) => node.name).sort(), ['pixel', 'tablet']);
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
  // A conflict is checked without consuming a fresh one-time invite. The same
  // invite can then pair a different identity successfully.
  const conflictInviteRes = await fetch(`${base}/api/settings/peering/invite`, {
    method: 'POST',
    headers: { authorization: `Bearer ${made.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'Conflict Retry', ssh: 'relay-alias' }),
  });
  const conflictInvite = peering.parsePairingUrl((await conflictInviteRes.json()).pairingUrl);
  const duplicate = await fetch(`${base}/pair/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, invite: conflictInvite.invite, name: 'duplicate-pixel' }),
  });
  assert.equal(duplicate.status, 409);
  const retryDifferentPeer = await fetch(`${base}/pair/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...body, invite: conflictInvite.invite, instanceId: 'd'.repeat(32), name: 'laptop', acceptToken: 'laptop-accept-secret' }),
  });
  assert.equal(retryDifferentPeer.status, 200, 'duplicate rejection does not burn the invite');
  const confirmAgain = await fetch(`${base}/pair/confirm`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: j.credential }) });
  assert.equal(confirmAgain.status, 200, 'confirm is idempotent after a lost response');
  const replay = await fetch(`${base}/pair/join`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(replay.status, 410);
});

test('/pair/confirm maps a lost reverse-port allocation race to actionable 409', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pair-race-'));
  const configDir = path.join(home, '.nexuscrew');
  const nodesPath = path.join(configDir, 'nodes.json');
  store.atomicWriteStore(nodesPath, store.emptyStore('a'.repeat(32)));
  const made = createServer({
    home, configDir, nodesPath, tokenPath: path.join(configDir, 'token'),
    filesRoot: path.join(home, 'files'), fleetEnabled: false,
  });
  await new Promise((resolve) => made.server.listen(0, '127.0.0.1', resolve));
  t.after(() => { made.server.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${made.server.address().port}`;
  const invite = peering.createInvite({
    invitesPath: peering.defaultInvitesPath(home), instanceId: 'a'.repeat(32),
    port: made.server.address().port, label: 'Race Hub',
  });
  const joined = await fetch(`${base}/pair/join`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      invite: peering.parsePairingUrl(invite.pairingUrl).invite,
      instanceId: 'b'.repeat(32), name: 'pixel', port: 41821,
      acceptToken: 'pixel-race-accept-secret',
    }),
  });
  assert.equal(joined.status, 200);
  const pending = await joined.json();
  let st = store.loadStoreStrict(nodesPath);
  st = store.addNode(st, {
    name: 'occupier', remotePort: 41822, localPort: pending.reversePort,
    direction: 'inbound', transport: 'inbound', autostart: true,
    visibility: 'network', nodeId: 'c'.repeat(32),
  });
  store.atomicWriteStore(nodesPath, st);
  const confirmed = await fetch(`${base}/pair/confirm`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: pending.credential }),
  });
  assert.equal(confirmed.status, 409);
  const body = await confirmed.json();
  assert.equal(body.code, 'pairing-allocation-conflict');
  assert.match(body.hint, /ripeti il pairing/i);
  assert.equal(store.getNode(store.loadStore(nodesPath), 'pixel'), null);
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
