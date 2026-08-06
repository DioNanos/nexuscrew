'use strict';
// tests/cell-scope-decks.test.js — i deck sono il quarto elenco, e non lo
// sembravano.
//
// Il guard filtrava `cells`, `sessions` e `unmanaged`. Un deck non contiene
// nessuna di quelle chiavi: contiene TILE, e ogni tile porta il nome della
// sessione tmux. A un peer ristretto a `Research` arrivava quindi la mappa
// completa delle celle dell'hub — non il contenuto, ma l'esistenza e il nome,
// che e' precisamente cio' che lo scope celle promette di non dare.
//
// Trovato dall'audit indipendente su NC-E, non da questo codice. E' il motivo
// per cui il filtro dei tre elenchi noti non basta come garanzia: la domanda
// giusta non e' "ho filtrato gli elenchi?" ma "quale risposta nomina una cella?".
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createCellScopeGuard, filterDecks } = require('../lib/cells/scope-guard.js');
const { createCellScope } = require('../lib/cells/scope.js');

const LOCAL = 'a'.repeat(32);
const PEER = 'b'.repeat(32);
const OTHER = 'c'.repeat(32);

const cellForSession = (s) => (s && s.startsWith('cloud-') ? s.slice('cloud-'.length) : null);
const storeWith = (...nodes) => ({ nodeId: LOCAL, nodes });
const peer = (extra = {}) => ({
  name: 'peer', nodeId: PEER, visibility: 'network', shared: true, cellVisibility: 'all', ...extra,
});
const RESTRICTED = () => storeWith(peer({ cellVisibility: 'selected', cells: ['Research'] }));

const tile = (session, extra = {}) => ({ session, height: 50, fontSize: 14, ...extra });
const deck = (name, tiles) => ({ name, revision: 1, layout: { columns: [{ width: 100, tiles }] } });

// Scope risolto come lo risolve la produzione, cosi' il test non reimplementa
// il predicato che vuole provare.
function scopeFor(store) {
  return createCellScope({ nodesPath: '/finto', loadStoreImpl: () => store, cellForSession })
    .resolve({ trust: 'federated', visited: [PEER, LOCAL] });
}

// --- il filtro ------------------------------------------------------------

test('un peer ristretto vede solo i tile delle celle concesse', () => {
  const scope = scopeFor(RESTRICTED());
  const out = filterDecks([deck('main', [tile('cloud-Dev'), tile('cloud-Research'), tile('cloud-Foxy')])], scope);
  assert.equal(out.length, 1);
  const sessions = out[0].layout.columns[0].tiles.map((t) => t.session);
  assert.deepEqual(sessions, ['cloud-Research']);
});

test('un deck fatto solo di celle non concesse sparisce, invece di comparire vuoto', () => {
  // Un deck vuoto e' la stessa rivelazione in negativo: "esiste un deck che
  // non puoi vedere" dice comunque che esiste.
  const scope = scopeFor(RESTRICTED());
  const out = filterDecks([deck('segreto', [tile('cloud-Dev')]), deck('main', [tile('cloud-Research')])], scope);
  assert.deepEqual(out.map((d) => d.name), ['main']);
});

test('una colonna rimasta senza tile non sopravvive alla colonna accanto', () => {
  const scope = scopeFor(RESTRICTED());
  const out = filterDecks([{
    name: 'main',
    revision: 1,
    layout: { columns: [{ width: 50, tiles: [tile('cloud-Dev')] }, { width: 50, tiles: [tile('cloud-Research')] }] },
  }], scope);
  assert.equal(out[0].layout.columns.length, 1);
  assert.deepEqual(out[0].layout.columns[0].tiles.map((t) => t.session), ['cloud-Research']);
});

test('un tile che punta a un ALTRO nodo resta: lo scope governa le celle di QUESTO hub', () => {
  const scope = scopeFor(RESTRICTED());
  const out = filterDecks([deck('main', [
    tile('cloud-Dev', { node: 'altro-nodo' }),
    tile('cloud-Dev', { ownerId: OTHER }),
    tile('cloud-Dev'),
  ])], scope);
  const kept = out[0].layout.columns[0].tiles;
  assert.equal(kept.length, 2, 'restano i due remoti, cade il locale');
  assert.ok(kept.every((t) => t.node || t.ownerId));
});

test('un tile con l\'ownerId di QUESTO nodo e\' locale, e si filtra come tale', () => {
  // Altrimenti basterebbe scrivere il proprio ownerId nel tile per far
  // sembrare remota una cella locale.
  const scope = scopeFor(RESTRICTED());
  const out = filterDecks([deck('main', [tile('cloud-Dev', { ownerId: LOCAL }), tile('cloud-Research')])], scope);
  assert.deepEqual(out[0].layout.columns[0].tiles.map((t) => t.session), ['cloud-Research']);
});

