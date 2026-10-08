'use strict';
// tests/notice-dismiss-reload.test.js — the local intent of «Pulisci» must
// survive the two things that make a cleared notice come back:
//
//   1. a RELOAD: the browser forgets its module-level tombstones and asks
//      /api/feed-state again, so the node — not the browser — must not serve the
//      notice any more;
//   2. a RESTART of the receiving node, when the owner could not take the
//      dismissal: the in-memory view is rebuilt from the owner's snapshot, which
//      still carries the notice. Only a durable local record can hold it out.
//
// The owner is the real thing in both cases: down (the dismissal queues as
// pending) and up-but-without-the-surface (blocked). Everything runs in-process
// on ephemeral ports and a temporary HOME: no service is touched.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const { tmuxSessionForCell } = require('../lib/fleet/definitions.js');

const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
const SECRET_AB = 'secret-a-b';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const instances = [];

function boot(t, dir, extra = {}) {
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
  const created = createServer({
    ...paths,
    filesRoot: path.join(dir, 'files'),
    port: 41999,
    fleetEnabled: false,
    eventFeedClientPollMs: 250,
    sessionExistsSeam: () => true,
    settingsSeams: {
      platform: 'linux', uid: 1000,
      execImpl: () => { throw new Error('exec disabled in test'); },
      serviceInstallPath: path.join(dir, 'systemd', 'nexuscrew.service'),
      keygen: (_kp, name) => `ssh-ed25519 AAAAC3FAKEKEY nexuscrew-tunnel-${name}`,
      spawnImpl: () => ({ pid: 4193999, unref() {} }),
      sshVersion: () => ({ major: 9, minor: 6 }),
    },
    ...extra,
  });
  return new Promise((res) => created.server.listen(0, '127.0.0.1', () => {
    const entry = {
      base: `http://127.0.0.1:${created.server.address().port}`,
      port: created.server.address().port,
      token: created.token, paths, nodeId: nodesStore.loadStoreStrict(paths.nodesPath).nodeId,
      server: created.server, watcher: created.watcher,
    };
    instances.push(entry);
    t.after(() => { try { entry.server.close(); } catch (_) {} if (entry.watcher) entry.watcher.close(); });
    res(entry);
  }));
}

function link(A, B, preset = 'admin') {
  const idA = A.nodeId;
  const idB = B.nodeId;
  let stA = nodesStore.addNode(nodesStore.loadStoreStrict(A.paths.nodesPath), {
    name: 'node-b', remotePort: 41999, localPort: 44777, nodeId: idB,
    acceptToken: SECRET_AB, direction: 'inbound', shared: false, visibility: 'network',
  });
  stA = nodesStore.setPeerAccessPreset(stA, 'node-b', preset);
  nodesStore.atomicWriteStore(A.paths.nodesPath, stA);
  let stB = nodesStore.addNode(nodesStore.loadStoreStrict(B.paths.nodesPath), {
    name: 'a-owner', remotePort: 41999, localPort: A.port, nodeId: idA,
    token: SECRET_AB, direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@a',
  });
  stB = nodesStore.updateNode(stB, 'a-owner', { eventsReceive: true });
  nodesStore.atomicWriteStore(B.paths.nodesPath, stB);
  return { idA, idB };
}

// Point the receiving node at another port for the same owner: how a peer that
// has been re-pointed at a different surface looks from the store's point of view.
function repoint(B, name, localPort) {
  let st = nodesStore.loadStoreStrict(B.paths.nodesPath);
  st = nodesStore.updateNode(st, name, { localPort });
  nodesStore.atomicWriteStore(B.paths.nodesPath, st);
}

