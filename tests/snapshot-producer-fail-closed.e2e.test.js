'use strict';
// tests/snapshot-producer-fail-closed.e2e.test.js — E2E produttore→ricevente→
// riconciliazione con DUE server REALI (nessuno stub HTTP): il produttore dello
// snapshot rispondeva 200 con asks:[] anche quando la LETTURA dello store degli
// asks è FALLITA (asks.json persistito con `options` malformata fa lanciare
// list()). Quel vuoto viaggiava come elenco AUTOREVOLE: i riceventi senza
// validatore (0.9.51/0.9.52: `if (!res.ok) continue;` e nient'altro) lo
// accettavano e reconcileImportedAsks chiudeva come 'dismissed' ogni alias
// importato assente. Contratto fail-closed: se il produttore non ha potuto
// leggere, non spedisce NESSUNO snapshot — 503 con corpo
// {"error":"asks-unreadable"} — e OGNI generazione di riceventi salta
// (0.9.51/0.9.52 su !res.ok, 0.9.53 su esito porta non 'ok' / errore vista).
//
// Cinque prove, stesso harness (stessa coppia reale, cambia solo lo store
// dell'owner):
//   1. CONTROLLO POSITIVO — owner sano, ask chiusa: lo snapshot è un vuoto
//      LEGITTIMO e l'alias SI chiude (il test sa anche fallire: se la coppia
//      pairing/porta/gate non lavorasse, questo caso diventa rosso).
//   2. DIFETTO (porta, owner non sottoscritto) — store dell'owner illeggibile:
//      la riconciliazione reale NON chiude l'alias.
//   3. DIFETTO (via sottoscritta) — stessa corruzione: la view del feed client
//      resta STALE con lastError 'snapshot HTTP 503' (il rifiuto del produttore
//      è arrivato davvero) e l'alias resta APERTO.
//   4. CONTRATTO DEL PRODUTTORE — coppia fresca, la stessa GET federata che fa
//      la porta: risposta 503, JSON dichiarato, corpo {"error":
//      "asks-unreadable"} — nessuno snapshot.
//   5. RICEVENTE 0.9.51/0.9.52 — la stessa GET della loro riconciliazione
//      (237abc5:lib/server.js:1163-1166): res.ok è false, quindi il loro
//      `if (!res.ok) continue;` (:1167, identico in 0.9.51) salta l'owner —
//      nessun parse, nessuna chiusura.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const { tmuxSessionForCell } = require('../lib/fleet/definitions.js');

const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
const SECRET = 'pairing-secret-token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (fn, { tries = 60, what = 'condition' } = {}) => {
  for (let i = 0; i < tries; i++) {
    const out = await fn();
    if (out) return out;
    await sleep(100);
  }
  return null;
};

// Attende che la view del feed osservi un determinato lastError, RACCOGLIENDO
// tutti gli errori visti durante il poll. Il rate-limit 6/min del produttore
// (lib/notify/event-feed-routes.js:22 SNAPSHOT_RATE_PER_MIN) fa passare solo i
// primi 6 snapshot (150 ms di finestra client l'uno => ~900 ms), poi li
// sovrascrive con 429. Leggere lastError solo a fine poll perde il 503 se la
// finestra e' gia' scaduta. L'asserzione essenziale (v. commenti dei test) e'
// che il produttore sia stato contattato DAVVERO e abbia rifiutato (503
// osservato almeno una volta), non che lastError sia ancora 503 alla fine.
// Si polla CONCORRENTEMENTE alla riconciliazione, cosi' il primo 503 e'
// catturato dentro la sua finestra.
async function awaitSeenError(feedView, expected, { tries = 200, gap = 50 } = {}) {
  const seen = [];
  for (let i = 0; i < tries; i++) {
    try {
      const v = await feedView();
      if (v && v.lastError) {
        seen.push(v.lastError);
        if (v.lastError === expected) return { ok: true, seen, view: v };
      }
    } catch (_) { /* best-effort: la view e' read-only */ }
    await sleep(gap);
  }
  return { ok: false, seen };
}

