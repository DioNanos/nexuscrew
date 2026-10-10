'use strict';
// tests/ask-dismiss-owner-cell.test.js — an imported ask whose tmux session has a
// non-canonical name (a cell with a custom `tmuxSession` on the owner) can be
// dismissed on this node.
//
// The defect: localDismissalEligibility() derived the cell from the SESSION NAME
// with the canonical codec (`cloud-*`), so for any other name the cell was null,
// the ask was "invisible" and the dismissal answered 404 although the node holds
// the grants and the owner publishes the ask. The owner is the only node that
// knows the cell, so the owner now publishes the cell it resolved and this node
// keeps THAT, validated at the authenticated ingress and bound to the owner and
// to the generation of the ask.
//
// Not derived by stripping a prefix, not taken from the local definitions (those
// describe THIS node), not accepted from the body of the dismissal.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createServer } = require('../lib/server.js');
const { createAsksStore } = require('../lib/notify/asks.js');
const { createEventFeedClient } = require('../lib/notify/event-feed-client.js');
const { createEventFeedRoutes } = require('../lib/notify/event-feed-routes.js');
const { resolveAskCell } = require('../lib/notify/ask-cell.js');
const nodes = require('../lib/nodes/store.js');
const { tmuxSessionForCell } = require('../lib/fleet/definitions.js');

const OWNER = 'b'.repeat(32);
const SELF = 'a'.repeat(32);
const ASK = '12345678';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- the cell source

test('the cell comes from what the owner resolved; the session name is only a fallback for canonical names', () => {
  assert.deepEqual(resolveAskCell({ session: 'lab-Dev', ownerCellId: 'Dev' }), { cellId: 'Dev', source: 'owner-feed' });
  assert.deepEqual(resolveAskCell({ session: 'desk-SysAdmin', originCell: 'SysAdmin' }), { cellId: 'SysAdmin', source: 'origin-attested' });
  assert.deepEqual(resolveAskCell({ session: tmuxSessionForCell('reviewer') }), { cellId: 'reviewer', source: 'canonical-session' });
  assert.deepEqual(resolveAskCell({ session: 'lab-Dev' }), { cellId: null, source: null }, 'a non-canonical name resolves to nothing');
  // The owner's statement wins over what the name would decode to (a custom
  // session can sit under a canonical-looking name that belongs to another cell).
  assert.equal(resolveAskCell({ session: 'cloud-Other', ownerCellId: 'Dev' }).cellId, 'Dev');
  // Two authenticated sources that disagree: nothing, never "the first".
  assert.deepEqual(resolveAskCell({ session: 'x', ownerCellId: 'A', originCell: 'B' }), { cellId: null, source: null, conflict: true });
  assert.equal(resolveAskCell({ session: 'x', ownerCellId: 'A', originCell: 'A' }).cellId, 'A');
  // Malformed values are not cells.
  for (const bad of ['', '../x', 'a b', 'x'.repeat(33), 42, null, {}, ['Dev']]) {
    assert.equal(resolveAskCell({ session: 'lab-Dev', ownerCellId: bad }).cellId, null, JSON.stringify(bad));
    assert.equal(resolveAskCell({ session: 'lab-Dev', originCell: bad }).cellId, null, JSON.stringify(bad));
  }
  // The prefix is never stripped from an arbitrary name.
  assert.equal(resolveAskCell({ session: 'lab-Dev' }).cellId, null);
  assert.equal(resolveAskCell({ session: 'lab-reviewer' }).cellId, null);
  assert.equal(resolveAskCell(null).cellId, null);
});

test('several candidates of the same generation: authenticated beats decoded, disagreement resolves to nothing, a source completes the other', () => {
  const { resolveAskCellFrom } = require('../lib/notify/ask-cell.js');
  const canonical = { session: tmuxSessionForCell('Alpha') };
  assert.equal(resolveAskCellFrom([canonical, { session: 'x', ownerCellId: 'Alpha' }]).cellId, 'Alpha');
  assert.equal(resolveAskCellFrom([{ session: 'x', originCell: 'Beta' }, { session: 'x' }]).cellId, 'Beta', 'one source knows what the other lacks');
  assert.equal(resolveAskCellFrom([{ session: 'x', originCell: 'Beta' }, { session: 'x', ownerCellId: 'Gamma' }]).cellId, null);
  assert.equal(resolveAskCellFrom([{ session: 'x', originCell: 'Beta' }, { session: 'x', ownerCellId: 'Gamma' }]).conflict, true);
  // An authenticated cell outranks a decode that says something else.
  assert.equal(resolveAskCellFrom([canonical, { session: 'x', originCell: 'Beta' }]).cellId, 'Beta');
  assert.equal(resolveAskCellFrom([{ session: 'x' }, { session: 'y' }]).cellId, null);
  assert.equal(resolveAskCellFrom([]).cellId, null);
});

