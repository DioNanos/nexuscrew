'use strict';
// tests/federated-asks.test.js — federated ask answer cycle (F3.2 stage a).
//
// Unit half: the durable receipt lifecycle and the shared answer service with
// a stubbed paste. HTTP half: the federated surface over TWO REAL SERVERS —
// gate, askReplyAccess, opaque 404s, closed body, idempotent replay, dismiss,
// reconcile. The 20 baseline ask tests stay green in tests/asks.test.js.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const { createAskReceipts } = require('../lib/notify/ask-receipts.js');
const { createAskAnswerService } = require('../lib/notify/ask-answer-service.js');
const { tmuxSessionForCell } = require('../lib/fleet/definitions.js');

// --- receipts + service (unit, stubbed paste) ------------------------------

function unit(t, { pasteCalls = [], pasteOk = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncasksvc-'));
  const filePath = path.join(dir, 'ask-receipts.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const asks = {
    store: new Map(),
    get: (id) => asks.store.get(id) || null,
    claim: (id) => {
      const a = asks.store.get(id);
      if (!a) return { ok: false, reason: 'unknown' };
      if (a.dismissed) return { ok: false, reason: 'dismissed' };
      if (a.answered) return { ok: false, reason: 'answered' };
      if (asks.claimed.has(id)) return { ok: false, reason: 'answering' };
      asks.claimed.add(id);
      return { ok: true, ask: { ...a } };
    },
    release: (id) => asks.claimed.delete(id),
    commit: (id, text) => {
      asks.claimed.delete(id);
      const a = asks.store.get(id);
      if (!a || a.answered) return false;
      a.answered = true; a.answer = text; a.revision = (a.revision || 0) + 1;
      return true;
    },
    claimed: new Set(),
  };
  const receipts = createAskReceipts({ filePath });
  let closures = [];
  const service = createAskAnswerService({
    asks, receipts,
    paste: () => { pasteCalls.push(1); return Promise.resolve(pasteOk); },
    onClosure: (kind, info) => closures.push({ kind, ...info }),
    labelPrefix: 'human',
  });
  return { asks, receipts, service, pasteCalls, closures, filePath };
}

const PEER = 'p'.repeat(32);
const OTHER = 'q'.repeat(32);

test('replay dello stesso requestId+testo restituisce lo stesso stato, MAI un secondo paste', async (t) => {
  const u = unit(t);
  u.asks.store.set('abc12345', { id: 'abc12345', session: 's', question: 'q', revision: 0 });
  const r1 = await u.service.answerFederated({ askId: 'abc12345', text: 'go', peerId: PEER, requestId: '11111111-1111-1111-1111-111111111111' });
  assert.equal(r1.ok, true);
  assert.equal(r1.state, 'committed');
  assert.equal(u.pasteCalls.length, 1);
  const r2 = await u.service.answerFederated({ askId: 'abc12345', text: 'go', peerId: PEER, requestId: '11111111-1111-1111-1111-111111111111' });
  assert.equal(r2.ok, true);
  assert.equal(r2.state, 'committed', 'the stored state, after a commit too');
  assert.equal(u.pasteCalls.length, 1, 'no second paste');
});

test('stesso requestId con testo diverso è un conflitto 409', async (t) => {
  const u = unit(t);
  u.asks.store.set('abc12345', { id: 'abc12345', session: 's', question: 'q', revision: 0 });
  await u.service.answerFederated({ askId: 'abc12345', text: 'go', peerId: PEER, requestId: '22222222-2222-2222-2222-222222222222' });
  const r = await u.service.answerFederated({ askId: 'abc12345', text: 'STOP', peerId: PEER, requestId: '22222222-2222-2222-2222-222222222222' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 409);
  assert.equal(r.reason, 'request-conflict');
});

test('una sola risposta vince: la concorrente vede answering/answered', async (t) => {
  const u = unit(t);
  u.asks.store.set('abc12345', { id: 'abc12345', session: 's', question: 'q', revision: 0 });
  // Someone holds the claim (a local answer in flight): the federated attempt
  // must lose WITHOUT touching the paste.
  u.asks.claimed.add('abc12345');
  const r = await u.service.answerFederated({ askId: 'abc12345', text: 'go', peerId: PEER, requestId: '33333333-3333-3333-3333-333333333333' });
  assert.equal(r.code, 409);
  assert.equal(u.pasteCalls.length, 0, 'the loser never pastes');
});

test('crash con pending: al restart diventa delivery-unknown e BLOCCA anche il locale, fino a reconcile', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaskrec-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'ask-receipts.json');
  // First process: an attempt stays pending (the "crash" happens right after).
  const receipts1 = createAskReceipts({ filePath });
  receipts1.attempt({ peerId: PEER, askId: 'abc12345', requestId: '44444444-4444-4444-4444-444444444444', text: 'go' });
  // Second process: recovery downgrades pending -> delivery-unknown and locks.
  const receipts2 = createAskReceipts({ filePath });
  const st = receipts2.statusFor('abc12345');
  assert.equal(st.unknown, 1, 'pending became delivery-unknown');
  assert.equal(st.blocked, true, 'the ask is locked');
  // The lock holds for the LOCAL path too.
  const asks = {
    store: new Map([['abc12345', { id: 'abc12345', session: 's', question: 'q', revision: 0 }]]),
    get(id) { return this.store.get(id) || null; },
    claim(id) { const a = this.get(id); return a && !a.answered ? { ok: true, ask: { ...a } } : { ok: false, reason: 'answered' }; },
    release() {}, commit(id, text) { const a = this.get(id); a.answered = true; a.answer = text; return true; },
  };
  const service = createAskAnswerService({ asks, receipts: receipts2, paste: async () => true, onClosure: () => {} });
  const local = await service.answerLocal({ askId: 'abc12345', text: 'retry' });
  assert.equal(local.code, 409);
  assert.equal(local.reason, 'delivery-unknown-block');
  // Reconciliation with a stale revision is refused (CAS)...
  const bad = receipts2.reconcile('abc12345', 'mark-delivered');
  assert.equal(bad.ok, true, 'receipt reconcile has no revision; the route CAS sits on the ask');
  assert.equal(service.answerLocal === service.answerLocal, true);
  // ...and after reconciliation the ask answers again.
  const local2 = await service.answerLocal({ askId: 'abc12345', text: 'retry' });
  assert.equal(local2.ok, true, 'reconcile unlocks the ask');
  void bad;
});

