'use strict';
// tests/federated-asks.test.js — federated ask answer cycle.
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
const { createAsksStore } = require('../lib/notify/asks.js');
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
    markReconciled: (id, decision) => {
      asks.claimed.delete(id);
      const a = asks.store.get(id);
      if (!a) return { ok: false, reason: 'unknown' };
      if (decision === 'mark-delivered' && !a.answered) {
        a.answered = true; a.answeredReconciled = true;
      }
      a.revision = (a.revision || 0) + 1;
      return { ok: true, ask: { ...a } };
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
    markReconciled(id, decision) {
      const a = this.get(id);
      if (decision === 'mark-delivered' && !a.answered) a.answered = true;
      a.revision = (a.revision || 0) + 1;
      return { ok: true, ask: { ...a } };
    },
  };
  const service = createAskAnswerService({ asks, receipts: receipts2, paste: async () => true, onClosure: () => {} });
  const local = await service.answerLocal({ askId: 'abc12345', text: 'retry' });
  assert.equal(local.code, 409);
  assert.equal(local.reason, 'delivery-unknown-block');
  // Reconciling as delivered CLOSES the ask: the paste was on the peer's side,
  // and a second local paste must never happen.
  const rec = await service.reconcile({ askId: 'abc12345', decision: 'mark-delivered', expectedRevision: 0 });
  assert.equal(rec.ok, true, 'the reconcile is accepted on the current revision');
  assert.equal(rec.revision, 1, 'the transition advanced the revision');
  const local2 = await service.answerLocal({ askId: 'abc12345', text: 'retry' });
  assert.equal(local2.ok, false);
  assert.equal(local2.code, 409);
  // The durable receipt answers first: it is the terminal state the paste
  // decision consults, and the ask is closed behind it (both are asserted).
  assert.equal(local2.reason, 'already-delivered', 'a terminal receipt forbids the paste');
  assert.equal(asks.store.get('abc12345').answered, true, 'reconciled as delivered, the ask is closed');
  const st2 = receipts2.statusFor('abc12345');
  assert.equal(st2.blocked, false, 'the unlock happened');
});

test('un reconcile non persistito NON sblocca: il blocco resta e non si incolla', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaskrecfail-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'ask-receipts.json');
  const receipts1 = createAskReceipts({ filePath });
  receipts1.attempt({ peerId: PEER, askId: 'abc12345', requestId: '55555555-5555-5555-5555-555555555555', text: 'go' });
  const receipts2 = createAskReceipts({ filePath }); // pending -> delivery-unknown
  assert.equal(receipts2.isBlocked('abc12345'), true);
  // The durable write now fails: the receipts file is replaced by a directory,
  // so the rename of the fresh temp file cannot land.
  fs.unlinkSync(filePath);
  fs.mkdirSync(filePath);
  const pasteCalls = [];
  const asks = { store: new Map([['abc12345', { id: 'abc12345', session: 's', question: 'q', revision: 0 }]]),
    get(id) { return this.store.get(id) || null; },
    claim(id) { const a = this.get(id); return a && !a.answered ? { ok: true, ask: { ...a } } : { ok: false, reason: 'answered' }; },
    release() {},
    commit(id, text) { const a = this.get(id); a.answered = true; a.answer = text; return true; },
    markReconciled(id) { const a = this.get(id); a.revision = (a.revision || 0) + 1; return { ok: true, ask: { ...a } }; } };
  const service = createAskAnswerService({ asks, receipts: receipts2, paste: async () => { pasteCalls.push(1); return true; }, onClosure: () => {} });
  const out = await service.reconcile({ askId: 'abc12345', decision: 'allow-new-attempt', expectedRevision: 0 });
  assert.equal(out.ok, false, 'a failed write cannot unlock');
  assert.equal(out.reason, 'persist-failed');
  assert.equal(receipts2.isBlocked('abc12345'), true, 'the block is still there');
  const answer = await service.answerLocal({ askId: 'abc12345', text: 'x' });
  assert.equal(answer.code, 409);
  assert.equal(pasteCalls.length, 0, 'zero pastes while the outcome is unknown');
});