// ---------------------------------------------------------------- owner snapshot

function ownerFixture(t, { cellVisibility = 'all', cells = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-owner-cell-'));
  const nodesPath = path.join(dir, 'nodes.json');
  nodes.initStore(nodesPath);
  let st = nodes.loadStoreStrict(nodesPath);
  st = nodes.addNode(st, { name: 'viewer', nodeId: SELF, direction: 'inbound', transport: 'inbound', shared: true, visibility: 'network',
    token: 'o-to-v', acceptToken: 'v-to-o', ssh: undefined, localPort: 44001, remotePort: 42001 });
  st = nodes.setPeerAccessGrants(st, 'viewer', { cellVisibility, ...(cellVisibility === 'selected' ? { cells } : {}),
    eventsAccess: true, nodeEventsAccess: false, askReplyAccess: false, filesReadAccess: false, liveHostAccess: false, panelAccess: false, peerOperatorAccess: false });
  nodes.atomicWriteStore(nodesPath, st);
  const open = [
    { id: 'aaaaaaa1', question: 'custom name?', session: 'lab-Dev', ts: 100 },
    { id: 'aaaaaaa2', question: 'canonical?', session: tmuxSessionForCell('Research'), ts: 101 },
    { id: 'aaaaaaa3', question: 'unresolved?', session: 'no-such-session', ts: 102 },
  ];
  // The owner's own resolution: a cell with a custom tmux session, plus the canonical codec.
  const customCells = { 'lab-Dev': 'Dev' };
  const cellForSession = (session) => customCells[session] || require('../lib/fleet/definitions.js').cellIdFromTmuxSession(session);
  const router = createEventFeedRoutes({
    nodesPath, log: () => {}, eventsEnabled: () => true, localNodeId: () => OWNER,
    originResolver: { resolve: async () => ({ ok: true, trust: 'federated', visited: [SELF, OWNER] }) },
    eventFeed: { status: () => ({ viewEpoch: 1, seq: 0 }), enablePeer() {} },
    history: { list: () => [], status: () => ({}) },
    asksStore: { health: () => ({ readable: true }), list: () => open.map((a) => ({ ...a })) },
    fleetP: Promise.resolve(null),
    cellForSession,
  });
  const app = express(); app.use('/event-feed', router);
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      t.after(() => { server.closeAllConnections?.(); server.close(); fs.rmSync(dir, { recursive: true, force: true }); });
      resolve({ snapshot: async () => (await fetch(`http://127.0.0.1:${server.address().port}/event-feed/snapshot`)).json() });
    });
  });
}

test('owner snapshot: each visible ask carries the cell the OWNER resolved, and only well-formed ids', async (t) => {
  const { snapshot } = await ownerFixture(t, { cellVisibility: 'all' });
  const snap = await snapshot();
  const byId = Object.fromEntries(snap.asks.map((a) => [a.id, a]));
  assert.equal(byId.aaaaaaa1.cellId, 'Dev', 'custom tmux name resolved through the owner\'s own definitions');
  assert.equal(byId.aaaaaaa2.cellId, 'Research');
  assert.equal(byId.aaaaaaa3, undefined, 'an ask the owner cannot place in a cell was never published (unchanged rule)');
  assert.ok(snap.asks.every((a) => Object.keys(a).every((k) => ['id', 'question', 'options', 'session', 'ts', 'cellId'].includes(k))), 'no other field leaks');
});

test('owner snapshot: the cell scope still decides which asks leave, and cellId follows it', async (t) => {
  const some = await (await ownerFixture(t, { cellVisibility: 'selected', cells: ['Dev'] })).snapshot();
  assert.deepEqual(some.asks.map((a) => [a.id, a.cellId]), [['aaaaaaa1', 'Dev']]);
  const none = await (await ownerFixture(t, { cellVisibility: 'none' })).snapshot();
  assert.deepEqual(none.asks, []);
});

// ---------------------------------------------------------------- the importing client

