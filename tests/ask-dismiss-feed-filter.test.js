'use strict';
// tests/ask-dismiss-feed-filter.test.js — END-TO-END on real servers for the
// durable side of the federated-ask close button: once a locally dismissed
// card is durable on the viewing node, a reload (a fresh feed client taking a
// fresh snapshot) must not bring it back, while a brand new ask must arrive.
// The owner keeps its ask open: removing locally is not answering.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const { createAsksStore, askFingerprint } = require('../lib/notify/asks.js');
const { tmuxSessionForCell } = require('../lib/fleet/definitions.js');

const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
const SECRET = 'pairing-secret-token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function boot(t, dir) {
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir, configDir,
    configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'),
    tokenPath: path.join(configDir, 'token'),
  };
  nodesStore.initStore(paths.nodesPath);
  const { server, token, watcher } = createServer({
    ...paths,
    filesRoot: path.join(dir, 'files'),
    port: 41999,
    fleetEnabled: false,
    eventFeedClientPollMs: 100,
    eventFeedClientMinSnapshotIntervalMs: 50,
    sessionExistsSeam: () => true,
    pasteSeam: () => true,
    askSubmit: () => ({ outcome: 'submitted', submitted: true }),
    settingsSeams: {
      platform: 'linux', uid: 1000,
      execImpl: () => { throw new Error('exec disabled in test'); },
      serviceInstallPath: path.join(dir, 'systemd', 'nexuscrew.service'),
      keygen: (_kp, name) => `ssh-ed25519 AAAAC3FAKEKEY nexuscrew-tunnel-${name}`,
      spawnImpl: () => ({ pid: 4193999, unref() {} }),
      sshVersion: () => ({ major: 9, minor: 6 }),
    },
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => {
    t.after(async () => {
      try {
        const st = nodesStore.loadStore(paths.nodesPath);
        if (st) {
          for (const n of (st.nodes || []).filter((n) => n && n.eventsReceive)) {
            nodesStore.atomicWriteStore(paths.nodesPath, nodesStore.updateNode(st, n.name, { eventsReceive: false }));
          }
        }
      } catch (_) { /* the teardown cannot depend on the store */ }
      await sleep(60);
      server.close();
      if (watcher) watcher.close();
    });
    res({ base: `http://127.0.0.1:${server.address().port}`, port: server.address().port, token, server, ...paths });
  }));
}

async function pair(t, root) {
  const B = await boot(t, path.join(root, 'owner'));
  const A = await boot(t, path.join(root, 'client'));
  const selfA = nodesStore.loadStoreStrict(A.nodesPath).nodeId;
  const selfB = nodesStore.loadStoreStrict(B.nodesPath).nodeId;
  // Owner B: the client sees the cells and the events, and NOTHING else — no
  // reply grant, no dismissal grant. Removing a card locally must not need any
  // of that.
  let stB = nodesStore.addNode(nodesStore.loadStoreStrict(B.nodesPath), {
    name: 'client', remotePort: 41999, localPort: 44778, nodeId: selfA,
    acceptToken: SECRET, direction: 'inbound', shared: false, visibility: 'network',
  });
  stB = nodesStore.setPeerAccessGrants(stB, 'client', {
    cellVisibility: 'selected', cells: ['dev'], eventsAccess: true, nodeEventsAccess: true,
    askReplyAccess: false, filesReadAccess: false, liveHostAccess: false, panelAccess: false, peerOperatorAccess: false,
  });
  nodesStore.atomicWriteStore(B.nodesPath, stB);
  // Client A: the owner is enabled for event reception, so its feed client
  // opens snapshot+stream on its own.
  let stA = nodesStore.addNode(nodesStore.loadStoreStrict(A.nodesPath), {
    name: 'owner', remotePort: 41999, localPort: B.port, nodeId: selfB,
    token: SECRET, direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@owner',
  });
  stA = nodesStore.updateNode(stA, 'owner', { eventsReceive: true });
  nodesStore.atomicWriteStore(A.nodesPath, stA);
  return { A, B, selfA, selfB };
}

const createAsk = (B, question) => fetch(`${B.base}/api/asks`, {
  method: 'POST', headers: H(B.token),
  body: JSON.stringify({ question, options: ['yes', 'no'], session: tmuxSessionForCell('dev') }),
}).then(async (r) => { assert.equal(r.status, 201); return (await r.json()).id; });

