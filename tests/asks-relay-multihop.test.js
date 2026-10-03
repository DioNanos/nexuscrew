'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { createServer } = require('../lib/server.js');
const store = require('../lib/nodes/store.js');
const { tmuxSessionForCell } = require('../lib/fleet/definitions.js');

const headers = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function boot(t, label) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `ask-route-${label}-`));
  const configDir = path.join(home, '.nexuscrew'); fs.mkdirSync(configDir);
  const nodesPath = path.join(configDir, 'nodes.json'); store.initStore(nodesPath);
  const pastes = [];
  const runtime = createServer({ home, configDir, nodesPath, configPath: path.join(configDir, 'config.json'),
    tokenPath: path.join(configDir, 'token'), filesRoot: path.join(home, 'files'),
    port: 0, fleetEnabled: false, sessionExistsSeam: () => true,
    pasteSeam: async (session, text) => { pastes.push({ session, text }); return true; },
    askSubmit: async (session, text) => { pastes.push({ session, text }); return { outcome: 'submitted', submitted: true }; },
    settingsSeams: { platform: 'linux', uid: 1000, execImpl: () => { throw new Error('disabled in fixture'); },
      serviceInstallPath: path.join(home, 'service'), keygen: () => 'ssh-ed25519 AAAAFIXTURE demo',
      spawnImpl: () => ({ pid: 4100000, unref() {} }), sshVersion: () => ({ major: 9, minor: 6 }) },
  });
  await new Promise((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    runtime.server.closeAllConnections();
    await new Promise((resolve) => runtime.server.close(resolve));
    runtime.watcher.close(); fs.rmSync(home, { recursive: true, force: true });
  });
  const port = runtime.server.address().port;
  return { ...runtime, home, configDir, nodesPath, port, base: `http://127.0.0.1:${port}`,
    id: store.loadStoreStrict(nodesPath).nodeId, pastes };
}
function peer(node, other, name, direction, token) {
  let st = store.addNode(store.loadStoreStrict(node.nodesPath), {
    name, nodeId: other.id, direction, token, acceptToken: token,
    localPort: other.port, remotePort: 41999, shared: true, visibility: 'network', ssh: 'demo@example.invalid',
  });
  st = store.setPeerAccessPreset(st, name, 'admin');
  st = store.updateNode(st, name, { eventsReceive: false });
  store.atomicWriteStore(node.nodesPath, st);
}
function edit(node, name, patch) {
  const st = store.updateNode(store.loadStoreStrict(node.nodesPath), name, patch);
  store.atomicWriteStore(node.nodesPath, st);
}
async function fixture(t) {
  const client = await boot(t, 'client'); const hub = await boot(t, 'hub'); const owner = await boot(t, 'owner');
  peer(client, hub, 'hub', 'outbound', 'client-hub-fixture-token');
  peer(hub, client, 'client', 'inbound', 'client-hub-fixture-token');
  peer(hub, owner, 'owner', 'outbound', 'hub-owner-fixture-token');
  peer(owner, hub, 'hub', 'inbound', 'hub-owner-fixture-token');
  assert.equal(store.loadStoreStrict(client.nodesPath).nodes.some((n) => n.nodeId === owner.id), false);
  assert.equal(store.loadStoreStrict(owner.nodesPath).nodes.some((n) => n.nodeId === client.id), false);
  const created = await fetch(`${owner.base}/api/asks`, { method: 'POST', headers: headers(owner.token),
    body: JSON.stringify({ question: 'Proceed with review?', session: tmuxSessionForCell('reviewer'), target: client.id }) });
  const body = await created.json(); assert.equal(created.status, 201, JSON.stringify(body));
  const askId = body.id;
  let alias;
  for (let attempt = 0; attempt < 30 && !alias; attempt++) {
    const list = await fetch(`${client.base}/api/asks?open=1`, { headers: headers(client.token) }).then((r) => r.json());
    alias = list.asks.find((a) => a.ownerId === owner.id && a.ownerAskId === askId);
    if (!alias) await sleep(10);
  }
  assert.ok(alias, 'the owner ASK is actually delivered through the hub before testing its return path');
  assert.notEqual(alias.id, askId);
  return { client, hub, owner, askId, alias };
}
async function relay(client, body) {
  const response = await fetch(`${client.base}/api/asks-relay`, { method: 'POST', headers: headers(client.token),
    body: JSON.stringify(body) });
  return { code: response.status, body: await response.json() };
}

