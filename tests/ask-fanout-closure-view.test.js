'use strict';
// Two isolated real servers over HTTP: an owner-origin node delivers an ASK to
// a target node via the federated fan-out route, then closes it. The exported
// owner view (/api/feed-state) is what a fresh page rebuilds cards from: every
// authenticated closure must leave it, for both outcomes, whether or not the
// local alias changed, and a closed generation must not come back by replay.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodes = require('../lib/nodes/store.js');
const { tmuxSessionForCell } = require('../lib/fleet/definitions.js');
const headers = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

async function boot(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-fanout-closure-'));
  const configDir = path.join(home, '.nexuscrew'); fs.mkdirSync(configDir);
  const nodesPath = path.join(configDir, 'nodes.json'); nodes.initStore(nodesPath);
  const runtime = createServer({ home, configDir, nodesPath, configPath: path.join(configDir, 'config.json'), tokenPath: path.join(configDir, 'token'),
    filesRoot: path.join(home, 'files'), port: 0, fleetEnabled: false, sessionExistsSeam: () => true, pasteSeam: () => true,
    askSubmit: async () => ({ outcome: 'submitted', submitted: true }),
    settingsSeams: { platform: 'linux', uid: 1000, execImpl: () => { throw new Error('disabled'); }, serviceInstallPath: path.join(home, 'service'),
      keygen: () => 'ssh-ed25519 AAAAFIXTURE demo', spawnImpl: () => ({ pid: 4100000, unref() {} }), sshVersion: () => ({ major: 9, minor: 6 }) },
  });
  await new Promise((resolve) => runtime.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { runtime.server.closeAllConnections(); await new Promise((resolve) => runtime.server.close(resolve)); runtime.watcher.close(); fs.rmSync(home, { recursive: true, force: true }); });
  return { ...runtime, nodesPath, port: runtime.server.address().port, id: nodes.loadStoreStrict(nodesPath).nodeId };
}

function pair(local, remote, name) {
  let st = nodes.addNode(nodes.loadStoreStrict(local.nodesPath), { name, nodeId: remote.id, direction: 'outbound', token: 'paired-fixture', acceptToken: 'paired-fixture',
    localPort: remote.port, remotePort: 41999, shared: true, visibility: 'network', ssh: 'demo@example.invalid' });
  st = nodes.setPeerAccessPreset(st, name, 'admin');
  nodes.atomicWriteStore(local.nodesPath, st);
}

async function topology(t) {
  const origin = await boot(t), remote = await boot(t);
  pair(origin, remote, 'remote'); pair(remote, origin, 'origin');
  // Event feed disabled on both sides: this suite isolates the fan-out route
  // from the second transport, exactly like the audit probe did.
  nodes.atomicWriteStore(origin.nodesPath, nodes.updateNode(nodes.loadStoreStrict(origin.nodesPath), 'remote', { direction: 'inbound', transport: 'inbound', eventsReceive: false }));
  nodes.atomicWriteStore(remote.nodesPath, nodes.updateNode(nodes.loadStoreStrict(remote.nodesPath), 'origin', { eventsReceive: false }));
  return { origin, remote };
}

function scenario(origin, remote) {
  const session = tmuxSessionForCell('reviewer');
  const body = (over = {}) => ({ target: remote.id, originNode: origin.id, originCell: session, ownerNode: origin.id, askId: 'abcdef01', ownerAskTs: 100,
    question: 'Shared question', options: [], session, ...over });
  return {
    body,
    send: async (b) => {
      const r = await fetch(`http://127.0.0.1:${origin.port}/api/route/remote/_/asks`, { method: 'POST', headers: headers(origin.token), body: JSON.stringify(b) });
      assert.equal(r.status, 200);
      return r.json();
    },
    state: async () => (await fetch(`http://127.0.0.1:${remote.port}/api/feed-state`, { headers: headers(remote.token) })).json(),
    viewAsks: async () => (await (await fetch(`http://127.0.0.1:${remote.port}/api/feed-state`, { headers: headers(remote.token) })).json()).views.flatMap((v) => v.asks),
  };
}

for (const outcome of ['answered', 'dismissed']) {
  test(`a fan-out ${outcome} closure leaves the exported owner view`, async (t) => {
    const { origin, remote } = await topology(t);
    const s = scenario(origin, remote);
    const accepted = await s.send(s.body());
    assert.equal(accepted.status, 'delivered');
    assert.equal((await s.viewAsks()).length, 1, 'the live ASK enters the exported owner view');
    const closure = await s.send(s.body({ closeOutcome: outcome }));
    assert.equal(closure.closed, true);
    assert.equal((await s.viewAsks()).length, 0, `a closed imported ASK must leave the exported owner view (${outcome})`);
  });

  test(`a replayed fan-out of the closed generation stays out of the view: ${outcome}`, async (t) => {
    const { origin, remote } = await topology(t);
    const s = scenario(origin, remote);
    await s.send(s.body());
    await s.send(s.body({ closeOutcome: outcome }));
    // The owner redelivers the same generation: whatever the local store
    // dedupes, the exported view must not grow the closed card back.
    await s.send(s.body());
    assert.equal((await s.viewAsks()).length, 0, `a replayed ${outcome} generation must not re-enter the exported view`);
  });
}

test('a duplicate closure is delivered and stays a no-op on the view', async (t) => {
  const { origin, remote } = await topology(t);
  const s = scenario(origin, remote);
  await s.send(s.body());
  const first = await s.send(s.body({ closeOutcome: 'answered' }));
  assert.equal(first.closed, true);
  const second = await s.send(s.body({ closeOutcome: 'answered' }));
  assert.equal(second.status, 'delivered');
  assert.equal(second.closed, false);
  assert.equal((await s.viewAsks()).length, 0);
});

test('a closure without a live alias still blocks that generation', async (t) => {
  const { origin, remote } = await topology(t);
  const s = scenario(origin, remote);
  // No ASK was ever delivered: the store has nothing to close, but the view
  // must learn the closure anyway, or a later delivery recreates the card.
  const closure = await s.send(s.body({ closeOutcome: 'answered' }));
  assert.equal(closure.status, 'delivered');
  assert.equal(closure.closed, false);
  await s.send(s.body());
  assert.equal((await s.viewAsks()).length, 0, 'a generation closed without an alias must not enter the view later');
});

test('a closure of an older generation does not close the newer one', async (t) => {
  const { origin, remote } = await topology(t);
  const s = scenario(origin, remote);
  await s.send(s.body());
  await s.send(s.body({ ownerAskTs: 200, question: 'New generation' }));
  const asks = await s.viewAsks();
  assert.equal(asks.length, 1);
  assert.equal(asks[0].ownerAskTs, 200);
  const closure = await s.send(s.body({ closeOutcome: 'answered' }));
  assert.equal(closure.status, 'delivered');
  const after = await s.viewAsks();
  assert.equal(after.length, 1, 'the newer generation must survive an older closure');
  assert.equal(after[0].ownerAskTs, 200);
});

test('a genuinely new generation is admitted after a closure', async (t) => {
  const { origin, remote } = await topology(t);
  const s = scenario(origin, remote);
  await s.send(s.body());
  await s.send(s.body({ closeOutcome: 'answered' }));
  await s.send(s.body({ ownerAskTs: 200, question: 'New generation' }));
  const after = await s.viewAsks();
  assert.equal(after.length, 1, 'a new generation must be admitted after the previous one closed');
  assert.equal(after[0].ownerAskTs, 200);
});
