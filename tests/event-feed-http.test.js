'use strict';
// tests/event-feed-http.test.js — the event feed over TWO REAL SERVERS.
//
// A (client) and B (owner) are two full createServer() instances. A reads B's
// feed through its own federation route, so the WHOLE path is exercised: Bearer
// hopping, the visited chain [clientId, ownerId], the hop proof, the class
// gate, the per-peer grants and the closed query surface. A local Bearer with
// no hop must get 403 with zero content — the feed has no local fallback.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const { tmuxSessionForCell } = require('../lib/fleet/definitions.js');

const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
const A_ID = 'a'.repeat(32); // client node id
const B_ID = 'b'.repeat(32); // owner node id
const SECRET = 'pairing-secret-token';

function boot(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncfeedhttp-'));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir,
    configDir,
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
    sessionExistsSeam: () => true,
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
    t.after(() => { server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    res({ base: `http://127.0.0.1:${server.address().port}`, port: server.address().port, token, watcher, ...paths });
  }));
}

// Pair A (client) with B (owner): B holds the inbound record with the grants,
// A holds the outbound record pointing at B's port with the shared secret.
async function pair(t, preset = 'user') {
  const A = await boot(t);
  const B = await boot(t);
  // The peer identities are the REAL store node ids: the visited chain is
  // built from them, so records must carry the same ids the nodes advertise.
  const selfA = nodesStore.loadStoreStrict(A.nodesPath).nodeId;
  const selfB = nodesStore.loadStoreStrict(B.nodesPath).nodeId;
  let stB = nodesStore.addNode(nodesStore.loadStoreStrict(B.nodesPath), {
    name: 'client', remotePort: 41999, localPort: 44777, nodeId: selfA,
    acceptToken: SECRET, direction: 'inbound', shared: false, visibility: 'network',
  });
  stB = nodesStore.setPeerAccessPreset(stB, 'client', preset);
  nodesStore.atomicWriteStore(B.nodesPath, stB);

  const stA = nodesStore.addNode(nodesStore.loadStoreStrict(A.nodesPath), {
    name: 'owner', remotePort: 41999, localPort: B.port, nodeId: selfB,
    token: SECRET, direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@owner',
  });
  nodesStore.atomicWriteStore(A.nodesPath, stA);
  return { A, B, selfA, selfB };
}

const feedViaA = (A) => `${A.base}/api/route/owner/_/event-feed`;

async function readStream(url, headers, { maxMs = 2500 } = {}) {
  const ctrl = new AbortController();
  const chunks = [];
  const timer = setTimeout(() => ctrl.abort(), maxMs);
  let status = null;
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    status = r.status;
    if (r.body) {
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(dec.decode(value));
      }
    }
  } catch (_) { /* aborted on purpose */ }
  clearTimeout(timer);
  return { status, text: chunks.join('') };
}

test('a local Bearer without a hop is 403 with zero content (no local fallback)', async (t) => {
  const { B } = await pair(t);
  const res = await fetch(`${B.base}/api/event-feed`, { headers: H(B.token) });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.ok(body.reason, 'a named refusal, never feed content');
});

test('live flow over two real servers: the frame is v1, attributed to the owner, scoped to a visible cell', async (t) => {
  const { A, B, selfB } = await pair(t);
  const done = readStream(feedViaA(A), H(A.token), { maxMs: 2000 });
  await new Promise((r) => setTimeout(r, 150));
  // The owner emits a notify bound to a cell resolved from the session.
  const emitted = await fetch(`${B.base}/api/notify`, {
    method: 'POST', headers: H(B.token),
    body: JSON.stringify({ title: 'cell event', body: 'hello dev', session: tmuxSessionForCell('dev') }),
  });
  assert.equal(emitted.status, 200);
  const { text } = await done;
  assert.ok(text.includes('data: '), 'the client received SSE frames');
  const frame = JSON.parse(text.split('\n').find((l) => l.startsWith('data: ')).slice(6));
  assert.equal(frame.v, 1);
  assert.equal(frame.ownerId, selfB, 'attributed to the owner');
  assert.equal(frame.scope, 'cell');
  assert.equal(frame.cellId, 'dev', 'the cell comes from the owner binding');
  assert.equal(frame.hop, 1);
  assert.match(frame.eventId, /^[0-9a-f-]{36}$/);
  assert.equal(frame.frame.title, 'cell event');
});