test('three real servers return an answer through the hub, with one paste, actor receipt and alias closure', async (t) => {
  const { client, owner, askId, alias } = await fixture(t);
  const requestId = crypto.randomUUID();
  const out = await relay(client, { action: 'answer', ownerId: owner.id, askId, text: 'Proceed', requestId });
  assert.equal(out.code, 200, JSON.stringify(out.body));
  assert.equal(out.body.status, 'committed');
  assert.equal(out.body.requestId, requestId);
  assert.equal(owner.pastes.length, 1);
  assert.equal(owner.pastes[0].session, tmuxSessionForCell('reviewer'));
  assert.equal(client.pastes.length, 0);
  const verify = await relay(client, { action: 'verify', ownerId: owner.id, askId, requestId });
  assert.equal(verify.code, 200, JSON.stringify(verify.body));
  assert.equal(verify.body.state, 'committed');
  const open = await fetch(`${client.base}/api/asks?open=1`, { headers: headers(client.token) }).then((r) => r.json());
  assert.equal(open.asks.some((a) => a.id === alias.id), false, 'only an authoritative committed closure removes the alias');
  assert.equal(owner.pastes.length, 1);
});

test('the proven two-hop terminal accepts ASK action without widening the event stream gate', async (t) => {
  const { client, owner, askId } = await fixture(t);
  const resource = `/api/route/hub/owner/_/event-feed/asks/${askId}/answer`;
  const response = await fetch(client.base + resource, { method: 'POST', headers: headers(client.token),
    body: JSON.stringify({ text: 'Proceed', requestId: crypto.randomUUID() }) });
  const body = await response.json().catch(() => ({ status: 'unsupported' }));
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(owner.pastes.length, 1);
  const stream = await fetch(`${client.base}/api/route/hub/owner/_/event-feed`, { headers: headers(client.token) });
  assert.equal(stream.status, 403, 'the full event feed remains direct-peer-only');
});

test('capability is an owner-qualified action through the same two hops and does not require eventsReceive', async (t) => {
  const { client, owner, askId } = await fixture(t);
  const response = await fetch(`${client.base}/api/asks-relay/capability?ownerId=${owner.id}&askId=${askId}`,
    { headers: headers(client.token) });
  const body = await response.json().catch(() => ({ status: 'unsupported' }));
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(body, { ownerId: owner.id, askId, canReply: true, status: 'open' });
  assert.equal(store.getNode(store.loadStoreStrict(client.nodesPath), 'hub').eventsReceive, false);
  assert.equal(owner.pastes.length, 0);
});

for (const scenario of ['hub ASK revoked', 'hub events revoked', 'owner ASK revoked', 'owner events revoked',
  'hidden cell', 'direct origin revoked', 'shared disabled', 'unknown route', 'wrong owner', 'readonly']) {
  test(`a two-hop ASK action is opaque and cannot paste when ${scenario}`, async (t) => {
    const { client, hub, owner, askId } = await fixture(t);
    if (scenario === 'hub ASK revoked') edit(hub, 'client', { askReplyAccess: false });
    if (scenario === 'hub events revoked') edit(hub, 'client', { eventsAccess: false });
    if (scenario === 'owner ASK revoked') edit(owner, 'hub', { askReplyAccess: false });
    if (scenario === 'owner events revoked') edit(owner, 'hub', { eventsAccess: false });
    if (scenario === 'hidden cell') edit(owner, 'hub', { cellVisibility: 'selected', cells: ['other'] });
    if (scenario === 'direct origin revoked') {
      peer(owner, client, 'direct-client', 'inbound', 'direct-origin-fixture-token');
      edit(owner, 'direct-client', { askReplyAccess: false });
    }
    if (scenario === 'shared disabled') edit(hub, 'owner', { shared: false });
    if (scenario === 'unknown route') {
      const st = store.loadStoreStrict(client.nodesPath); st.nodes = []; store.atomicWriteStore(client.nodesPath, st);
    }
    if (scenario === 'readonly') owner.cfg.readonlyDefault = true;
    const ownerId = scenario === 'wrong owner' ? 'f'.repeat(32) : owner.id;
    const out = await relay(client, { action: 'answer', ownerId, askId, text: 'Proceed', requestId: crypto.randomUUID() });
    assert.ok([403, 404].includes(out.code), JSON.stringify(out));
    assert.equal(owner.pastes.length, 0); assert.equal(hub.pastes.length, 0); assert.equal(client.pastes.length, 0);
    assert.ok(!JSON.stringify(out.body).includes('Proceed with review?'));
    assert.ok(!JSON.stringify(out.body).includes(tmuxSessionForCell('reviewer')));
    const cap = await fetch(`${client.base}/api/asks-relay/capability?ownerId=${ownerId}&askId=${askId}`,
      { headers: headers(client.token) }).then(async (r) => ({ code: r.status, body: await r.json().catch(() => ({})) }));
    assert.notEqual(cap.body.canReply, true, 'a denied action never gains a capability from a feed');
    assert.ok(!JSON.stringify(cap.body).includes(tmuxSessionForCell('reviewer')));
  });
}