function stubClient({ asks = () => [], epoch = () => 1 } = {}) {
  const store = { nodeId: SELF, nodes: [{ name: 'owner', nodeId: OWNER, token: 'TOK', direction: 'outbound', eventsReceive: true, localPort: 46001 }] };
  const fetchImpl = async (url, opts = {}) => {
    if (url.includes('/federation/health')) return { ok: true, status: 200, json: async () => ({ ok: true, instanceId: OWNER, eventFeedV1: true }) };
    if (url.includes('/event-feed/snapshot')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ ownerId: OWNER, cursor: '1:0', viewEpoch: epoch(), asks: asks(), notifications: [] }) };
    }
    if (url.includes('/event-feed')) {
      return { ok: true, status: 200, json: async () => ({}), text: async () => '',
        body: { getReader: () => ({ read: () => new Promise((_res, rej) => {
          if (opts.signal.aborted) rej(new Error('stopped')); else opts.signal.addEventListener('abort', () => rej(new Error('stopped')), { once: true });
        }), cancel: async () => {} }) } };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
  };
  const client = createEventFeedClient({ loadStore: () => store, fetchImpl, pollMs: 50, now: () => 1000, minSnapshotIntervalMs: 0, eventsHub: { broadcast() {} }, log: () => {} });
  return { client };
}
async function round(client) {
  client.start(); await new Promise((r) => setImmediate(r)); client.stop();
  return (client.state().views[0] || {}).asks || [];
}
async function resnapshot(client) { client.viewFor(OWNER).cursor = null; return round(client); }
const wire = (over = {}) => ({ id: ASK, question: 'q?', session: 'lab-Dev', ts: 100, ...over });

test('client: the owner\'s cellId is validated, kept as ownerCellId and never exposed under its wire name', async (t) => {
  const { client } = stubClient({ asks: () => [wire({ cellId: 'Dev' })] });
  t.after(() => client.stop());
  const [ask] = await round(client);
  assert.equal(ask.ownerCellId, 'Dev');
  assert.equal(ask.cellId, undefined);
  assert.equal(resolveAskCell(ask).cellId, 'Dev');
});

test('client: names that are ours cannot be smuggled in by the wire (ownerCellId, originCell)', async (t) => {
  const { client } = stubClient({ asks: () => [wire({ ownerCellId: 'Forged', originCell: 'Forged2' })] });
  t.after(() => client.stop());
  const [ask] = await round(client);
  assert.equal(ask.ownerCellId, undefined);
  assert.equal(ask.originCell, undefined);
  assert.equal(resolveAskCell(ask).cellId, null, 'a forged field resolves to nothing');
});

test('client: a malformed cellId makes the snapshot invalid; nothing of it enters the view', async (t) => {
  for (const bad of ['../x', '', 7, {}, 'x'.repeat(33)]) {
    const { client } = stubClient({ asks: () => [wire({ cellId: bad })] });
    t.after(() => client.stop());
    assert.deepEqual(await round(client), [], `cellId ${JSON.stringify(bad)}`);
  }
});

test('client: a snapshot without a cell (older owner) keeps the cell the view held for the SAME generation, never for a new one', async (t) => {
  let phase = 0;
  const { client } = stubClient({ asks: () => [phase === 0 ? wire({ cellId: 'Dev' })
    : phase === 1 ? wire() // same ts, same content, no cell
      : phase === 2 ? wire({ ts: 200 }) // new generation, no cell
        : wire({ question: 'changed?' })] });
  t.after(() => client.stop());
  assert.equal((await round(client))[0].ownerCellId, 'Dev');
  phase = 1; assert.equal((await resnapshot(client))[0].ownerCellId, 'Dev', 'same generation: kept');
  phase = 2; assert.equal((await resnapshot(client))[0].ownerCellId, undefined, 'a new generation inherits nothing');
  phase = 3; assert.equal((await resnapshot(client))[0].ownerCellId, undefined, 'different content inherits nothing');
});

test('client: a client restarted from scratch rebuilds the cell from the owner snapshot', async (t) => {
  const { client } = stubClient({ asks: () => [wire({ cellId: 'Dev' })] });
  t.after(() => client.stop());
  assert.equal((await round(client))[0].ownerCellId, 'Dev');
  const { client: restarted } = stubClient({ asks: () => [wire({ cellId: 'Dev' })] });
  t.after(() => restarted.stop());
  assert.equal((await round(restarted))[0].ownerCellId, 'Dev', 'no state is needed to recover it');
});