// Finestra e cadenze come tests/snapshot-schema-e2e.test.js: le GET della
// riconciliazione stanno oltre la finestra minima l'una dall'altra, così ogni
// una passa dalla porta con la finestra libera.
const WINDOW_MS = 150;
const POLL_MS = 100;

const OWNER_ASK_ID = 'ownfc01';
const ALIAS_ID = 'aliasfc1';

function boot(t, dir) {
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
    eventFeedClientPollMs: POLL_MS,
    eventFeedClientMinSnapshotIntervalMs: WINDOW_MS,
    sessionExistsSeam: () => true,
    pasteSeam: () => true,
    askSubmit: () => ({ outcome: 'submitted', submitted: true }),
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
    t.after(async () => {
      try {
        const st = nodesStore.loadStore(paths.nodesPath);
        if (st) {
          for (const n of (st.nodes || []).filter((n) => n && n.eventsReceive)) {
            nodesStore.atomicWriteStore(paths.nodesPath, nodesStore.updateNode(st, n.name, { eventsReceive: false }));
          }
        }
      } catch (_) { /* il teardown non puo' dipendere dallo store */ }
      await sleep(60);
      server.close();
      if (watcher) watcher.close();
    });
    res({ base: `http://127.0.0.1:${server.address().port}`, port: server.address().port, token, server, ...paths });
  }));
}

// Semina asks.json PRIMA del boot: lo store e' lazy, quindi il primo list()
// (la costruzione dello snapshot) carica ESATTAMENTE questo file.
function seedAsks(dir, asks) {
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'asks.json'), JSON.stringify({ asks }), { mode: 0o600 });
}

// Semina un asks.json RAW (già serializzato): serve per i casi MALFORMATI
// (virgola finale) o con `asks` non array, che seedAsks() non puo' esprimere
// perche' JSON.stringify produrrebbe JSON valido.
function seedAsksRaw(dir, raw) {
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'asks.json'), raw, { mode: 0o600 });
}

// Ripara asks.json sul disco con una forma valida (stesso store, niente restart).
function repairAsks(dir, asks) {
  const configDir = path.join(dir, '.nexuscrew');
  fs.writeFileSync(path.join(configDir, 'asks.json'), `${JSON.stringify({ asks }, null, 2)}\n`, { mode: 0o600 });
}

// L'ask dell'owner, nelle due forme che fanno la differenza:
//   sano    — chiuso (answered): list({open:true}) lo esclude LEGITTIMAMENTE;
//   rotto   — aperto con `options` non array: supera il filtro di load()
//             (chiede solo id stringa) e fa lanciare a.options.slice() in
//             list(), la corruzione con cui l'audit ha riprodotto il difetto.
function ownerAsk({ broken }) {
  return {
    id: OWNER_ASK_ID,
    question: broken ? 'aperta, ma lo store non si lascia leggere' : 'chiusa sull\'owner prima del test',
    options: broken ? { male: 'formato' } : ['si', 'no'],
    session: tmuxSessionForCell('dev'),
    ts: Date.now(),
    revision: broken ? 0 : 1,
    answered: !broken,
    dismissed: false,
    ...(!broken ? { answeredTs: Date.now() } : {}),
  };
}