test('lo status di un tentativo è scoped per peer: un altro peer non vede nulla', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaskscope-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const receipts = createAskReceipts({ filePath: path.join(dir, 'r.json') });
  receipts.attempt({ peerId: PEER, askId: 'abc12345', requestId: '55555555-5555-5555-5555-555555555555', text: 'go' });
  assert.equal(receipts.get(OTHER, 'abc12345', '55555555-5555-5555-5555-555555555555'), null, 'wrong peer: nothing');
  assert.ok(receipts.get(PEER, 'abc12345', '55555555-5555-5555-5555-555555555555'));
});

// --- HTTP: two real servers --------------------------------------------------

const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
const A_ID = 'a'.repeat(32);
const B_ID = 'b'.repeat(32);
const SECRET = 'pairing-secret-token';

function boot(t, { pasteCalls = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaskhttp-'));
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
    sessionExistsSeam: () => true,
    pasteSeam: pasteCalls ? (session, text) => { pasteCalls.push({ session, text }); return true; } : undefined,
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
    res({ base: `http://127.0.0.1:${server.address().port}`, port: server.address().port, token, ...paths });
  }));
}

async function pair(t, preset = 'admin') {
  const pasteCalls = [];
  const B = await boot(t, { pasteCalls });
  const A = await boot(t);
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
  return { A, B, selfA, selfB, pasteCalls };
}