test('client: a live ask frame takes the cell from the authenticated cell-scoped envelope only', async (t) => {
  const { client } = stubClient();
  t.after(() => client.stop());
  const frame = (over) => ({ ownerId: OWNER, eventId: `e-${Math.random()}`, hop: 1, frame: { type: 'ask', askId: ASK, question: 'live?', session: 'lab-Dev', ts: 5, askTs: 5 }, ...over });
  assert.equal(client.reemit(frame({ scope: 'cell', cellId: 'Dev' })) !== false, true);
  assert.equal(client.viewFor(OWNER).asks[0].ownerCellId, 'Dev');
  const { client: other } = stubClient(); t.after(() => other.stop());
  other.reemit(frame({ scope: 'node', cellId: 'Dev' }));
  assert.equal(other.viewFor(OWNER).asks[0].ownerCellId, undefined, 'a node-scoped envelope names no cell');
  const { client: bad } = stubClient(); t.after(() => bad.stop());
  bad.reemit(frame({ scope: 'cell', cellId: '../x' }));
  assert.equal(bad.viewFor(OWNER).asks[0].ownerCellId, undefined, 'a malformed cell id in the envelope is ignored');
  // A body field named ownerCellId on the frame is not read.
  const { client: forged } = stubClient(); t.after(() => forged.stop());
  forged.reemit(frame({ scope: 'cell', cellId: 'Dev', frame: { type: 'ask', askId: ASK, question: 'live?', session: 'lab-Dev', ts: 5, askTs: 5, ownerCellId: 'Forged', cellId: 'Forged' } }));
  assert.equal(forged.viewFor(OWNER).asks[0].ownerCellId, 'Dev');
});

// ---------------------------------------------------------------- the dismissal, end to end

