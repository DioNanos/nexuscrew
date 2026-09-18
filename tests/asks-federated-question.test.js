'use strict';
// tests/asks-federated-question.test.js — la DOMANDA federata (nc_ask).
//
// Il difetto chiuso qui: `nc_ask` esisteva solo sul nodo locale. La RISPOSTA era
// gia' federata (ask-relay + /event-feed/asks/<id>/answer), l'ANDATA no —
// `ASK_KEYS` non ammetteva nemmeno un `target`, e `/asks` non era in allow-list.
//
// Unit half: schema, target, fan-out (dispatcher iniettato), allow-list.
// HTTP half: due server REALI — la domanda parte da A verso B e atterra nel
// store di B marcata con l'owner, senza rimbalzare indietro (loop test).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { createAsksStore } = require('../lib/notify/asks.js');
const { createNotifier } = require('../lib/notify/notifier.js');
const { notifyRoutes } = require('../lib/notify/routes.js');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const { tmuxSessionForCell } = require('../lib/fleet/definitions.js');
const { allowedResource } = require('../lib/proxy/federation.js');
const { classifyResource } = require('../lib/proxy/resource-acl.js');

const P1 = '1'.repeat(32);
const P2 = '2'.repeat(32);
const SELF = 'f'.repeat(32);

// --- unit harness: dispatcher e peer list iniettati --------------------------

function setup(t, { peerTargets = null, dispatchImpl = null, frames = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaskfed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const hub = { broadcast: (f) => { frames.push(f); return 1; }, clientCount: () => 1 };
  const push = { sendToAll: async () => ({ sent: 0, removed: 0 }) };
  const asks = createAsksStore({ dir });
  const calls = [];
  const dispatcher = {
    dispatch: async (args) => {
      calls.push(args);
      if (dispatchImpl) return dispatchImpl(args);
      return { status: 'delivered' };
    },
  };
  const app = express();
  app.use('/api', notifyRoutes({
    cfg: { readonlyDefault: false },
    notifier: createNotifier({ hub, push }),
    push,
    asks,
    paste: () => Promise.resolve(true),
    sessionExists: (s) => typeof s === 'string' && s.startsWith('cell-'),
    localNodeId: () => SELF,
    dispatcher,
    peerTargets,
  }));
  return new Promise((res) => {
    const srv = app.listen(0, '127.0.0.1', () => {
      t.after(() => srv.close());
      res({
        dir, frames, calls, asks,
        j: (p, opts = {}) => fetch(`http://127.0.0.1:${srv.address().port}${p}`, {
          ...opts,
          headers: { ...(opts.body ? { 'content-type': 'application/json' } : {}), ...(opts.headers || {}) },
        }),
      });
    });
  });
}

const ask = (j, body) => j('/api/asks', { method: 'POST', body: JSON.stringify(body) });

// --- A1: schema e target -----------------------------------------------------

test('A1: chiave estranea -> 400 (schema chiuso), `target` ammesso', async (t) => {
  const s = await setup(t);
  const bad = await ask(s.j, { question: 'q', options: ['a'], session: 'cell-a', bogus: 1 });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /chiave non ammessa: "bogus"/);

  const ok = await ask(s.j, { question: 'q', options: ['a'], session: 'cell-a' });
  assert.equal(ok.status, 201);

  const withTarget = await ask(s.j, { question: 'q', options: ['a'], session: 'cell-a', target: P1 });
  assert.equal(withTarget.status, 201);
});

test('A1: target malformato -> 400, e non crea nulla', async (t) => {
  const s = await setup(t);
  for (const target of ['nope', 'a'.repeat(31), 'a'.repeat(33), `${'a'.repeat(32)}:x`]) {
    const r = await ask(s.j, { question: 'q', options: ['a'], session: 'cell-a', target });
    assert.equal(r.status, 400, `target ${target}`);
    assert.match((await r.json()).error, /target deve essere un instanceId di nodo/);
  }
  const open = await (await s.j('/api/asks?open=1')).json();
  assert.equal(open.asks.length, 0, 'nessun ask creato da un target invalido');
});

