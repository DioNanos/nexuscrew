'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const store = require('../lib/nodes/store.js');
const presets = require('../lib/nodes/access-presets.js');
const commands = require('../lib/nodes/commands.js');
const { settingsRoutes } = require('../lib/settings/routes.js');
const { createServer } = require('../lib/server.js');
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-reception-'));
  const configDir = path.join(home, '.nexuscrew'); fs.mkdirSync(configDir);
  const nodesPath = path.join(configDir, 'nodes.json');
  let data = store.emptyStore('a'.repeat(32));
  data = store.addNode(data, { name: 'peer', direction: 'inbound', localPort: 2222, remotePort: 2222, nodeId: 'b'.repeat(32), acceptToken: 'fixture-secret' });
  store.atomicWriteStore(nodesPath, data);
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, configDir, nodesPath, configPath: path.join(configDir, 'config.json') };
}
const peer = f => store.loadStoreStrict(f.nodesPath).nodes[0];
async function startup(t, f, extra = {}) {
  const { server, token, watcher } = createServer({ ...f, port: 0, fleetEnabled: false, filesRoot: path.join(f.home, 'files'), ...extra });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { const closed = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await closed; watcher?.close(); });
  server.testToken = token;
  return server;
}
test('admin applies local reception without adding it to the grant vector', () => {
  assert.equal(presets.applyPreset({ eventsReceive: false }, 'admin').eventsReceive, true);
  assert.equal(presets.BOOLEAN_GRANTS.includes('eventsReceive'), false);
});
test('preset and CAS persist admin reception with just one revision', t => {
  const f = fixture(t); const before = store.loadStoreStrict(f.nodesPath);
  const next = store.setPeerAccessPreset(before, 'peer', 'admin');
  assert.equal(next.nodes[0].eventsReceive, true); assert.equal(next.accessRevision, 1);
  const result = store.setPeerAccessPresetCas({ filePath: f.nodesPath, name: 'peer', presetName: 'admin', expectedRevision: 0 });
  assert.equal(result.ok, true); assert.equal(peer(f).eventsReceive, true); assert.equal(store.accessRevisionOf(store.loadStoreStrict(f.nodesPath)), 1);
  const bytes = fs.readFileSync(f.nodesPath);
  assert.equal(store.setPeerAccessPresetCas({ filePath: f.nodesPath, name: 'peer', presetName: 'admin', expectedRevision: 0 }).conflict, true);
  assert.deepEqual(fs.readFileSync(f.nodesPath), bytes);
});
test('node edits turn on admin reception and reject an explicit contrary choice without writing', t => {
  const f = fixture(t); const edit = patch => commands.nodesEdit({ nodesPath: f.nodesPath, ref: 'peer', patch, log: () => {} });
  assert.equal(edit({ accessRole: 'admin' }).code, 0); assert.equal(peer(f).eventsReceive, true);
  const bytes = fs.readFileSync(f.nodesPath);
  assert.equal(edit({ accessRole: 'admin', eventsReceive: false }).code, 1); assert.deepEqual(fs.readFileSync(f.nodesPath), bytes);
});
test('the settings PATCH uses the same admin reception and conflict behavior', async t => {
  const f = fixture(t); const app = express(); app.use('/api/settings', settingsRoutes({ cfg: { ...f }, nodesPath: f.nodesPath }));
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => new Promise(resolve => server.close(resolve)));
  const patch = body => fetch(`http://127.0.0.1:${server.address().port}/api/settings/nodes/peer`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await patch({ accessRole: 'admin', accessRevision: 0 })).status, 200); assert.equal(peer(f).eventsReceive, true);
  const bytes = fs.readFileSync(f.nodesPath); assert.equal((await patch({ accessRole: 'admin', eventsReceive: false, accessRevision: 1 })).status, 400); assert.deepEqual(fs.readFileSync(f.nodesPath), bytes);
});
test('startup migrates recognized admin once, preserving identity and an operational off afterwards', async t => {
  const f = fixture(t); let data = store.setPeerAccessPreset(store.loadStoreStrict(f.nodesPath), 'peer', 'admin'); data = store.updateNode(data, 'peer', { eventsReceive: false }); store.atomicWriteStore(f.nodesPath, data);
  const before = peer(f); const revision = store.accessRevisionOf(data); const first = await startup(t, f);
  assert.equal(peer(f).eventsReceive, true); assert.equal(peer(f).nodeId, before.nodeId); assert.equal(peer(f).acceptToken, before.acceptToken); assert.equal(store.accessRevisionOf(store.loadStoreStrict(f.nodesPath)), revision + 1);
  await new Promise(resolve => first.close(resolve));
  const migrated = fs.readFileSync(f.nodesPath); const second = await startup(t, f); assert.deepEqual(fs.readFileSync(f.nodesPath), migrated); await new Promise(resolve => second.close(resolve));
  store.atomicWriteStore(f.nodesPath, store.updateNode(store.loadStoreStrict(f.nodesPath), 'peer', { eventsReceive: false }));
  const off = fs.readFileSync(f.nodesPath); await startup(t, f); assert.equal(peer(f).eventsReceive, false); assert.deepEqual(fs.readFileSync(f.nodesPath), off);
});
test('startup does not activate user, nexushost or unconfigured peers and readonly never writes', async t => {
  for (const role of ['user', 'nexushost', null, 'admin']) {
    const f = fixture(t); let data = store.loadStoreStrict(f.nodesPath); if (role) data = store.setPeerAccessPreset(data, 'peer', role); data = store.updateNode(data, 'peer', { eventsReceive: false }); store.atomicWriteStore(f.nodesPath, data);
    const bytes = fs.readFileSync(f.nodesPath); await startup(t, f, { readonlyDefault: role === 'admin' }); assert.equal(peer(f).eventsReceive, false); if (role === 'admin') assert.deepEqual(fs.readFileSync(f.nodesPath), bytes);
  }
});
test('an admin preset with reception explicitly false is a conflict on CAS and node edits', t => {
  const f = fixture(t); const before = fs.readFileSync(f.nodesPath);
  assert.throws(() => store.setPeerAccessPresetCas({ filePath: f.nodesPath, name: 'peer', presetName: 'admin', expectedRevision: 0, extraPatch: { eventsReceive: false } }), /eventsReceive/);
  assert.deepEqual(fs.readFileSync(f.nodesPath), before);
  const result = commands.nodesEdit({ nodesPath: f.nodesPath, ref: 'peer', patch: { accessRole: 'admin', eventsReceive: false }, log: () => {} });
  assert.equal(result.code, 1); assert.deepEqual(fs.readFileSync(f.nodesPath), before);
});
test('migration recognizes an admin with a missing reception field and preserves custom peers', async t => {
  const f = fixture(t); let data = store.setPeerAccessPreset(store.loadStoreStrict(f.nodesPath), 'peer', 'admin');
  store.atomicWriteStore(f.nodesPath, data); const raw = JSON.parse(fs.readFileSync(f.nodesPath)); delete raw.nodes[0].eventsReceive; fs.writeFileSync(f.nodesPath, JSON.stringify(raw));
  await startup(t, f); assert.equal(peer(f).eventsReceive, true);
  const other = fixture(t); data = store.setPeerAccessPreset(store.loadStoreStrict(other.nodesPath), 'peer', 'user'); data = store.setPeerAccessGrants(data, 'peer', { ...presets.grantsOf(data.nodes[0]).grants, filesReadAccess: false });
  store.atomicWriteStore(other.nodesPath, data); await startup(t, other); assert.equal(peer(other).eventsReceive, false); assert.equal(presets.grantsOf(peer(other)).label, 'custom');
});
test('startup leaves an unreadable node store intact instead of inferring admin', async t => {
  const f = fixture(t); fs.writeFileSync(f.nodesPath, '{corrupt'); const before = fs.readFileSync(f.nodesPath);
  try { await startup(t, f); } catch { /* A strict startup refusal is also acceptable; writing is not. */ }
  assert.deepEqual(fs.readFileSync(f.nodesPath), before);
});