// Coppia reale owner B / client A. L'alias importato di quell'ask e' aperto su
// A: e' lui che la riconciliazione potrebbe chiudere per colpa del finto vuoto.
async function pairReal(t, root, { broken, subscribed, ownerRaw }) {
  const ownerDir = path.join(root, 'owner');
  const clientDir = path.join(root, 'client');
  if (ownerRaw !== undefined) seedAsksRaw(ownerDir, ownerRaw);
  else seedAsks(ownerDir, [ownerAsk({ broken })]);
  const B = await boot(t, ownerDir);
  const selfB = nodesStore.loadStoreStrict(B.nodesPath).nodeId;
  seedAsks(clientDir, [{
    id: ALIAS_ID,
    question: 'alias che non deve chiudersi per colpa di uno store illeggibile',
    options: [],
    session: tmuxSessionForCell('dev'),
    ts: Date.now(),
    revision: 0,
    originNode: selfB, ownerId: selfB, ownerAskId: OWNER_ASK_ID,
  }]);
  const A = await boot(t, clientDir);
  const selfA = nodesStore.loadStoreStrict(A.nodesPath).nodeId;
  // Owner B: il peer 'client' vede la cella dev, gli eventi e puo' rispondere
  // le ask (stessi grants di tests/ask-resync-e2e.test.js).
  let stB = nodesStore.addNode(nodesStore.loadStoreStrict(B.nodesPath), {
    name: 'client', remotePort: 41999, localPort: 44777, nodeId: selfA,
    acceptToken: SECRET, direction: 'inbound', shared: false, visibility: 'network',
  });
  stB = nodesStore.setPeerAccessGrants(stB, 'client', {
    cellVisibility: 'selected', cells: ['dev'], eventsAccess: true, nodeEventsAccess: true,
    askReplyAccess: true, filesReadAccess: false, liveHostAccess: false, panelAccess: false, peerOperatorAccess: false,
  });
  nodesStore.atomicWriteStore(B.nodesPath, stB);
  // Client A: il peer owner con la porta reale di B; eventsReceive decide se
  // la view sottoscrive (via sottoscritta) o se resta solo la porta.
  let stA = nodesStore.addNode(nodesStore.loadStoreStrict(A.nodesPath), {
    name: 'owner', remotePort: 41999, localPort: B.port, nodeId: selfB,
    token: SECRET, direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@owner',
  });
  if (subscribed) stA = nodesStore.updateNode(stA, 'owner', { eventsReceive: true });
  nodesStore.atomicWriteStore(A.nodesPath, stA);

  // La STESSA GET che fa la porta del ricevente: route federata reale di B,
  // gate reale (origine federata, hop chain, grants). Nessuno stub.
  const ownerSnapshot = async () => fetch(`http://127.0.0.1:${B.port}/federation/route/_/event-feed/snapshot`, {
    headers: { authorization: `Bearer ${SECRET}`, 'x-nexuscrew-visited': selfA },
  });
  const aliasRecord = async () => {
    const r = await fetch(`${A.base}/api/asks`, { headers: H(A.token) });
    assert.equal(r.status, 200, 'la GET /api/asks risponde sempre (best-effort)');
    const list = await r.json();
    return (list.asks || []).find((a) => a.id === ALIAS_ID) || null;
  };
  const feedView = async () => {
    const r = await fetch(`${A.base}/api/feed-state`, { headers: H(A.token) });
    assert.equal(r.status, 200);
    return ((await r.json()).views || []).find((v) => v.ownerId === selfB) || null;
  };
  return { A, B, selfA, selfB, ownerSnapshot, aliasRecord, feedView, ownerDir };
}

// Quattro GET oltre la finestra l'una dall'altra: ognuna dà alla
// riconciliazione una porta libera (più i retry programmati degli skip).
async function driveReconciliation(A) {
  for (let i = 0; i < 4; i++) {
    const r = await fetch(`${A.base}/api/asks`, { headers: H(A.token) });
    assert.equal(r.status, 200);
    await r.json();
    await sleep(WINDOW_MS + 20);
  }
  await sleep(WINDOW_MS + 100); // coda per i retry armati dagli skip
}

test('E2E fail-closed (controllo positivo): owner sano con ask chiusa — lo snapshot è un vuoto LEGITTIMO e l\'alias SI chiude', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncfc-pos-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { A, selfB, ownerSnapshot, aliasRecord } = await pairReal(t, root, { broken: false, subscribed: false });
  // Il produttore reale dichiara un vuoto SENZA marcatore: è autorizzato a
  // farlo, perché l'ha potuto leggere.
  const r = await ownerSnapshot();
  assert.equal(r.status, 200, 'la route federata dello snapshot risponde');
  const snap = await r.json();
  assert.equal(snap.ownerId, selfB);
  assert.notEqual(snap.resyncRequired, true, 'owner leggibile: nessun marcatore');
  assert.deepEqual(snap.asks, [], 'l\'ask chiuso non compare');
  // E quel vuoto legittimo chiude davvero l'alias: la coppia reale lavora.
  const closed = await waitUntil(async () => {
    const rec = await aliasRecord();
    return !rec || rec.dismissed === true;
  }, { tries: 45, what: 'alias chiuso dal vuoto legittimo' });
  assert.ok(closed, 'con uno snapshot leggibile e pulito l\'alias SI chiude (l\'harness non è un verde a vuoto)');
});