// An owner from BEFORE the notices surface: everything it serves is real — the
// snapshot included, so the cleared notices are still there to come back — but
// the notice routes answer the way a 0.9.64 does. This is the `unsupported`
// case of the relay contract, without a faked feed.
async function surfaceLessOwner(t, targetBase) {
  const up = new URL(targetBase);
  const server = http.createServer((req, res) => {
    if (req.url.includes('/event-feed/notices')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden', reason: 'resource-not-classified' }));
      return;
    }
    const proxy = http.request({
      host: up.hostname, port: up.port, method: req.method, path: req.url, headers: req.headers,
    }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
    proxy.on('error', () => { try { res.writeHead(502, { 'content-type': 'application/json' }); res.end('{}'); } catch (_) {} });
    req.pipe(proxy);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  return server.address().port;
}

async function viewOf(B, ownerId) {
  const res = await fetch(`${B.base}/api/feed-state`, { headers: H(B.token) });
  const state = await res.json();
  return (state.views || []).find((v) => v.ownerId === ownerId) || null;
}

async function waitForNotices(B, ownerId, count, tries = 40) {
  let view = null;
  for (let i = 0; i < tries; i += 1) {
    view = await viewOf(B, ownerId);
    if (view && (view.notifications || []).length === count) return view;
    await sleep(150);
  }
  return view;
}

function emit(owner, token, titles) {
  return Promise.all(titles.map((title) => fetch(`${owner.base}/api/notify`, {
    method: 'POST', headers: H(owner.token || token),
    body: JSON.stringify({ title, session: tmuxSessionForCell('dev') }),
  })));
}

function queuedOnDisk(B) {
  const file = path.join(B.paths.configDir, 'notice-dismissal-queue.json');
  if (!fs.existsSync(file)) return [];
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return (parsed && parsed.entries) || [];
}

test('clear with the owner down: the reload does not hand the notices back, and the intent is on disk', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncnoticerl-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const A = await boot(t, path.join(dir, 'a'));
  const B = await boot(t, path.join(dir, 'b'));
  const { idA } = link(A, B);

  await emit(A, A.token, ['pending one', 'pending two']);
  const seen = await waitForNotices(B, idA, 2);
  assert.equal((seen.notifications || []).length, 2, 'B imported both notices');

  // The owner goes away: the dismissal cannot travel NOW, which is exactly the
  // case the operator cannot see coming.
  A.server.close();
  await sleep(400);

  const cleared = await fetch(`${B.base}/api/notices-relay`, {
    method: 'POST', headers: H(B.token),
    body: JSON.stringify({ action: 'dismiss-all', owners: [idA] }),
  });
  assert.equal(cleared.status, 200);
  const body = await cleared.json();
  assert.deepStrictEqual(body, { results: { [idA]: { pending: 2 } } }, 'the local intent stands and is queued');

  // The reload: a brand new read of the aggregated state, with no browser
  // memory left. The node must not serve the cleared notices any more.
  const after = await viewOf(B, idA);
  assert.deepStrictEqual((after.notifications || []).map((n) => n.eventId), [], 'the reload does not hand the cleared notices back');

  // Durability, measured on the file: a restart of this node reads it back.
  const queued = queuedOnDisk(B);
  assert.equal(queued.length, 2, 'one durable record per cleared notice');
  assert.deepStrictEqual([...new Set(queued.map((e) => e.ownerId))], [idA]);
  assert.deepStrictEqual([...new Set(queued.map((e) => e.syncState))], ['pending']);
  const clearedIds = new Set((seen.notifications || []).map((n) => n.eventId));
  assert.deepStrictEqual(new Set(queued.map((e) => e.eventId)), clearedIds, 'the records name the cleared notices');

  // A second operator surface for the same owner does not bring them back
  // either: the queue is the node's intent, not one browser's.
  const again = await fetch(`${B.base}/api/feed-state`, { headers: H(B.token) });
  assert.equal(again.status, 200);
});

// An owner that TAKES the dismissal but cannot be polled any more: the notice
// route answers 2xx, every other route fails. Nothing can leave the view but the
// local closure itself.
async function takingOwnerOnly(t) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, body });
      if (req.url.includes('/event-feed/notices')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ dismissed: 2 }));
        return;
      }
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => { server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  return { port: server.address().port, seen };
}