async function boot(t, { grants, session = 'lab-Dev', snapshotCell = 'Dev', alias = null, ownerUp = true, ts = 100, feedTs = ts, loseReplies = false, previousDismissal = null, feedQuestion = null } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ask-dismiss-cell-'));
  const configDir = path.join(home, '.nexuscrew'); fs.mkdirSync(configDir);
  const nodesPath = path.join(configDir, 'nodes.json'); nodes.initStore(nodesPath);
  const asksDir = configDir;
  if (alias) createAsksStore({ dir: asksDir }).create({ question: 'Review?', session: alias.session || session, ownerId: OWNER, ownerAskId: ASK, originNode: OWNER, ...(alias.noTs ? {} : { ownerAskTs: alias.ts === undefined ? ts : alias.ts }), ...(alias.originCell ? { originCell: alias.originCell } : {}) });
  if (previousDismissal) {
    // An earlier generation of the same id, already dismissed on this node (persisted).
    const old = { id: ASK, ownerAskId: ASK, question: previousDismissal.question, session: previousDismissal.session, ownerAskTs: previousDismissal.ts, originNode: OWNER };
    const stored = createAsksStore({ dir: asksDir }).dismissImported({ ownerId: OWNER, ownerAskId: ASK, ask: old, cellId: previousDismissal.cellId });
    assert.equal(stored.ok, true, JSON.stringify(stored));
  }
  const source = { id: ASK, ...(feedTs === 'absent' ? {} : { ts: feedTs }), question: feedQuestion || (alias ? 'Review?' : 'Feed only?'), session, ...(snapshotCell ? { cellId: snapshotCell } : {}) };
  const owner = http.createServer((req, res) => {
    const json = (b) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(b)); };
    // A reply that is lost after the request went out: the relay cannot know whether the answer landed.
    if (loseReplies && req.method === 'POST') { req.resume(); req.on('end', () => req.socket.destroy()); return; }
    if (req.url.includes('/capability')) return json({ ownerId: OWNER, askId: ASK, canReply: true, status: 'open' });
    if (req.url.includes('/health')) return json({ ok: true, instanceId: OWNER, eventFeedV1: true });
    if (req.url.includes('/event-feed/snapshot')) return json({ ownerId: OWNER, cursor: '1:0', viewEpoch: 1, asks: alias && !snapshotCell && !ownerUp ? [] : [source], notifications: [] });
    if (req.url.includes('/event-feed')) { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write(': ready\n\n'); return; }
    json({ nodes: [] });
  });
  await new Promise((r) => owner.listen(0, '127.0.0.1', r));
  t.after(() => { owner.closeAllConnections(); owner.close(); });
  let st = nodes.addNode(nodes.loadStoreStrict(nodesPath), { name: 'owner', nodeId: OWNER, direction: 'outbound', eventsReceive: true, token: 'fixture', shared: true, visibility: 'network',
    ssh: 'demo@example.invalid', localPort: owner.address().port, remotePort: 42002 });
  st = nodes.setPeerAccessGrants(st, 'owner', { cellVisibility: 'all', eventsAccess: true, nodeEventsAccess: false, askReplyAccess: true, filesReadAccess: false, liveHostAccess: false, panelAccess: false, peerOperatorAccess: false, ...(grants || {}) });
  nodes.atomicWriteStore(nodesPath, st);
  const runtime = createServer({ home, configDir, nodesPath, configPath: path.join(configDir, 'config.json'), tokenPath: path.join(configDir, 'token'),
    eventFeedClientPollMs: 20, filesRoot: path.join(home, 'files'), port: 0, fleetEnabled: false, sessionExistsSeam: () => true, pasteSeam: () => true,
    askSubmit: async () => ({ outcome: 'submitted', submitted: true }),
    settingsSeams: { platform: 'linux', uid: 1000, execImpl: () => { throw new Error('disabled'); }, serviceInstallPath: path.join(home, 'service'),
      keygen: () => 'ssh-ed25519 AAAAFIXTURE demo', spawnImpl: () => ({ pid: 4100000, unref() {} }), sshVersion: () => ({ major: 9, minor: 6 }) } });
  await new Promise((r) => runtime.server.listen(0, '127.0.0.1', r));
  t.after(async () => { runtime.server.closeAllConnections(); await new Promise((r) => runtime.server.close(r)); runtime.watcher.close(); fs.rmSync(home, { recursive: true, force: true }); });
  const port = runtime.server.address().port;
  const headers = { authorization: `Bearer ${runtime.token}`, 'content-type': 'application/json' };
  const api = {
    port, configDir, owner, source,
    view: () => fetch(`http://127.0.0.1:${port}/api/feed-state`, { headers }).then((r) => r.json()),
    capability: () => fetch(`http://127.0.0.1:${port}/api/asks-relay/capability?ownerId=${OWNER}&askId=${ASK}&dismissals=1`, { headers }).then((r) => r.json()),
    answer: async (text = 'yes') => { const r = await fetch(`http://127.0.0.1:${port}/api/asks-relay`, { method: 'POST', headers, body: JSON.stringify({ action: 'answer', ownerId: OWNER, askId: ASK, text, requestId: '11111111-1111-4111-8111-111111111111' }) }); return { code: r.status, body: await r.json().catch(() => ({})) }; },
    relayState: () => fetch(`http://127.0.0.1:${port}/api/asks-relay/state`, { headers }).then((r) => r.json()),
    dismiss: async (extra = {}) => { const r = await fetch(`http://127.0.0.1:${port}/api/asks-relay`, { method: 'POST', headers, body: JSON.stringify({ action: 'dismiss-local', ownerId: OWNER, askId: ASK, ...extra }) }); return { code: r.status, body: await r.json() }; },
    waitForCard: async () => { for (let i = 0; i < 200; i++) { const v = await api.view(); if (v.views.some((x) => x.asks.some((a) => (a.ownerAskId || a.id) === ASK))) return true; await sleep(10); } return false; },
  };
  return api;
}

for (const [label, grants, expected] of [
  ['all cells', {}, 200],
  ['selected, including the cell', { cellVisibility: 'selected', cells: ['Dev'] }, 200],
  ['selected, not including the cell', { cellVisibility: 'selected', cells: ['Other'] }, 404],
  ['none', { cellVisibility: 'none' }, 404],
  ['feed grant revoked', { eventsAccess: false }, 404],
]) {
  test(`dismiss-local of an ask from a custom tmux session (lab-Dev), cell scope ${label}, owner online → ${expected}`, async (t) => {
    const rt = await boot(t, { grants });
    assert.equal(await rt.waitForCard(), true, 'the owner feed established the card');
    const cap = await rt.capability();
    assert.equal(cap.canDismissLocal, expected === 200, JSON.stringify(cap));
    const out = await rt.dismiss();
    assert.equal(out.code, expected, JSON.stringify(out));
    if (expected === 200) assert.deepEqual(out.body, { dismissed: true, scope: 'local', ownerSync: out.body.ownerSync });
    const records = createAsksStore({ dir: rt.configDir }).listImportedDismissals();
    assert.equal(records.length, expected === 200 ? 1 : 0, 'nothing persisted on a refusal');
    if (expected === 200) assert.equal(records[0].cellId, 'Dev', 'the record keeps the owner-resolved cell');
  });
}

