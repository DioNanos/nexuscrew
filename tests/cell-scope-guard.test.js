'use strict';
// tests/cell-scope-guard.test.js — il punto di decisione unico.
//
// I canali da cui una cella puo' trapelare sono tredici. Applicare il filtro
// route per route significa dimenticarne uno, e un permesso che vale su dodici
// canali su tredici non e' un permesso: e' un'etichetta. Questo middleware sta
// in testa al router /api e decide una volta sola, sia per le LETTURE (filtra
// cio' che esce) sia per le AZIONI (rifiuta cio' che punta fuori scope).
//
// Il bersaglio di ogni route e' dichiarato in una tabella esplicita, non
// indovinato: preferisco un elenco che qualcuno dovra' estendere a una regola
// magica che sbaglia in silenzio quando arriva una route nuova.
const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { createCellScopeGuard } = require('../lib/cells/scope-guard.js');

const LOCAL = 'a'.repeat(32);
const PEER = 'b'.repeat(32);

const storeWith = (...nodes) => ({ nodeId: LOCAL, nodes });
const peer = (extra = {}) => ({
  name: 'peer', nodeId: PEER, visibility: 'network', shared: true, cellVisibility: 'all', ...extra,
});
const cellForSession = (s) => (s && s.startsWith('cloud-') ? s.slice('cloud-'.length) : null);

// App di prova: il guard davanti a route che imitano quelle vere.
function appWith(store, { federated = true } = {}) {
  const app = express();
  app.use(express.json());
  app.use(createCellScopeGuard({
    nodesPath: '/finto',
    loadStoreImpl: () => store,
    cellForSession,
    // Seam: nei test l'origine e' dichiarata invece che provata dall'hop,
    // cosi' questo file prova il GUARD e non di nuovo la prova di hop (che ha
    // gia' i suoi test in ws-federated-origin e audio).
    resolveOrigin: (req) => (federated && req.headers['x-test-visited']
      ? { ok: true, trust: 'federated', visited: String(req.headers['x-test-visited']).split(',') }
      : { ok: true, trust: 'local-bridge' }),
  }));
  app.get('/cells', (_req, res) => res.json({ cells: [{ cell: 'Dev' }, { cell: 'Research' }] }));
  app.get('/fleet/status', (_req, res) => res.json({ available: true, cells: [{ cell: 'Dev' }, { cell: 'Research' }] }));
  app.get('/sessions', (_req, res) => res.json({ sessions: [{ name: 'cloud-Dev', preview: 'segreto' }, { name: 'cloud-Research' }] }));
  app.post('/cells/send', (_req, res) => res.json({ ok: true }));
  app.post('/fleet/up', (_req, res) => res.json({ ok: true }));
  app.post('/fleet/define-cell', (_req, res) => res.json({ ok: true }));
  app.delete('/sessions/:name', (_req, res) => res.json({ ok: true }));
  app.get('/files', (_req, res) => res.json({ files: [] }));
  return app;
}