test('forged hop proofs, visited chains and route cycles cannot expose or paste an ASK', async (t) => {
  const { client, owner, askId } = await fixture(t);
  for (const visited of [`${client.id},${owner.id}`, `${owner.id},${owner.id}`, `${client.id},${'e'.repeat(32)}`]) {
    const response = await fetch(`${owner.base}/api/event-feed/asks/${askId}/answer`, { method: 'POST',
      headers: { ...headers(owner.token), 'x-nexuscrew-hop': 'forged-fixture-proof', 'x-nexuscrew-visited': visited },
      body: JSON.stringify({ text: 'Proceed', requestId: crypto.randomUUID() }) });
    assert.equal(response.status, 403);
    assert.ok(!(await response.text()).includes(tmuxSessionForCell('reviewer')));
  }
  const cyclic = await fetch(`${client.base}/api/route/hub/owner/hub/owner/_/event-feed/asks/${askId}/answer`, {
    method: 'POST', headers: headers(client.token), body: JSON.stringify({ text: 'Proceed', requestId: crypto.randomUUID() }) });
  assert.ok([403, 404, 409].includes(cyclic.status));
  assert.equal(owner.pastes.length, 0);
});

test('replaying a request is idempotent, a text mismatch conflicts and two actors cannot read each other receipts', async (t) => {
  const { client, hub, owner, askId } = await fixture(t);
  const requestId = crypto.randomUUID();
  const answer = { action: 'answer', ownerId: owner.id, askId, text: 'Proceed', requestId };
  const results = await Promise.all([relay(client, answer), relay(client, answer)]);
  assert.ok(results.every((r) => r.code === 200 && r.body.status === 'committed'), JSON.stringify(results));
  assert.equal(owner.pastes.length, 1);
  const replay = await relay(client, answer); assert.equal(replay.body.status, 'committed');
  const mismatch = await relay(client, { ...answer, text: 'Different answer' });
  assert.equal(mismatch.code, 409); assert.equal(mismatch.body.reason, 'request-conflict');
  const second = await boot(t, 'second-client');
  peer(second, hub, 'hub', 'outbound', 'second-hub-fixture-token');
  peer(hub, second, 'second-client', 'inbound', 'second-hub-fixture-token');
  const otherReceipt = await relay(second, { action: 'verify', ownerId: owner.id, askId, requestId });
  assert.equal(otherReceipt.code, 404);
  assert.ok(!JSON.stringify(otherReceipt.body).includes('committed'));
  const receipt = await relay(client, { action: 'verify', ownerId: owner.id, askId, requestId });
  assert.equal(receipt.body.state, 'committed');
  assert.equal(receipt.body.ownerId, owner.id); assert.equal(receipt.body.askId, askId);
  assert.equal(receipt.body.actor, client.id);
  assert.equal(owner.pastes.length, 1);
});