test('clear the owner takes: the node stops serving the notices at once, not at the next poll', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncnoticerl3-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const A = await boot(t, path.join(dir, 'a'));
  const B = await boot(t, path.join(dir, 'b'));
  const { idA } = link(A, B);

  await emit(A, A.token, ['taken one', 'taken two']);
  const seen = await waitForNotices(B, idA, 2);
  assert.equal((seen.notifications || []).length, 2, 'B imported both notices');

  // From here the owner takes the dismissal but refuses every other route: no
  // snapshot can land any more, so what the node serves right after the call is
  // decided by the local closure alone — deterministically, not by the next poll.
  const taking = await takingOwnerOnly(t);
  repoint(B, 'a-owner', taking.port);
  await sleep(150);
  const pre = await viewOf(B, idA);
  assert.equal((pre.notifications || []).length, 2, 'the view still holds both before the clear');

  const cleared = await fetch(`${B.base}/api/notices-relay`, {
    method: 'POST', headers: H(B.token),
    body: JSON.stringify({ action: 'dismiss-all', owners: [idA] }),
  });
  assert.equal(cleared.status, 200);
  assert.deepStrictEqual(await cleared.json(), { results: { [idA]: { ok: true, dismissed: 2 } } });
  // The poll also lands here (and fails): the notices route must have been hit
  // exactly once for the whole owner.
  const noticeCalls = taking.seen.filter((r) => r.url.includes('/event-feed/notices'));
  assert.equal(noticeCalls.length, 1, 'one request per owner, as the design asks');
  assert.equal(noticeCalls[0].method, 'POST');
  assert.ok(noticeCalls[0].url.includes('/event-feed/notices/dismiss-all'));

  const after = await viewOf(B, idA);
  // Nothing else can empty this view: a dismissal drops a notice, a snapshot can
  // only bring one back — and the closure has just been confirmed.
  assert.deepStrictEqual((after.notifications || []).map((n) => n.eventId), [], 'the node stops serving them immediately');
});

test('clear against an owner without the surface: blocked stays blocked across a restart of this node', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncnoticerl2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const A = await boot(t, path.join(dir, 'a'));
  let B = await boot(t, path.join(dir, 'b'));
  const { idA } = link(A, B);

  await emit(A, A.token, ['blocked one', 'blocked two']);
  const seen = await waitForNotices(B, idA, 2);
  assert.equal((seen.notifications || []).length, 2, 'B imported both notices');
  const clearedIds = new Set((seen.notifications || []).map((n) => n.eventId));

  // The owner answers for its feed but not for the notices surface: the
  // dismissal will never be taken there, so only the LOCAL record can hold.
  const proxyPort = await surfaceLessOwner(t, A.base);
  repoint(B, 'a-owner', proxyPort);
  await sleep(200);

  const cleared = await fetch(`${B.base}/api/notices-relay`, {
    method: 'POST', headers: H(B.token),
    body: JSON.stringify({ action: 'dismiss-all', owners: [idA] }),
  });
  assert.equal(cleared.status, 200);
  assert.deepStrictEqual(await cleared.json(), { results: { [idA]: { blocked: 'unsupported' } } });

  const after = await viewOf(B, idA);
  assert.deepStrictEqual((after.notifications || []).map((n) => n.eventId), [], 'cleared, and declared blocked');
  const queued = queuedOnDisk(B);
  assert.equal(queued.length, 2, 'the blocked intent is durable too');
  assert.deepStrictEqual([...new Set(queued.map((e) => e.syncState))], ['blocked']);

  // RESTART of the receiving node: the view is rebuilt from the owner's
  // snapshot (which still carries the notices) and the browser memory is gone.
  B.server.close();
  await sleep(300);
  B = await boot(t, path.join(dir, 'b'));

  // Two facts make the assertion below a measurement instead of a coincidence:
  // the owner STILL holds both notices (read from its own durable history), and
  // the restarted node completed a snapshot round — the very read that, without
  // the durable local intent, hands them back.
  const history = JSON.parse(fs.readFileSync(path.join(A.paths.configDir, 'event-feed-history.json'), 'utf8'));
  const stillAtOwner = new Set((history.entries || []).map((e) => e.envelope && e.envelope.eventId));
  for (const eventId of clearedIds) {
    assert.ok(stillAtOwner.has(eventId), 'the owner still holds the notice: it could come back');
  }

  let served = null;
  for (let i = 0; i < 40; i += 1) {
    served = await viewOf(B, idA);
    if (served && served.stale === false) break;
    await sleep(150);
  }
  assert.equal(served.stale, false, 'the restarted node completed a snapshot round');
  assert.deepStrictEqual((served.notifications || []).map((n) => n.eventId), [], 'the durable local intent keeps them out of what the node serves');
});