test('se il nodeId locale non e\' noto, un ownerId si tratta come locale (fail-closed)', () => {
  // Store senza nodeId: non sappiamo chi siamo. Sbagliare in questo verso
  // costa un tile in meno; sbagliare nell'altro costa un nome di cella in piu'.
  const store = { nodes: [peer({ cellVisibility: 'selected', cells: ['Research'] })] };
  const scope = createCellScope({ nodesPath: '/finto', loadStoreImpl: () => store, cellForSession })
    .resolve({ trust: 'federated', visited: [PEER, LOCAL] });
  const out = filterDecks([deck('main', [tile('cloud-Dev', { ownerId: OTHER })])], scope);
  assert.equal(out.length, 0, 'senza identita\' locale il tile non passa');
});

test('una sessione che non appartiene a nessuna cella e\' fuori da ogni scope', () => {
  const scope = scopeFor(RESTRICTED());
  const out = filterDecks([deck('main', [tile('tmux-fatta-a-mano'), tile('cloud-Research')])], scope);
  assert.deepEqual(out[0].layout.columns[0].tiles.map((t) => t.session), ['cloud-Research']);
});

test('scope `all`: il payload non viene toccato', () => {
  const scope = scopeFor(storeWith(peer()));
  const decks = [deck('main', [tile('cloud-Dev'), tile('cloud-Research')])];
  const out = filterDecks(decks, scope);
  assert.deepEqual(out[0].layout.columns[0].tiles.map((t) => t.session), ['cloud-Dev', 'cloud-Research']);
});

test('una forma inattesa passa invece di essere svuotata in silenzio', () => {
  // Se domani il layout cambia, meglio un test che si rompe di un elenco che
  // si azzera senza che nessuno se ne accorga.
  const scope = scopeFor(RESTRICTED());
  const strano = { name: 'main', revision: 1, layout: { rows: [] } };
  assert.deepEqual(filterDecks([strano], scope), [strano]);
});

// --- il guard, dal vivo ---------------------------------------------------

function appWith(store) {
  const app = express();
  app.use(express.json());
  app.use(createCellScopeGuard({
    nodesPath: '/finto',
    loadStoreImpl: () => store,
    cellForSession,
    resolveOrigin: (req) => (req.headers['x-test-visited']
      ? { ok: true, trust: 'federated', visited: String(req.headers['x-test-visited']).split(',') }
      : { ok: true, trust: 'local-bridge' }),
  }));
  app.get('/decks', (_req, res) => res.json({
    schemaVersion: 1,
    decks: [deck('main', [tile('cloud-Dev'), tile('cloud-Research')])],
  }));
  return app;
}

const listen = (app) => new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
const get = async (srv, visited) => {
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/decks`, {
    headers: visited ? { 'x-test-visited': visited.join(',') } : {},
  });
  return { status: r.status, payload: await r.json() };
};

test('GET /decks federata: al peer ristretto arriva solo la cella concessa', async (t) => {
  const srv = await listen(appWith(RESTRICTED()));
  t.after(() => srv.close());
  const { status, payload } = await get(srv, [PEER, LOCAL]);
  assert.equal(status, 200);
  const sessions = payload.decks.flatMap((d) => d.layout.columns.flatMap((c) => c.tiles.map((x) => x.session)));
  assert.deepEqual(sessions, ['cloud-Research']);
  assert.ok(!JSON.stringify(payload).includes('cloud-Dev'), 'nessuna traccia della cella non concessa');
});

test('GET /decks locale: il proprietario della macchina vede tutto', async (t) => {
  const srv = await listen(appWith(RESTRICTED()));
  t.after(() => srv.close());
  const { payload } = await get(srv, null);
  const sessions = payload.decks.flatMap((d) => d.layout.columns.flatMap((c) => c.tiles.map((x) => x.session)));
  assert.deepEqual(sessions, ['cloud-Dev', 'cloud-Research']);
});

// --- rete di sicurezza sulle route non dichiarate -------------------------
// L'audit ha misurato il limite della prima versione: `body.cell` veniva
// fermato, `body.cellId` no. La tabella delle route resta la prima linea; qui
// si prova che la seconda non dipenda dal nome esatto che qualcuno scegliera'.

function appWithUnknownRoute(store) {
  const app = express();
  app.use(express.json());
  app.use(createCellScopeGuard({
    nodesPath: '/finto',
    loadStoreImpl: () => store,
    cellForSession,
    resolveOrigin: (req) => (req.headers['x-test-visited']
      ? { ok: true, trust: 'federated', visited: String(req.headers['x-test-visited']).split(',') }
      : { ok: true, trust: 'local-bridge' }),
  }));
  // Route inventata: e' il caso "qualcuno la aggiunge domani e dimentica la
  // tabella".
  app.post('/route-nuova', (_req, res) => res.json({ ok: true }));
  return app;
}

const post = async (srv, body, visited) => {
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/route-nuova`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(visited ? { 'x-test-visited': visited.join(',') } : {}) },
    body: JSON.stringify(body),
  });
  return r.status;
};

test('route non dichiarata: il bersaglio si riconosce dalla forma del nome, non da un elenco', async (t) => {
  const srv = await listen(appWithUnknownRoute(RESTRICTED()));
  t.after(() => srv.close());
  for (const body of [{ cell: 'Dev' }, { cellId: 'Dev' }, { targetCell: 'Dev' }, { sessionName: 'cloud-Dev' }, { tmuxSession: 'cloud-Dev' }]) {
    assert.equal(await post(srv, body, [PEER, LOCAL]), 403, `atteso 403 per ${JSON.stringify(body)}`);
  }
});