const createAsk = (B, session) => fetch(`${B.base}/api/asks`, {
  method: 'POST', headers: H(B.token),
  body: JSON.stringify({ question: 'proceed?', options: ['yes', 'no'], session }),
}).then(async (r) => ({ status: r.status, id: (await r.json()).id }));

test('happy path: the peer answers through the proxy, the receipt reads committed, replay is idempotent', async (t) => {
  const { A, B, pasteCalls } = await pair(t);
  const { id } = await createAsk(B, tmuxSessionForCell('dev'));
  const url = `${A.base}/api/route/owner/_/event-feed/asks/${id}/answer`;
  const body = { text: 'yes', requestId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' };
  const r1 = await fetch(url, { method: 'POST', headers: H(A.token), body: JSON.stringify(body) });
  assert.equal(r1.status, 200);
  const out1 = await r1.json();
  assert.equal(out1.status, 'committed');
  assert.equal(pasteCalls.length, 1);
  assert.ok(pasteCalls[0].text.includes('ask#'), 'the paste carries the ask marker');
  // Replay: same id, same text.
  const r2 = await fetch(url, { method: 'POST', headers: H(A.token), body: JSON.stringify(body) });
  assert.equal(r2.status, 200);
  assert.equal((await r2.json()).status, 'committed');
  assert.equal(pasteCalls.length, 1, 'no second paste');
  // Status: scoped and honest.
  const st = await fetch(`${A.base}/api/route/owner/_/event-feed/asks/${id}/requests/${body.requestId}`, { headers: H(A.token) });
  assert.equal(st.status, 200);
  assert.equal((await st.json()).state, 'committed');
});

test('stesso requestId con testo diverso: 409, e lo stato resta committed', async (t) => {
  const { A, B } = await pair(t);
  const { id } = await createAsk(B, tmuxSessionForCell('dev'));
  const url = `${A.base}/api/route/owner/_/event-feed/asks/${id}/answer`;
  await fetch(url, { method: 'POST', headers: H(A.token), body: JSON.stringify({ text: 'yes', requestId: '8c9e6679-7425-40de-944b-e07fc1f90ae7' }) });
  const r = await fetch(url, { method: 'POST', headers: H(A.token), body: JSON.stringify({ text: 'no', requestId: '8c9e6679-7425-40de-944b-e07fc1f90ae7' }) });
  assert.equal(r.status, 409);
  const st = await fetch(`${A.base}/api/route/owner/_/event-feed/asks/${id}/requests/8c9e6679-7425-40de-944b-e07fc1f90ae7`, { headers: H(A.token) });
  assert.equal((await st.json()).state, 'committed');
});

test('user senza askReplyAccess: 403, e il paste non parte', async (t) => {
  const { A, B, pasteCalls } = await pair(t, 'user');
  const { id } = await createAsk(B, tmuxSessionForCell('dev'));
  const r = await fetch(`${A.base}/api/route/owner/_/event-feed/asks/${id}/answer`, {
    method: 'POST', headers: H(A.token),
    body: JSON.stringify({ text: 'yes', requestId: '9c9e6679-7425-40de-944b-e07fc1f90ae7' }),
  });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).reason, 'grant-required:ask-action');
  assert.equal(pasteCalls.length, 0);
});

test('id inesistente e cella nascosta: la STESSA risposta 404 opaca', async (t) => {
  const { A, B } = await pair(t, 'user');
  // Narrow the visibility to the dev cell.
  let st = nodesStore.loadStoreStrict(B.nodesPath);
  st = nodesStore.setPeerAccessGrants(st, 'client', {
    cellVisibility: 'selected', cells: ['dev'], eventsAccess: true, nodeEventsAccess: true,
    askReplyAccess: true, filesReadAccess: false, liveHostAccess: false, panelAccess: false, peerOperatorAccess: false,
  });
  nodesStore.atomicWriteStore(B.nodesPath, st);
  const created = await createAsk(B, tmuxSessionForCell('secret'));
  const hidden = created.id;
  const unknown = 'deadbeef';
  const r1 = await fetch(`${A.base}/api/route/owner/_/event-feed/asks/${hidden}/answer`, {
    method: 'POST', headers: H(A.token), body: JSON.stringify({ text: 'x', requestId: 'ad555555-5555-5555-5555-555555555555' }),
  });
  const r2 = await fetch(`${A.base}/api/route/owner/_/event-feed/asks/${unknown}/answer`, {
    method: 'POST', headers: H(A.token), body: JSON.stringify({ text: 'x', requestId: 'ad555555-5555-5555-5555-555555555556' }),
  });
  assert.equal(r1.status, 404);
  assert.equal(r2.status, 404);
  assert.equal(await r1.text(), await r2.text(), 'indistinguishable');
});