test('dismiss-local works with the owner OFFLINE (same grants, quiet ask) and survives asking twice', async (t) => {
  const rt = await boot(t);
  assert.equal(await rt.waitForCard(), true);
  rt.owner.closeAllConnections(); await new Promise((r) => rt.owner.close(r));
  const first = await rt.dismiss(); assert.equal(first.code, 200, JSON.stringify(first));
  const second = await rt.dismiss(); assert.equal(second.code, 200);
  assert.equal(createAsksStore({ dir: rt.configDir }).listImportedDismissals().length, 1);
  const after = await rt.view(); assert.ok(after.views.every((v) => v.asks.every((a) => (a.ownerAskId || a.id) !== ASK)), 'the card left the view');
});

test('desk-style name and a canonical name both work; a canonical name still works without any owner cell', async (t) => {
  const a = await boot(t, { session: 'desk-SysAdmin', snapshotCell: 'SysAdmin' });
  assert.equal(await a.waitForCard(), true); assert.equal((await a.dismiss()).code, 200);
  const b = await boot(t, { session: tmuxSessionForCell('reviewer'), snapshotCell: null });
  assert.equal(await b.waitForCard(), true);
  assert.equal((await b.capability()).canDismissLocal, true, 'fallback to the canonical codec for an older owner');
  assert.equal((await b.dismiss()).code, 200);
});

test('an older owner that publishes no cell for a non-canonical session: refused, and it says why', async (t) => {
  const rt = await boot(t, { snapshotCell: null });
  assert.equal(await rt.waitForCard(), true);
  assert.equal((await rt.capability()).canDismissLocal, false);
  const out = await rt.dismiss();
  assert.equal(out.code, 409);
  assert.equal(out.body.reason, 'cell-unresolved');
  assert.equal(createAsksStore({ dir: rt.configDir }).listImportedDismissals().length, 0);
});

test('the dismissal request carries no cell: a cellId (or anything else) in the body is refused', async (t) => {
  const rt = await boot(t, { grants: { cellVisibility: 'selected', cells: ['Other'] } });
  assert.equal(await rt.waitForCard(), true);
  for (const extra of [{ cellId: 'Other' }, { cell: 'Other' }, { ownerCellId: 'Other' }, { session: 'cloud-Other' }]) {
    const out = await rt.dismiss(extra);
    assert.equal(out.code, 400, JSON.stringify(extra));
  }
  assert.equal(createAsksStore({ dir: rt.configDir }).listImportedDismissals().length, 0);
});

test('cards persisted before this release: an alias with the attested originCell is dismissible; without any cell it is declared unresolved', async (t) => {
  const withOrigin = await boot(t, { alias: { originCell: 'Dev' }, snapshotCell: null, ownerUp: false });
  assert.equal((await withOrigin.capability()).canDismissLocal, true, 'originCell was attested by the origin resolver when the alias was created');
  const out = await withOrigin.dismiss(); assert.equal(out.code, 200, JSON.stringify(out));
  assert.equal(createAsksStore({ dir: withOrigin.configDir }).getImportedDismissal(OWNER, ASK).cellId, 'Dev');

  const bare = await boot(t, { alias: {}, snapshotCell: null, ownerUp: false });
  assert.equal((await bare.capability()).canDismissLocal, false);
  const refused = await bare.dismiss();
  assert.equal(refused.code, 409); assert.equal(refused.body.reason, 'cell-unresolved');
});

test('two authenticated sources that disagree about the cell resolve to nothing', async (t) => {
  const rt = await boot(t, { alias: { originCell: 'Dev' }, snapshotCell: 'Elsewhere' });
  assert.equal(await rt.waitForCard(), true);
  const out = await rt.dismiss();
  assert.equal(out.code, 409, JSON.stringify(out)); assert.equal(out.body.reason, 'cell-unresolved');
});

test('the grants are read on every call: revoking eventsAccess after the card appeared blocks the dismissal', async (t) => {
  const rt = await boot(t);
  assert.equal(await rt.waitForCard(), true);
  assert.equal((await rt.capability()).canDismissLocal, true);
  const nodesPath = path.join(rt.configDir, 'nodes.json');
  nodes.atomicWriteStore(nodesPath, nodes.setPeerAccessGrants(nodes.loadStoreStrict(nodesPath), 'owner',
    { cellVisibility: 'all', eventsAccess: false, nodeEventsAccess: false, askReplyAccess: false, filesReadAccess: false, liveHostAccess: false, panelAccess: false, peerOperatorAccess: false }));
  assert.equal((await rt.capability()).canDismissLocal, false);
  assert.equal((await rt.dismiss()).code, 404);
});

