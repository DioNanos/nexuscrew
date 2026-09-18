const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const store = require('../lib/nodes/store.js');
const cmds = require('../lib/nodes/commands.js');
const { settingsRoutes } = require('../lib/settings/routes.js');

// A throwaway installation: one paired peer, its own store file, no real
// process and no internal path in the fixtures.
function boot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-access-'));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const nodesPath = path.join(configDir, 'nodes.json');
  let st = store.emptyStore('a'.repeat(32));
  st = store.addNode(st, { name: 'peer-a', direction: 'inbound', remotePort: 2222, localPort: 2222 });
  store.atomicWriteStore(nodesPath, st);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, configDir, nodesPath };
}

function view(nodesPath) {
  return store.accessInventory(store.loadStoreStrict(nodesPath));
}

function edit(nodesPath, patch, extra = {}) {
  const lines = [];
  const out = cmds.nodesEdit({ nodesPath, ref: 'peer-a', patch, ...extra, log: (l) => lines.push(String(l)) });
  return { ...out, lines };
}

test('a peer whose grants were never set is denied, and stays that way', (t) => {
  const { nodesPath } = boot(t);
  const before = view(nodesPath);
  assert.strictEqual(before.peers[0].configured, false);
  assert.strictEqual(before.peers[0].label, 'unconfigured');
  for (const key of ['eventsAccess', 'nodeEventsAccess', 'askReplyAccess', 'filesReadAccess', 'peerOperatorAccess', 'liveHostAccess', 'panelAccess']) {
    assert.strictEqual(before.peers[0].grants[key], false, key);
  }
  // No partial edit promotes it: the vector has to be set on purpose.
  const granular = edit(nodesPath, { filesReadAccess: true });
  assert.strictEqual(granular.code, 1);
  assert.strictEqual(granular.reason, 'access-not-configured');
  assert.strictEqual(view(nodesPath).peers[0].configured, false);
  // The explicit act is a preset.
  const preset = edit(nodesPath, { accessRole: 'user' });
  assert.strictEqual(preset.code, 0);
  const after = view(nodesPath);
  assert.strictEqual(after.peers[0].configured, true);
  assert.strictEqual(after.peers[0].label, 'user');
  assert.strictEqual(after.peers[0].grants.filesReadAccess, true);
  assert.strictEqual(after.peers[0].grants.peerOperatorAccess, false);
});

test('the three presets are applied whole and the label is derived', (t) => {
  const { nodesPath } = boot(t);
  const cases = [
    ['admin', true, true, true, true],
    ['user', true, true, false, false],
    ['nexushost', false, false, false, false],
  ];
  for (const [name, events, nodeEvents, live, operator] of cases) {
    const out = edit(nodesPath, { accessRole: name });
    assert.strictEqual(out.code, 0, out.lines.join(' | '));
    const peer = view(nodesPath).peers[0];
    assert.strictEqual(peer.label, name);
    assert.strictEqual(peer.grants.eventsAccess, events, name);
    assert.strictEqual(peer.grants.nodeEventsAccess, nodeEvents, name);
    assert.strictEqual(peer.grants.liveHostAccess, live, name);
    assert.strictEqual(peer.grants.peerOperatorAccess, operator, name);
  }
});

test('live hosting is refused without the complete admin set', (t) => {
  const { nodesPath } = boot(t);
  assert.strictEqual(edit(nodesPath, { accessRole: 'admin' }).code, 0);
  const narrowed = edit(nodesPath, { panelAccess: false });
  assert.strictEqual(narrowed.code, 1);
  assert.strictEqual(narrowed.reason, 'invalid-grants');
  assert.strictEqual(view(nodesPath).peers[0].label, 'admin');
  // Turning live hosting off is a legitimate vector, just no longer a preset.
  const off = edit(nodesPath, { liveHostAccess: false });
  assert.strictEqual(off.code, 0);
  assert.strictEqual(view(nodesPath).peers[0].label, 'custom');
  assert.strictEqual(view(nodesPath).peers[0].grants.panelAccess, true);
});

test('a granular grant is applied on top of a configured vector', (t) => {
  const { nodesPath } = boot(t);
  assert.strictEqual(edit(nodesPath, { accessRole: 'user' }).code, 0);
  const out = edit(nodesPath, { filesReadAccess: false });
  assert.strictEqual(out.code, 0);
  const peer = view(nodesPath).peers[0];
  assert.strictEqual(peer.grants.filesReadAccess, false);
  assert.strictEqual(peer.grants.eventsAccess, true);
  assert.strictEqual(peer.label, 'custom');
  // A grant that is not a boolean is refused instead of being coerced.
  assert.strictEqual(edit(nodesPath, { eventsAccess: 'on' }).code, 1);
});

test('a preset and granular grants in the same request are refused', (t) => {
  const { nodesPath } = boot(t);
  const out = edit(nodesPath, { accessRole: 'user', filesReadAccess: true });
  assert.strictEqual(out.code, 1);
  assert.strictEqual(out.reason, 'preset-and-grants');
  assert.strictEqual(view(nodesPath).peers[0].configured, false);
});

test('a declared role is refused: the label is derived, never stored', (t) => {
  const { nodesPath } = boot(t);
  const out = edit(nodesPath, { role: 'admin' });
  assert.strictEqual(out.code, 1);
  assert.strictEqual(view(nodesPath).peers[0].configured, false);
  const unknown = edit(nodesPath, { accessRole: 'superuser' });
  assert.strictEqual(unknown.code, 1);
  assert.strictEqual(unknown.reason, 'invalid-access-role');
});