test('E2E fail-closed (porta): store dell\'owner illeggibile — la riconciliazione NON chiude l\'alias', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncfc-door-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { A, aliasRecord } = await pairReal(t, root, { broken: true, subscribed: false });
  // Riconciliazione reale: la porta chiede lo snapshot al produttore rotto e
  // riceve un esito non 'ok' (http-503) — NON chiude. È l'asserzione del
  // difetto: su codice senza fail-closed il produttore rispondeva 200 con
  // asks:[] e l'alias veniva chiuso 'dismissed' da un elenco che non era mai
  // stato letto davvero.
  await driveReconciliation(A);
  const rec = await aliasRecord();
  assert.ok(rec, 'l\'alias importato è ancora nell\'elenco');
  assert.notEqual(rec.dismissed, true, 'uno snapshot di un produttore che non ha potuto leggere gli asks NON chiude mai un alias');
});

test('E2E fail-closed (via sottoscritta): store illeggibile — view stale su snapshot HTTP 503, l\'alias resta APERTO', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncfc-view-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { A, aliasRecord, feedView } = await pairReal(t, root, { broken: true, subscribed: true });
  // La riconciliazione passa dalla porta condivisa con la view: nessuna chiusura.
  // Si OSSERVA la view CONCORRENTEMENTE alla riconciliazione: il 503 del
  // produttore vive solo nei primi 6 snapshot (~900 ms di finestra client),
  // poi il rate-limit 6/min lo sovrascrive con 429. Leggere lastError solo a
  // fine riconciliazione perde il 503 e fa oscillare il test fra 503 e 429.
  const observing = awaitSeenError(feedView, 'snapshot HTTP 503');
  await driveReconciliation(A);
  const observed = await observing;
  const rec = await aliasRecord();
  assert.ok(rec, 'l\'alias importato è ancora nell\'elenco');
  assert.notEqual(rec.dismissed, true, 'nessuna chiusura per un produttore che non ha potuto leggere (via sottoscritta)');
  // La view del client segnala la causa: prova che il produttore è stato
  // contattato DAVVERO e che il suo rifiuto 503 è arrivato (non un verde a
  // vuoto; il retry della view va a backoff, non a loop). Si accetta la PRIMA
  // osservazione del 503 anche se poi il rate lo sovrascrive con 429.
  assert.ok(observed.ok,
    'la view dell\'owner ha osservato almeno una volta lastError "snapshot HTTP 503" (visti: '
    + Array.from(new Set(observed.seen)).join(', ') + ')');
});

// Il contratto del PRODUTTORE, su una coppia fresca (nessuna riconciliazione
// azionata: il primo snapshot della finestra non può che rispondere, fuori dal
// rate 6/min che view e porta consumano negli altri test): se lo store lancia,
// non parte NESSUNO snapshot. Rifiuto 503, corpo JSON minimo: un 200 — con
// qualunque corpo o marcatore — verrebbe invece deciso dai riceventi che non
// conoscono il validatore.
test('E2E fail-closed (produttore): lettura asks che lancia — 503, JSON {"error":"asks-unreadable"}, nessuno snapshot', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncfc-prod-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { ownerSnapshot } = await pairReal(t, root, { broken: true, subscribed: false });
  const r = await ownerSnapshot();
  assert.equal(r.status, 503, 'senza un elenco leggibile non c\'è snapshot: rifiuto 503');
  assert.match(String(r.headers.get('content-type') || ''), /^application\/json\b/, 'il corpo è JSON dichiarato');
  const body = await r.json();
  assert.deepEqual(body, { error: 'asks-unreadable' }, 'corpo minimo: nessun campo di snapshot');
});