test('an answer in flight or of uncertain delivery still blocks the local dismissal (the fix does not open that door)', async (t) => {
  const rt = await boot(t, { loseReplies: true });
  assert.equal(await rt.waitForCard(), true);
  assert.equal((await rt.capability()).canDismissLocal, true, 'quiet ask: dismissible');
  const answered = await rt.answer();
  const attempts = (await rt.relayState()).attempts.filter((a) => a.ownerId === OWNER && a.askId === ASK);
  assert.ok(attempts.some((a) => ['sent', 'uncertain'].includes(a.state)), `an attempt of unknown outcome exists: ${JSON.stringify({ answered, attempts })}`);
  assert.equal((await rt.capability()).canDismissLocal, false);
  const out = await rt.dismiss();
  assert.equal(out.code, 409, JSON.stringify(out));
  assert.equal(out.body.reason, 'delivery-unknown-block');
  assert.equal(createAsksStore({ dir: rt.configDir }).listImportedDismissals().length, 0);
});


test('a NEW generation of an id dismissed before brings its own cell and is dismissible by it', async (t) => {
  const rt = await boot(t, { grants: { cellVisibility: 'selected', cells: ['Dev', 'Dev2'] }, ts: 200, session: 'lab-Dev2', snapshotCell: 'Dev2',
    previousDismissal: { question: 'Feed only?', session: 'lab-Dev', ts: 100, cellId: 'Dev' } });
  const store = () => createAsksStore({ dir: rt.configDir });
  assert.equal(store().getImportedDismissal(OWNER, ASK).cellId, 'Dev');
  assert.equal(await rt.waitForCard(), true, 'the new generation is not hidden by the old dismissal');
  assert.equal((await rt.capability()).canDismissLocal, true);
  assert.equal((await rt.dismiss()).code, 200);
  const record = store().getImportedDismissal(OWNER, ASK);
  assert.equal(record.cellId, 'Dev2', 'the record follows the new generation and ITS cell');
  assert.equal(record.ownerAskTs, 200);
});

test('a dismissal persisted before a restart keeps working with the cell it was taken with, without the card', async (t) => {
  // The card is gone from the owner's snapshot (the owner closed it) and the node restarted:
  // only the durable record is left, and it carries the owner-resolved cell.
  const rt = await boot(t, { snapshotCell: 'Dev', previousDismissal: { question: 'Feed only?', session: 'lab-Dev', ts: 100, cellId: 'Dev' } });
  const out = await rt.dismiss();
  assert.equal(out.code, 200, JSON.stringify(out));
  assert.equal(createAsksStore({ dir: rt.configDir }).listImportedDismissals().length, 1);
});

// ---------------------------------------------------------------- G1: a cell is lent only between sources of the SAME, KNOWN generation

async function g1(t, { alias, feedTs, snapshotCell, feedQuestion, grants = { cellVisibility: 'selected', cells: ['Dev'] }, session = 'lab-Other' }) {
  const rt = await boot(t, { grants, alias: { session: 'lab-Other', ...alias }, feedTs, snapshotCell, session, feedQuestion });
  assert.equal(await rt.waitForCard(), true);
  return rt;
}
const persisted = (rt) => createAsksStore({ dir: rt.configDir }).listImportedDismissals();

test('G1: a legacy alias (cell Dev, no owner timestamp) does not lend its cell to a feed card of a KNOWN generation without one', async (t) => {
  const rt = await g1(t, { alias: { originCell: 'Dev', noTs: true }, feedTs: 200, snapshotCell: null });
  assert.equal((await rt.capability()).canDismissLocal, false);
  const out = await rt.dismiss();
  assert.equal(out.code, 409, JSON.stringify(out));
  assert.equal(out.body.reason, 'cell-unresolved');
  assert.equal(persisted(rt).length, 0, 'nothing was recorded');
});