test('A1: l\'ask locale NON porta ownerId (ownerId = «appartiene a un altro nodo»)', async (t) => {
  const s = await setup(t);
  const r = await ask(s.j, { question: 'q', options: ['a'], session: 'cell-a' });
  assert.equal(r.status, 201);
  const open = await (await s.j('/api/asks?open=1')).json();
  assert.equal(open.asks.length, 1);
  assert.deepStrictEqual(Object.keys(open.asks[0]).filter((k) => /owner/.test(k)), [],
    'un ask di casa non deve far scegliere alla UI il ritorno federato');
});

// --- A2: fan-out -------------------------------------------------------------

test('A2: con un target esplicito il dispatch parte UNA volta, verso quel nodo', async (t) => {
  const s = await setup(t);
  const r = await ask(s.j, { question: 'q', options: ['a', 'b'], session: 'cell-a', target: P1 });
  assert.equal(r.status, 201);
  const { id, fanout } = await r.json();
  assert.equal(s.calls.length, 1);
  assert.equal(s.calls[0].resource, '/asks');
  assert.equal(s.calls[0].target, P1);
  assert.equal(s.calls[0].payload.askId, id, 'il payload porta l\'id della domanda creata');
  assert.equal(s.calls[0].payload.ownerNode, SELF);
  assert.equal(s.calls[0].origin.node, SELF);
  assert.equal(s.calls[0].origin.cell, 'cell-a');
  assert.deepStrictEqual(fanout, [{ target: P1, status: 'delivered' }]);
});

test('A2: senza target (D1) il dispatch parte per TUTTI i peer autorizzati, una volta ciascuno', async (t) => {
  const s = await setup(t, { peerTargets: async () => [P1, P2, P1, SELF, 'non-un-id'] });
  const r = await ask(s.j, { question: 'q', options: ['a'], session: 'cell-a' });
  assert.equal(r.status, 201);
  assert.deepStrictEqual(s.calls.map((c) => c.target), [P1, P2],
    'dedup, self escluso, id non validi scartati');
  const { fanout } = await r.json();
  assert.equal(fanout.length, 2);
});

test('A2: senza `peerTargets` non si inventa un destinatario', async (t) => {
  const s = await setup(t, { peerTargets: null });
  const r = await ask(s.j, { question: 'q', options: ['a'], session: 'cell-a' });
  assert.equal(r.status, 201);
  assert.equal(s.calls.length, 0);
  const body = await r.json();
  assert.equal(body.fanout, undefined);
});

test('A2: dispatch che SOLLEVA -> l\'ask locale nasce comunque, il peer e\' `unknown`', async (t) => {
  const s = await setup(t, { dispatchImpl: () => { throw new Error('boom'); } });
  const r = await ask(s.j, { question: 'q', options: ['a'], session: 'cell-a', target: P1 });
  assert.equal(r.status, 201, 'il fallimento del peer non blocca la domanda locale');
  const { fanout } = await r.json();
  assert.deepStrictEqual(fanout, [{ target: P1, status: 'unknown', reason: 'dispatch-threw' }]);
  const open = await (await s.j('/api/asks?open=1')).json();
  assert.equal(open.asks.length, 1, 'la domanda locale esiste');
  assert.ok(s.frames.find((f) => f.type === 'ask'), 'il frame ask locale e\' stato emesso');
  assert.ok(s.frames.find((f) => f.type === 'notify' && f.urgency === 'high'), 'e anche la notify');
});

test('A2: dispatch rifiutato dal peer -> riportato, mai un successo inventato', async (t) => {
  const s = await setup(t, { dispatchImpl: () => ({ status: 'refused', reason: 'grant-required:operator' }) });
  const r = await ask(s.j, { question: 'q', options: ['a'], session: 'cell-a', target: P1 });
  assert.equal(r.status, 201);
  const { fanout } = await r.json();
  assert.deepStrictEqual(fanout, [{ target: P1, status: 'refused', reason: 'grant-required:operator' }]);
});

// --- A3: allow-list ----------------------------------------------------------

test('A3: `/asks` POST attraversa, GET no, e la classe e\' operatore', () => {
  assert.equal(allowedResource('/asks', 'POST'), true);
  assert.equal(allowedResource('/asks', 'GET'), false);
  assert.equal(allowedResource('/asks', 'DELETE'), false);
  assert.equal(classifyResource('/asks', 'POST'), 'operator');
  assert.equal(classifyResource('/asks', 'GET'), null);
  // La write-back verso la CELLA resta un'altra cosa e un'altra classe.
  assert.equal(classifyResource('/asks/cell-a/answer', 'POST'), 'ask-action');
  // La GET resta locale: lo snapshot degli ask e' autorevole solo sul proprio nodo.
  assert.equal(allowedResource('/asks', 'GET'), false);
});

