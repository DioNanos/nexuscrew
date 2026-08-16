'use strict';
// tests/live-host-federation.test.js — designare la cella ospite Live di un
// nodo REMOTO, via federazione, sul modello gia' verificato per il pannello
// (panel-auth-live.test.js): due server veri (HUB + REMOTO), la via allowlistata
// /api/route/<peer>/_/live-host*, un gate PER-PEER a default negato.
//
// Il difetto che questo test chiude: getLiveHost/designateHostCell/clearHostCell
// non accettavano `route` e la risorsa non era instradabile via /api/route (ne'
// nota ne' allowlistata) — quindi un peer che lavora da un nodo verso un altro
// comandava sempre il NexusCrew che serve la pagina, mai quello che possiede la
// cella. La guardia che conta: senza permesso il rifiuto NOMINA LA CAUSA (come
// fa il pannello con 'panel-not-granted'), mai un silenzio; con permesso la
// designazione arriva davvero e la stella cambia.

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const federation = require('../lib/proxy/federation.js');
const nodesStore = require('../lib/nodes/store.js');
const { requireToken } = require('../lib/auth/middleware.js');
const { liveHostRoutes } = require('../lib/live-host/routes.js');
const { createLiveHostStore } = require('../lib/live-host/store.js');

const TOKEN = 'buono';

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', r));

// Fleet finto: UNA cella locale 'A', attiva, senza lease (fallback tmux-only
// dichiarato in routes.js — eligibile se attiva).
function fleetFinto() {
  return Promise.resolve({
    available: true,
    status: async () => ({ cells: [{ cell: 'A', active: true, tmux: true }] }),
  });
}

