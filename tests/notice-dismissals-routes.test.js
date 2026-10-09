'use strict';
// tests/notice-dismissals-routes.test.js — the owner-side notice dismissal
// surface, on an ISOLATED router (no server, no federation): the chain gate,
// the grants, the opaque 404, the idempotent 200, the dedicated budget, the
// READONLY refusal and the closed body of `dismiss-all`.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const nodes = require('../lib/nodes/store.js');
const { createNoticeDismissals } = require('../lib/notify/notice-dismissals.js');
const { createEventFeedNoticesRoutes } = require('../lib/notify/event-feed-notices-routes.js');

const OWNER = 'a'.repeat(32);
const PEER = 'b'.repeat(32);
const E1 = '0f8fad5b-d9cb-469f-a165-70867728950e';
const E2 = '11111111-2222-4333-8444-555555555555';

const entry = (eventId, cellId) => ({
  origin: 'local',
  eventId,
  at: 1_700_000_000_000,
  envelope: { v: 1, ownerId: OWNER, eventId, scope: 'cell', cellId, hop: 1, emittedAt: 1_700_000_000_000, frame: { type: 'notify', title: 'x' } },
});

async function fixture(t, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncdroutes-'));
  const nodesPath = path.join(dir, 'nodes.json');
  nodes.initStore(nodesPath);
  let st = nodes.addNode(nodes.loadStoreStrict(nodesPath), {
    name: 'peer', nodeId: PEER, direction: 'inbound', token: 'fixture',
    localPort: 42001, remotePort: 42002, ssh: 'demo@example.invalid', shared: true, visibility: 'network',
  });
  if (opts.extraPeer) {
    // A second paired node: the RELAY of a two-hop request.
    st = nodes.addNode(st, {
      name: 'relay2', nodeId: opts.extraPeer.nodeId, direction: 'inbound', token: 'fixture2',
      localPort: 42003, remotePort: 42004, ssh: 'relay@example.invalid', shared: true, visibility: 'network',
    });
    st = nodes.setPeerAccessPreset(st, 'relay2', opts.extraPeer.preset || 'admin');
  }
  if (opts.grants) {
    // The grant vector is written whole, never in pieces: the store refuses a
    // partial one, so the fixture completes it.
    st = nodes.setPeerAccessGrants(st, 'peer', {
      // A coherent vector: the operator grants need the complete admin set, and
      // these fixtures only exercise the feed-action ones.
      cellVisibility: 'all', cells: [], eventsAccess: true, nodeEventsAccess: true,
      askReplyAccess: true, filesReadAccess: true, liveHostAccess: false,
      panelAccess: false, peerOperatorAccess: false, ...opts.grants,
    });
  } else {
    st = nodes.setPeerAccessPreset(st, 'peer', opts.preset || 'admin');
  }
  nodes.atomicWriteStore(nodesPath, st);

  const history = { list: () => (opts.entries || [entry(E1, 'dev'), entry(E2, 'dev')]).slice() };
  // `brokenStore`: a directory where the file should be, so the atomic rename
  // fails for real and the degradation has to be declared.
  const dismissalsPath = path.join(dir, 'notice-dismissals.json');
  if (opts.brokenStore) fs.mkdirSync(dismissalsPath);
  const dismissals = createNoticeDismissals({
    filePath: dismissalsPath,
    now: opts.now || (() => 1_700_000_000_000),
  });
  const closed = [];
  const app = express();
  app.use('/notices', createEventFeedNoticesRoutes({
    nodesPath,
    localNodeId: () => OWNER,
    eventsEnabled: () => true,
    originResolver: { resolve: async () => (opts.origin || { ok: true, trust: 'federated', origin: { node: PEER }, visited: [PEER, OWNER] }) },
    history,
    dismissals,
    closeNotice: async (arg) => { closed.push(arg); },
    readonly: opts.readonly,
    now: opts.now || (() => 1_700_000_000_000),
  }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const request = async (method, url, body) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { code: res.status, body: await res.json() };
  };
  return { request, dismissals, closed, dir, nodesPath };
}

test('no proven federated origin: refused before anything else', async (t) => {
  const noHop = await fixture(t, { origin: { ok: false, reason: 'no-hop' } });
  const a = await noHop.request('DELETE', `/notices/${E1}`);
  assert.equal(a.code, 403);

  const local = await fixture(t, { origin: { ok: true, trust: 'local', origin: { node: PEER }, visited: [] } });
  const b = await local.request('DELETE', `/notices/${E1}`);
  assert.equal(b.code, 403);
  assert.equal(b.body.reason, 'federated-origin-required');
});

test('a chain that is not [actor, ..., owner] is refused', async (t) => {
  const short = await fixture(t, { origin: { ok: true, trust: 'federated', origin: { node: PEER }, visited: [PEER] } });
  const a = await short.request('DELETE', `/notices/${E1}`);
  assert.equal(a.code, 403);
  assert.equal(a.body.reason, 'hop-chain');

  const wrongEnd = await fixture(t, { origin: { ok: true, trust: 'federated', origin: { node: PEER }, visited: [PEER, 'c'.repeat(32)] } });
  const b = await wrongEnd.request('DELETE', `/notices/${E1}`);
  assert.equal(b.code, 403);
  assert.equal(b.body.reason, 'hop-chain');
});

test('a ring that does not hold the action grants is refused', async (t) => {
  // The user preset reads the feed and does NOT act on it.
  const f = await fixture(t, { preset: 'user' });
  const out = await f.request('DELETE', `/notices/${E1}`);
  assert.equal(out.code, 403);
  assert.equal(out.body.reason, 'grant-required:ask-action');
  assert.equal(f.dismissals.isDismissed(E1), false, 'nothing is written for a refused request');
});

test('an unknown id and an invisible one are the same opaque 404', async (t) => {
  const f = await fixture(t, {
    grants: { cellVisibility: 'selected', cells: ['dev'], eventsAccess: true, nodeEventsAccess: false, askReplyAccess: true },
    entries: [entry(E1, 'dev'), entry(E2, 'hidden-cell')],
  });
  const unknown = await f.request('DELETE', `/notices/99999999-9999-4999-8999-999999999999`);
  const invisible = await f.request('DELETE', `/notices/${E2}`);
  assert.equal(unknown.code, 404);
  assert.equal(invisible.code, 404);
  assert.deepStrictEqual(invisible.body, unknown.body, 'the two must be indistinguishable');
  assert.equal(f.dismissals.isDismissed(E2), false);
});

test('a visible notice is dismissed once, then reported as already dismissed', async (t) => {
  const f = await fixture(t);
  const first = await f.request('DELETE', `/notices/${E1}`);
  assert.equal(first.code, 200);
  assert.deepStrictEqual(first.body, { dismissed: true, idempotent: false });
  assert.equal(f.dismissals.isDismissed(E1), true);
  assert.deepStrictEqual(f.closed, [{ scope: 'cell', cellId: 'dev', eventId: E1 }], 'the closure carries scope and cell of the original');

  const again = await f.request('DELETE', `/notices/${E1}`);
  assert.equal(again.code, 200);
  assert.deepStrictEqual(again.body, { dismissed: true, idempotent: true });
  assert.equal(f.closed.length, 1, 'no second closure is published');
});

test('an id that is not an event id is a 400, never a lookup', async (t) => {
  const f = await fixture(t);
  const out = await f.request('DELETE', '/notices/not-a-uuid');
  assert.equal(out.code, 400);
  assert.equal(f.dismissals.isDismissed('not-a-uuid'), false);
});

test('the dismissal budget is its own and closes at six per minute', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 6; i += 1) {
    const out = await f.request('DELETE', `/notices/${E1}`);
    assert.equal(out.code, 200, `request ${i + 1} stays inside the budget`);
  }
  const seventh = await f.request('DELETE', `/notices/${E1}`);
  assert.equal(seventh.code, 429);
});