function listen(app) {
  return new Promise((res) => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
}
const call = async (srv, method, path, { body, visited } = {}) => {
  const r = await fetch(`http://127.0.0.1:${srv.address().port}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(visited ? { 'x-test-visited': visited.join(',') } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const payload = await r.json().catch(() => null);
  return { status: r.status, payload };
};

const RESTRICTED = () => storeWith(peer({ cellVisibility: 'selected', cells: ['Research'] }));

test('gli elenchi escono filtrati: /cells, /fleet/status e /sessions insieme', async (t) => {
  const srv = await listen(appWith(RESTRICTED()));
  t.after(() => srv.close());
  const chain = [PEER, LOCAL];

  const cells = await call(srv, 'GET', '/cells', { visited: chain });
  assert.deepEqual(cells.payload.cells.map((c) => c.cell), ['Research']);

  // Questo e' l'elenco che la PWA remota usa DAVVERO: filtrare /cells e non
  // questo significa non filtrare niente per l'utente reale.
  const fleet = await call(srv, 'GET', '/fleet/status', { visited: chain });
  assert.deepEqual(fleet.payload.cells.map((c) => c.cell), ['Research']);

  // Le sessioni portano anche `preview`, cioe' CONTENUTO del terminale: una
  // cella nascosta con anteprima visibile e' peggio di una cella visibile.
  const sess = await call(srv, 'GET', '/sessions', { visited: chain });
  assert.deepEqual(sess.payload.sessions.map((s) => s.name), ['cloud-Research']);
  assert.equal(JSON.stringify(sess.payload).includes('segreto'), false, 'l\'anteprima di una cella fuori scope non deve uscire');
});

test('le azioni fuori scope sono rifiutate, quelle dentro passano', async (t) => {
  const srv = await listen(appWith(RESTRICTED()));
  t.after(() => srv.close());
  const chain = [PEER, LOCAL];

  assert.equal((await call(srv, 'POST', '/fleet/up', { body: { cell: 'Dev' }, visited: chain })).status, 403);
  assert.equal((await call(srv, 'POST', '/fleet/up', { body: { cell: 'Research' }, visited: chain })).status, 200);

  assert.equal((await call(srv, 'POST', '/cells/send', {
    body: { to: { cell: 'Dev', tmuxSession: 'cloud-Dev' }, text: 'ciao' }, visited: chain,
  })).status, 403);
  assert.equal((await call(srv, 'POST', '/cells/send', {
    body: { to: { cell: 'Research', tmuxSession: 'cloud-Research' }, text: 'ciao' }, visited: chain,
  })).status, 200);

  assert.equal((await call(srv, 'DELETE', '/sessions/cloud-Dev', { visited: chain })).status, 403);
  assert.equal((await call(srv, 'GET', '/files?session=cloud-Dev', { visited: chain })).status, 403);
});

test('definire celle non e\' concesso a chi ha uno scope ristretto', async (t) => {
  const srv = await listen(appWith(RESTRICTED()));
  t.after(() => srv.close());
  // Senza questo, un peer con accesso a una sola cella se ne crea un'altra e
  // ci agisce: il permesso si aggirerebbe da solo.
  assert.equal((await call(srv, 'POST', '/fleet/define-cell', {
    body: { def: { id: 'Nuova' } }, visited: [PEER, LOCAL],
  })).status, 403);
});

test('un peer senza restrizioni non subisce alcun cambiamento', async (t) => {
  const srv = await listen(appWith(storeWith(peer())));
  t.after(() => srv.close());
  const chain = [PEER, LOCAL];
  const cells = await call(srv, 'GET', '/cells', { visited: chain });
  assert.deepEqual(cells.payload.cells.map((c) => c.cell), ['Dev', 'Research']);
  assert.equal((await call(srv, 'POST', '/fleet/up', { body: { cell: 'Dev' }, visited: chain })).status, 200);
});

test('le richieste locali non sono toccate', async (t) => {
  const srv = await listen(appWith(RESTRICTED()));
  t.after(() => srv.close());
  const cells = await call(srv, 'GET', '/cells');
  assert.deepEqual(cells.payload.cells.map((c) => c.cell), ['Dev', 'Research']);
  assert.equal((await call(srv, 'POST', '/fleet/up', { body: { cell: 'Dev' } })).status, 200);
});

test('un peer sconosciuto non vede nulla e non agisce', async (t) => {
  const srv = await listen(appWith(storeWith()));
  t.after(() => srv.close());
  const chain = [PEER, LOCAL];
  assert.deepEqual((await call(srv, 'GET', '/cells', { visited: chain })).payload.cells, []);
  assert.equal((await call(srv, 'POST', '/fleet/up', { body: { cell: 'Research' }, visited: chain })).status, 403);
});

test('una route che nomina una cella ma non e\' in tabella viene NEGATA, non ignorata', async (t) => {
  // Il difetto da impedire: aggiungere domani una route con `body.cell` e non
  // accorgersi che sfugge al guard. Una route sconosciuta che porta un
  // bersaglio riconoscibile deve chiudersi, non aprirsi.
  const app = appWith(RESTRICTED());
  app.post('/rotta/nuova/inventata', (_req, res) => res.json({ ok: true }));
  const srv = await listen(app);
  t.after(() => srv.close());
  const res = await call(srv, 'POST', '/rotta/nuova/inventata', {
    body: { cell: 'Dev' }, visited: [PEER, LOCAL],
  });
  assert.equal(res.status, 403, 'una route non dichiarata che nomina una cella deve essere fail-closed');
});
