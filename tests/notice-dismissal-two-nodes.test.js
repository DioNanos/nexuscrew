'use strict';
// tests/notice-dismissal-two-nodes.test.js — a cleared notice over TWO REAL NODES.
//
// A owns the notices, B is a client that receives them. The operator on B clears
// the whole visible set in ONE request; the owner records it, its snapshot stops
// carrying those entries, and the closure frames take the cards out of B's live
// view. The point of the test is the MEASUREMENT: 50 closures must arrive and be
// processed, inside the per-owner ingress budget (120 frames/min) — not be
// assumed to fit.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const { tmuxSessionForCell } = require('../lib/fleet/definitions.js');

const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
const SECRET_AB = 'secret-a-b';
const BULK = 50;

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
  const { server, token, watcher } = createServer({
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
  return new Promise((res) => server.listen(0, '127.0.0.1', () => {
    t.after(() => { server.close(); if (watcher) watcher.close(); });
    res({ base: `http://127.0.0.1:${server.address().port}`, port: server.address().port, token, paths });
  }));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function link(A, B, preset = 'admin') {
  const idA = nodesStore.loadStoreStrict(A.paths.nodesPath).nodeId;
  const idB = nodesStore.loadStoreStrict(B.paths.nodesPath).nodeId;
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
  return { A, B, idA, idB };
}

async function pair(t, dir, preset = 'admin') {
  const A = await boot(t, path.join(dir, 'a'));
  const B = await boot(t, path.join(dir, 'b'));
  return link(A, B, preset);
}

// Raw SSE read of the node's own hub feed, so the closure frames are COUNTED
// on the wire instead of being inferred from the view they produce.
async function readStream(url, headers, { maxMs = 6000 } = {}) {
  const ctrl = new AbortController();
  const frames = [];
  const timer = setTimeout(() => ctrl.abort(), maxMs);
  try {
    const r = await fetch(url, { headers, signal: ctrl.signal });
    if (!r.body) return frames;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const line = block.split('\n').find((l) => l.startsWith('data: '));
        if (line) { try { frames.push(JSON.parse(line.slice(6))); } catch (_) {} }
      }
    }
  } catch (_) { /* aborted on purpose */ }
  clearTimeout(timer);
  return frames;
}

async function viewOfB(B, idA) {
  const res = await fetch(`${B.base}/api/feed-state`, { headers: H(B.token) });
  const state = await res.json();
  return (state.views || []).find((v) => v.ownerId === idA) || null;
}