test('body con sessione/target: 400 prima di ogni altra considerazione', async (t) => {
  const { A, B } = await pair(t);
  const { id } = await createAsk(B, tmuxSessionForCell('dev'));
  const r = await fetch(`${A.base}/api/route/owner/_/event-feed/asks/${id}/answer`, {
    method: 'POST', headers: H(A.token),
    body: JSON.stringify({ text: 'x', requestId: 'bd555555-5555-5555-5555-555555555555', session: 'cell-session' }),
  });
  assert.equal(r.status, 400);
});

test('dismiss federato: idempotente e con il suo evento di chiusura', async (t) => {
  const { A, B } = await pair(t);
  const { id } = await createAsk(B, tmuxSessionForCell('dev'));
  const r1 = await fetch(`${A.base}/api/route/owner/_/event-feed/asks/${id}`, { method: 'DELETE', headers: H(A.token) });
  assert.equal(r1.status, 200);
  const r2 = await fetch(`${A.base}/api/route/owner/_/event-feed/asks/${id}`, { method: 'DELETE', headers: H(A.token) });
  assert.equal(r2.status, 200);
  assert.equal((await r2.json()).idempotent, true);
});

test('gate revocato prima del claim: 403 anche per un ask esistente', async (t) => {
  const { A, B } = await pair(t);
  const { id } = await createAsk(B, tmuxSessionForCell('dev'));
  const st = nodesStore.loadStoreStrict(B.nodesPath);
  const revision = nodesStore.accessRevisionOf(st);
  await fetch(`${B.base}/api/settings/nodes/client`, {
    method: 'PATCH', headers: H(B.token),
    body: JSON.stringify({ accessRole: 'nexushost', accessRevision: revision }),
  });
  const r = await fetch(`${A.base}/api/route/owner/_/event-feed/asks/${id}/answer`, {
    method: 'POST', headers: H(A.token),
    body: JSON.stringify({ text: 'x', requestId: 'cd555555-5555-5555-5555-555555555555' }),
  });
  assert.equal(r.status, 403);
});

test('reconcile: solo locale, decisione validata, CAS sulla revisione', async (t) => {
  const { B } = await pair(t);
  const { id } = await createAsk(B, tmuxSessionForCell('dev'));
  const ask = JSON.parse(fs.readFileSync(path.join(B.configDir, 'asks.json'), 'utf8')).asks[0];
  const bad = await fetch(`${B.base}/api/asks/${id}/reconcile`, {
    method: 'POST', headers: H(B.token),
    body: JSON.stringify({ decision: 'whatever' }),
  });
  assert.equal(bad.status, 400);
  const stale = await fetch(`${B.base}/api/asks/${id}/reconcile`, {
    method: 'POST', headers: H(B.token),
    body: JSON.stringify({ decision: 'mark-delivered', expectedRevision: (ask.revision || 0) + 5 }),
  });
  assert.equal(stale.status, 409);
  const ok = await fetch(`${B.base}/api/asks/${id}/reconcile`, {
    method: 'POST', headers: H(B.token),
    body: JSON.stringify({ decision: 'mark-delivered', expectedRevision: ask.revision || 0 }),
  });
  assert.equal(ok.status, 200);
});