// Il ricevente 0.9.51/0.9.52 non ha validatore: la sua riconciliazione fa la
// GET federata (237abc5:lib/server.js:1163-1166; la catena d'hop la aggiunge
// il proxy federato in avanti, lib/proxy/federation.js:423-425 — qui la GET
// replica la richiesta come arriva all'owner) e decide SOLO su res.ok
// (`if (!res.ok) continue;`, 237abc5:lib/server.js:1167 — regione identica in
// 0.9.51, 307c037). Si esegue quel ramo esatto contro il produttore reale
// rotto: deve saltare.
test('E2E fail-closed (ricevente 0.9.51/0.9.52): la GET della riconciliazione non è ok — il ramo !res.ok salta', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncfc-legacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { ownerSnapshot } = await pairReal(t, root, { broken: true, subscribed: false });
  // Il frammento del ricevente vecchio, tale e quale: fetch, e SOLO res.ok
  // decide. Nessun validatore, nessun marcatore conosciuto.
  let snap = null;
  let skipped = false;
  let skipStatus = null;
  try {
    const res = await ownerSnapshot();
    if (!res.ok) { skipped = true; skipStatus = res.status; } // 237abc5:lib/server.js:1167
    else { snap = await res.json(); }
  } catch (_) { skipped = true; }
  assert.ok(skipped, 'la risposta non è ok: il ricevente 0.9.51/0.9.52 salta l\'owner');
  assert.equal(skipStatus, 503, 'salta per il rifiuto asks-unreadable, non per un caso accidentale');
  assert.equal(snap, null, 'nessun corpo raggiunge la decisione del ricevente vecchio: chiusura impossibile');
});

// --- DIFETTO nc-0953: asks.json ESISTENTE ma MALFORMATO ----------------------
// Il 503 di 6d05d1f scatta solo se list() LANCIA. Ma un JSON malformato (virgola
// finale) o un `asks` non array fanno tornare [] a list() SILENZIOSAMENTE: il
// produttore spediva 200 con asks:[] autorevole e i riceventi chiudevano alias
// aperti. Queste prove replicano quel difetto sul produttore reale: con il fix
// il health gate rifiuta 503 PRIMA di list(), e il ricevente non chiude.

// Una domanda aperta dell'owner, con JSON malformato (virgola finale dopo
// l'array): il file ESISTE, contiene una domanda aperta, ma e' illeggibile.
function malformedOwnerRaw() {
  const session = tmuxSessionForCell('dev');
  return `{"asks":[{"id":"${OWNER_ASK_ID}","question":"aperta ma store malformato","session":"${session}","ts":${Date.now()},"answered":false,"dismissed":false}],}`;
}

// Forma `asks` non array: JSON valido, ma la struttura e' invalida.
function nonArrayOwnerRaw() {
  const session = tmuxSessionForCell('dev');
  return `${JSON.stringify({ asks: { id: OWNER_ASK_ID, session } }, null, 2)}\n`;
}

// La domanda aperta dell'owner, in forma VALIDA, per il riparo.
function openOwnerAsk() {
  const session = tmuxSessionForCell('dev');
  return { id: OWNER_ASK_ID, question: 'aperta e leggibile', session, ts: Date.now(), answered: false, dismissed: false };
}

test('E2E nc-0953 (porta): asks.json malformato (virgola finale) — produttore 503, la riconciliazione NON chiude l\'alias', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncfc-mal-door-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { A, ownerSnapshot, aliasRecord } = await pairReal(t, root, { ownerRaw: malformedOwnerRaw(), subscribed: false });
  // Il produttore reale non puo' leggere il proprio store: 503, nessuno snapshot.
  const r = await ownerSnapshot();
  assert.equal(r.status, 503, 'store malformato => 503, non 200 con asks:[] autorevole');
  const body = await r.json();
  assert.deepEqual(body, { error: 'asks-unreadable' });
  // La riconciliazione reale (porta) riceve 503 e non chiude l'alias.
  await driveReconciliation(A);
  const rec = await aliasRecord();
  assert.ok(rec, 'l\'alias importato e\' ancora nell\'elenco');
  assert.notEqual(rec.dismissed, true, 'uno snapshot di un produttore con store malformato NON chiude mai un alias');
});