const feedView = async (X, ownerId) => {
  const r = await fetch(`${X.base}/api/feed-state`, { headers: H(X.token) });
  assert.equal(r.status, 200);
  return (await r.json()).views.find((v) => v.ownerId === ownerId) || null;
};

const waitUntil = async (fn, { tries = 60, what } = {}) => {
  for (let i = 0; i < tries; i++) {
    const out = await fn();
    if (out) return out;
    await sleep(100);
  }
  return null;
};

const hasAsk = (view, askId) => !!(view && (view.asks || []).some((a) => (a.ownerAskId || a.id) === askId));

test('E2E: a locally dismissed card survives a reload, and a new ask still arrives', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaskfilter-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { A, B, selfB } = await pair(t, root);
  const askId = await createAsk(B, 'procedo con la pulizia?');
  assert.ok(await waitUntil(async () => hasAsk(await feedView(A, selfB), askId), { what: 'card imported' }), 'the card reaches the client view');
  // A second ask created BEFORE the reload: a different card, never dismissed.
  const newId = await createAsk(B, 'nuova domanda separata');
  assert.ok(await waitUntil(async () => hasAsk(await feedView(A, selfB), newId), { what: 'new card imported' }), 'the second card reaches the client view');

  // The operator removes the first card on the viewing node. The dismissal is
  // made durable directly in the receiving store (the same record the
  // dismiss-local endpoint writes), with no permission from the owner.
  const view = await feedView(A, selfB);
  const viewAsk = view.asks.find((a) => (a.ownerAskId || a.id) === askId);
  const out = createAsksStore({ dir: A.configDir }).dismissImported({ ownerId: selfB, ownerAskId: askId, ask: viewAsk, syncState: 'blocked' });
  assert.equal(out.ok, true);

  // RELOAD: a fresh server process on the same data directory rebuilds its
  // feed view from a fresh owner snapshot — exactly what the operator's
  // browser does. The dismissed card must stay out; the other one must be
  // there.
  const A2 = await boot(t, path.join(root, 'client'));
  const viewAfter = await waitUntil(async () => {
    const v = await feedView(A2, selfB);
    return v && (v.asks || []).length ? v : null;
  }, { what: 'reloaded view populated' });
  assert.ok(viewAfter, 'the reloaded node serves a populated view');
  assert.equal(hasAsk(viewAfter, askId), false, 'the locally dismissed card does not come back after the reload');
  assert.equal(hasAsk(viewAfter, newId), true, 'the other card is still served');

  // The owner still keeps both asks open: removing locally is not answering.
  const list = await fetch(`${B.base}/api/asks`, { headers: H(B.token) }).then((r) => r.json());
  const oldRec = (list.asks || []).find((a) => a.id === askId);
  assert.ok(oldRec, 'the owner keeps the first ask');
  assert.equal(oldRec.dismissed, false, 'the owner ask was never closed by the local removal');
  assert.equal(oldRec.answered, false, 'the owner ask was never answered by the local removal');
});

test('a newer generation of the same ask is not dismissed, an older one is', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-dismiss-gen-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = createAsksStore({ dir: home });
  const OWNER = 'e'.repeat(32);
  const ask = store.create({ question: 'riprovo?', options: ['yes'], session: tmuxSessionForCell('dev'), ownerId: OWNER, ownerAskId: 'aabbccdd', originNode: OWNER, ownerAskTs: 100 }).ask;
  assert.equal(store.dismissImported({ ownerId: OWNER, ownerAskId: 'aabbccdd', ask, syncState: 'blocked' }).ok, true);
  // Same generation: stays suppressed across reloads and snapshots.
  assert.equal(store.isImportedDismissed(OWNER, ask), true, 'the dismissed generation is suppressed');
  // A newer generation of the same ask (same owner ask id, newer ts): the
  // operator asked again — the card must come back.
  const newer = { ...ask, ownerAskTs: 101 };
  assert.equal(store.isImportedDismissed(OWNER, newer), false, 'a newer generation is not dismissed');
  // A different question under the same id at the newer ts: not dismissed.
  const changed = { ...ask, ownerAskTs: 101, question: 'testo diverso' };
  assert.equal(askFingerprint(changed) !== askFingerprint(ask), true);
  assert.equal(store.isImportedDismissed(OWNER, changed), false, 'changed content is not dismissed');
});