test('dismiss and point verification use the same route and close only the owner-qualified alias', async (t) => {
  const { client, owner, askId, alias } = await fixture(t);
  const dismissed = await relay(client, { action: 'dismiss', ownerId: owner.id, askId });
  assert.equal(dismissed.code, 200, JSON.stringify(dismissed));
  const capability = await fetch(`${client.base}/api/asks-relay/capability?ownerId=${owner.id}&askId=${askId}`,
    { headers: headers(client.token) }).then((r) => r.json());
  assert.equal(capability.canReply, false); assert.equal(capability.status, 'dismissed');
  const asks = await fetch(`${client.base}/api/asks?open=1`, { headers: headers(client.token) }).then((r) => r.json());
  assert.equal(asks.asks.some((a) => a.id === alias.id), false);
  assert.equal(owner.pastes.length, 0);
});

test('a lost reply after the real owner paste remains uncertain until verify, without a second POST', async (t) => {
  const { createAskRelay } = require('../lib/notify/ask-relay.js');
  const { client, owner, askId } = await fixture(t);
  let posts = 0;
  const relayClient = createAskRelay({ loadStore: () => store.loadStoreStrict(client.nodesPath),
    peers: async () => (await fetch(`${client.base}/api/peers`, { headers: headers(client.token) }).then((r) => r.json())).peers,
    localPort: () => client.port, localToken: () => client.token,
    fetchImpl: async (url, opts) => {
      const response = await fetch(url, opts);
      if (opts.method === 'POST') { posts += 1; await response.text(); throw new Error('reply lost after paste'); }
      return response;
    },
  });
  const requestId = crypto.randomUUID();
  const uncertain = await relayClient.relayAnswer({ ownerId: owner.id, askId, text: 'Proceed', rid: requestId });
  assert.equal(uncertain.uncertain, true);
  assert.equal(owner.pastes.length, 1);
  const checked = await relayClient.verifyStatus({ ownerId: owner.id, askId, requestId });
  assert.equal(checked.state, 'committed');
  assert.equal(posts, 1); assert.equal(owner.pastes.length, 1);
});

for (const format of ['json', 'html']) test(`an older owner with a ${format} missing-capability response is explicitly unsupported`, async (t) => {
  const http = require('node:http');
  const client = await boot(t, 'client'); const hub = await boot(t, 'hub');
  const id = 'e'.repeat(32);
  const legacy = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/federation/health')) res.end(JSON.stringify({ instanceId: id, eventFeedV1: true }));
    else if (req.url.startsWith('/federation/topology')) res.end(JSON.stringify({ instanceId: id, nodes: [] }));
    else { res.writeHead(404, { 'content-type': format === 'html' ? 'text/html' : 'application/json' }); res.end(format === 'html' ? '<p>Not found</p>' : JSON.stringify({ error: 'not found' })); }
  });
  await new Promise((resolve) => legacy.listen(0, '127.0.0.1', resolve));
  t.after(async () => { legacy.closeAllConnections(); await new Promise((resolve) => legacy.close(resolve)); });
  peer(client, hub, 'hub', 'outbound', 'legacy-client-hub-token');
  peer(hub, client, 'client', 'inbound', 'legacy-client-hub-token');
  peer(hub, { id, port: legacy.address().port }, 'legacy-owner', 'outbound', 'legacy-hub-owner-token');
  const response = await fetch(`${client.base}/api/asks-relay/capability?ownerId=${id}&askId=aabbccdd`,
    { headers: headers(client.token) });
  const body = await response.json().catch(() => ({}));
  assert.equal(body.status, 'unsupported');
  assert.equal(body.canReply, false);
});