// --- A4: inbound su due server REALI ----------------------------------------

const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
const SECRET = 'pairing-secret-token';

function boot(t, { pasteCalls = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaskfed-http-'));
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
  const B = await boot(t);
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
  return { A, B, selfA, selfB };
}

// Come `pair()`, ma con il paste finto ANCHE sul nodo di origine: serve ai test
// in cui e' l'owner a rispondere (senza il seam il paste vero fallisce con 502).
async function pairWithPaste(t) {
  const B = await boot(t, { pasteCalls: [] });
  const A = await boot(t, { pasteCalls: [] });
  const selfA = nodesStore.loadStoreStrict(A.nodesPath).nodeId;
  const selfB = nodesStore.loadStoreStrict(B.nodesPath).nodeId;
  let stB = nodesStore.addNode(nodesStore.loadStoreStrict(B.nodesPath), {
    name: 'client', remotePort: 41999, localPort: 44777, nodeId: selfA,
    acceptToken: SECRET, direction: 'inbound', shared: false, visibility: 'network',
  });
  stB = nodesStore.setPeerAccessPreset(stB, 'client', 'admin');
  nodesStore.atomicWriteStore(B.nodesPath, stB);
  const stA = nodesStore.addNode(nodesStore.loadStoreStrict(A.nodesPath), {
    name: 'owner', remotePort: 41999, localPort: B.port, nodeId: selfB,
    token: SECRET, direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@owner',
  });
  nodesStore.atomicWriteStore(A.nodesPath, stA);
  return { A, B, selfA, selfB };
}

const openAsks = (n, tok) => fetch(`${n.base}/api/asks?open=1`, { headers: H(tok) })
  .then(async (r) => (await r.json()).asks);

test('A4: la domanda di A (target=B) atterra nel store di B, marcata con l\'owner e con l\'id dell\'owner', async (t) => {
  const { A, B, selfA, selfB } = await pair(t);
  const r = await fetch(`${A.base}/api/asks`, {
    method: 'POST', headers: H(A.token),
    body: JSON.stringify({
      question: 'procedo con il merge?', options: ['si', 'no'],
      session: tmuxSessionForCell('dev'), target: selfB,
    }),
  });
  assert.equal(r.status, 201);
  const { id, fanout } = await r.json();
  assert.equal(fanout.length, 1);
  assert.equal(fanout[0].target, selfB);
  assert.equal(fanout[0].status, 'delivered', `fan-out: ${JSON.stringify(fanout)}`);

  const onB = await openAsks(B, B.token);
  assert.equal(onB.length, 1, 'la domanda e\' arrivata sul nodo target');
  assert.equal(onB[0].question, 'procedo con il merge?');
  assert.equal(onB[0].ownerId, selfA, 'ownerId = il nodo che possiede la domanda');
  assert.equal(onB[0].originNode, selfA, 'marcata come importata');
  assert.equal(onB[0].ownerAskId, id, 'l\'id con cui l\'OWNER conosce la domanda');
  assert.notEqual(onB[0].id, id, 'il nostro id locale resta nostro (nessuna collisione)');
});

test('A4 — LOOP: un ask importato non torna indietro (A->B->A)', async (t) => {
  const { A, B, selfA, selfB } = await pair(t);
  await fetch(`${A.base}/api/asks`, {
    method: 'POST', headers: H(A.token),
    body: JSON.stringify({ question: 'q', options: ['si', 'no'], session: tmuxSessionForCell('dev'), target: selfB }),
  });
  // Tempo per un eventuale rimbalzo: se B ridispacciasse, A vedrebbe una
  // seconda domanda (con se stesso come target) e B una terza.
  await new Promise((res) => setTimeout(res, 300));
  const onA = await openAsks(A, A.token);
  const onB = await openAsks(B, B.token);
  assert.equal(onA.length, 1, 'A ha UNA sola domanda: quella creata da lui');
  assert.equal(onB.length, 1, 'B non ha generato ne\' esportato nulla');
  assert.equal(onA[0].ownerId, undefined, 'A non ha ricevuto indietro il proprio ask');
  assert.ok(onB[0].originNode, 'B lo tiene marcato come importato');
});

test('A4: la GET locale di B non vede l\'ask di A come se fosse suo', async (t) => {
  const { A, B, selfA, selfB } = await pair(t);
  await fetch(`${A.base}/api/asks`, {
    method: 'POST', headers: H(A.token),
    body: JSON.stringify({ question: 'q', options: ['si'], session: tmuxSessionForCell('dev'), target: selfB }),
  });
  const onB = await openAsks(B, B.token);
  assert.equal(onB[0].ownerId, selfA);
  // La UI identifica la card con (ownerId, id): senza ownerId due domande di
  // nodi diversi con lo stesso id locale sarebbero la stessa card.
  assert.notEqual(`${onB[0].ownerId}:${onB[0].id}`, `:${onB[0].id}`);
});

test('A4: senza prova di hop, le chiavi federate restano 400 anche sul target', async (t) => {
  const { B, selfB } = await pair(t);
  const r = await fetch(`${B.base}/api/asks`, {
    method: 'POST', headers: H(B.token),
    body: JSON.stringify({
      question: 'q', options: ['si'], session: tmuxSessionForCell('dev'),
      target: selfB, originNode: 'a'.repeat(32), askId: 'deadbeef',
    }),
  });
  assert.equal(r.status, 400, 'un ingresso locale non puo\' fingersi federato');
  assert.match((await r.json()).error, /chiave non ammessa/);
});

// --- A5: il ritorno ----------------------------------------------------------

test('A5: il relay risolve l\'owner dallo store e cita l\'id DELL\'OWNER nella URL', async (t) => {
  const { createAskRelay } = require('../lib/notify/ask-relay.js');
  const calls = [];
  const store = {
    nodeId: 'b'.repeat(32),
    nodes: [
      // Il peer che riceve la domanda ha l'owner come peer OUTBOUND: e' da li'
      // che il ritorno trova rotta, token e porta. Mai da cio' che dice un evento.
      { name: 'owner', direction: 'outbound', nodeId: 'a'.repeat(32), token: 'pair-token', localPort: 41234 },
      { name: 'altro', direction: 'inbound', nodeId: 'c'.repeat(32), token: 'x', localPort: 41235 },
    ],
  };
  const relay = createAskRelay({
    loadStore: () => store,
    fetchImpl: async (url, opts) => {
      calls.push({ url, opts });
      return { status: 200, json: async () => ({ status: 'answered' }) };
    },
  });
  const ownerAskId = 'deadbeef';
  const out = await relay.relayAnswer({ ownerId: 'a'.repeat(32), askId: ownerAskId, text: 'si' });
  assert.equal(out.ok, true);
  assert.equal(out.status, 'committed');
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/federation\/route\/_\/event-feed\/asks\/deadbeef\/answer$/,
    'la risposta va all\'id con cui l\'OWNER conosce la domanda');
  assert.equal(calls[0].opts.headers.authorization, 'Bearer pair-token');
  assert.equal(JSON.parse(calls[0].opts.body).text, 'si');

  // Un owner che non e' tra i peer autorizzati non diventa mai una rotta.
  const unknown = await relay.relayAnswer({ ownerId: '9'.repeat(32), askId: ownerAskId, text: 'si' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.reason, 'owner-unknown');
  assert.equal(calls.length, 1, 'nessuna richiesta partita verso un owner non autorizzato');
});

test('A5: la rotta /api/asks-relay PARSA il body (difetto preesistente corretto)', async (t) => {
  const { B, selfB } = await pair(t);
  // Prima della correzione questa rotta non montava `express.json`: `req.body`
  // era undefined, il relay leggeva un body vuoto e rispondeva 400 «ownerId,
  // askId e text richiesti» a OGNI richiesta. Ora il body arriva, e l'esito e'
  // quello VERO: qui B non ha una rotta outbound verso l'owner, quindi
  // `owner-unknown` e' il rifiuto corretto.
  const r = await fetch(`${B.base}/api/asks-relay`, {
    method: 'POST', headers: H(B.token),
    body: JSON.stringify({ ownerId: 'a'.repeat(32), askId: 'deadbeef', text: 'si' }),
  });
  const body = await r.json();
  assert.equal(r.status, 404, `relay: ${JSON.stringify(body)}`);
  assert.equal(body.reason, 'owner-unknown');
  assert.doesNotMatch(String(body.error), /richiesti/, 'il body non e\' piu\' vuoto');
});

test('A5: la card di un ask importato ha cio\' che serve a rispondere (ownerId + ownerAskId)', async (t) => {
  const { A, B, selfA, selfB } = await pair(t);
  const created = await (await fetch(`${A.base}/api/asks`, {
    method: 'POST', headers: H(A.token),
    body: JSON.stringify({ question: 'q', options: ['si', 'no'], session: tmuxSessionForCell('dev'), target: selfB }),
  })).json();

  const onB = await openAsks(B, B.token);
  const mine = onB[0];
  // Sono ESATTAMENTE i due campi che NotifyCenter usa per scegliere il ritorno
  // federato (relayAskAnswer) e per citare l'id giusto.
  assert.equal(mine.ownerId, selfA);
  assert.equal(mine.ownerAskId, created.id);
  assert.equal(mine.ownerAskId === mine.id, false, 'il nostro id locale non e\' quello dell\'owner');
});

// --- R2: l'importato non esce dal destinatario -------------------------------

test('R2: lo snapshot di B non riesporta un ask importato (un terzo peer non lo vede)', async (t) => {
  const { A, B, selfB } = await pair(t);
  // C raggiunge B: e' il terzo che non deve vedere la domanda A→B.
  const C = await boot(t);
  const selfC = nodesStore.loadStoreStrict(C.nodesPath).nodeId;
  // B deve ACCETTARE C: senza il peer inbound su B, la lettura di C e' rifiutata.
  let bs = nodesStore.loadStoreStrict(B.nodesPath);
  bs = nodesStore.addNode(bs, {
    name: 'third', nodeId: selfC, acceptToken: 'third-secret', direction: 'inbound',
    shared: false, visibility: 'network', remotePort: 41999, localPort: 44778,
  });
  bs = nodesStore.setPeerAccessPreset(bs, 'third', 'admin');
  nodesStore.atomicWriteStore(B.nodesPath, bs);
  const cs = nodesStore.addNode(nodesStore.loadStoreStrict(C.nodesPath), {
    name: 'middle', nodeId: selfB, token: 'third-secret', direction: 'outbound',
    shared: true, visibility: 'network', ssh: 'u@middle', remotePort: 41999, localPort: B.port,
  });
  nodesStore.atomicWriteStore(C.nodesPath, cs);

  const created = await (await fetch(`${A.base}/api/asks`, {
    method: 'POST', headers: H(A.token),
    body: JSON.stringify({ question: 'A_TO_B_ONLY', options: ['yes'], session: tmuxSessionForCell('dev'), target: selfB }),
  })).json();

  // B lo mostra a se stesso: e' il destinatario, e deve poterlo rispondere.
  const imported = await openAsks(B, B.token);
  assert.equal(imported.length, 1);
  assert.equal(imported[0].ownerAskId, created.id);

  // C legge lo snapshot DI B: l'ask importato non c'e'.
  const snap = await (await fetch(`${C.base}/api/route/middle/_/event-feed/snapshot`, { headers: H(C.token) })).json();
  assert.equal(snap.asks.length, 0, 'un ask importato non deve essere riesportato come nostro');
  // Chi possiede la domanda continua a vederla aperta: la guardia toglie solo
  // gli IMPORTATI, non svuota lo snapshot.
  assert.equal((await openAsks(A, A.token)).length, 1);
});

// --- R3: chiusura dell'alias, dedup, cap ------------------------------------

test('R3: la chiusura dell\'owner chiude l\'alias locale, anche dopo un reload', async (t) => {
  const { A, B, selfB } = await pairWithPaste(t);
  const created = await (await fetch(`${A.base}/api/asks`, {
    method: 'POST', headers: H(A.token),
    body: JSON.stringify({ question: 'CLOSE_ME', options: ['yes'], session: tmuxSessionForCell('dev'), target: selfB }),
  })).json();

  const before = await openAsks(B, B.token);
  assert.equal(before.length, 1);
  const mine = before[0];

  // L'owner scarta. La chiusura viaggia sulla stessa strada dell'andata.
  const dr = await fetch(`${A.base}/api/asks/${created.id}`, { method: 'DELETE', headers: H(A.token) });
  assert.equal(dr.status, 200);
  assert.equal((await openAsks(A, A.token)).length, 0);

  const after = await openAsks(B, B.token);
  assert.equal(after.length, 0, 'la chiusura dell\'owner deve chiudere l\'alias locale');

  // DUREVOLE: non e' solo un frame per la UI. Rileggendo lo store dal disco
  // l'alias risulta chiuso, quindi non ricompare a un reload.
  const onDisk = JSON.parse(fs.readFileSync(path.join(B.configDir, 'asks.json'), 'utf8')).asks;
  const alias = onDisk.find((a) => a.ownerAskId === created.id);
  assert.ok(alias, 'la riga resta nello storico');
  assert.equal(alias.dismissed, true, 'ed e\' marcata chiusa, non solo tolta dalla lista');

  // La risposta dell'owner chiude allo stesso modo.
  const created2 = await (await fetch(`${A.base}/api/asks`, {
    method: 'POST', headers: H(A.token),
    body: JSON.stringify({ question: 'ANSWER_ME', options: ['yes'], session: tmuxSessionForCell('dev'), target: selfB }),
  })).json();
  const ans = await fetch(`${A.base}/api/asks/${created2.id}/answer`, {
    method: 'POST', headers: H(A.token), body: JSON.stringify({ text: 'yes' }),
  });
  assert.equal(ans.status, 200);
  assert.equal((await openAsks(B, B.token)).length, 0, 'anche la risposta chiude l\'alias');
});

test('R3: la stessa domanda non crea due alias (dedup per identita\' canonica)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaskdedup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createAsksStore({ dir });
  const OWNER = 'a'.repeat(32);
  const first = store.create({ question: 'q', session: 'cell-a', ownerId: OWNER, ownerAskId: 'deadbeef', originNode: OWNER });
  assert.equal(first.ok, true);
  const again = store.create({ question: 'q', session: 'cell-a', ownerId: OWNER, ownerAskId: 'deadbeef', originNode: OWNER });
  assert.equal(again.ok, true);
  assert.equal(again.deduped, true, 'la seconda consegna non crea un secondo alias');
  assert.equal(again.ask.id, first.ask.id);
  assert.equal(store.list({ open: true }).length, 1);

  // La chiusura trova l'alias per la coppia canonica, non per l'id locale.
  const closed = store.closeImported({ ownerId: OWNER, ownerAskId: 'deadbeef', outcome: 'dismissed' });
  assert.equal(closed.changed, true);
  assert.equal(closed.ask.id, first.ask.id);
  assert.equal(store.list({ open: true }).length, 0);
  // Idempotente: una seconda chiusura non cambia nulla.
  assert.equal(store.closeImported({ ownerId: OWNER, ownerAskId: 'deadbeef', outcome: 'answered' }).changed, false);
});