test('E2E nc-0953 (via sottoscritta): asks.json malformato — view stale su 503, alias APERTO', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncfc-mal-view-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { A, aliasRecord, feedView } = await pairReal(t, root, { ownerRaw: malformedOwnerRaw(), subscribed: true });
  // Si OSSERVA la view CONCORRENTEMENTE alla riconciliazione: il 503 del
  // produttore malformato vive solo nei primi 6 snapshot (~900 ms), poi il
  // rate-limit 6/min lo sovrascrive con 429. Leggere lastError a fine poll
  // faceva oscillare il test fra 503 e 429 a seconda del ritmo. Si accetta la
  // prima osservazione del 503 e si raccolgono gli errori visti.
  const observing = awaitSeenError(feedView, 'snapshot HTTP 503');
  await driveReconciliation(A);
  const observed = await observing;
  const rec = await aliasRecord();
  assert.ok(rec, 'l\'alias importato e\' ancora nell\'elenco');
  assert.notEqual(rec.dismissed, true, 'nessuna chiusura per store malformato (via sottoscritta)');
  assert.ok(observed.ok,
    'la view ha osservato almeno una volta lastError "snapshot HTTP 503" (visti: '
    + Array.from(new Set(observed.seen)).join(', ') + ')');
});

test('E2E nc-0953 (porta): asks non array — produttore 503, la riconciliazione NON chiude l\'alias', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncfc-nonarr-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { A, ownerSnapshot, aliasRecord } = await pairReal(t, root, { ownerRaw: nonArrayOwnerRaw(), subscribed: false });
  const r = await ownerSnapshot();
  assert.equal(r.status, 503, 'asks non array => 503, non vuoto autorevole');
  assert.deepEqual(await r.json(), { error: 'asks-unreadable' });
  await driveReconciliation(A);
  const rec = await aliasRecord();
  assert.ok(rec, 'l\'alias importato e\' ancora nell\'elenco');
  assert.notEqual(rec.dismissed, true, 'uno snapshot di un produttore con asks non array NON chiude mai un alias');
});

test('E2E nc-0953 (risanamento): ripara il file sull\'owner — lo snapshot torna 200 con la domanda e l\'alias resta APERTO', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncfc-repair-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { A, selfB, ownerSnapshot, aliasRecord, ownerDir } = await pairReal(t, root, { ownerRaw: malformedOwnerRaw(), subscribed: false });
  // Fase 1: store malformato -> 503 (un solo snapshot esplicito, per non
  // consumare il rate 6/min che serve alla fase successiva).
  assert.equal((await ownerSnapshot()).status, 503);
  // Fase 2: l'operatore ripara asks.json sul disco (stesso server, niente
  // restart). Lo store illeggibile NON e' cacheato: il prossimo snapshot rilegge.
  repairAsks(ownerDir, [openOwnerAsk()]);
  const r = await ownerSnapshot();
  assert.equal(r.status, 200, 'dopo il riparo lo snapshot e\' di nuovo autorevole');
  const snap = await r.json();
  assert.equal(snap.ownerId, selfB);
  assert.ok(Array.isArray(snap.asks) && snap.asks.some((a) => a.id === OWNER_ASK_ID), 'la domanda aperta e\' di nuovo nello snapshot');
  // Fase 3: la riconciliazione vede la domanda VIVA e NON chiude l'alias.
  await driveReconciliation(A);
  const rec = await aliasRecord();
  assert.ok(rec, 'l\'alias e\' ancora presente');
  assert.notEqual(rec.dismissed, true, 'la domanda e\' viva nello snapshot: l\'alias resta APERTO, non viene chiuso');
});