for (const transit of [false, true]) test(`a real reverse owner supports capability, answer, receipt and dismiss through its proven slot (${transit ? 'transit' : 'local'})`, async t => {
  const http = require('node:http');
  const ledger = require('../lib/nodes/reverse-pool.js');
  const { respondSlotProof } = require('../lib/nodes/reverse-slot-proof.js');
  const { client, hub, owner, askId } = await fixture(t);
  const proofRequests = []; const actionLeaks = [];
  const proxyToOwner = (req, res) => {
    const up = http.request({ host: '127.0.0.1', port: owner.port, path: req.url, method: req.method, headers: req.headers }, response => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(up);
  };
  let slotPort;
  const slot = http.createServer((req, res) => {
    if (req.url !== '/reverse-slot-proof') return proxyToOwner(req, res);
    let text = ''; req.on('data', chunk => { text += chunk; });
    req.on('end', () => {
      proofRequests.push({ headers: req.headers, text });
      const answer = respondSlotProof({ secret: 'hub-owner-fixture-token',
        expected: { remotePort: slotPort, generation: 3, instanceId: owner.id }, request: JSON.parse(text) });
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(answer));
    });
  });
  await new Promise(resolve => slot.listen(0, '127.0.0.1', resolve)); slotPort = slot.address().port;
  const decoy = http.createServer((req, res) => {
    if (req.url.includes('/event-feed/asks/')) { actionLeaks.push(req.headers.authorization); res.setHeader('content-type', 'application/json'); res.end('{}'); }
    else proxyToOwner(req, res); // Discovery retains its existing non-ASK transport.
  });
  await new Promise(resolve => decoy.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const server of [slot, decoy]) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  });
  let st = store.upgradeToReversePoolSchema(store.loadStoreStrict(hub.nodesPath), ledger.ledgerHead(ledger.emptyLedger('e'.repeat(32))));
  st = store.updateNode(st, 'owner', { direction: 'inbound', transport: 'inbound', localPort: decoy.address().port,
    reversePool: store.reversePoolDefault(slotPort, { verification: 'verified', generation: 3 }) });
  store.atomicWriteStore(hub.nodesPath, st);
  const origin = transit ? client : hub;
  const cap = await fetch(`${origin.base}/api/asks-relay/capability?ownerId=${owner.id}&askId=${askId}`, { headers: headers(origin.token) }).then(r => r.json());
  assert.equal(actionLeaks.length, 0, 'capability does not reach the decoy port');
  assert.equal(cap.canReply, true);
  const requestId = crypto.randomUUID();
  const answer = await relay(origin, { ownerId: owner.id, askId, text: 'Proceed', requestId });
  assert.equal(answer.body.status, 'committed', JSON.stringify(answer));
  assert.equal(owner.pastes.length, 1);
  const verified = await relay(origin, { action: 'verify', ownerId: owner.id, askId, requestId });
  assert.equal(verified.body.state, 'committed'); assert.equal(verified.body.actor, origin.id);
  const next = await fetch(`${owner.base}/api/asks`, { method: 'POST', headers: headers(owner.token),
    body: JSON.stringify({ question: 'Review another item?', session: tmuxSessionForCell('reviewer'), target: client.id }) }).then(r => r.json());
  const dismissed = await relay(origin, { action: 'dismiss', ownerId: owner.id, askId: next.id });
  assert.equal(dismissed.body.dismissed, true);
  const closed = await fetch(`${origin.base}/api/asks-relay/capability?ownerId=${owner.id}&askId=${next.id}`, { headers: headers(origin.token) }).then(r => r.json());
  assert.equal(closed.canReply, false); assert.equal(closed.status, 'dismissed');
  assert.equal(actionLeaks.length, 0); assert.equal(owner.pastes.length, 1);
  assert.equal(proofRequests.length, 1, 'one cold proof is shared by the warm actions');
  assert.ok(proofRequests.every(p => !p.headers.authorization && !p.text.includes('Proceed')));
});

test('concurrent different text with the same request id conflicts before independent route resolution', async t => {
  const { createAskRelay } = require('../lib/notify/ask-relay.js');
  const { client, owner, askId } = await fixture(t);
  const inventory = await fetch(`${client.base}/api/peers`, { headers: headers(client.token) }).then(r => r.json());
  let release;
  const route = new Promise(resolve => { release = resolve; });
  const relayClient = createAskRelay({ loadStore: () => store.loadStoreStrict(client.nodesPath), peers: () => route,
    localPort: () => client.port, localToken: () => client.token });
  const requestId = crypto.randomUUID();
  const first = relayClient.relayAnswer({ ownerId: owner.id, askId, text: 'Proceed', rid: requestId });
  let conflict;
  const second = relayClient.relayAnswer({ ownerId: owner.id, askId, text: 'Different answer', rid: requestId }).then(result => { conflict = result; return result; });
  try {
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(conflict?.code, 409, 'the conflicting request is rejected before the independent route promise resolves');
    assert.equal(conflict.reason, 'request-conflict');
    assert.equal(owner.pastes.length, 0);
  } finally { release(inventory.peers); await Promise.all([first, second]); }
  assert.equal(owner.pastes.length, 1);
});