test('G1: a card of an OLDER known generation lends nothing to the selected newer one, and a newer one takes nothing from an older alias', async (t) => {
  // Alias 100 (cell Dev), feed 200 without a cell: the feed card is selected, its generation has no cell of its own.
  const a = await g1(t, { alias: { originCell: 'Dev', ts: 100 }, feedTs: 200, snapshotCell: null });
  const outA = await a.dismiss();
  assert.equal(outA.code, 409, JSON.stringify(outA));
  assert.equal(outA.body.reason, 'cell-unresolved');
  assert.equal(persisted(a).length, 0);
  // Alias 200 (cell Dev), feed 100 with ANOTHER cell: the alias is the selected generation and keeps its own cell;
  // the older card neither lends its cell nor makes a conflict.
  const b = await g1(t, { alias: { originCell: 'Dev', ts: 200 }, feedTs: 100, snapshotCell: 'Other', grants: { cellVisibility: 'selected', cells: ['Dev', 'Other'] } });
  const outB = await b.dismiss();
  assert.equal(outB.code, 200, JSON.stringify(outB));
  assert.equal(persisted(b)[0].cellId, 'Dev');
  assert.equal(persisted(b)[0].ownerAskTs, 200);
});

test('G1: equal known timestamps and the same content still complete each other (the alias cell serves the feed card)', async (t) => {
  const rt = await g1(t, { alias: { originCell: 'Dev', ts: 200 }, feedTs: 200, snapshotCell: null });
  assert.equal((await rt.capability()).canDismissLocal, true);
  const out = await rt.dismiss();
  assert.equal(out.code, 200, JSON.stringify(out));
  assert.equal(persisted(rt)[0].cellId, 'Dev');
  assert.equal(persisted(rt)[0].ownerAskTs, 200);
});

test('G1: the selected ask keeps its OWN cell: a feed card with its cell is dismissible whatever the alias lacks', async (t) => {
  const rt = await g1(t, { alias: { noTs: true }, feedTs: 200, snapshotCell: 'Dev' });
  const out = await rt.dismiss();
  assert.equal(out.code, 200, JSON.stringify(out));
  assert.equal(persisted(rt)[0].cellId, 'Dev');
  assert.equal(persisted(rt)[0].ownerAskTs, 200);
});

test('G1: a legacy alias with an attested cell and no feed card at all (owner gone) is its own source and stays dismissible', async (t) => {
  const rt = await boot(t, { grants: { cellVisibility: 'selected', cells: ['Dev'] }, snapshotCell: null, ownerUp: false,
    alias: { session: 'lab-Other', originCell: 'Dev', noTs: true } });
  assert.equal((await rt.capability()).canDismissLocal, true);
  assert.equal((await rt.dismiss()).code, 200);
});

test('G1: a cell bound to another generation also cannot widen the scope: the legacy cell Dev is outside selected=[Other]', async (t) => {
  const rt = await g1(t, { alias: { originCell: 'Dev', ts: 200 }, feedTs: 200, snapshotCell: null, grants: { cellVisibility: 'selected', cells: ['Other'] } });
  assert.equal((await rt.dismiss()).code, 404);
});

test('G1: an owner that sends no timestamp (feed side unknown) lends nothing to an alias, and the alias lends nothing to it', async (t) => {
  // Alias with a known generation and no cell of its own, feed card WITH a cell but no timestamp:
  // the feed card is not bound to the alias generation, so its cell is not lent to it.
  const a = await g1(t, { alias: { ts: 200 }, feedTs: 'absent', snapshotCell: 'Dev' });
  const outA = await a.dismiss();
  assert.equal(outA.code, 409, JSON.stringify(outA));
  assert.equal(outA.body.reason, 'cell-unresolved');
  assert.equal(persisted(a).length, 0);
  // Both generations unknown: still no cell crosses over (the alias keeps only what it carries itself).
  const b = await g1(t, { alias: { noTs: true }, feedTs: 'absent', snapshotCell: 'Dev' });
  const outB = await b.dismiss();
  assert.equal(outB.code, 409, JSON.stringify(outB));
  assert.equal(persisted(b).length, 0);
  // ... and what the alias carries itself is enough.
  const c = await g1(t, { alias: { noTs: true, originCell: 'Dev' }, feedTs: 'absent', snapshotCell: null });
  assert.equal((await c.dismiss()).code, 200);
});

test('G1: a card with the same timestamp but DIFFERENT content is another ask: it lends no cell', async (t) => {
  const rt = await g1(t, { alias: { ts: 200 }, feedTs: 200, snapshotCell: 'Dev', feedQuestion: 'A different question?' });
  const out = await rt.dismiss();
  assert.equal(out.code, 409, JSON.stringify(out));
  assert.equal(out.body.reason, 'cell-unresolved', 'the cell of the other card is not borrowed, so the reason is the unresolved cell, not an ambiguity');
  assert.equal(persisted(rt).length, 0);
});