test('il perdente del claim non lascia una ricevuta pending', async (t) => {
  const u = unit(t);
  u.asks.store.set('abc12345', { id: 'abc12345', session: 's', question: 'q', revision: 0 });
  u.asks.claimed.add('abc12345'); // someone else holds the claim
  const r = await u.service.answerFederated({ askId: 'abc12345', text: 'go', peerId: PEER, requestId: '66666666-6666-6666-6666-666666666666' });
  assert.equal(r.code, 409, 'the loser is refused');
  const entry = u.receipts.get(PEER, 'abc12345', '66666666-6666-6666-6666-666666666666');
  assert.ok(entry, 'the attempt is recorded');
  assert.equal(entry.state, 'failed', 'finalized, never left pending');
  assert.equal(u.receipts.isBlocked('abc12345'), false, 'no fake lock');
});

test('il dismiss non rimuove un ask con esito incerto, su nessuno dei due percorsi', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaskdismiss-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'ask-receipts.json');
  const first = createAskReceipts({ filePath });
  first.attempt({ peerId: PEER, askId: 'abc12345', requestId: '77777777-7777-7777-7777-777777777777', text: 'go' });
  const receipts = createAskReceipts({ filePath }); // pending -> delivery-unknown
  assert.equal(receipts.isBlocked('abc12345'), true);
  const ask = { id: 'abc12345', session: 's', question: 'q', revision: 0 };
  const asks = {
    get: (id) => (id === ask.id ? ask : null),
    dismiss: () => { ask.dismissed = true; ask.revision += 1; return { ok: true, ask: { ...ask } }; },
  };
  const service = createAskAnswerService({ asks, receipts, paste: async () => true, onClosure: () => {} });
  const out = service.dismiss('abc12345');
  assert.equal(out.ok, false, 'an unknown outcome cannot be dismissed away');
  assert.equal(out.reason, 'delivery-unknown-block');
  assert.equal(ask.dismissed, undefined, 'the ask is still there, not dismissed');
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

// Crash simulato su un server REALE: un tentativo resta `pending` su disco e al
// boot successivo e' delivery-unknown — la sola condizione in cui un operatore
// riconcilia davvero (un ask bloccato non accetta nuovi tentativi).
const SEED_ID = 'fee1dead';
function seedUnknownAsk(configDir, askId, {
  question = 'proceed?', session = tmuxSessionForCell('dev'), requestId = '00000000-0000-4000-8000-0000000000f1',
} = {}) {
  // 0600: lo store degli ask rifiuta di leggere un file con permessi larghi.
  fs.writeFileSync(path.join(configDir, 'asks.json'), JSON.stringify({
    asks: [{ id: askId, question, session, ts: Date.now(), revision: 0 }],
  }), { mode: 0o600 });
  const seeded = createAskReceipts({ filePath: path.join(configDir, 'ask-receipts.json') });
  const out = seeded.attempt({ peerId: B_ID, askId, requestId, text: 'go' });
  assert.equal(out.ok, true, 'seed: il tentativo pendente e scritto');
}

function boot(t, { pasteCalls = null, seed = null } = {}) {
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
  if (seed) seed(configDir); // seed PRIMA di createServer: le ricevute si leggono al boot
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

async function pair(t, preset = 'admin', seedB = null) {
  const pasteCalls = [];
  const B = await boot(t, { pasteCalls, seed: seedB });
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
  const { B } = await pair(t, 'admin', (dir) => seedUnknownAsk(dir, SEED_ID));
  const id = SEED_ID;
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
  // The CAS is MANDATORY: with no revision the route refuses to touch the state.
  const noRev = await fetch(`${B.base}/api/asks/${id}/reconcile`, {
    method: 'POST', headers: H(B.token),
    body: JSON.stringify({ decision: 'mark-delivered' }),
  });
  assert.equal(noRev.status, 400, 'expectedRevision obbligatoria');
  assert.equal((await noRev.json()).reason, 'revision-required');
  const ok = await fetch(`${B.base}/api/asks/${id}/reconcile`, {
    method: 'POST', headers: H(B.token),
    body: JSON.stringify({ decision: 'mark-delivered', expectedRevision: ask.revision || 0 }),
  });
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.equal(okBody.revision, (ask.revision || 0) + 1, 'the transition advanced the revision');
  // The token the operator used is stale from here on: a second reconcile with
  // the same revision cannot unlock anything.
  const replay = await fetch(`${B.base}/api/asks/${id}/reconcile`, {
    method: 'POST', headers: H(B.token),
    body: JSON.stringify({ decision: 'allow-new-attempt', expectedRevision: ask.revision || 0 }),
  });
  assert.equal(replay.status, 409, 'a reconciled generation cannot be reconciled twice');
  // E sulla generazione GIA' risolta non si finge un successo: non c'e' piu'
  // nulla di incerto da riconciliare.
  const again = await fetch(`${B.base}/api/asks/${id}/reconcile`, {
    method: 'POST', headers: H(B.token),
    body: JSON.stringify({ decision: 'allow-new-attempt', expectedRevision: (ask.revision || 0) + 1 }),
  });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).reason, 'nothing-to-reconcile');
});

