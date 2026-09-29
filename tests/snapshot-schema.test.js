'use strict';
// tests/snapshot-schema.test.js — lo SCHEMA COMPLETO dello snapshot vive nel
// VALIDATORE UNICO (validateSnapshot): ogni campo che il codice a valle usa
// davvero (applySnapshot, la porta ownerSnapshotAsks, la riconciliazione degli
// alias, la UI del centro notifiche) è richiesto col tipo esatto. Un campo
// mancante o di tipo sbagliato in QUALUNQUE punto non è MAI 'ok': lo snapshot
// non è autorevole, nessuna applicazione parziale, nessuna chiusura di alias
// su un elenco che non è un elenco.
//
// Prova su ENTRAMBE le vie:
//   - sottoscritta: poll() → snapshotOnce → view.lastError (niente 'applied');
//   - porta: ownerSnapshotAsks() per owner NON sottoscritti → status 'error'
//     con reason esplicita (mai 'ok').
// I mapping storici (owner-mismatch, snapshot-element-oversize,
// snapshot-resync-required) restano identici: i test li bloccano.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const nodesStore = require('../lib/nodes/store.js');
const { createEventFeedClient } = require('../lib/notify/event-feed-client.js');

const OWNER = 'a'.repeat(32);

// Lo snapshot come lo emette il produttore (event-feed-routes buildSnapshot):
// forma completa, tutti i campi col tipo giusto.
const baseSnapshot = () => ({
  v: 1,
  ownerId: OWNER,
  peerId: 'p'.repeat(8),
  viewEpoch: 1,
  cursor: '1:1',
  askReplyAccess: false,
  asks: [{ id: 'a1', question: 'procedo?', options: ['sì', 'no'], session: 'dev', ts: 1 }],
  notifications: [{ v: 1, ownerId: OWNER, eventId: 'e1', scope: 'node', cellId: null, hop: 1, emittedAt: 1, frame: { type: 'notify', title: 't', body: 'b' } }],
  fleetState: { available: true, cells: [{ cell: 'dev', active: true }] },
});