test('dismiss-all publishes ONE closure per cleared notice: 50 frames, measured on the wire', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncnotice2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // The owner boots first and its durable history is seeded BEFORE any client
  // exists: the store reads the file once, so the window must be on disk before
  // the first snapshot. A window of exactly 50 entries is what the design caps
  // `dismiss-all` at — and it is also the client's snapshot cap, so the view
  // alone is not the instrument: the closures are counted on the hub feed.
  const A = await boot(t, path.join(dir, 'a'));
  const idA = nodesStore.loadStoreStrict(A.paths.nodesPath).nodeId;
  const now = Date.now();
  const entries = Array.from({ length: BULK }, (_, i) => {
    const eventId = `${String(i).padStart(8, '0')}-aaaa-4aaa-8aaa-${'a'.repeat(12)}`;
    return {
      origin: 'local', eventId, at: now - (BULK - i) * 100,
      envelope: {
        v: 1, ownerId: idA, eventId, scope: 'cell', cellId: 'dev', hop: 1,
        emittedAt: now - (BULK - i) * 100, frame: { type: 'notify', title: `notice ${i}`, urgency: 'normal' },
      },
    };
  });
  fs.writeFileSync(path.join(A.paths.configDir, 'event-feed-history.json'),
    JSON.stringify({ schema: 'nexuscrew-event-feed-history-v1', savedAt: now, entries }), { mode: 0o600 });

  const B = await boot(t, path.join(dir, 'b'));
  link(A, B);

  // Count the closures while the operator clears everything in ONE request.
  // The wire measured here is the NODE's hub (`/api/events`): since the cap
  // fix the peer's own feed client connects to the owner too, and one stream
  // per pair replaces any hand-opened stream on the same pair — the hub is
  // where the frames reach this node's browsers anyway.
  const counting = readStream(`${B.base}/api/events`, H(B.token), { maxMs: 5000 });
  await sleep(600); // the stream must be established BEFORE the burst
  const cleared = await fetch(`${B.base}/api/route/a-owner/_/event-feed/notices/dismiss-all`, {
    method: 'POST', headers: H(B.token), body: JSON.stringify({}),
  });
  assert.equal(cleared.status, 200);
  assert.deepStrictEqual(await cleared.json(), { dismissed: BULK }, 'one request clears the whole window');

  const frames = await counting;
  const closures = frames.filter((f) => f && f.type === 'notify-dismissed' && f.ownerId === idA);
  assert.equal(closures.length, BULK, 'MEASURED: 50 closures, one per cleared notice');
  assert.equal(new Set(closures.map((f) => f.eventId)).size, BULK, 'no duplicate, no missing id');

  // The ingress absorbed the burst: the per-owner budget is 120 frames/min and
  // the client would declare the block (and drop frames) past it.
  const view = await viewOfB(B, idA);
  assert.ok(view, 'B holds a view of A');
  assert.equal(view.ingressBlockedUntil || null, null, 'the per-owner ingress budget was not exceeded');

  // The owner stops serving the CLEARED notices. What it does serve, by design,
  // are the closures themselves: they enter the history, so a peer that missed
  // the live frame recovers the dismissal from the backlog — and the receiving
  // side drops them by type (frontend/src/lib/remote-notices.js:22 admits only
  // `notify`, so a closure never becomes a card).
  const seeded = new Set(entries.map((e) => e.eventId));
  const snap = await (await fetch(`${B.base}/api/route/a-owner/_/event-feed/snapshot`, { headers: H(B.token) })).json();
  assert.equal(snap.ownerId, idA);
  const served = (snap.notifications || []).map((n) => n.eventId);
  assert.equal(served.some((eventId) => seeded.has(eventId)), false, 'no cleared notice is served any more');
  const recovered = (snap.notifications || []).filter((n) => n.frame && n.frame.type === 'notify-closed');
  assert.equal(recovered.length, BULK, 'the backlog carries one closure per cleared notice');
  assert.equal(new Set(recovered.map((n) => n.frame.eventId)).size, BULK, 'each closure names its notice');
});

test('a notice nobody cleared stays, and the closure removes exactly one', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncnotice2b-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { A, B, idA } = await pair(t, dir);

  for (const title of ['keep me', 'clear me']) {
    await fetch(`${A.base}/api/notify`, {
      method: 'POST', headers: H(A.token),
      body: JSON.stringify({ title, session: tmuxSessionForCell('dev') }),
    });
  }
  let view = null;
  for (let i = 0; i < 40; i += 1) {
    view = await viewOfB(B, idA);
    if (view && view.stale === false && (view.notifications || []).length === 2) break;
    await sleep(150);
  }
  assert.equal((view.notifications || []).length, 2, 'B imported both');

  const target = view.notifications.find((n) => n.frame.title === 'clear me');
  const out = await fetch(`${B.base}/api/route/a-owner/_/event-feed/notices/${target.eventId}`, {
    method: 'DELETE', headers: H(B.token),
  });
  assert.equal(out.status, 200);
  assert.deepStrictEqual(await out.json(), { dismissed: true, idempotent: false });

  for (let i = 0; i < 20; i += 1) {
    view = await viewOfB(B, idA);
    if (view && (view.notifications || []).length === 1) break;
    await sleep(100);
  }
  const left = (view.notifications || []).map((n) => n.frame.title);
  assert.deepStrictEqual(left, ['keep me'], 'exactly the cleared notice left the view');
});