test('reconciliato come consegnato: l ask e chiuso e non si incolla piu', async (t) => {
  const { A, B, pasteCalls } = await pair(t, 'admin', (dir) => seedUnknownAsk(dir, SEED_ID));
  const id = SEED_ID;
  const ask = JSON.parse(fs.readFileSync(path.join(B.configDir, 'asks.json'), 'utf8')).asks[0];
  const ok = await fetch(`${B.base}/api/asks/${id}/reconcile`, {
    method: 'POST', headers: H(B.token),
    body: JSON.stringify({ decision: 'mark-delivered', expectedRevision: ask.revision || 0 }),
  });
  assert.equal(ok.status, 200);
  const before = pasteCalls.length;
  const answer = await fetch(`${B.base}/api/asks/${id}/answer`, {
    method: 'POST', headers: H(B.token),
    body: JSON.stringify({ text: 'again' }),
  });
  assert.equal(answer.status, 409, 'the ask is closed: no second paste after mark-delivered');
  assert.equal(pasteCalls.length, before, 'zero pastes');
  // And the federated surface sees the same closure.
  const fed = await fetch(`${A.base}/api/route/owner/_/event-feed/asks/${id}/answer`, {
    method: 'POST', headers: H(A.token),
    body: JSON.stringify({ text: 'again', requestId: 'aa666666-6666-6666-6666-666666666666' }),
  });
  assert.equal(fed.status, 409);
  assert.equal(pasteCalls.length, before, 'still zero pastes');
});