test('R3: il cap degli importati e\' separato da quello dei locali', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaskcap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = createAsksStore({ dir });
  const OWNER = 'a'.repeat(32);
  for (let i = 0; i < store.MAX_OPEN_IMPORTED; i += 1) {
    const r = store.create({
      question: `importata ${i}`, session: 'cell-a',
      ownerId: OWNER, ownerAskId: i.toString(16).padStart(8, '0'), originNode: OWNER,
    });
    assert.equal(r.ok, true, `importata ${i}`);
  }
  assert.equal(store.openCount('imported'), store.MAX_OPEN_IMPORTED);
  assert.equal(store.openCount('local'), 0);

  // Il punto del difetto: cento importate bloccavano il primo ask locale.
  const own = store.create({ question: 'la mia', options: ['si'], session: 'cell-a' });
  assert.equal(own.ok, true, 'gli importati non devono consumare il budget dei locali');
  assert.equal(store.openCount('local'), 1);

  // Il cap degli importati resta un cap.
  const over = store.create({
    question: 'oltre', session: 'cell-a',
    ownerId: OWNER, ownerAskId: 'ffffffff', originNode: OWNER,
  });
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'cap');

  // E il cap dei locali resta quello dei locali.
  const overLocal = store.create({ question: 'oltre locale', session: 'cell-a' });
  assert.equal(overLocal.ok, true, 'il locale #2 e\' sotto il proprio cap');
});
