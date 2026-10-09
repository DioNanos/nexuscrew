'use strict';
// tests/snapshot-schema.test.js — le REGOLE dello snapshot vivono nel
// VALIDATORE UNICO (validateSnapshot), in DUE PROFILI dello stesso contratto:
//   - 'view' (via sottoscritta: poll() → snapshotOnce → applySnapshot): lo
//     SCHEMA COMPLETO dei campi che la vista applica. Un campo mancante o di
//     tipo sbagliato in QUALUNQUE punto non è MAI 'ok': lo snapshot non si
//     applica, niente applicazione parziale (view.lastError lo dice).
//   - 'decision' (la porta ownerSnapshotAsks, su owner NON sottoscritti): il
//     sottoinsieme che rende l'elenco asks AUTOREVOLE per la chiusura degli
//     alias importati (ownerId atteso, resyncRequired ben formato e non
//     dichiarante, content-type, asks elenco di oggetti con id 1..64, cap di
//     pagina e per-elemento, cap del corpo). I campi che la chiusura NON
//     legge non la bloccano: una vista non applicabile non è una prova che
//     l'ask sia ancora viva.
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

// Il content-type con cui un owner reale serve lo snapshot (Express:
// application/json + charset). `null` = dichiarazione assente.
const CT_JSON = 'application/json; charset=utf-8';
// Risposta snapshot come arriva da un owner reale: JSON DICHIARATO. Il
// validatore rifiuta chi dichiara un media type DIVERSO da application/json
// (text/plain non è la superficie dello snapshot, per quanto il corpo
// parsisca); la dichiarazione ASSENTE resta tollerata (proxy che spogliano
// gli header, trasporti degradati).
const snapRes = (snap, contentType = CT_JSON) => ({
  ok: true, status: 200,
  headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? contentType : null) },
  text: async () => JSON.stringify(snap),
});

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
  const fetchImpl = async (_url, opts = {}) => {
    const next = responses.shift();
    if (!next) return { ok: false, status: 500, text: async () => '', json: async () => ({}) };
    return typeof next === 'function' ? next(opts) : next;
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
// capability dichiarata e stream sano aperto fino all'abort. La view riporta l'esito.
async function subscribedView(t, snap, contentType = CT_JSON) {
  const health = { ok: true, status: 200, json: async () => ({ ok: true, instanceId: OWNER, eventFeedV1: true }) };
  let enteredStream;
  const streamEntered = new Promise((resolve) => { enteredStream = resolve; });
  const stream = ({ signal }) => ({
    ok: true, status: 200,
    body: { getReader: () => ({ read: () => {
      enteredStream();
      return new Promise((resolve) => {
        if (signal.aborted) resolve({ done: true });
        else signal.addEventListener('abort', () => resolve({ done: true }), { once: true });
      });
    } }) },
    text: async () => '',
  });
  const client = makeClient(t, {
    eventsReceive: true,
    responses: [health, snapRes(snap, contentType), stream],
  });
  const round = client.poll();
  await Promise.race([streamEntered, round]);
  client.stop();
  await round;
  return client.viewFor(OWNER);
}

// La PORTA per owner NON sottoscritti: esito tipizzato, MAI 'ok' su una forma
// rifiutata.
async function doorResult(t, snap, contentType = CT_JSON) {
  const client = makeClient(t, {
    eventsReceive: false,
    responses: [snapRes(snap, contentType)],
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

test('porta: ask con ownerAskId non stringa non blocca la decisione (è un campo della vista)', async (t) => {
  // Il profilo DECISION della porta legge id e cap di ogni elemento: i campi
  // interni della card li applica la vista. ownerAskId malformato tenuto
  // FUORI dalla view (test sopra), irrilevante per la chiusura.
  const snap = baseSnapshot();
  snap.asks[0].ownerAskId = 7;
  assert.equal((await doorResult(t, snap)).status, 'ok');
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

test('porta: ask con options non array non blocca la decisione (è un campo della vista)', async (t) => {
  assert.equal((await doorResult(t, { ...baseSnapshot(), asks: [{ id: 'a1', question: 'q', options: 3, session: 'dev' }] })).status, 'ok');
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

test('porta: cursor non stringa non blocca la decisione (la chiusura non lo legge)', async (t) => {
  // Il contratto della PORTA è decisionale: ownerId, resyncRequired,
  // content-type e l'elenco asks. Un cursor malformato rende lo snapshot non
  // applicabile alla VISTA (test sopra), ma non è una prova che l'ask sia
  // ancora viva: tenere aperta una card chiusa per colpa del cursor è il
  // difetto opposto.
  const out = await doorResult(t, { ...baseSnapshot(), cursor: 11 });
  assert.equal(out.status, 'ok');
  assert.ok(Array.isArray(out.asks));
});

test('via sottoscritta: viewEpoch non numero è rifiutato', async (t) => {
  const view = await subscribedView(t, { ...baseSnapshot(), viewEpoch: '1' });
  assert.equal(view.lastError, 'snapshot-schema:viewEpoch');
});

test('porta: viewEpoch non numero non blocca la decisione (la chiusura non lo legge)', async (t) => {
  assert.equal((await doorResult(t, { ...baseSnapshot(), viewEpoch: '1' })).status, 'ok');
});

test('via sottoscritta: askReplyAccess non booleano è rifiutato', async (t) => {
  const view = await subscribedView(t, { ...baseSnapshot(), askReplyAccess: 'yes' });
  assert.equal(view.lastError, 'snapshot-schema:askReplyAccess');
});

test('porta: askReplyAccess non booleano non blocca la decisione (è un campo della vista)', async (t) => {
  assert.equal((await doorResult(t, { ...baseSnapshot(), askReplyAccess: 'yes' })).status, 'ok');
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

test('porta: notifications non array non blocca la decisione (è un campo della vista)', async (t) => {
  assert.equal((await doorResult(t, { ...baseSnapshot(), notifications: 'no-array' })).status, 'ok');
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

test('porta: fleetState non oggetto non blocca la decisione (è un campo della vista)', async (t) => {
  assert.equal((await doorResult(t, { ...baseSnapshot(), fleetState: 'stato' })).status, 'ok');
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
  // La via della perdita dati della verifica: owner sottoscritto, la porta passa
  // da snapshotOnce. Il validatore rifiuta prima dell'applicazione e la porta
  // NON può rispondere 'ok' con un elenco inesistente.
  const snap = baseSnapshot();
  delete snap.asks;
  const client = makeClient(t, {
    eventsReceive: true,
    responses: [snapRes(snap)],
  });
  const out = await client.ownerSnapshotAsks(OWNER);
  assert.equal(out.status, 'error');
  assert.notEqual(out.status, 'ok');
  const view = client.viewFor(OWNER);
  assert.equal(view.lastError, 'snapshot-schema:asks');
  assert.deepEqual(view.asks, []);
});

// ————————————————————————————— content-type: JSON dichiarato ——

test('via sottoscritta: snapshot servito come text/plain è rifiutato, mai applicato', async (t) => {
  const view = await subscribedView(t, baseSnapshot(), 'text/plain');
  assert.equal(view.lastError, 'snapshot-content-type');
  assert.equal(view.stale, true);
  assert.deepEqual(view.asks, []);
  assert.equal(view.cursor, null);
});

test('porta: snapshot servito come text/plain è error esplicito, mai ok', async (t) => {
  assert.deepEqual(await doorResult(t, baseSnapshot(), 'text/plain'),
    { status: 'error', reason: 'snapshot-content-type' });
});

test('porta: snapshot senza content-type dichiarato resta ammesso', async (t) => {
  // La regola colpisce chi dichiara un tipo SBAGLIATO: la dichiarazione
  // assenta (proxy che spoglia gli header, trasporto degradato) non è una
  // dichiarazione falsa. Con le stub fetch senza headers del tutto vale lo
  // stesso contratto (test sotto).
  const out = await doorResult(t, baseSnapshot(), null);
  assert.equal(out.status, 'ok');
});

test('porta: risposta senza header del tutto resta ammessa', async (t) => {
  const snap = baseSnapshot();
  const client = makeClient(t, {
    eventsReceive: false,
    responses: [{ ok: true, status: 200, text: async () => JSON.stringify(snap) }],
  });
  const out = await client.ownerSnapshotAsks(OWNER);
  assert.equal(out.status, 'ok');
  assert.ok(Array.isArray(out.asks));
});

test('porta su owner SOTTOSCRITTO: text/plain è error, non ok', async (t) => {
  const snap = baseSnapshot();
  const client = makeClient(t, {
    eventsReceive: true,
    responses: [snapRes(snap, 'text/plain')],
  });
  const out = await client.ownerSnapshotAsks(OWNER);
  assert.deepEqual(out, { status: 'error', reason: 'snapshot-failed' });
  assert.equal(client.viewFor(OWNER).lastError, 'snapshot-content-type');
});

test('porta: application/json con charset è la superficie ammessa', async (t) => {
  const out = await doorResult(t, baseSnapshot(), 'application/json; charset=utf-8');
  assert.equal(out.status, 'ok');
});

// ————————————————————— content-type anche sulla via sottoscritta ——

test('porta su owner SOTTOSCRITTO: content-type dichiarato sbagliato è rifiutato dalla porta stessa', async (t) => {
  // Non basta che la VIEW rifiuti: la porta deve avere lo stesso gate, al
  // profilo decisionale — su questa via lo snapshot passa da snapshotOnce.
  const snap = baseSnapshot();
  const client = makeClient(t, {
    eventsReceive: true,
    responses: [snapRes(snap, 'text/html; charset=utf-8')],
  });
  const out = await client.ownerSnapshotAsks(OWNER);
  assert.deepEqual(out, { status: 'error', reason: 'snapshot-failed' });
  assert.equal(client.viewFor(OWNER).lastError, 'snapshot-content-type');
});

// ————————————————————— resyncRequired: booleano o niente ——

test('via sottoscritta: resyncRequired numerico è rifiutato', async (t) => {
  const view = await subscribedView(t, { ...baseSnapshot(), resyncRequired: 1 });
  assert.equal(view.lastError, 'snapshot-schema:resyncRequired');
  assert.deepEqual(view.asks, []);
});

test('porta: resyncRequired numerico è error esplicito', async (t) => {
  assert.deepEqual(await doorResult(t, { ...baseSnapshot(), resyncRequired: 1 }),
    { status: 'error', reason: 'snapshot-schema:resyncRequired' });
});

test('porta: resyncRequired stringa "true" è error esplicito', async (t) => {
  assert.deepEqual(await doorResult(t, { ...baseSnapshot(), resyncRequired: 'true' }),
    { status: 'error', reason: 'snapshot-schema:resyncRequired' });
});

test('porta: resyncRequired oggetto è error esplicito', async (t) => {
  assert.deepEqual(await doorResult(t, { ...baseSnapshot(), resyncRequired: { required: true } }),
    { status: 'error', reason: 'snapshot-schema:resyncRequired' });
});

test('porta: resyncRequired false è la forma ammessa', async (t) => {
  const out = await doorResult(t, { ...baseSnapshot(), resyncRequired: false });
  assert.equal(out.status, 'ok');
});

// ——— cap di pagina: il marcatore dice che la FONTE superava la pagina ———

test('porta: elenco ESATTAMENTE al cap di pagina (100) senza marcatore è intero e prova l\'assenza', async (t) => {
  // Il produttore decide il marcatore sul conteggio della FONTE, prima del
  // taglio: una pagina di 100 da una fonte non più grande è l'elenco intero
  // dell'owner, e va a ok. Il marcatore compare solo quando la fonte aveva
  // più voci della pagina.
  const asks = Array.from({ length: 100 }, (_, i) => ({ id: `a${i}`, question: 'q', session: 'dev' }));
  const out = await doorResult(t, { ...baseSnapshot(), asks });
  assert.equal(out.status, 'ok');
  assert.equal(out.asks.length, 100);
});

test('porta: elenco OLTRE il cap di pagina (101) senza marcatore non prova nessuna assenza', async (t) => {
  // Il produttore non emette mai più di 100 voci: un elenco più lungo non è
  // una forma dell'owner, e l'assenza di una domanda lì non è provabile.
  const asks = Array.from({ length: 101 }, (_, i) => ({ id: `a${i}`, question: 'q', session: 'dev' }));
  assert.deepEqual(await doorResult(t, { ...baseSnapshot(), asks }),
    { status: 'error', reason: 'snapshot-element-oversize' });
});

test('porta: elenco al cap CON il marcatore è il floor dichiarato (resync-required)', async (t) => {
  const asks = Array.from({ length: 100 }, (_, i) => ({ id: `a${i}`, question: 'q', session: 'dev' }));
  assert.deepEqual(await doorResult(t, { ...baseSnapshot(), asks, resyncRequired: true }),
    { status: 'error', reason: 'snapshot-resync-required' });
});

test('porta: 99 ask sono un elenco pieno ma provabile', async (t) => {
  const asks = Array.from({ length: 99 }, (_, i) => ({ id: `a${i}`, question: 'q', session: 'dev' }));
  const out = await doorResult(t, { ...baseSnapshot(), asks });
  assert.equal(out.status, 'ok');
  assert.equal(out.asks.length, 99);
});

// ——————— la porta non legge i campi della vista, MA la vista resta protetta ——

test('via sottoscritta via PORTA (owner sottoscritto): decisione ok, vista non applicabile', async (t) => {
  // viewEpoch stringa: la porta risponde 'ok' (la chiusura legge asks), la
  // vista NON applica lo snapshot e resta stale con la sua causa.
  const snap = baseSnapshot();
  snap.viewEpoch = '1';
  const client = makeClient(t, {
    eventsReceive: true,
    responses: [snapRes(snap)],
  });
  const out = await client.ownerSnapshotAsks(OWNER);
  assert.equal(out.status, 'ok');
  assert.ok(Array.isArray(out.asks));
  const view = client.viewFor(OWNER);
  assert.equal(view.lastError, 'snapshot-schema:viewEpoch');
  assert.deepEqual(view.asks, [], 'la vista non applica lo snapshot che non sa applicare');
});
