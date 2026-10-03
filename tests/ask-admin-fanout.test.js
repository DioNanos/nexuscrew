'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodes = require('../lib/nodes/store.js');
const { tmuxSessionForCell } = require('../lib/fleet/definitions.js');
const headers = token => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
async function boot(t, extra = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-owner-access-'));
  const configDir = path.join(home, '.nexuscrew'); fs.mkdirSync(configDir);
  const nodesPath = path.join(configDir, 'nodes.json'); nodes.initStore(nodesPath);
  const runtime = createServer({ home, configDir, nodesPath, configPath: path.join(configDir, 'config.json'), tokenPath: path.join(configDir, 'token'),
    ...extra, filesRoot: path.join(home, 'files'), port: 0, fleetEnabled: false, sessionExistsSeam: () => true, pasteSeam: () => true,
    askSubmit: async () => ({ outcome: 'submitted', submitted: true }),
    settingsSeams: { platform: 'linux', uid: 1000, execImpl: () => { throw new Error('disabled'); }, serviceInstallPath: path.join(home, 'service'),
      keygen: () => 'ssh-ed25519 AAAAFIXTURE demo', spawnImpl: () => ({ pid: 4100000, unref() {} }), sshVersion: () => ({ major: 9, minor: 6 }) },
  });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  runtime.server.prependListener('request', (req, res) => {
    if (req.method !== 'POST' || !req.url.includes('/federation/route/') || !req.url.endsWith('/asks')) return;
    const entry = { url: `http://127.0.0.1:${runtime.server.address().port}${req.url}` };
    const end = res.end; res.end = function(chunk, ...args) {
      entry.status = res.statusCode;
      if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) { try { entry.reply = JSON.parse(String(chunk)); } catch (_) {} }
      return end.call(this, chunk, ...args);
    };
    const chunks = []; req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => { entry.body = JSON.parse(Buffer.concat(chunks).toString()); observed.push(entry); });
  });
  t.after(async () => { runtime.server.closeAllConnections(); await new Promise(resolve => runtime.server.close(resolve)); runtime.watcher.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { ...runtime, nodesPath, port: runtime.server.address().port, id: nodes.loadStoreStrict(nodesPath).nodeId };
}

let observed = [];
const access = require('../lib/nodes/access-presets.js');
function pair(local, remote, name, preset = 'admin') {
  let st = nodes.addNode(nodes.loadStoreStrict(local.nodesPath), { name, nodeId: remote.id, direction: 'outbound', token: 'paired-admin-fixture', acceptToken: 'paired-admin-fixture',
    localPort: remote.port, remotePort: 41999, shared: true, visibility: 'network', ssh: 'demo@example.invalid' });
  if (preset !== 'legacy') st = nodes.setPeerAccessPreset(st, name, preset === 'custom' ? 'admin' : preset);
  if (preset === 'custom') st = nodes.updateNode(st, name, { liveHostAccess: false, filesReadAccess: false });
  nodes.atomicWriteStore(local.nodesPath, st);
  const view = access.grantsOf(st.nodes.find(p => p.name === name));
  assert.equal(view.label, preset === 'legacy' ? 'unconfigured' : preset);
}
function observe() { observed = []; return observed; }
async function create(local, target) {
  const response = await fetch(`http://127.0.0.1:${local.port}/api/asks`, { method: 'POST', headers: headers(local.token),
    body: JSON.stringify({ question: 'Review this change?', session: tmuxSessionForCell('reviewer'), ...(target ? { target } : {}) }) });
  const body = await response.json(); assert.equal(response.status, 201, JSON.stringify(body)); return body;
}
async function open(local) {
  return fetch(`http://127.0.0.1:${local.port}/api/asks?open=1`, { headers: headers(local.token) }).then(r => r.json()).then(b => b.asks);
}
async function dismiss(local, id) {
  const response = await fetch(`http://127.0.0.1:${local.port}/api/asks/${id}`, { method: 'DELETE', headers: headers(local.token), body: '{}' });
  assert.equal(response.status, 200, await response.text());
}
test('ASK broadcast sends only to the configured admin and reports skipped peers', async t => {
  const logs = []; const origin = await boot(t, { log: message => logs.push(message) });
  const remotes = [];
  for (const role of ['admin', 'user', 'nexushost', 'custom', 'legacy']) {
    const remote = await boot(t); pair(origin, remote, role, role); pair(remote, origin, 'origin'); remotes.push({ role, remote });
  }
  const actions = observe(t); const ask = await create(origin);
  const attempted = actions.filter(a => !a.body.closeOutcome);
  assert.deepEqual((ask.fanout || []).map(item => item.target), [remotes[0].remote.id], 'non-admin destinations are not dispatched');
  assert.deepEqual(attempted.map(a => new URL(a.url).port), [String(remotes[0].remote.port)]);
  assert.ok((await open(origin)).some(a => a.id === ask.id), 'the local ASK is retained');
  assert.ok(logs.some(line => line.includes('skipped: not admin') && line.includes('4')));
});
for (const role of ['user', 'nexushost', 'custom', 'legacy']) test(`an explicit ${role} target cannot bypass the ASK sender filter`, async t => {
  const origin = await boot(t); const remote = await boot(t); pair(origin, remote, 'remote', role); pair(remote, origin, 'origin');
  const actions = observe(t); const ask = await create(origin, remote.id);
  assert.equal(actions.length, 0); assert.equal(ask.fanout, undefined, 'an explicit non-admin target is not dispatched'); assert.ok((await open(origin)).some(a => a.id === ask.id));
});
for (const first of ['admin', 'user']) for (const next of ['admin', 'custom']) test(`transitive ASK with ${first} first hop and ${next} next hop follows both admin decisions`, async t => {
  const origin = await boot(t); const hub = await boot(t); const leaf = await boot(t);
  pair(origin, hub, 'hub', first); pair(hub, origin, 'origin'); pair(hub, leaf, 'leaf', next); pair(leaf, hub, 'hub');
  const actions = observe(t); const ask = await create(origin, leaf.id);
  const atLeaf = actions.filter(a => new URL(a.url).port === String(leaf.port));
  const atHub = actions.filter(a => new URL(a.url).port === String(hub.port));
  if (first === 'user') { assert.equal(ask.fanout, undefined, 'a user first hop is not dispatched'); assert.equal(atHub.length, 0, 'a non-admin first hop is never attempted'); assert.equal(atLeaf.length, 0); }
  else if (next === 'custom') {
    assert.equal(atHub.length, 1); assert.equal(atLeaf.length, 0, 'the hub refuses before forwarding to custom');
    assert.equal(ask.fanout[0].status, 'refused');
    assert.equal(atHub[0].status, 403); assert.equal(atHub[0].reply.reason, 'ask-target-not-admin');
  } else {
    assert.equal(atHub.length, 1); assert.equal(atLeaf.length, 1); assert.equal(ask.fanout[0].status, 'delivered');
    assert.ok((await open(leaf)).some(a => a.ownerId === origin.id && a.ownerAskId === ask.id));
  }
});
test('ASK closure is not sent to user or custom even after they were previously admin', async t => {
  const origin = await boot(t); const admin = await boot(t); const user = await boot(t); const custom = await boot(t);
  for (const [name, remote] of [['admin', admin], ['user', user], ['custom', custom]]) { pair(origin, remote, name); pair(remote, origin, 'origin'); }
  const ask = await create(origin);
  let st = nodes.setPeerAccessPreset(nodes.loadStoreStrict(origin.nodesPath), 'user', 'user');
  st = nodes.updateNode(st, 'custom', { liveHostAccess: false, filesReadAccess: false }); nodes.atomicWriteStore(origin.nodesPath, st);
  const actions = observe(t); await dismiss(origin, ask.id);
  const closed = actions.filter(a => a.body.closeOutcome);
  assert.deepEqual(closed.map(a => new URL(a.url).port), [String(admin.port)]);
});

test('a custom next hop refuses an ASK closure with a healthy store before delivery', async t => {
  const origin = await boot(t); const hub = await boot(t); const leaf = await boot(t);
  pair(origin, hub, 'hub'); pair(hub, origin, 'origin'); pair(hub, leaf, 'leaf', 'custom'); pair(leaf, hub, 'hub');
  const actions = observe(t);
  const response = await fetch(`http://127.0.0.1:${origin.port}/api/route/hub/leaf/_/asks`, { method: 'POST', headers: headers(origin.token),
    body: JSON.stringify({ target: leaf.id, originNode: origin.id, originCell: tmuxSessionForCell('reviewer'),
      ownerNode: origin.id, askId: '11223344', closeOutcome: 'dismissed' }) });
  assert.equal(response.status, 403); assert.equal((await response.json()).reason, 'ask-target-not-admin');
  assert.equal(actions.filter(a => new URL(a.url).port === String(leaf.port)).length, 0);
  assert.ok(nodes.loadStoreStrict(leaf.nodesPath), 'the refused target has a healthy store');
});