test('a hidden cell never reaches the peer, and the ask of a hidden cell is not in the snapshot', async (t) => {
  const { A, B, selfB } = await pair(t, 'user');
  // Narrow the visibility to the dev cell only.
  let st = nodesStore.loadStoreStrict(B.nodesPath);
  st = nodesStore.setPeerAccessGrants(st, 'client', {
    cellVisibility: 'selected', cells: ['dev'], eventsAccess: true, nodeEventsAccess: true,
    askReplyAccess: false, filesReadAccess: false, liveHostAccess: false, panelAccess: false, peerOperatorAccess: false,
  });
  nodesStore.atomicWriteStore(B.nodesPath, st);

  await fetch(`${B.base}/api/notify`, {
    method: 'POST', headers: H(B.token),
    body: JSON.stringify({ title: 'visible', session: tmuxSessionForCell('dev') }),
  });
  await fetch(`${B.base}/api/notify`, {
    method: 'POST', headers: H(B.token),
    body: JSON.stringify({ title: 'hidden', session: tmuxSessionForCell('secret') }),
  });
  await fetch(`${B.base}/api/asks`, {
    method: 'POST', headers: H(B.token),
    body: JSON.stringify({ question: 'hidden ask?', session: tmuxSessionForCell('secret') }),
  });

  const snap = await (await fetch(`${feedViaA(A)}/snapshot`, { headers: H(A.token) })).json();
  assert.equal(snap.ownerId, selfB);
  assert.ok(snap.cursor, 'the snapshot carries the view cursor');
  assert.equal(snap.notifications.some((e) => e.frame.title === 'hidden'), false, 'hidden cell notify filtered');
  assert.equal(snap.notifications.some((e) => e.frame.title === 'visible'), true);
  assert.equal(snap.asks.length, 0, 'the hidden ask is not visible through an id guess either');
  const { text } = await readStream(feedViaA(A), H(A.token), { maxMs: 1200 });
  assert.ok(!text.includes('hidden'), 'no hidden content on the stream');
});

test('a token in the query is refused on the feed surface', async (t) => {
  const { A } = await pair(t);
  const res = await fetch(`${feedViaA(A)}?token=${SECRET}`, { headers: H(A.token) });
  assert.ok([403, 404].includes(res.status));
  const text = await res.text();
  assert.ok(!text.includes('data:'), 'zero feed content');
});

test('the kill-switch denies opens and snapshots live, with a named reason', async (t) => {
  const { A, B } = await pair(t);
  fs.writeFileSync(B.configPath, JSON.stringify({ federation: { events: { enabled: false } } }));
  const snap = await fetch(`${feedViaA(A)}/snapshot`, { headers: H(A.token) });
  assert.equal(snap.status, 403);
  const body = await snap.json();
  assert.equal(body.reason, 'events-disabled');
  const stream = await fetch(feedViaA(A), { headers: H(A.token) });
  assert.equal(stream.status, 403);
});

test('revoking the grants closes the view: the stream is refused after the downgrade', async (t) => {
  const { A, B } = await pair(t);
  await fetch(`${B.base}/api/notify`, {
    method: 'POST', headers: H(B.token),
    body: JSON.stringify({ title: 'before', session: tmuxSessionForCell('dev') }),
  });
  const st = nodesStore.loadStoreStrict(B.nodesPath);
  const revision = nodesStore.accessRevisionOf(st);
  const patch = await fetch(`${B.base}/api/settings/nodes/client`, {
    method: 'PATCH', headers: H(B.token),
    body: JSON.stringify({ accessRole: 'nexushost', accessRevision: revision }),
  });
  assert.equal(patch.status, 200, 'the downgrade is a valid write');
  const stream = await fetch(feedViaA(A), { headers: H(A.token) });
  assert.equal(stream.status, 403, 'the revoked peer gets no new stream');
});

test('a federated notify is delivered locally but NEVER re-exported (loop protection)', async (t) => {
  // The client needs peerOperatorAccess for the federated /notify ingress.
  const { A, B, selfB } = await pair(t, 'admin');
  const sent = await fetch(`${A.base}/api/route/owner/_/notify`, {
    method: 'POST', headers: H(A.token),
    body: JSON.stringify({ title: 'from A', target: selfB, originCell: 'dev' }),
  });
  assert.equal(sent.status, 200);
  // B delivered it to its own UI; the feed/history of B must not contain it.
  const snap = await (await fetch(`${feedViaA(A)}/snapshot`, { headers: H(A.token) })).json();
  assert.equal(snap.notifications.length, 0, 'an imported event is not re-exported');
});
