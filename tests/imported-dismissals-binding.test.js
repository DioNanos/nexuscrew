'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const nodes = require('../lib/nodes/store.js');
const { createServer } = require('../lib/server.js');
const { createAsksStore } = require('../lib/notify/asks.js');
const { tmuxSessionForCell } = require('../lib/fleet/definitions.js');
const OWNER = 'b'.repeat(32), ID = '12345678';
async function binding(t, credential) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dismissal-binding-'));
  const configDir = path.join(home, '.nexuscrew'); fs.mkdirSync(configDir);
  const nodesPath = path.join(configDir, 'nodes.json'); nodes.initStore(nodesPath);
  let st = nodes.addNode(nodes.loadStoreStrict(nodesPath), { name: 'owner', nodeId: OWNER, direction: 'inbound',
    token: 'initial-token', shared: true, visibility: 'network', ssh: 'demo@example.invalid', localPort: 42001, remotePort: 42002 });
  st = nodes.setPeerAccessPreset(st, 'owner', 'user'); nodes.atomicWriteStore(nodesPath, st);
  st = nodes.loadStoreStrict(nodesPath); st.nodes[0].token = credential; st.nodes[0].acceptToken = credential;
  nodes.atomicWriteStore(nodesPath, st);
  createAsksStore({ dir: configDir }).create({ question: 'Review?', session: tmuxSessionForCell('reviewer'),
    ownerId: OWNER, ownerAskId: ID, originNode: OWNER, ownerAskTs: 100 });
  const runtime = createServer({ home, configDir, nodesPath, port: 0, fleetEnabled: false,
    filesRoot: path.join(home, 'files'), configPath: path.join(configDir, 'config.json'), tokenPath: path.join(configDir, 'token'),
    sessionExistsSeam: () => true, pasteSeam: () => true,
    settingsSeams: { platform: 'linux', uid: 1000, execImpl: () => { throw new Error('disabled'); }, serviceInstallPath: path.join(home, 'service'),
      keygen: () => 'ssh-ed25519 AAAAFIXTURE demo', spawnImpl: () => ({ pid: 4100000, unref() {} }), sshVersion: () => ({ major: 9, minor: 6 }) } });
  await new Promise(resolve => runtime.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { runtime.server.closeAllConnections(); await new Promise(resolve => runtime.server.close(resolve)); runtime.watcher.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const response = await fetch(`http://127.0.0.1:${runtime.server.address().port}/api/asks-relay`, {
    method: 'POST', headers: { authorization: `Bearer ${runtime.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'dismiss-local', ownerId: OWNER, askId: ID }) });
  assert.equal(response.status, 200);
  const record = JSON.parse(fs.readFileSync(path.join(configDir, 'asks.json'))).importedDismissals[`${OWNER}|${ID}`];
  const peer = nodes.loadStoreStrict(nodesPath).nodes[0];
  const secretHash = crypto.createHash('sha256').update(JSON.stringify([{ nodeId: peer.nodeId, direction: peer.direction,
    shared: peer.shared, token: peer.token, acceptToken: peer.acceptToken, localPort: peer.localPort, reversePool: peer.reversePool,
    configured: true, grants: require('../lib/nodes/access-presets.js').grantsOf(peer).grants }]) + '[]').digest('hex');
  assert.notEqual(record.retryBinding, secretHash, 'asks.json must not contain the peer credential hash');
  assert.equal(JSON.stringify(record).includes(credential), false);
  return record.retryBinding;
}
test('durable retry bindings depend on rotation counts rather than peer secret values', async t => {
  assert.equal(await binding(t, 'rotation-value-one'), await binding(t, 'rotation-value-two'));
});

test('pairing rotation revisions persist, advance only on rotation and cannot be rolled back', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pairing-revision-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nodes.json'); nodes.initStore(file);
  const input = nodes.addNode(nodes.loadStoreStrict(file), { name: 'owner', nodeId: OWNER, token: 'one',
    direction: 'outbound', ssh: 'demo@example.invalid', localPort: 42001, remotePort: 42002 });
  nodes.atomicWriteStore(file, input);
  let st = nodes.loadStoreStrict(file); const first = st.nodes[0].pairingRevision || 0;
  st.nodes[0].token = 'two'; nodes.atomicWriteStore(file, st);
  st = nodes.loadStoreStrict(file); assert.equal(st.nodes[0].pairingRevision, first + 1);
  st.nodes[0].pairingRevision = 0; nodes.atomicWriteStore(file, st);
  st = nodes.loadStoreStrict(file); assert.equal(st.nodes[0].pairingRevision, first + 1);
  st.nodes[0].acceptToken = 'accepted'; nodes.atomicWriteStore(file, st);
  st = nodes.loadStoreStrict(file); assert.equal(st.nodes[0].pairingRevision, first + 2);
  st.nodes[0].localPort++; nodes.atomicWriteStore(file, st);
  assert.equal(nodes.loadStoreStrict(file).nodes[0].pairingRevision, first + 2);
});
