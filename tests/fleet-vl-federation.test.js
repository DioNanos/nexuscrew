'use strict';
// La via FEDERATA dei due endpoint vl: la stessa operazione deve riuscire
// anche a distanza, sul nodo owner, senza eseguire nulla sul nodo che guarda.
//
// Due server reali, come in fleet-models-federation-e2e.test.js: il motivo e'
// imparato a caro prezzo — i test unitari sull'allowlist erano verdi mentre il
// giro completo non funzionava. Una riga in piu' in una regex non prova che
// la richiesta attraversi il proxy, arrivi al router fleet del nodo remoto e
// torni indietro. Questo lo prova.
//
// L'invariante: cio' che si puo' fare in locale si deve poter fare a distanza,
// e cio' che READONLY toglie resta tolto. In piu': il nodo che GUARDA non
// esegue nulla — la sessione nuova e' consumata sul nodo OWNER, dove stanno
// il marcatore e lo spawn.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');

const PEER_TOKEN = 'peer-token-abcdefghijklmnopqrstuvwxyz0123456789';

// Registra cio' che il nodo riceve DAVVERO: il punto del test e' che la
// chiamata arrivi fin li', non che il proxy risponda 200 per conto suo.
function fleetSeam() {
  const seen = { newSession: [], inventory: [], newSessionState: [] };
  return {
    seen,
    seam: {
      available: true,
      provider: 'builtin',
      isCellSession: () => true,
      capabilities: () => ['status', 'definitions', 'define', 'remove', 'model-test'],
      status: async () => ({ available: true, cells: [] }),
      definitions: () => ({ engines: [], cells: [], models: [] }),
      defineModel: () => ({ ok: true }),
      removeModel: () => ({ ok: true }),
      testModel: async (engine, model) => ({ engine, model, outcome: 'ok', latencyMs: 7 }),
      // La richiesta di sessione nuova: sul nodo OWNER, non su quello che
      // guarda. Il seam registra il bersaglio per provare che il lavoro e'
      // avvenuto dall'altra parte.
      vlNewSession: async (cell) => {
        seen.newSession.push(cell);
        return { ok: true, cell, state: 'pending' };
      },
      vlLegacyInventory: () => {
        seen.inventory.push(true);
        return { entries: [{ name: 'vl-prova', sessionCount: 2 }], moved: 0, deleted: 0 };
      },
      // Lo stato della richiesta di sessione nuova: read-only, per cella. La
      // rotella esiste nella tabella delle route federate, quindi la richiesta
      // arriva al nodo OWNER (e non viene trattata come una risorsa ignota).
      vlNewSessionState: (cell) => {
        seen.newSessionState.push(cell);
        return { cell, state: 'none' };
      },
    },
  };
}