test('un corpo che non nomina celle passa: la rete di sicurezza non e\' un muro', async (t) => {
  const srv = await listen(appWithUnknownRoute(RESTRICTED()));
  t.after(() => srv.close());
  assert.equal(await post(srv, { volume: 3 }, [PEER, LOCAL]), 200);
});

test('il locale non passa dalla rete di sicurezza', async (t) => {
  const srv = await listen(appWithUnknownRoute(RESTRICTED()));
  t.after(() => srv.close());
  assert.equal(await post(srv, { cellId: 'Dev' }, null), 200);
});

// --- regressione: la provenienza non e' un bersaglio ----------------------
// rc.17 ha rotto /notify e /audio/speak federati per ogni peer ristretto: il
// loro corpo porta `originCell`, che il SERVER scrive come provenienza
// attestata, e il criterio di forma lo scambiava per il bersaglio di una route
// dimenticata. Due funzioni sane bloccate da una rete di sicurezza.
//
// Trovato dalla riverifica dell'audit, misurato. Da qui in poi la regressione
// e' coperta: le due route sono dichiarate, e una chiave di provenienza non
// fa scattare la rete nemmeno su una route sconosciuta.

const { filterRecords } = require('../lib/cells/scope-guard.js');

function appWithSideRoutes(store) {
  const app = express();
  app.use(express.json());
  app.use(createCellScopeGuard({
    nodesPath: '/finto',
    loadStoreImpl: () => store,
    cellForSession,
    resolveOrigin: (req) => (req.headers['x-test-visited']
      ? { ok: true, trust: 'federated', visited: String(req.headers['x-test-visited']).split(',') }
      : { ok: true, trust: 'local-bridge' }),
  }));
  app.post('/notify', (_req, res) => res.json({ ok: true }));
  app.post('/audio/speak', (_req, res) => res.json({ ok: true }));
  app.post('/route-nuova', (_req, res) => res.json({ ok: true }));
  app.get('/diagnostics/logs', (_req, res) => res.json({
    records: [
      { seq: 1, code: 'A', meta: { cell: 'Dev' } },
      { seq: 2, code: 'B', meta: { cell: 'Research' } },
      { seq: 3, code: 'C', meta: {} },
    ],
  }));
  return app;
}

const send = async (srv, path, body, visited) => {
  const r = await fetch(`http://127.0.0.1:${srv.address().port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(visited ? { 'x-test-visited': visited.join(',') } : {}) },
    body: JSON.stringify(body),
  });
  return r.status;
};

test('/notify federata passa anche a un peer ristretto: la notifica non ha un bersaglio cella', async (t) => {
  const srv = await listen(appWithSideRoutes(RESTRICTED()));
  t.after(() => srv.close());
  assert.equal(await send(srv, '/notify', { title: 'x', originCell: 'Dev' }, [PEER, LOCAL]), 200);
});

test('/audio/speak federata passa: il suo permesso e\' l\'ACL per-nodo, non lo scope celle', async (t) => {
  const srv = await listen(appWithSideRoutes(RESTRICTED()));
  t.after(() => srv.close());
  assert.equal(await send(srv, '/audio/speak', { text: 'x', originCell: 'Dev' }, [PEER, LOCAL]), 200);
});

test('una chiave di provenienza non fa scattare la rete nemmeno su una route sconosciuta', async (t) => {
  const srv = await listen(appWithSideRoutes(RESTRICTED()));
  t.after(() => srv.close());
  assert.equal(await send(srv, '/route-nuova', { originCell: 'Dev' }, [PEER, LOCAL]), 200);
  assert.equal(await send(srv, '/route-nuova', { fromCell: 'Dev' }, [PEER, LOCAL]), 200);
  // ...ma un BERSAGLIO su quella stessa route resta negato.
  assert.equal(await send(srv, '/route-nuova', { cellId: 'Dev' }, [PEER, LOCAL]), 403);
});

test('/diagnostics/logs: i record di celle non concesse non escono', async (t) => {
  const srv = await listen(appWithSideRoutes(RESTRICTED()));
  t.after(() => srv.close());
  const r = await fetch(`http://127.0.0.1:${srv.address().port}/diagnostics/logs`, {
    headers: { 'x-test-visited': [PEER, LOCAL].join(',') },
  });
  const payload = await r.json();
  assert.deepEqual(payload.records.map((x) => x.seq), [2, 3], 'resta Research e il record senza cella');
  assert.ok(!JSON.stringify(payload).includes('Dev'));
});

test('un record senza cella passa: lo scope governa le celle, non i diagnostici di sistema', () => {
  const scope = scopeFor(RESTRICTED());
  const out = filterRecords([{ seq: 1, meta: {} }, { seq: 2 }, { seq: 3, meta: { cell: 'Dev' } }], scope);
  assert.deepEqual(out.map((x) => x.seq), [1, 2]);
});