test('READONLY refuses the mutation', async (t) => {
  const f = await fixture(t, { readonly: () => true });
  const out = await f.request('DELETE', `/notices/${E1}`);
  assert.equal(out.code, 403);
  assert.equal(f.dismissals.isDismissed(E1), false);
});

test('dismiss-all takes a closed body and clears exactly the visible set', async (t) => {
  const f = await fixture(t, {
    grants: { cellVisibility: 'selected', cells: ['dev'], eventsAccess: true, nodeEventsAccess: false, askReplyAccess: true },
    entries: [entry(E1, 'dev'), entry(E2, 'hidden-cell')],
  });
  const extra = await f.request('POST', '/notices/dismiss-all', { cells: ['dev'] });
  assert.equal(extra.code, 400, 'no field may choose the target set');

  const out = await f.request('POST', '/notices/dismiss-all', {});
  assert.equal(out.code, 200);
  assert.deepStrictEqual(out.body, { dismissed: 1 }, 'only the visible entry');
  assert.equal(f.dismissals.isDismissed(E1), true);
  assert.equal(f.dismissals.isDismissed(E2), false);
  assert.deepStrictEqual(f.closed, [{ scope: 'cell', cellId: 'dev', eventId: E1 }]);

  const again = await f.request('POST', '/notices/dismiss-all', {});
  assert.equal(again.code, 200);
  assert.deepStrictEqual(again.body, { dismissed: 0 }, 'a second run clears nothing new');
});

test('a relayed request is judged by what the ORIGIN sees, like the snapshot does', async (t) => {
  const ORIGIN = 'c'.repeat(32);
  const f = await fixture(t, {
    // The node that ASKS is the origin and sees the whole feed; the node that
    // DELIVERS (the relay) is narrower and cannot see the cell at all.
    origin: { ok: true, trust: 'federated', origin: { node: ORIGIN }, visited: [ORIGIN, PEER, OWNER] },
    extraPeer: { nodeId: ORIGIN, preset: 'admin' },
    grants: { cellVisibility: 'selected', cells: ['other'] },
  });
  const out = await f.request('DELETE', `/notices/${E1}`);
  assert.equal(out.code, 200, 'the origin sees the entry, so the dismissal is allowed');
  assert.deepStrictEqual(out.body, { dismissed: true, idempotent: false });
  assert.equal(f.dismissals.isDismissed(E1), true);
});

test('a store that cannot write still clears the notice on this node, and declares it', async (t) => {
  const f = await fixture(t, { brokenStore: true });
  const out = await f.request('DELETE', `/notices/${E1}`);
  assert.equal(out.code, 200, 'the operator intent is honoured in-process');
  assert.deepStrictEqual(out.body, { dismissed: true, idempotent: false });
  assert.equal(f.dismissals.isDismissed(E1), true);
  assert.equal(f.dismissals.status().degraded, 'dismissals-write-failed', 'and the loss of durability is visible');
});