// Stessa forma di federazioneDiProva (panel-auth-live.test.js): REMOTO con API
// vera + listener federato vero; HUB con la via /api/route dietro il Bearer
// della PWA. Qui la risorsa e' /live-host, non /panel: niente ticket/cookie/ws.
async function federazioneDiProva({ liveHostAccess } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-livehost-fed-'));
  // Server gia' in ascolto: tracciati man mano, cosi' un errore a META' setup
  // (es. store che rifiuta ancora il campo del permesso: e' PROPRIO il rosso
  // che questo file deve dimostrare) chiude cio' che e' gia' partito invece di
  // lasciare handle orfani — altrimenti non e' un rosso, e' un'attesa infinita
  // (stesso rimedio di ws-preauth.test.js/notify-api.test.js, qui applicato
  // anche al percorso di errore, non solo al close finale).
  const avviati = [];
  const chiudiTutto = async () => {
    for (const srv of avviati.splice(0)) {
      if (typeof srv.closeAllConnections === 'function') srv.closeAllConnections();
      await new Promise((r) => srv.close(r));
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };

  try {
    const HUB_TOKEN = 'f'.repeat(40);        // hub -> remoto (presentato al peerRouter)
    const REMOTE_ACCEPT = HUB_TOKEN;         // il remoto riconosce l'hub da questo
    const REMOTE_TOKEN_OUT = 'e'.repeat(40); // remoto -> hub (non usato qui)
    const HUB_NODE_ID = 'a'.repeat(32);
    const REMOTE_NODE_ID = 'b'.repeat(32);

    // REMOTO: API vera (requireToken + liveHostRoutes) + listener federato vero.
    const remoteApi = express();
    remoteApi.use('/api', requireToken({ get: () => TOKEN }));
    remoteApi.use('/api/live-host', liveHostRoutes({
      fleetP: fleetFinto(),
      store: createLiveHostStore({ filePath: path.join(dir, 'live-host.json') }),
      readonly: () => false,
    }));
    const remoteApiSrv = http.createServer(remoteApi);
    await listen(remoteApiSrv);
    avviati.push(remoteApiSrv);

    const remoteNodesPath = path.join(dir, 'remote-nodes.json');
    const rst = nodesStore.addNode(nodesStore.emptyStore(REMOTE_NODE_ID), {
      name: 'hub', remotePort: 41821, localPort: 41821, direction: 'inbound', transport: 'inbound',
      autostart: true, shared: true, visibility: 'network', nodeId: HUB_NODE_ID,
      token: REMOTE_TOKEN_OUT, acceptToken: REMOTE_ACCEPT,
      ...(liveHostAccess !== undefined ? { liveHostAccess } : {}),
    });
    nodesStore.atomicWriteStore(remoteNodesPath, rst);
    const remoteFed = express();
    remoteFed.use('/federation', federation.peerRouter({
      nodesPath: remoteNodesPath, localPort: remoteApiSrv.address().port,
      localCredential: () => TOKEN, hopSecret: 'hopsegreto',
    }));
    const remoteFedSrv = http.createServer(remoteFed);
    await listen(remoteFedSrv);
    avviati.push(remoteFedSrv);

    // HUB: la PWA entra col suo Bearer, la risorsa viaggia sulla via federata.
    const hubNodesPath = path.join(dir, 'hub-nodes.json');
    const hst = nodesStore.addNode(nodesStore.emptyStore(HUB_NODE_ID), {
      name: 'remoto', remotePort: 41821, localPort: remoteFedSrv.address().port,
      direction: 'inbound', transport: 'inbound', autostart: true, shared: true,
      visibility: 'network', nodeId: REMOTE_NODE_ID, token: HUB_TOKEN, acceptToken: 'd'.repeat(40),
    });
    nodesStore.atomicWriteStore(hubNodesPath, hst);
    const hubApp = express();
    const hubRouter = federation.routeHandler({
      nodesPath: hubNodesPath, localPort: 1, localCredential: () => 'hub', ingress: null, hopSecret: 'hopsegreto',
    });
    hubApp.use('/api/route', requireToken({ get: () => TOKEN }), hubRouter);
    const hubSrv = http.createServer(hubApp);
    await listen(hubSrv);
    avviati.push(hubSrv);

    return {
      base: `http://127.0.0.1:${hubSrv.address().port}`,
      close: chiudiTutto,
    };
  } catch (e) {
    await chiudiTutto();
    throw e;
  }
}

const get = (base, p) => fetch(`${base}${p}`, { headers: { authorization: `Bearer ${TOKEN}` } })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const post = (base, p, body) => fetch(`${base}${p}`, {
  method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify(body || {}),
}).then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

test('SENZA permesso: GET /api/route/<peer>/_/live-host -> 403, causa nominata (non un 404 muto)', async (t) => {
  const fed = await federazioneDiProva({ liveHostAccess: false });
  t.after(() => fed.close());
  const r = await get(fed.base, '/api/route/remoto/_/live-host');
  assert.equal(r.status, 403);
  assert.equal(r.body.reason, 'live-host-not-granted', 'la causa e\' nominata, come panel-not-granted');
});

test('SENZA permesso (default: campo assente): POST designate -> 403 con causa, non un silenzio', async (t) => {
  const fed = await federazioneDiProva(); // liveHostAccess assente = negato di default
  t.after(() => fed.close());
  const r = await post(fed.base, '/api/route/remoto/_/live-host/designate', { cellId: 'A', expectedRevision: 0 });
  assert.equal(r.status, 403);
  assert.equal(r.body.reason, 'live-host-not-granted');
});

test('CON permesso: GET /api/route/<peer>/_/live-host arriva davvero al nodo remoto', async (t) => {
  const fed = await federazioneDiProva({ liveHostAccess: true });
  t.after(() => fed.close());
  const r = await get(fed.base, '/api/route/remoto/_/live-host');
  assert.equal(r.status, 200);
  assert.equal(r.body.hostCell, null);
  assert.equal(r.body.revision, 0);
});

test('CON permesso: designare da remoto funziona — la stella cambia davvero sul nodo posseduto', async (t) => {
  const fed = await federazioneDiProva({ liveHostAccess: true });
  t.after(() => fed.close());
  const d = await post(fed.base, '/api/route/remoto/_/live-host/designate', { cellId: 'A', expectedRevision: 0 });
  assert.equal(d.status, 200, JSON.stringify(d.body));
  assert.equal(d.body.hostCell, 'A');
  // Il verso opposto della stessa prova: una lettura successiva, sempre via
  // federazione, conferma che la designazione e' rimasta sul nodo remoto.
  const after = await get(fed.base, '/api/route/remoto/_/live-host');
  assert.equal(after.status, 200);
  assert.equal(after.body.hostCell, 'A', 'la stella e\' cambiata sul nodo che possiede la cella');
});

test('CON permesso: anche SPEGNERE da remoto arriva al nodo posseduto', async (t) => {
  // Un audit indipendente ha notato che `clear` era nel gate e nel routing ma
  // non aveva un caso end-to-end: il comportamento reggeva, la regressione no.
  // Accendere e non poter spegnere e' un modo di rompere la funzione che i due
  // test sopra non vedrebbero — chiudono entrambi sul verso «accendi».
  const fed = await federazioneDiProva({ liveHostAccess: true });
  t.after(() => fed.close());
  const d = await post(fed.base, '/api/route/remoto/_/live-host/designate', { cellId: 'A', expectedRevision: 0 });
  assert.equal(d.status, 200, JSON.stringify(d.body));

  const c = await post(fed.base, '/api/route/remoto/_/live-host/clear', { expectedRevision: d.body.revision });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.hostCell, null, 'clear ha risposto senza spegnere');

  // E la conferma dal nodo che possiede la cella, non dalla risposta di chi ha
  // chiesto: e' la lettura successiva a dire se lo stato e' cambiato davvero.
  const after = await get(fed.base, '/api/route/remoto/_/live-host');
  assert.equal(after.status, 200);
  assert.equal(after.body.hostCell, null, 'la stella e\' rimasta accesa sul nodo remoto');
});

test('SENZA permesso: nemmeno SPEGNERE passa — il gate copre i due versi', async (t) => {
  const fed = await federazioneDiProva({ liveHostAccess: false });
  t.after(() => fed.close());
  const c = await post(fed.base, '/api/route/remoto/_/live-host/clear', { expectedRevision: 0 });
  assert.equal(c.status, 403);
  assert.match(JSON.stringify(c.body), /live-host-not-granted/,
    'il rifiuto deve nominare la causa, come per designate');
});
