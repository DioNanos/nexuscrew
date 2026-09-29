'use strict';
// tests/snapshot-producer-fail-closed.e2e.test.js — E2E produttore→ricevente→
// riconciliazione con DUE server REALI (nessuno stub HTTP): il produttore dello
// snapshot dichiara asks:[] senza resyncRequired anche quando la LETTURA dello
// store degli asks è FALLITA (asks.json persistito con `options` malformata fa
// lanciare list()). Quel vuoto viaggiava come elenco AUTOREVOLE: il validatore
// del ricevente lo accettava e reconcileImportedAsks chiudeva come 'dismissed'
// ogni alias importato assente. Contratto fail-closed: se il produttore non ha
// potuto leggere, lo snapshot NON è autorevole (resyncRequired:true) e la
// riconciliazione non chiude NIENTE.
//
// Quattro prove, stesso harness (stessa coppia reale, cambia solo lo store
// dell'owner):
//   1. CONTROLLO POSITIVO — owner sano, ask chiusa: lo snapshot è un vuoto
//      LEGITTIMO e l'alias SI chiude (il test sa anche fallire: se la coppia
//      pairing/porta/gate non lavorasse, questo caso diventa rosso).
//   2. DIFETTO (porta, owner non sottoscritto) — store dell'owner illeggibile:
//      la riconciliazione reale NON chiude l'alias.
//   3. DIFETTO (via sottoscritta) — stessa corruzione: la view del feed client
//      resta STALE con lastError 'snapshot-resync-required' (il marcatore è
//      arrivato davvero) e l'alias resta APERTO.
//   4. CONTRATTO DEL PRODUTTORE — coppia fresca, la stessa GET federata che fa
//      la porta: lo snapshot risponde 200 e dichiara resyncRequired:true.
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
async function pairReal(t, root, { broken, subscribed }) {
  const ownerDir = path.join(root, 'owner');
  const clientDir = path.join(root, 'client');
  seedAsks(ownerDir, [ownerAsk({ broken })]);
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
  return { A, B, selfA, selfB, ownerSnapshot, aliasRecord, feedView };
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
  // Riconciliazione reale: la porta prende lo snapshot del produttore rotto e
  // NON deve chiudere. È l'asserzione del difetto: su codice senza fail-closed
  // l'alias viene chiuso 'dismissed' da un elenco che il produttore non ha
  // mai potuto leggere.
  await driveReconciliation(A);
  const rec = await aliasRecord();
  assert.ok(rec, 'l\'alias importato è ancora nell\'elenco');
  assert.notEqual(rec.dismissed, true, 'uno snapshot di un produttore che non ha potuto leggere gli asks NON chiude mai un alias');
});

test('E2E fail-closed (via sottoscritta): store illeggibile — view stale su resync-required, l\'alias resta APERTO', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncfc-view-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { A, aliasRecord, feedView } = await pairReal(t, root, { broken: true, subscribed: true });
  // La riconciliazione passa dalla porta condivisa con la view: nessuna chiusura.
  await driveReconciliation(A);
  const rec = await aliasRecord();
  assert.ok(rec, 'l\'alias importato è ancora nell\'elenco');
  assert.notEqual(rec.dismissed, true, 'nessuna chiusura per uno snapshot non autorevole (via sottoscritta)');
  // La view del client segnala la causa: prova che il produttore è stato
  // contattato DAVVERO e che il marcatore del produttore rotto è arrivato
  // (non un verde a vuoto). La finestra/view può consumare il budget snapshot
  // del peer: si attende la causa con pazienza, non a colpo sicuro.
  const stale = await waitUntil(async () => {
    const v = await feedView();
    return v && v.lastError === 'snapshot-resync-required' ? v : null;
  }, { tries: 120, what: 'view stale con la causa del produttore' });
  assert.ok(stale, 'la view dell\'owner è stale con lastError snapshot-resync-required');
});

// Il contratto del PRODUTTORE, su una coppia fresca (nessuna riconciliazione
// azionata: il primo snapshot della finestra non può che rispondere 200, fuori
// dal rate 6/min che view e porta consumano negli altri test): se lo store
// lancia, la risposta esiste, è JSON e dichiara sé stessa non autorevole.
test('E2E fail-closed (produttore): lettura asks che lancia — snapshot 200 con resyncRequired:true', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncfc-prod-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { selfB, ownerSnapshot } = await pairReal(t, root, { broken: true, subscribed: false });
  const r = await ownerSnapshot();
  assert.equal(r.status, 200, 'la route federata dello snapshot risponde comunque');
  const snap = await r.json();
  assert.equal(snap.ownerId, selfB, 'snapshot del proprietario atteso');
  assert.equal(snap.resyncRequired, true, 'la lettura fallita rende lo snapshot NON autorevole');
  assert.ok(Array.isArray(snap.asks), 'asks resta un elenco (vuoto)');
});