test('the write is a compare-and-set on the policy revision', (t) => {
  const { nodesPath } = boot(t);
  const rev0 = view(nodesPath).revision;
  assert.strictEqual(rev0, 0);
  const ok = edit(nodesPath, { accessRole: 'user' }, { expectedRevision: rev0 });
  assert.strictEqual(ok.code, 0);
  assert.strictEqual(view(nodesPath).revision, rev0 + 1);
  const stale = edit(nodesPath, { accessRole: 'admin' }, { expectedRevision: rev0 });
  assert.strictEqual(stale.code, 1);
  assert.strictEqual(stale.reason, 'revision-conflict');
  assert.strictEqual(stale.revision, rev0 + 1);
  assert.strictEqual(view(nodesPath).peers[0].label, 'user');
  const current = edit(nodesPath, { accessRole: 'admin' }, { expectedRevision: rev0 + 1 });
  assert.strictEqual(current.code, 0);
  assert.strictEqual(view(nodesPath).revision, rev0 + 2);
});

test('two writers starting from the same revision: exactly one wins', (t) => {
  const { nodesPath } = boot(t);
  const rev = view(nodesPath).revision;
  const first = store.setPeerAccessPresetCas({
    filePath: nodesPath, name: 'peer-a', presetName: 'user', expectedRevision: rev,
  });
  const second = store.setPeerAccessPresetCas({
    filePath: nodesPath, name: 'peer-a', presetName: 'admin', expectedRevision: rev,
  });
  assert.strictEqual(first.ok, true);
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.conflict, true);
  assert.strictEqual(view(nodesPath).revision, rev + 1);
  assert.strictEqual(view(nodesPath).peers[0].label, 'user');
});

test('a store written before the grants existed still loads, denied', (t) => {
  const { dir, configDir, nodesPath } = boot(t);
  const raw = {
    schemaVersion: store.SCHEMA_VERSION,
    nodeId: 'b'.repeat(32),
    nodes: [{
      name: 'peer-a', direction: 'inbound', remotePort: 2222, localPort: 2222,
      roles: { client: true, node: false }, rolesKnown: true,
      transport: 'inbound', autostart: true, shared: false, visibility: 'network',
      cellVisibility: 'all', panelAccess: true, liveHostAccess: false,
    }],
  };
  fs.writeFileSync(nodesPath, JSON.stringify(raw, null, 2));
  const loaded = store.loadStoreStrict(nodesPath);
  assert.ok(loaded, 'un record legacy deve restare caricabile');
  const peer = view(nodesPath).peers[0];
  assert.strictEqual(peer.configured, false);
  assert.strictEqual(peer.label, 'unconfigured');
  for (const key of ['eventsAccess', 'nodeEventsAccess', 'askReplyAccess', 'filesReadAccess', 'peerOperatorAccess']) {
    assert.strictEqual(peer.grants[key], false, key);
  }
  // A plain load does not rewrite the file with fields nobody set.
  const onDisk = JSON.parse(fs.readFileSync(nodesPath, 'utf8'));
  assert.strictEqual(onDisk.accessRevision, undefined);
  assert.ok(dir && configDir);
});

test('the inventory names the peers an explicit migration still has to set', (t) => {
  const { nodesPath } = boot(t);
  const lines = [];
  assert.strictEqual(cmds.nodesAccess({ nodesPath, log: (l) => lines.push(String(l)) }).code, 0);
  assert.ok(lines.some((l) => /unconfigured/.test(l)), lines.join(' | '));
  assert.ok(lines.some((l) => /da configurare esplicitamente/.test(l)), lines.join(' | '));
  assert.strictEqual(edit(nodesPath, { accessRole: 'user' }).code, 0);
  const after = cmds.nodesAccess({ nodesPath, log: () => {} });
  assert.deepStrictEqual(after.unconfigured, []);
  assert.strictEqual(after.peers[0].label, 'user');
});

// --- REST surface (same route the settings UI calls) ------------------------

function mountSettings(nodesPath, configDir, home) {
  const app = express();
  app.use('/api/settings', settingsRoutes({
    cfg: { home, configDir, configPath: path.join(configDir, 'config.json'), nodesPath },
    nodesPath,
  }));
  return app;
}

async function withServer(t, app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return fn(`http://127.0.0.1:${server.address().port}`);
}

const patchNode = (base, body) => fetch(`${base}/api/settings/nodes/peer-a`, {
  method: 'PATCH',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('REST: a declared role is refused with 400 and applies no preset', async (t) => {
  const { nodesPath, configDir, dir } = boot(t);
  await withServer(t, mountSettings(nodesPath, configDir, dir), async (base) => {
    const res = await patchNode(base, { role: 'admin' });
    assert.strictEqual(res.status, 400);
    assert.match((await res.json()).error, /role/);
    assert.strictEqual(view(nodesPath).peers[0].configured, false);
  });
});

test('REST: the preset is applied, and a stale revision answers 409', async (t) => {
  const { nodesPath, configDir, dir } = boot(t);
  await withServer(t, mountSettings(nodesPath, configDir, dir), async (base) => {
    const rev = view(nodesPath).revision;
    const ok = await patchNode(base, { accessRole: 'user', accessRevision: rev });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(view(nodesPath).peers[0].label, 'user');
    const stale = await patchNode(base, { accessRole: 'admin', accessRevision: rev });
    assert.strictEqual(stale.status, 409);
    assert.strictEqual(view(nodesPath).peers[0].label, 'user');
    const bad = await patchNode(base, { accessRole: 'user', accessRevision: 'now' });
    assert.strictEqual(bad.status, 400);
  });
});