function makeClient(t, { eventsReceive = false, responses = [] } = {}) {
  const fetchImpl = async () => {
    const next = responses.shift();
    if (!next) return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
    return next;
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncschema-'));
  const nodesPath = path.join(dir, 'nodes.json');
  nodesStore.initStore(nodesPath);
  let st = nodesStore.addNode(nodesStore.loadStoreStrict(nodesPath), {
    name: 'owner', remotePort: 41999, localPort: 44777, nodeId: OWNER,
    token: 'TOK', direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@owner',
  });
  if (eventsReceive) st = nodesStore.updateNode(st, 'owner', { eventsReceive: true });
  nodesStore.atomicWriteStore(nodesPath, st);
  const ref = { value: null };
  t.after(() => {
    try { if (ref.value) ref.value.stop(); } catch (_) { /* già fermo */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const client = createEventFeedClient({
    loadStore: () => nodesStore.loadStoreStrict(nodesPath),
    fetchImpl,
    pollMs: 30,
    minSnapshotIntervalMs: 0,
    eventsHub: { broadcast: () => {} },
  });
  ref.value = client;
  return client;
}

// La VIA SOTTOSCRITTA: un round di poll() senza start() (nessun timer), con
// capability dichiarata e stream che chiude subito. La view riporta l'esito.
async function subscribedView(t, snap) {
  const health = { ok: true, status: 200, json: async () => ({ ok: true, instanceId: OWNER, eventFeedV1: true }) };
  const stream = {
    ok: true, status: 200,
    body: { getReader: () => ({ read: async () => ({ done: true }) }) },
    text: async () => '',
  };
  const client = makeClient(t, {
    eventsReceive: true,
    responses: [health, { ok: true, status: 200, text: async () => JSON.stringify(snap) }, stream],
  });
  await client.poll();
  return client.viewFor(OWNER);
}

// La PORTA per owner NON sottoscritti: esito tipizzato, MAI 'ok' su una forma
// rifiutata.
async function doorResult(t, snap) {
  const client = makeClient(t, {
    eventsReceive: false,
    responses: [{ ok: true, status: 200, text: async () => JSON.stringify(snap) }],
  });
  return client.ownerSnapshotAsks(OWNER);
}

// ———————————————————————————————————————————————— asks: l'elenco che decide ——

test('via sottoscritta: snapshot SENZA asks è rifiutato, mai applicato', async (t) => {
  const snap = baseSnapshot();
  delete snap.asks;
  const view = await subscribedView(t, snap);
  assert.equal(view.lastError, 'snapshot-schema:asks');
  assert.equal(view.stale, true);
  assert.deepEqual(view.asks, [], 'niente applicazione parziale: la view resta vuota');
  assert.equal(view.cursor, null, 'il cursor di uno snapshot rifiutato non entra');
});

test('porta: snapshot SENZA asks è error esplicito, mai ok', async (t) => {
  const snap = baseSnapshot();
  delete snap.asks;
  assert.deepEqual(await doorResult(t, snap), { status: 'error', reason: 'snapshot-schema:asks' });
});

test('via sottoscritta: asks non array (stringa) è rifiutato', async (t) => {
  const view = await subscribedView(t, { ...baseSnapshot(), asks: 'no-array' });
  assert.equal(view.lastError, 'snapshot-schema:asks');
  assert.deepEqual(view.asks, []);
});

test('via sottoscritta: asks non array (oggetto) è rifiutato', async (t) => {
  const view = await subscribedView(t, { ...baseSnapshot(), asks: { 0: { id: 'a1' } } });
  assert.equal(view.lastError, 'snapshot-schema:asks');
});

test('porta: asks non array è error esplicito', async (t) => {
  assert.deepEqual(await doorResult(t, { ...baseSnapshot(), asks: 'no-array' }),
    { status: 'error', reason: 'snapshot-schema:asks' });
});

// ————————————————————————————— ogni ask: i campi che la card usa davvero ——

test('via sottoscritta: ask con ownerAskId non stringa è rifiutata', async (t) => {
  const snap = baseSnapshot();
  snap.asks[0].ownerAskId = 7;
  const view = await subscribedView(t, snap);
  assert.equal(view.lastError, 'snapshot-schema:asks');
  assert.deepEqual(view.asks, []);
});

test('porta: ask con ownerAskId non stringa è error esplicito', async (t) => {
  const snap = baseSnapshot();
  snap.asks[0].ownerAskId = 7;
  assert.deepEqual(await doorResult(t, snap), { status: 'error', reason: 'snapshot-schema:asks' });
});

test('via sottoscritta: ask con question non stringa è rifiutata', async (t) => {
  const view = await subscribedView(t, { ...baseSnapshot(), asks: [{ id: 'a1', question: 42, session: 'dev' }] });
  assert.equal(view.lastError, 'snapshot-schema:asks');
});

test('via sottoscritta: ask con options non array è rifiutata', async (t) => {
  const view = await subscribedView(t, { ...baseSnapshot(), asks: [{ id: 'a1', question: 'q', options: 'sì', session: 'dev' }] });
  assert.equal(view.lastError, 'snapshot-schema:asks');
});

test('via sottoscritta: ask con session non stringa è rifiutata', async (t) => {
  const view = await subscribedView(t, { ...baseSnapshot(), asks: [{ id: 'a1', question: 'q', session: 9 }] });
  assert.equal(view.lastError, 'snapshot-schema:asks');
});

test('via sottoscritta: ask con ts non numero è rifiutata', async (t) => {
  const view = await subscribedView(t, { ...baseSnapshot(), asks: [{ id: 'a1', question: 'q', session: 'dev', ts: '1' }] });
  assert.equal(view.lastError, 'snapshot-schema:asks');
});

test('porta: ask con options non array è error esplicito', async (t) => {
  assert.deepEqual(await doorResult(t, { ...baseSnapshot(), asks: [{ id: 'a1', question: 'q', options: 3, session: 'dev' }] }),
    { status: 'error', reason: 'snapshot-schema:asks' });
});

// Mapping storici BLOCCATI: id ed elemento restano motivo di cap, non di
// schema — la reason esistente non cambia.
test('via sottoscritta: ask senza id resta snapshot-element-oversize (mapping invariato)', async (t) => {
  const view = await subscribedView(t, { ...baseSnapshot(), asks: [{ question: 'q', session: 'dev' }] });
  assert.equal(view.lastError, 'snapshot-element-oversize');
});

test('via sottoscritta: ask id numerico resta snapshot-element-oversize (mapping invariato)', async (t) => {
  const view = await subscribedView(t, { ...baseSnapshot(), asks: [{ id: 42, question: 'q', session: 'dev' }] });
  assert.equal(view.lastError, 'snapshot-element-oversize');
});

test('porta: ask senza id resta snapshot-element-oversize (mapping invariato)', async (t) => {
  assert.deepEqual(await doorResult(t, { ...baseSnapshot(), asks: [{ question: 'q', session: 'dev' }] }),
    { status: 'error', reason: 'snapshot-element-oversize' });
});

// ——————————————————————————————————— flag e scalari, tipo esatto ——

test('via sottoscritta: cursor non stringa è rifiutato', async (t) => {
  const view = await subscribedView(t, { ...baseSnapshot(), cursor: 11 });
  assert.equal(view.lastError, 'snapshot-schema:cursor');
  assert.equal(view.cursor, null);
});

test('porta: cursor non stringa è error esplicito', async (t) => {
  assert.deepEqual(await doorResult(t, { ...baseSnapshot(), cursor: 11 }),
    { status: 'error', reason: 'snapshot-schema:cursor' });
});

test('via sottoscritta: viewEpoch non numero è rifiutato', async (t) => {
  const view = await subscribedView(t, { ...baseSnapshot(), viewEpoch: '1' });
  assert.equal(view.lastError, 'snapshot-schema:viewEpoch');
});

test('porta: viewEpoch non numero è error esplicito', async (t) => {
  assert.deepEqual(await doorResult(t, { ...baseSnapshot(), viewEpoch: '1' }),
    { status: 'error', reason: 'snapshot-schema:viewEpoch' });
});

test('via sottoscritta: askReplyAccess non booleano è rifiutato', async (t) => {
  const view = await subscribedView(t, { ...baseSnapshot(), askReplyAccess: 'yes' });
  assert.equal(view.lastError, 'snapshot-schema:askReplyAccess');
});

test('porta: askReplyAccess non booleano è error esplicito', async (t) => {
  assert.deepEqual(await doorResult(t, { ...baseSnapshot(), askReplyAccess: 'yes' }),
    { status: 'error', reason: 'snapshot-schema:askReplyAccess' });
});

test('via sottoscritta: resyncRequired non booleano è rifiutato (non solo true)', async (t) => {
  const view = await subscribedView(t, { ...baseSnapshot(), resyncRequired: 'true' });
  assert.equal(view.lastError, 'snapshot-schema:resyncRequired');
});

test('porta: resyncRequired non booleano è error esplicito', async (t) => {
  assert.deepEqual(await doorResult(t, { ...baseSnapshot(), resyncRequired: 'true' }),
    { status: 'error', reason: 'snapshot-schema:resyncRequired' });
});

// ————————————————————————————— notifications e fleetState, se presenti ——

test('via sottoscritta: notifications non array è rifiutato', async (t) => {
  const view = await subscribedView(t, { ...baseSnapshot(), notifications: 'no-array' });
  assert.equal(view.lastError, 'snapshot-schema:notifications');
  assert.deepEqual(view.notifications, []);
});

test('porta: notifications non array è error esplicito', async (t) => {
  assert.deepEqual(await doorResult(t, { ...baseSnapshot(), notifications: 'no-array' }),
    { status: 'error', reason: 'snapshot-schema:notifications' });
});

test('via sottoscritta: fleetState non oggetto è rifiutato', async (t) => {
  const view = await subscribedView(t, { ...baseSnapshot(), fleetState: 'stato' });
  assert.equal(view.lastError, 'snapshot-schema:fleetState');
  assert.equal(view.fleetState, null);
});

test('via sottoscritta: fleetState.available non booleano è rifiutato', async (t) => {
  const view = await subscribedView(t, { ...baseSnapshot(), fleetState: { available: 'yes', cells: [] } });
  assert.equal(view.lastError, 'snapshot-schema:fleetState');
});

test('via sottoscritta: fleetState.cells non array è rifiutato', async (t) => {
  const view = await subscribedView(t, { ...baseSnapshot(), fleetState: { available: true, cells: 'no' } });
  assert.equal(view.lastError, 'snapshot-schema:fleetState');
});

test('porta: fleetState non oggetto è error esplicito', async (t) => {
  assert.deepEqual(await doorResult(t, { ...baseSnapshot(), fleetState: 'stato' }),
    { status: 'error', reason: 'snapshot-schema:fleetState' });
});

// Assenza TOLLERATA dove il consumatore ha un default (applySnapshot): il
// floor dichiarato, non un rifiuto.
test('via sottoscritta: notifications e fleetState assenti sono ammessi', async (t) => {
  const snap = baseSnapshot();
  delete snap.notifications;
  delete snap.fleetState;
  const view = await subscribedView(t, snap);
  assert.equal(view.lastError, null);
  assert.equal(view.stale, false);
  assert.equal(view.asks.length, 1);
});

// ————————————————————————————— reason esistenti: identiche ——

test('via sottoscritta: ownerId estraneo resta owner-mismatch', async (t) => {
  const view = await subscribedView(t, { ...baseSnapshot(), ownerId: 'b'.repeat(32) });
  assert.equal(view.lastError, 'owner-mismatch');
});

test('porta: ownerId estraneo resta owner-mismatch', async (t) => {
  assert.deepEqual(await doorResult(t, { ...baseSnapshot(), ownerId: 'b'.repeat(32) }),
    { status: 'error', reason: 'owner-mismatch' });
});

test('via sottoscritta: resyncRequired true resta snapshot-resync-required', async (t) => {
  const view = await subscribedView(t, { ...baseSnapshot(), resyncRequired: true });
  assert.equal(view.lastError, 'snapshot-resync-required');
});

test('porta: resyncRequired true resta snapshot-resync-required', async (t) => {
  assert.deepEqual(await doorResult(t, { ...baseSnapshot(), resyncRequired: true }),
    { status: 'error', reason: 'snapshot-resync-required' });
});

// ————————————————————————————————————— positivi ——

test('via sottoscritta: snapshot completo è applicato', async (t) => {
  const view = await subscribedView(t, baseSnapshot());
  assert.equal(view.lastError, null);
  assert.equal(view.stale, false);
  assert.equal(view.cursor, '1:1');
  assert.equal(view.asks.length, 1);
  assert.equal(view.asks[0].id, 'a1');
  assert.equal(view.asks[0].ownerId, OWNER, 'l\'ask importata è attribuita all\'owner');
});

test('porta: snapshot completo è ok con l\'elenco asks', async (t) => {
  const snap = baseSnapshot();
  const out = await doorResult(t, snap);
  assert.equal(out.status, 'ok');
  assert.ok(Array.isArray(out.asks));
  assert.deepEqual(out.asks, snap.asks);
});

test('porta su owner SOTTOSCRITTO: snapshot senza asks è error, non ok', async (t) => {
  // La via della perdita dati dell'audit: owner sottoscritto, la porta passa
  // da snapshotOnce. Il validatore rifiuta prima dell'applicazione e la porta
  // NON può rispondere 'ok' con un elenco inesistente.
  const snap = baseSnapshot();
  delete snap.asks;
  const client = makeClient(t, {
    eventsReceive: true,
    responses: [{ ok: true, status: 200, text: async () => JSON.stringify(snap) }],
  });
  const out = await client.ownerSnapshotAsks(OWNER);
  assert.equal(out.status, 'error');
  assert.notEqual(out.status, 'ok');
  const view = client.viewFor(OWNER);
  assert.equal(view.lastError, 'snapshot-schema:asks');
  assert.deepEqual(view.asks, []);
});