test('migration opens an admin feed at startup without a manual restart or toggle', async t => {
  const owner = fixture(t); let data = store.loadStoreStrict(owner.nodesPath);
  data = { ...data, nodeId: 'c'.repeat(32), nodes: data.nodes.map(n => ({ ...n, nodeId: 'a'.repeat(32) })) };
  data = store.setPeerAccessPreset(data, 'peer', 'admin'); store.atomicWriteStore(owner.nodesPath, data);
  const remote = await startup(t, owner);
  const client = fixture(t); data = store.addNode(store.emptyStore('a'.repeat(32)), { name: 'owner', direction: 'outbound', ssh: 'user@owner', localPort: remote.address().port, remotePort: remote.address().port, nodeId: 'c'.repeat(32), token: 'fixture-secret', shared: true });
  data = store.setPeerAccessPreset(data, 'owner', 'admin'); data = store.updateNode(data, 'owner', { eventsReceive: false }); store.atomicWriteStore(client.nodesPath, data);
  const local = await startup(t, client); let view;
  for (let i = 0; i < 100; i++) {
    const state = await (await fetch(`http://127.0.0.1:${local.address().port}/api/feed-state`, { headers: { authorization: `Bearer ${local.testToken}` } })).json();
    view = state.views?.find(v => v.ownerId === 'c'.repeat(32)); if (view && !view.stale) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(view && !view.stale, 'a recognized admin starts receiving an authoritative owner snapshot');
  assert.equal(view.askReplyAccess, true);
});

for (const kind of ['missing', 'invalid', 'symlink']) test(`startup migration reports the appropriate store condition (${kind})`, async t => {
  const f = fixture(t); const messages = [];
  if (kind === 'missing') fs.unlinkSync(f.nodesPath);
  if (kind === 'invalid') fs.writeFileSync(f.nodesPath, '{invalid');
  if (kind === 'symlink') {
    const target = path.join(f.home, 'store-target'); fs.renameSync(f.nodesPath, target); fs.symlinkSync(target, f.nodesPath);
  }
  await startup(t, f, { log: message => messages.push(message) });
  const migration = messages.filter(message => message.includes('Admin reception migration skipped'));
  if (kind === 'missing') assert.equal(migration.some(message => message.includes('unreadable')), false);
  else assert.ok(migration.some(message => message.includes('NODES_STORE_INVALID')), JSON.stringify(migration));
});