async function bootNode(t, { readonlyDefault = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlfed-'));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir,
    configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'),
    tokenPath: path.join(configDir, 'token'),
    topologyCachePath: path.join(configDir, 'topology-cache.json'),
  };
  nodesStore.initStore(paths.nodesPath);
  const { seen, seam } = fleetSeam();
  const { server, token, watcher } = createServer({
    protectSharedTmuxServer: false,
    ...paths,
    filesRoot: path.join(dir, 'files'),
    port: 0,
    readonlyDefault,
    fleetSeam: seam,
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => { server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const nodeId = nodesStore.loadStore(paths.nodesPath).nodeId;
  const call = (method, apiPath, body) => fetch(`${base}${apiPath}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { paths, port, base, token, nodeId, call, seen };
}

function link(a, b) {
  let stA = nodesStore.loadStoreStrict(a.paths.nodesPath);
  stA = nodesStore.addNode(stA, {
    name: 'peer-b', ssh: 'user@peer-b', remotePort: 41999, localPort: b.port,
    nodeId: b.nodeId, token: PEER_TOKEN, direction: 'outbound', shared: true,
    visibility: 'network', peerOperatorAccess: true,
  });
  nodesStore.atomicWriteStore(a.paths.nodesPath, stA);
  let stB = nodesStore.loadStoreStrict(b.paths.nodesPath);
  stB = nodesStore.addNode(stB, {
    name: 'peer-a', remotePort: 41999, localPort: a.port,
    nodeId: a.nodeId, acceptToken: PEER_TOKEN, direction: 'inbound', shared: true,
    visibility: 'network', peerOperatorAccess: true,
  });
  nodesStore.atomicWriteStore(b.paths.nodesPath, stB);
}

async function pair(t, opts = {}) {
  const a = await bootNode(t);
  const b = await bootNode(t, opts);
  link(a, b);
  return { a, b };
}

// --- 1. la richiesta di sessione nuova attraversa e arriva al nodo OWNER ----

test('la richiesta di sessione nuova federata arriva al nodo OWNER, non a quello che guarda', async (t) => {
  const { a, b } = await pair(t);
  const res = await a.call('POST', '/api/route/peer-b/_/fleet/vl-new-session', { cell: 'CellaProva' });
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.state, 'pending');
  assert.deepEqual(b.seen.newSession, ['CellaProva'], 'la richiesta deve essere arrivata al nodo remoto (owner)');
  assert.deepEqual(a.seen.newSession, [], 'e NON deve essere finita sul nodo che guarda');
});

test('la richiesta federata non esegue nulla sul nodo che guarda', async (t) => {
  // "nessun processo sul viewer": il nodo che guarda non consuma il marcatore
  // e non avvia nulla. La richiesta e' un atto dell'owner.
  const { a, b } = await pair(t);
  const res = await a.call('POST', '/api/route/peer-b/_/fleet/vl-new-session', { cell: 'CellaProva' });
  assert.equal(res.status, 200);
  assert.equal(a.seen.newSession.length, 0, 'il viewer non ha consumato nulla');
  assert.equal(b.seen.newSession.length, 1, 'l\'owner ha consumato la richiesta');
});

test('l\'inventario legacy federato e\' una diagnosi read-only: attraversa e non muta', async (t) => {
  const { a, b } = await pair(t);
  const res = await a.call('GET', '/api/route/peer-b/_/fleet/vl-legacy-inventory');
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.entries.length, 1);
  assert.equal(out.entries[0].name, 'vl-prova');
  assert.equal(out.moved, 0, 'l\'inventario non sposta nulla');
  assert.equal(out.deleted, 0, 'l\'inventario non cancella nulla');
  assert.equal(b.seen.inventory.length, 1, 'l\'inventario e\' stato calcolato sul nodo owner');
});

// --- 2. i verbi sbagliati non passano --------------------------------------

test('federare la risorsa non federa ogni verbo', async (t) => {
  const { a } = await pair(t);
  // GET sulla richiesta di sessione nuova: e' una POST, non una GET.
  const res = await a.call('GET', '/api/route/peer-b/_/fleet/vl-new-session');
  assert.notEqual(res.status, 200, 'GET su /fleet/vl-new-session non deve passare');
  // POST sull'inventario: e' una GET, non una POST.
  const res2 = await a.call('POST', '/api/route/peer-b/_/fleet/vl-legacy-inventory', { cell: 'CellaProva' });
  assert.notEqual(res2.status, 200, 'POST su /fleet/vl-legacy-inventory non deve passare');
});

// --- 3. READONLY: la mutazione sparisce, la diagnosi resta -------------------

test('READONLY sul nodo owner blocca la richiesta di sessione nuova', async (t) => {
  const { a, b } = await pair(t, { readonlyDefault: true });
  const res = await a.call('POST', '/api/route/peer-b/_/fleet/vl-new-session', { cell: 'CellaProva' });
  assert.notEqual(res.status, 200, 'una mutazione non deve partire da un nodo in sola lettura');
  assert.deepEqual(b.seen.newSession, [], 'nessuna richiesta deve essere arrivata all\'owner');
});

test('READONLY sul nodo owner NON blocca l\'inventario (diagnosi read-only)', async (t) => {
  // L'inventario non muta niente: e' una lettura dello stato del nodo, come
  // /fleet/status o /fleet/definitions, che restano aperti in sola lettura.
  const { a, b } = await pair(t, { readonlyDefault: true });
  const res = await a.call('GET', '/api/route/peer-b/_/fleet/vl-legacy-inventory');
  assert.equal(res.status, 200, 'la diagnosi read-only resta raggiungibile');
  assert.equal(b.seen.inventory.length, 1);
});

// --- 4. l'inventario con scope ristretto: 403, e l'owner non scanna ---------

test('l\'inventario legacy con scope ristretto: 403 e l\'owner non calcola nulla', async (t) => {
  // L'inventario e' lo STATO DEL NODO (le cartelle condivise pre-contratto):
  // nomi e conteggi, senza una mappatura affidabile cella->sessione. Proiettarlo
  // su uno scope parziale richiederebbe inventare quella mappa, quindi la
  // scelta e' intero o niente: il peer operatore con scope ristretto riceve
  // un 403, e l'owner non scandisce niente.
  const { a, b } = await pair(t);
  let st = nodesStore.loadStoreStrict(b.paths.nodesPath);
  st = nodesStore.setPeerAccessGrants(st, 'peer-a', {
    cellVisibility: 'selected', cells: ['CellaProva'],
    liveHostAccess: false, panelAccess: false, eventsAccess: false,
    nodeEventsAccess: false, askReplyAccess: false, filesReadAccess: false,
    peerOperatorAccess: true,
  });
  nodesStore.atomicWriteStore(b.paths.nodesPath, st);

  const res = await a.call('GET', '/api/route/peer-b/_/fleet/vl-legacy-inventory');
  assert.equal(res.status, 403, 'scope ristretto: l\'inventario non esce');
  const body = await res.json().catch(() => ({}));
  assert.equal(body.entries, undefined, 'nessun inventario nella risposta');
  assert.equal(b.seen.inventory.length, 0, 'l\'owner non ha calcolato l\'inventario');
  // L'operatore del nodo proprietario continua a leggerlo: la restrizione e'
  // sul peer, non su chi possiede la macchina.
  const locale = await b.call('GET', '/api/fleet/vl-legacy-inventory');
  assert.equal(locale.status, 200, 'il proprietario del nodo legge il suo inventario');
  assert.equal(b.seen.inventory.length, 1);
});

test('l\'inventario legacy con scope "none": 403 dichiarato', async (t) => {
  const { a, b } = await pair(t);
  let st = nodesStore.loadStoreStrict(b.paths.nodesPath);
  st = nodesStore.setPeerAccessGrants(st, 'peer-a', {
    cellVisibility: 'none',
    liveHostAccess: false, panelAccess: false, eventsAccess: false,
    nodeEventsAccess: false, askReplyAccess: false, filesReadAccess: false,
    peerOperatorAccess: true,
  });
  nodesStore.atomicWriteStore(b.paths.nodesPath, st);
  const res = await a.call('GET', '/api/route/peer-b/_/fleet/vl-legacy-inventory');
  assert.equal(res.status, 403);
  assert.equal(b.seen.inventory.length, 0, 'l\'owner non ha calcolato l\'inventario');
});

// --- 5. lo stato della richiesta di sessione nuova attraversa --------------

test('lo stato della richiesta di sessione nuova e\' una route federata: arriva al nodo OWNER', async (t) => {
  const { a, b } = await pair(t);
  const res = await a.call('GET', '/api/route/peer-b/_/fleet/vl-new-session-state?cell=CellaProva');
  const out = await res.json();
  assert.equal(res.status, 200, JSON.stringify(out));
  assert.equal(out.cell, 'CellaProva');
  assert.deepEqual(b.seen.newSessionState, ['CellaProva'], 'la lettura e\' avvenuta sul nodo owner');
  assert.deepEqual(a.seen.newSessionState, [], 'e NON sul nodo che guarda');
});

// --- 6. il peer senza permesso operatore non ottiene nulla -------------------

test('un peer senza permesso operatore non aziona la richiesta di sessione nuova', async (t) => {
  const { a, b } = await pair(t);
  // Si toglie il permesso operatore al peer: la risorsa e' di classe
  // 'operator', quindi senza il grant il peer non la apre. Il toglimento
  // passa dalla API del negozio (il vettore di concessioni e' validato come
  // un blocco, non editato a mano).
  // Il gate di classe legge il record del peer autenticato NEL NODO CHE
  // RISPONDE (l'owner): e' li' che si vede se quel peer puo' agire. Percio'
  // il grant da togliere e' quello che l'owner conosce del peer che arriva.
  let st = nodesStore.loadStoreStrict(b.paths.nodesPath);
  st = nodesStore.setPeerAccessGrants(st, 'peer-a', {
    cellVisibility: 'all',
    liveHostAccess: false,
    panelAccess: false,
    eventsAccess: false,
    nodeEventsAccess: false,
    askReplyAccess: false,
    filesReadAccess: false,
    peerOperatorAccess: false,
  });
  nodesStore.atomicWriteStore(b.paths.nodesPath, st);

  const res = await a.call('POST', '/api/route/peer-b/_/fleet/vl-new-session', { cell: 'CellaProva' });
  assert.notEqual(res.status, 200, 'senza il grant operatore la mutazione non passa');
  assert.deepEqual(b.seen.newSession, [], 'e nessuna richiesta arriva all\'owner');
});