test('una ricevuta terminale blocca il paste anche su un nuovo requestId', async (t) => {
  const u = unit(t);
  const { createAsksStore } = require('../lib/notify/asks.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaskterminal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const asks = createAsksStore({ dir });
  const id = asks.create({ question: 'q', session: 'cell-test' }).ask.id;
  const receipts = createAskReceipts({ filePath: path.join(dir, 'receipts.json') });
  let pastes = 0;
  const service = createAskAnswerService({ asks, receipts, paste: async () => { pastes += 1; return true; }, onClosure: () => {} });
  const first = await service.answerFederated({ askId: id, text: 'yes', peerId: PEER, requestId: '88888888-8888-4888-8888-888888888888' });
  assert.equal(first.ok, true);
  assert.equal(pastes, 1);
  // The ask is closed AND the receipt is terminal: a different request id (a
  // fresh attempt, not a replay) must never produce a second paste.
  const second = await service.answerFederated({ askId: id, text: 'again', peerId: PEER, requestId: '99999999-9999-4999-8999-999999999999' });
  assert.equal(second.code, 409);
  assert.equal(second.reason, 'already-delivered');
  assert.equal(pastes, 1, 'no second paste');
  assert.equal(receipts.answerStateFor(id), 'committed');
  void u;
});

test('mark-delivered: se la transizione dello store fallisce, il blocco resta', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaskpartial-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'receipts.json');
  const first = createAskReceipts({ filePath });
  first.attempt({ peerId: PEER, askId: 'abc12345', requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', text: 'go' });
  const receipts = createAskReceipts({ filePath }); // pending -> delivery-unknown
  const ask = { id: 'abc12345', session: 's', question: 'q', revision: 0 };
  const asks = {
    get: (id) => (id === ask.id ? ask : null),
    markReconciled: () => ({ ok: false, reason: 'unknown' }),
    claim: () => ({ ok: true, ask: { ...ask } }),
  };
  let pastes = 0;
  const service = createAskAnswerService({ asks, receipts, paste: async () => { pastes += 1; return true; }, onClosure: () => {} });
  const out = service.reconcile({ askId: 'abc12345', decision: 'mark-delivered', expectedRevision: 0 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'ask-transition-failed');
  assert.equal(receipts.isBlocked('abc12345'), true, 'the receipt still blocks');
  assert.equal(ask.answered, undefined, 'and the ask was not half-closed');
  const answer = await service.answerLocal({ askId: 'abc12345', text: 'x' });
  assert.equal(answer.code, 409);
  assert.equal(pastes, 0, 'nothing became pasteable');
});

test('mark-delivered: se la ricevuta non si scrive, l ask resta CHIUSO e non si incolla', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaskpartial2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'receipts.json');
  const first = createAskReceipts({ filePath });
  first.attempt({ peerId: PEER, askId: 'abc12345', requestId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', text: 'go' });
  const receipts = createAskReceipts({ filePath });
  const ask = { id: 'abc12345', session: 's', question: 'q', revision: 0 };
  const asks = {
    get: (id) => (id === ask.id ? ask : null),
    markReconciled: () => { ask.answered = true; ask.revision += 1; return { ok: true, ask: { ...ask } }; },
    claim: (id) => (ask.answered ? { ok: false, reason: 'answered' } : { ok: true, ask: { ...ask } }),
    release: () => {},
  };
  // The durable receipt write fails: the file becomes a directory.
  fs.unlinkSync(filePath);
  fs.mkdirSync(filePath);
  let pastes = 0;
  const service = createAskAnswerService({ asks, receipts, paste: async () => { pastes += 1; return true; }, onClosure: () => {} });
  const out = service.reconcile({ askId: 'abc12345', decision: 'mark-delivered', expectedRevision: 0 });
  assert.equal(out.ok, false, 'the receipt was not reconciled');
  assert.equal(out.reason, 'persist-failed');
  assert.equal(ask.answered, true, 'the residue is the restrictive one: the ask is closed');
  assert.equal(receipts.isBlocked('abc12345'), true, 'and the receipt still blocks');
  const answer = await service.answerLocal({ askId: 'abc12345', text: 'x' });
  assert.equal(answer.code, 409);
  assert.equal(pastes, 0, 'no paste after a partial failure');
});

test('allow-new-attempt: un fallimento parziale non chiude l ask e non fa incollare', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaskpartial3-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'receipts.json');
  const first = createAskReceipts({ filePath });
  first.attempt({ peerId: PEER, askId: 'abc12345', requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', text: 'go' });
  const receipts = createAskReceipts({ filePath });
  const ask = { id: 'abc12345', session: 's', question: 'q', revision: 0 };
  const asks = {
    get: (id) => (id === ask.id ? ask : null),
    markReconciled: () => { ask.revision += 1; return { ok: true, ask: { ...ask } }; },
    claim: (id) => (ask.answered ? { ok: false, reason: 'answered' } : { ok: true, ask: { ...ask } }),
    release: () => {},
  };
  fs.unlinkSync(filePath);
  fs.mkdirSync(filePath); // the receipt write cannot land
  let pastes = 0;
  const service = createAskAnswerService({ asks, receipts, paste: async () => { pastes += 1; return true; }, onClosure: () => {} });
  const out = service.reconcile({ askId: 'abc12345', decision: 'allow-new-attempt', expectedRevision: 0 });
  assert.equal(out.ok, false);
  assert.equal(ask.answered, undefined, 'reopening must never close the ask');
  assert.equal(ask.dismissed, undefined, 'nor discard it');
  assert.equal(receipts.isBlocked('abc12345'), true, 'the block is still the restrictive residue');
  const answer = await service.answerLocal({ askId: 'abc12345', text: 'x' });
  assert.equal(answer.code, 409);
  assert.equal(pastes, 0);
});

// --- FIX 3 (re-audit cf00c8ce): riconciliazione e paste vivo -----------------
// Il fix e' nel punto di DECISIONE della riconciliazione: qui si prova che il
// claim di un paste ancora in volo non viene toccato e che un "niente da
// riconciliare" non viene presentato come successo.

function realFix3(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncfix3-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const asks = createAsksStore({ dir });
  const receipts = createAskReceipts({ filePath: path.join(dir, 'ask-receipts.json') });
  const pastes = [];
  let release = null;
  const service = createAskAnswerService({
    asks, receipts,
    paste: async () => {
      pastes.push(1);
      if (pastes.length === 1 && release) await new Promise((r) => { release.hang = r; });
      return true;
    },
    labelPrefix: 'human',
  });
  return { asks, receipts, service, pastes, hook: (r) => { release = r; } };
}

test('reconcile su un paste ANCORA IN VOLO viene rifiutato: il claim non si tocca e non nasce un secondo paste', async (t) => {
  const ctx = realFix3(t);
  let hang = null;
  ctx.hook({ get hang() { return hang; }, set hang(v) { hang = v; } });
  const askId = ctx.asks.create({ question: 'domanda', session: 'cell-a' }).ask.id;
  const inFlight = ctx.service.answerFederated({
    askId, text: 'primo', peerId: PEER, requestId: '11111111-1111-4111-8111-111111111111',
  });
  await new Promise((r) => setImmediate(r)); // il paste #1 e' partito e il claim e' suo

  const rec = ctx.service.reconcile({ askId, decision: 'allow-new-attempt', expectedRevision: 0 });
  assert.equal(rec.ok, false, 'una riconciliazione su un paste vivo non e\' un successo');
  assert.equal(rec.code, 409);
  assert.equal(rec.reason, 'answering');

  const second = await ctx.service.answerLocal({ askId, text: 'secondo' });
  assert.equal(second.ok, false, 'il claim non e stato rilasciato dalla riconciliazione');
  assert.equal(second.reason, 'answering');

  if (typeof hang === 'function') hang();
  const first = await inFlight;
  assert.equal(first.ok, true, 'il paste vivo arriva comunque a termine');
  assert.equal(ctx.pastes.length, 1, 'un solo paste: nessun doppio incollo');
});

test('reconcile senza nulla di incerto: 409 nothing-to-reconcile, mai un ok con changed 0', async (t) => {
  const ctx = realFix3(t);
  const askId = ctx.asks.create({ question: 'domanda', session: 'cell-a' }).ask.id;
  const done = await ctx.service.answerFederated({
    askId, text: 'risposta', peerId: PEER, requestId: '22222222-2222-4222-8222-222222222222',
  });
  assert.equal(done.ok, true);
  const rev = ctx.asks.get(askId).revision || 0;
  const rec = ctx.service.reconcile({ askId, decision: 'allow-new-attempt', expectedRevision: rev });
  assert.equal(rec.ok, false, 'non c\'era alcun esito incerto da riconciliare');
  assert.equal(rec.code, 409);
  assert.equal(rec.reason, 'nothing-to-reconcile');
});

test('la riconciliazione e legata alla GENERAZIONE degli esiti incerti, non solo alla revisione dell ask', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncfix3gen-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'ask-receipts.json');
  let receipts = createAskReceipts({ filePath });
  // Due tentativi che un crash lascia pendenti: al recovery sono delivery-unknown.
  assert.equal(receipts.attempt({ peerId: PEER, askId: 'a1', requestId: 'aaaaaaaa-1111-4111-8111-111111111111', text: 'x' }).ok, true);
  assert.equal(receipts.attempt({ peerId: OTHER, askId: 'a1', requestId: 'bbbbbbbb-1111-4111-8111-111111111111', text: 'y' }).ok, true);
  receipts = createAskReceipts({ filePath }); // restart
  const read = receipts.reconcilableFor('a1');
  assert.equal(read.count, 2);
  assert.equal(read.live, 0);

  // Una decisione presa su una generazione DIVERSA da quella letta non sblocca
  // nulla. Nota dichiarata: un ask bloccato RIFIUTA nuovi tentativi, quindi
  // l'insieme degli esiti incerti puo' muoversi solo con un altro crash; qui il
  // disallineamento e' costruito a mano e il test prova l'invariante di
  // sicurezza, non un percorso di produzione.
  const wrongCount = receipts.reconcile('a1', 'allow-new-attempt', { count: read.count + 1, generation: read.generation });
  assert.equal(wrongCount.ok, false);
  assert.equal(wrongCount.reason, 'generation-changed');
  const wrongGen = receipts.reconcile('a1', 'allow-new-attempt', { count: read.count, generation: 'deadbeefdeadbeef' });
  assert.equal(wrongGen.ok, false);
  assert.equal(wrongGen.reason, 'generation-changed');
  assert.equal(receipts.isBlocked('a1'), true, 'nessuno sblocco su una generazione che nessuno ha deciso');

  // Con la generazione letta davvero la riconciliazione passa e sblocca.
  const good = receipts.reconcile('a1', 'allow-new-attempt', { count: read.count, generation: read.generation });
  assert.equal(good.ok, true);
  assert.equal(good.changed, 2);
  assert.equal(receipts.isBlocked('a1'), false);
});
