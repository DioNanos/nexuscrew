'use strict';
// tests/ask-resync-e2e.test.js — END-TO-END su due server REALI per il fix
// ask-resync (la lezione del Pixel 2026-09-29: una funzione testata ma mai
// chiamata non corregge nulla).
//
//   1. dismiss CONFERMATO via POST /api/asks-relay → la card esce SUBITO dalla
//      view che /api/feed-state serve, stream vivo o no;
//   2. il frame ask-closed dell'owner (dismiss fatto SULL'OWNER) droppa la
//      view anche senza azione locale;
//   3. riavvio simulato del client con l'owner pulito: la card non torna.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const { tmuxSessionForCell } = require('../lib/fleet/definitions.js');

const H = (token) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
const SECRET = 'pairing-secret-token';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// boot su una directory data (il riavvio simulato riusa la STESSA directory:
// le view sono in memoria, il pairing persiste).
function boot(t, dir, { cleanup = true } = {}) {
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
    eventFeedClientPollMs: 100,
    eventFeedClientMinSnapshotIntervalMs: 50,
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
    if (cleanup) {
      t.after(async () => {
        // Igiene: prima via il flag di ricezione (il client del server smette
        // di connettersi), poi le socket. Niente stream in salita al drain.
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
    }
    res({ base: `http://127.0.0.1:${server.address().port}`, port: server.address().port, token, server, ...paths });
  }));
}

async function pair(t, root) {
  const B = await boot(t, path.join(root, 'owner'));
  const A = await boot(t, path.join(root, 'client'));
  const selfA = nodesStore.loadStoreStrict(A.nodesPath).nodeId;
  const selfB = nodesStore.loadStoreStrict(B.nodesPath).nodeId;
  // Owner B: il peer 'client' vede le celle selezionate, gli eventi e puo'
  // rispondere/scartare le ask (askReplyAccess) — è il gate del feed e del
  // DELETE federato.
  let stB = nodesStore.addNode(nodesStore.loadStoreStrict(B.nodesPath), {
    name: 'client', remotePort: 41999, localPort: 44777, nodeId: selfA,
    acceptToken: SECRET, direction: 'inbound', shared: false, visibility: 'network',
  });
  stB = nodesStore.setPeerAccessGrants(stB, 'client', {
    cellVisibility: 'selected', cells: ['dev'], eventsAccess: true, nodeEventsAccess: true,
    askReplyAccess: true, filesReadAccess: false, liveHostAccess: false, panelAccess: false, peerOperatorAccess: false,
  });
  nodesStore.atomicWriteStore(B.nodesPath, stB);
  // Client A: l'owner è abilitato alla RICEZIONE degli eventi → il suo feed
  // client (auto-start in createServer) apre snapshot+stream.
  let stA = nodesStore.addNode(nodesStore.loadStoreStrict(A.nodesPath), {
    name: 'owner', remotePort: 41999, localPort: B.port, nodeId: selfB,
    token: SECRET, direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@owner',
  });
  stA = nodesStore.updateNode(stA, 'owner', { eventsReceive: true });
  nodesStore.atomicWriteStore(A.nodesPath, stA);
  return { A, B, selfA, selfB };
}

const createAsk = (B, question) => fetch(`${B.base}/api/asks`, {
  method: 'POST', headers: H(B.token),
  body: JSON.stringify({ question, options: ['yes', 'no'], session: tmuxSessionForCell('dev') }),
}).then(async (r) => { assert.equal(r.status, 201); return (await r.json()).id; });

const feedView = async (X, ownerId) => {
  const r = await fetch(`${X.base}/api/feed-state`, { headers: H(X.token) });
  assert.equal(r.status, 200);
  return (await r.json()).views.find((v) => v.ownerId === ownerId) || null;
};

const waitUntil = async (fn, { tries = 60, what } = {}) => {
  for (let i = 0; i < tries; i++) {
    const out = await fn();
    if (out) return out;
    await sleep(100);
  }
  return null;
};

const hasAsk = (view, askId) => !!(view && (view.asks || []).some((a) => (a.ownerAskId || a.id) === askId));

test('E2E: il dismiss confermato via /asks-relay toglie la card dalla view del feed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaskfix-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { A, B, selfB } = await pair(t, root);
  const askId = await createAsk(B, 'procedo con il deploy?');
  // La card arriva nella view del client (snapshot dell'owner).
  const imported = await waitUntil(async () => hasAsk(await feedView(A, selfB), askId), { what: 'card imported' });
  assert.ok(imported, 'the card reaches the client view');
  // Dismiss dalla UI del client → relay → owner: 2xx = confermato.
  const r = await fetch(`${A.base}/api/asks-relay`, {
    method: 'POST', headers: H(A.token),
    body: JSON.stringify({ action: 'dismiss', ownerId: selfB, askId }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { dismissed: true });
  // La view NON deve più contenere la card: il feed-state è ciò che la UI
  // reimporta a ogni caricamento — è da lì che la card del Pixel tornava.
  const gone = await waitUntil(async () => !hasAsk(await feedView(A, selfB), askId));
  assert.ok(gone, 'the confirmed dismiss removes the card from the feed view');
  // L'owner è pulito: il record resta in storico, marcato dismissed.
  const list = await fetch(`${B.base}/api/asks`, { headers: H(B.token) }).then((r) => r.json());
  const rec = (list.asks || []).find((a) => a.id === askId);
  assert.ok(rec, 'the owner still keeps the ask in its history');
  assert.equal(rec.dismissed, true, 'the ask is marked dismissed on the owner');
});

test('E2E: il frame ask-closed dell\'owner droppa la view anche senza azione locale', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaskfix-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { A, B, selfB } = await pair(t, root);
  const askId = await createAsk(B, 'chiudo dal lato owner');
  assert.ok(await waitUntil(async () => hasAsk(await feedView(A, selfB), askId), { what: 'card imported' }), 'the card reaches the client view');
  // Il dismiss avviene SULL'OWNER (un'altra superficie): il frame ask-closed
  // deve arrivare al client e la view lo applica.
  const r = await fetch(`${B.base}/api/asks/${askId}`, { method: 'DELETE', headers: H(B.token) });
  assert.equal(r.status, 200);
  const gone = await waitUntil(async () => !hasAsk(await feedView(A, selfB), askId));
  assert.ok(gone, 'the owner frame closes the card on the client view too');
});

test('E2E: riavvio del client con l\'owner pulito — la card non torna', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncaskfix-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { A, B, selfB } = await pair(t, root);
  const askId = await createAsk(B, 'sopravvivo al riavvio?');
  assert.ok(await waitUntil(async () => hasAsk(await feedView(A, selfB), askId), { what: 'card imported' }), 'the card reaches the client view');
  // Dismiss confermato, owner pulito.
  const r = await fetch(`${A.base}/api/asks-relay`, {
    method: 'POST', headers: H(A.token),
    body: JSON.stringify({ action: 'dismiss', ownerId: selfB, askId }),
  });
  assert.equal(r.status, 200);
  // Riavvio del client: stessa directory (pairing persistito), nuovo processo
  // di stato — le view nascono vuote e ripartono da snapshot.
  A.server.close();
  const A2 = await boot(t, path.join(root, 'client'), { cleanup: true });
  const rebuilt = await waitUntil(async () => {
    const view = await feedView(A2, selfB);
    return view && view.stale === false ? view : null;
  }, { what: 'live view rebuilt' });
  assert.ok(rebuilt, 'the restarted client rebuilds a LIVE view for the owner');
  assert.equal(hasAsk(rebuilt, askId), false, 'the dismissed card does NOT come back after the restart');
});

// La riproduzione FEDELE del Pixel (2026-09-29): lo stream dell'owner fa 409
// a perenne (3 reset → tappo: nessuna richiesta, nessun frame), ma la
// scrittura arriva (il DELETE del relay risponde 2xx). In questo stato la
// card non può uscire né per frame né per snapshot: l'unico percorso è il
// dismiss CONFERMATO che chiama dismissConfirmed sul client del server.
test('E2E (Pixel): view in resync-exhausted + dismiss confermato → la card esce dalla view', async (t) => {
  const OWNER = 'c'.repeat(32);
  const hits = { dismiss: 0, feed: 0 };
  const fake = http.createServer((req, res) => {
    const url = req.url || '';
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url === '/federation/health') return json(200, { ok: true, instanceId: OWNER, eventFeedV1: true });
    if (url.includes('/event-feed/snapshot')) { hits.feed += 1; return json(200, { ownerId: OWNER, cursor: '1:1', viewEpoch: 1, notifications: [], asks: [{ id: 'abc12345', question: 'la card che non sparisce', session: 's' }] }); }
    if (url.includes('/event-feed/asks/') && req.method === 'DELETE') { hits.dismiss += 1; return json(200, { dismissed: true }); }
    if (url.includes('/event-feed')) { hits.feed += 1; return json(409, { error: 'cursor is too old', reason: 'reset-required' }); }
    return json(404, { error: 'no stub' });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  t.after(() => { try { fake.closeAll && fake.closeAll(); fake.close(); } catch (_) {} });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncpixel-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const A = await boot(t, dir);
  let st = nodesStore.addNode(nodesStore.loadStoreStrict(A.nodesPath), {
    name: 'owner', remotePort: 41999, localPort: fake.address().port, nodeId: OWNER,
    token: 'TOK', direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@owner',
  });
  st = nodesStore.updateNode(st, 'owner', { eventsReceive: true });
  nodesStore.atomicWriteStore(A.nodesPath, st);
  // La card arriva via snapshot, poi lo stream 409 per sempre esaurisce il resync.
  const view = await waitUntil(async () => {
    const v = await feedView(A, OWNER);
    return v && v.stale === true && v.lastError === 'resync-exhausted' && hasAsk(v, 'abc12345') ? v : null;
  }, { tries: 100, what: 'gated view with the card' });
  assert.ok(view, 'the view is resync-exhausted with the card still in it');
  // Durante il cooldown l'owner non riceve nulla (il tappo di R5 resta).
  const feedBefore = hits.feed;
  await sleep(400);
  assert.equal(hits.feed, feedBefore, 'the exhausted view makes no request (R5)');
  const invalid = await fetch(`${A.base}/api/asks-relay`, {
    method: 'POST', headers: H(A.token),
    body: JSON.stringify({ action: 'dismiss', ownerId: OWNER, askId: 'not-hex' }),
  });
  assert.equal(invalid.status, 404, 'invalid ASK ids are refused by the routed allowlist');
  assert.equal(hits.dismiss, 0, 'an invalid id never forwards the dismiss to the owner');
  // Il dismiss confermato: 2xx dall'owner, scrittura arrivata.
  const r = await fetch(`${A.base}/api/asks-relay`, {
    method: 'POST', headers: H(A.token),
    body: JSON.stringify({ action: 'dismiss', ownerId: OWNER, askId: 'abc12345' }),
  });
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { dismissed: true });
  assert.equal(hits.dismiss, 1, 'the relay reached the owner exactly once');
  // La card esce dalla view NONOSTANTE lo stream morto: è il percorso che
  // mancava (dismissConfirmed senza chiamanti nella 0.9.52 e in e822fb0).
  const gone = await waitUntil(async () => !hasAsk(await feedView(A, OWNER), 'abc12345'));
  assert.ok(gone, 'the confirmed dismiss removes the card from the gated view');
});

// Il finding dell'audit (reaudit 2026-09-29): alla scadenza del cooldown uno
// snapshotOnce FALSE (oversize, owner-mismatch, resyncRequired) non riarmava
// il cooldown → uno snapshot a ogni tick, all'infinito. Via HTTP reale: un
// owner che prima fa esaurire il resync (stream 409 perenne) e poi risponde
// con snapshot oversize deve ricevere ESATTAMENTE uno snapshot per scadenza.
test('E2E: recupero fallito → una richiesta di snapshot per scadenza, non uno storm', async (t) => {
  const OWNER = 'd'.repeat(32);
  const hits = { snap: 0, stream: 0 };
  const small = JSON.stringify({ ownerId: OWNER, cursor: '1:1', viewEpoch: 1, notifications: [], asks: [] });
  const oversize = JSON.stringify({ ownerId: OWNER, cursor: '1:1', viewEpoch: 1, notifications: [], asks: [], filler: 'x'.repeat(4 * 1024 * 1024) });
  const fake = http.createServer((req, res) => {
    const url = req.url || '';
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url === '/federation/health') return json(200, { ok: true, instanceId: OWNER, eventFeedV1: true });
    if (url.includes('/event-feed/snapshot')) {
      hits.snap += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(hits.snap <= 3 ? small : oversize); // i primi 3 round esauriscono, poi il recupero fallisce
      return;
    }
    if (url.includes('/event-feed')) { hits.stream += 1; return json(409, { error: 'cursor is too old', reason: 'reset-required' }); }
    return json(404, { error: 'no stub' });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  t.after(() => { try { fake.close(); } catch (_) {} });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncrearm-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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
    eventFeedClientPollMs: 50,
    eventFeedClientMinSnapshotIntervalMs: 300,
    eventFeedClientResyncCooldownStepsMs: [300, 600, 1000],
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
  t.after(async () => { await sleep(40); server.close(); if (watcher) watcher.close(); });
  const A = await new Promise((res) => server.listen(0, '127.0.0.1', () => res({
    base: `http://127.0.0.1:${server.address().port}`, token, ...paths,
  })));
  let st = nodesStore.addNode(nodesStore.loadStoreStrict(A.nodesPath), {
    name: 'owner', remotePort: 41999, localPort: fake.address().port, nodeId: OWNER,
    token: 'TOK', direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@owner',
  });
  st = nodesStore.updateNode(st, 'owner', { eventsReceive: true });
  nodesStore.atomicWriteStore(A.nodesPath, st);
  // Esaurimento col primo gradino (3 round di snapshot+409).
  const armed = await waitUntil(async () => {
    const r = await fetch(`${A.base}/api/feed-state`, { headers: H(A.token) });
    const v = ((await r.json()).views || []).find((x) => x.ownerId === OWNER);
    return v && v.resyncBlockedUntil ? v : null;
  }, { tries: 100, what: 'cooldown armed' });
  assert.ok(armed, 'the view reaches the exhausted state with a cooldown');
  // Due scadenze (300 + 600 ms): il quinto snapshot è il recupero della
  // seconda scadenza; il terzo gradino (1000 ms) lo segue e resta FUORI dalla
  // finestra di asserzione — un tentativo per scadenza, mai di più.
  const five = await waitUntil(async () => hits.snap >= 5, { tries: 100, what: 'second recovery attempt' });
  assert.ok(five, 'two recovery attempts happened after two expiries');
  assert.equal(hits.snap, 5, 'exactly one recovery snapshot per expiry (3 + 2): ' + hits.snap);
  // L'arm del cooldown avviene quando il client PROCESSA la risposta, dopo il
  // conteggio lato server: prima la stabilità, poi la lettura dello stato.
  await sleep(500); // dentro il terzo gradino: nessun tentativo supplementare
  assert.equal(hits.snap, 5, 'the re-armed cooldown holds: no extra attempt before the next expiry');
  const r2 = await fetch(`${A.base}/api/feed-state`, { headers: H(A.token) });
  const v2 = ((await r2.json()).views || []).find((x) => x.ownerId === OWNER);
  assert.equal(v2.resyncExhaustions, 3, 'the ladder grew across the failed recoveries');
  assert.equal(v2.lastError, 'snapshot-oversize', 'the diagnostic carries the cause');
  assert.ok(v2.resyncBlockedUntil, 'the cooldown stays armed while the owner stays broken');
});

// Terzo giro dell'audit: il recupero può fallire anche LANCIANDO (500, rete,
// abort) — tutti gli esiti non riusciti del tentativo passano dallo stesso
// punto che riarma il cooldown, non da un ramo per tipo di errore.
function brokenRecoveryTest(label, failureMode, expectLastError) {
  test(`E2E: recupero che fallisce (${label}) → una richiesta per scadenza`, async (t) => {
    const OWNER = 'e'.repeat(32);
    const hits = { snap: 0, stream: 0 };
    const small = JSON.stringify({ ownerId: OWNER, cursor: '1:1', viewEpoch: 1, notifications: [], asks: [] });
    const fake = http.createServer((req, res) => {
      const url = req.url || '';
      const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (url === '/federation/health') return json(200, { ok: true, instanceId: OWNER, eventFeedV1: true });
      if (url.includes('/event-feed/snapshot')) {
        hits.snap += 1;
        if (hits.snap <= 3) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(small); return; }
        if (failureMode === 'http500') return json(500, { error: 'owner exploded' });
        req.socket.destroy(); // errore di rete: nessuna risposta, socket chiusa
        return;
      }
      if (url.includes('/event-feed')) { hits.stream += 1; return json(409, { error: 'cursor is too old', reason: 'reset-required' }); }
      return json(404, { error: 'no stub' });
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    t.after(() => { try { fake.close(); } catch (_) {} });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncthrow-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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
      eventFeedClientPollMs: 50,
      eventFeedClientMinSnapshotIntervalMs: 300,
      eventFeedClientResyncCooldownStepsMs: [300, 600, 1000],
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
    t.after(async () => { await sleep(40); server.close(); if (watcher) watcher.close(); });
    const A = await new Promise((res) => server.listen(0, '127.0.0.1', () => res({
      base: `http://127.0.0.1:${server.address().port}`, token, ...paths,
    })));
    let st = nodesStore.addNode(nodesStore.loadStoreStrict(A.nodesPath), {
      name: 'owner', remotePort: 41999, localPort: fake.address().port, nodeId: OWNER,
      token: 'TOK', direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@owner',
    });
    st = nodesStore.updateNode(st, 'owner', { eventsReceive: true });
    nodesStore.atomicWriteStore(A.nodesPath, st);
    const viewNow = async () => {
      const r = await fetch(`${A.base}/api/feed-state`, { headers: H(A.token) });
      return ((await r.json()).views || []).find((x) => x.ownerId === OWNER) || null;
    };
    const armed = await waitUntil(async () => {
      const v = await viewNow();
      return v && v.resyncBlockedUntil ? v : null;
    }, { tries: 100, what: 'cooldown armed' });
    assert.ok(armed, 'the view reaches the exhausted state with a cooldown');
    // Due scadenze (300 + 600 ms): due tentativi falliti, due riarma.
    const five = await waitUntil(async () => hits.snap >= 5, { tries: 100, what: 'second recovery attempt' });
    assert.ok(five, `two failed recovery attempts happened (${label})`);
    assert.equal(hits.snap, 5, 'one throwing recovery per expiry (3 + 2): ' + hits.snap);
    await sleep(500); // dentro il terzo gradino
    assert.equal(hits.snap, 5, 'the re-armed cooldown holds after a thrown recovery');
    assert.equal(hits.stream, 3, 'no stream request beyond the exhaustion rounds');
    const v2 = await viewNow();
    assert.equal(v2.resyncExhaustions, 3, 'the ladder grew across the thrown recoveries');
    // Il riarma segue il fetch fallito (che il socket distrutto rende lento):
    // tra consumo e riarma c'e' una finestra di transito, si accetta entro un tick.
    const rearmed = await waitUntil(async () => (await viewNow()).resyncBlockedUntil, { tries: 20, what: 'cooldown re-armed' });
    assert.ok(rearmed, 'the cooldown stays armed while the owner keeps failing');
    const v3 = await viewNow();
    if (expectLastError) assert.equal(v3.lastError, expectLastError, 'the cause lands in lastError');
    else assert.ok(v3.lastError, 'a cause lands in lastError');
  });
}
brokenRecoveryTest('HTTP 500', 'http500', 'snapshot HTTP 500');
brokenRecoveryTest('socket chiusa', 'socket', null);

// Il caso dell'ultimo giro di audit: un frame SSE malformato dopo uno
// snapshot valido azzera il cursore e, senza l'invariante, ripartiva lo
// snapshot a ogni tick (12 in 260 ms). Con la finestra minima la richiesta
// torna a UNA per intervallo, qualunque sia la causa del reset.
test('E2E: frame malformato dopo snapshot valido — uno snapshot per finestra', async (t) => {
  const OWNER = 'f'.repeat(32);
  const hits = { snap: 0, stream: 0 };
  const small = JSON.stringify({ ownerId: OWNER, cursor: '1:1', viewEpoch: 1, notifications: [], asks: [] });
  const fake = http.createServer((req, res) => {
    const url = req.url || '';
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url === '/federation/health') return json(200, { ok: true, instanceId: OWNER, eventFeedV1: true });
    if (url.includes('/event-feed/snapshot')) { hits.snap += 1; res.writeHead(200, { 'content-type': 'application/json' }); res.end(small); return; }
    if (url.includes('/event-feed')) {
      hits.stream += 1;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('id: 1:1\ndata: {"non json valida\n\n'); // frame malformato: il cursore cade, il resync riparte
      return;
    }
    return json(404, { error: 'no stub' });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  t.after(() => { try { fake.close(); } catch (_) {} });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncgap-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
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
    eventFeedClientPollMs: 50,
    eventFeedClientMinSnapshotIntervalMs: 800,
    eventFeedClientResyncCooldownStepsMs: [2000, 5000, 10000],
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
  t.after(async () => { await sleep(40); server.close(); if (watcher) watcher.close(); });
  const A = await new Promise((res) => server.listen(0, '127.0.0.1', () => res({
    base: `http://127.0.0.1:${server.address().port}`, token, ...paths,
  })));
  let st = nodesStore.addNode(nodesStore.loadStoreStrict(A.nodesPath), {
    name: 'owner', remotePort: 41999, localPort: fake.address().port, nodeId: OWNER,
    token: 'TOK', direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@owner',
  });
  st = nodesStore.updateNode(st, 'owner', { eventsReceive: true });
  nodesStore.atomicWriteStore(A.nodesPath, st);
  const viewNow = async () => {
    const r = await fetch(`${A.base}/api/feed-state`, { headers: H(A.token) });
    return ((await r.json()).views || []).find((x) => x.ownerId === OWNER) || null;
  };
  // Il primo snapshot arriva, il frame malformato fa ripartire il resync e
  // la finestra blocca il secondo: stale con cooldown visibile.
  assert.ok(await waitUntil(async () => {
    const v = await viewNow();
    return v && v.stale === true && v.nextSnapshotAllowedAt && hits.snap === 1 ? v : null;
  }, { tries: 100, what: 'rate-limited after the malformed frame' }), 'the view is stale with the window visible and ONE snapshot');
  await sleep(400); // dentro la finestra (800 ms)
  assert.equal(hits.snap, 1, 'no snapshot inside the window: ' + hits.snap);
  // Alla scadenza esattamente un altro snapshot, poi di nuovo finestra.
  await waitUntil(async () => hits.snap >= 2, { tries: 100, what: 'second snapshot after the window' });
  assert.equal(hits.snap, 2, 'one snapshot per interval: ' + hits.snap);
  await sleep(400);
  assert.equal(hits.snap, 2, 'the window holds after the second snapshot');
});

// La porta unica: GET /api/asks aziona la riconciliazione, che da R5 non fa
// più fetch dirette dello snapshot — passa dalla porta del feed client, e la
// finestra per owner vale anche per lei. N GET in 1 s → 0 o 1 snapshot.
test('E2E: N GET /api/asks in 1 s → al massimo uno snapshot per owner', async (t) => {
  const OWNER = '9'.repeat(32);
  const hits = { snap: 0, stream: 0 };
  // Owner pulito: lo snapshot non elenca la ask → la riconciliazione chiude
  // l'alias importato (il comportamento visto sull'alias 4f7cc1bc del Pixel).
  const small = JSON.stringify({ ownerId: OWNER, cursor: '1:1', viewEpoch: 1, notifications: [], asks: [] });
  const fake = http.createServer((req, res) => {
    const url = req.url || '';
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url === '/federation/health') return json(200, { ok: true, instanceId: OWNER, eventFeedV1: true });
    if (url.includes('/event-feed/snapshot')) { hits.snap += 1; res.writeHead(200, { 'content-type': 'application/json' }); res.end(small); return; }
    if (url.includes('/event-feed')) { hits.stream += 1; return json(409, { error: 'x', reason: 'reset-required' }); }
    return json(404, { error: 'no stub' });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  t.after(() => { try { fake.close(); } catch (_) {} });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncdoor-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir, configDir,
    configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'),
    tokenPath: path.join(configDir, 'token'),
  };
  nodesStore.initStore(paths.nodesPath);
  // Alias importato APERTO: è lui che dà lavoro alla riconciliazione.
  const alias = {
    id: '4f7cc1bc', question: 'alias che deve chiudersi', options: [],
    session: tmuxSessionForCell('dev'), ts: Date.now(), revision: 0,
    originNode: OWNER, ownerId: OWNER, ownerAskId: 'a3977abd',
  };
  fs.writeFileSync(path.join(configDir, 'asks.json'), JSON.stringify({ asks: [alias] }), { mode: 0o600 });
  const { server, token, watcher } = createServer({
    ...paths,
    filesRoot: path.join(dir, 'files'),
    port: 41999,
    fleetEnabled: false,
    eventFeedClientPollMs: 50,
    eventFeedClientMinSnapshotIntervalMs: 1000,
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
  t.after(async () => { await sleep(40); server.close(); if (watcher) watcher.close(); });
  const A = await new Promise((res) => server.listen(0, '127.0.0.1', () => res({
    base: `http://127.0.0.1:${server.address().port}`, token, ...paths,
  })));
  let st = nodesStore.addNode(nodesStore.loadStoreStrict(A.nodesPath), {
    name: 'owner', remotePort: 41999, localPort: fake.address().port, nodeId: OWNER,
    token: 'TOK', direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@owner',
  });
  nodesStore.atomicWriteStore(A.nodesPath, st);
  // 5 GET /api/asks entro 1 s: la riconciliazione parte a ogni lettura.
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${A.base}/api/asks`, { headers: H(A.token) });
    assert.equal(r.status, 200);
  }
  await sleep(150); // assestamento dei completamenti best-effort
  assert.ok(hits.snap <= 1, 'at most ONE snapshot reaches the owner per window: ' + hits.snap);
  assert.ok(hits.snap >= 1, 'the door actually fetched once: ' + hits.snap);
  // L'alias importato è stato chiuso (owner pulito → non elencato).
  const list = await fetch(`${A.base}/api/asks`, { headers: H(A.token) }).then((r) => r.json());
  const rec = (list.asks || []).find((a) => a.id === '4f7cc1bc');
  assert.ok(!rec || rec.dismissed === true, 'the imported alias is closed by the reconciliation');
});

// R6-1 (grave): con l'owner sottoscritto e il primo snapshot ancora in volo,
// uno skip NON è autorevole: la riconciliazione non deve chiudere un alias
// aperto sulla base di una view vuota per costruzione.
test('E2E: snapshot in volo — lo skip non chiude alias aperti', async (t) => {
  const OWNER = 'b'.repeat(31) + '1';
  const hits = { snap: 0 };
  const withAsk = JSON.stringify({ ownerId: OWNER, cursor: '1:1', viewEpoch: 1, notifications: [], asks: [{ id: 'a3977abd', question: 'aperta davvero', session: 's' }] });
  const fake = http.createServer((req, res) => {
    const url = req.url || '';
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url === '/federation/health') return json(200, { ok: true, instanceId: OWNER, eventFeedV1: true });
    if (url.includes('/event-feed/snapshot')) {
      hits.snap += 1;
      // Primo snapshot LENTO: resta in volo mentre arriva la GET /api/asks.
      setTimeout(() => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(withAsk); }, 400);
      return;
    }
    if (url.includes('/event-feed')) return json(409, { error: 'x', reason: 'reset-required' });
    return json(404, { error: 'no stub' });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  t.after(() => { try { fake.close(); } catch (_) {} });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncpend-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir, configDir,
    configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'),
    tokenPath: path.join(configDir, 'token'),
  };
  nodesStore.initStore(paths.nodesPath);
  const alias = {
    id: 'alias-pend', question: 'aperta davvero', options: [],
    session: tmuxSessionForCell('dev'), ts: Date.now(), revision: 0,
    originNode: OWNER, ownerId: OWNER, ownerAskId: 'a3977abd',
  };
  fs.writeFileSync(path.join(configDir, 'asks.json'), JSON.stringify({ asks: [alias] }), { mode: 0o600 });
  const { server, token, watcher } = createServer({
    ...paths,
    filesRoot: path.join(dir, 'files'),
    port: 41999,
    fleetEnabled: false,
    eventFeedClientPollMs: 50,
    eventFeedClientMinSnapshotIntervalMs: 1000,
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
  t.after(async () => { await sleep(40); server.close(); if (watcher) watcher.close(); });
  const A = await new Promise((res) => server.listen(0, '127.0.0.1', () => res({
    base: `http://127.0.0.1:${server.address().port}`, token, ...paths,
  })));
  let st = nodesStore.addNode(nodesStore.loadStoreStrict(A.nodesPath), {
    name: 'owner', remotePort: 41999, localPort: fake.address().port, nodeId: OWNER,
    token: 'TOK', direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@owner',
    eventsReceive: true,
  });
  nodesStore.atomicWriteStore(A.nodesPath, st);
  // La GET parte mentre il primo snapshot è in volo.
  await sleep(100);
  const r = await fetch(`${A.base}/api/asks`, { headers: H(A.token) });
  assert.equal(r.status, 200);
  await sleep(800); // il snapshot in volo si applica: l'ask è aperta sull'owner
  const list = await fetch(`${A.base}/api/asks`, { headers: H(A.token) }).then((x) => x.json());
  const rec = (list.asks || []).find((a) => a.id === 'alias-pend');
  assert.ok(rec, 'the alias still exists');
  assert.notEqual(rec.dismissed, true, 'a skipped snapshot never closes an open alias');
  assert.ok(hits.snap >= 1, 'the snapshot eventually landed: ' + hits.snap);
});

// R6-2: il timeout della porta copre fetch E corpo — un owner che manda gli
// header e non chiude il corpo non può appendere la GET /api/asks.
test('E2E: corpo che non finisce — la porta aborta e la GET risponde', async (t) => {
  const OWNER = 'c'.repeat(31) + '2';
  let headersSent = 0;
  const fake = http.createServer((req, res) => {
    const url = req.url || '';
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url === '/federation/health') return json(200, { ok: true, instanceId: OWNER, eventFeedV1: true });
    if (url.includes('/event-feed/snapshot')) {
      headersSent += 1;
      // Header FLUSHATI con un pezzo di corpo, poi niente più: è il caso
      // reale dell'audit (fetch risolve, r.text() resta appeso).
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"asks":');
      return;
    }
    if (url.includes('/event-feed')) return json(409, { error: 'x', reason: 'reset-required' });
    return json(404, { error: 'no stub' });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  t.after(() => { try { fake.close(); } catch (_) {} });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nchang-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir, configDir,
    configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'),
    tokenPath: path.join(configDir, 'token'),
  };
  nodesStore.initStore(paths.nodesPath);
  const alias = {
    id: 'alias-hang', question: 'alias con owner appeso', options: [],
    session: tmuxSessionForCell('dev'), ts: Date.now(), revision: 0,
    originNode: OWNER, ownerId: OWNER, ownerAskId: 'h4ng1ng',
  };
  fs.writeFileSync(path.join(configDir, 'asks.json'), JSON.stringify({ asks: [alias] }), { mode: 0o600 });
  const { server, token, watcher } = createServer({
    ...paths,
    filesRoot: path.join(dir, 'files'),
    port: 41999,
    fleetEnabled: false,
    eventFeedClientPollMs: 500,
    eventFeedClientMinSnapshotIntervalMs: 1000,
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
  t.after(async () => { await sleep(40); server.close(); if (watcher) watcher.close(); });
  const A = await new Promise((res) => server.listen(0, '127.0.0.1', () => res({
    base: `http://127.0.0.1:${server.address().port}`, token, ...paths,
  })));
  let st = nodesStore.addNode(nodesStore.loadStoreStrict(A.nodesPath), {
    name: 'owner', remotePort: 41999, localPort: fake.address().port, nodeId: OWNER,
    token: 'TOK', direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@owner',
  });
  nodesStore.atomicWriteStore(A.nodesPath, st);
  const t0 = Date.now();
  // La corsa sta nel test: oggi la GET resta appesa (il corpo non finisce e
  // la porta non aborta la lettura), e il rosso deve essere un rosso, non un
  // test appeso.
  const r = await Promise.race([
    fetch(`${A.base}/api/asks`, { headers: H(A.token) }),
    sleep(9000).then(() => null),
  ]);
  const elapsed = Date.now() - t0;
  assert.ok(r, 'the GET answers even with a hanging owner body (no hang)');
  assert.equal(r.status, 200, 'the GET answers even with a hanging owner body');
  assert.ok(elapsed < 6000, `the door timeout bounds the read (elapsed ${elapsed} ms)`);
  assert.ok(headersSent >= 1, 'the owner was actually contacted');
  // L'alias resta aperto: un timeout non è autorevole.
  const list = await r.json();
  const rec = (list.asks || []).find((a) => a.id === 'alias-hang');
  assert.ok(rec && rec.dismissed !== true, 'a timeout never closes an open alias');
});

// R6-3: una GET caduta nella finestra non può lasciare la card aperta per
// sempre: UN tentativo programmato alla scadenza della finestra, per owner,
// senza duplicati, chiude l'alias appena l'owner risulta pulito.
test('E2E: skip in finestra → un retry alla scadenza chiude l\'alias senza nuove GET', async (t) => {
  const OWNER = 'd'.repeat(31) + '3';
  const hits = { snap: 0 };
  const withAsk = JSON.stringify({ ownerId: OWNER, cursor: '1:1', viewEpoch: 1, notifications: [], asks: [{ id: 'a3977abd', question: 'aperta', session: 's' }] });
  const clean = JSON.stringify({ ownerId: OWNER, cursor: '1:2', viewEpoch: 1, notifications: [], asks: [] });
  const fake = http.createServer((req, res) => {
    const url = req.url || '';
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url === '/federation/health') return json(200, { ok: true, instanceId: OWNER, eventFeedV1: true });
    if (url.includes('/event-feed/snapshot')) {
      hits.snap += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(hits.snap <= 2 ? withAsk : clean); // i primi due lo elencano, poi l'owner lo chiude
      return;
    }
    if (url.includes('/event-feed')) return json(409, { error: 'x', reason: 'reset-required' });
    return json(404, { error: 'no stub' });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  t.after(() => { try { fake.close(); } catch (_) {} });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncretry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir, configDir,
    configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'),
    tokenPath: path.join(configDir, 'token'),
  };
  nodesStore.initStore(paths.nodesPath);
  const alias = {
    id: 'alias-retry', question: 'aperta', options: [],
    session: tmuxSessionForCell('dev'), ts: Date.now(), revision: 0,
    originNode: OWNER, ownerId: OWNER, ownerAskId: 'a3977abd',
  };
  fs.writeFileSync(path.join(configDir, 'asks.json'), JSON.stringify({ asks: [alias] }), { mode: 0o600 });
  const { server, token, watcher } = createServer({
    ...paths,
    filesRoot: path.join(dir, 'files'),
    port: 41999,
    fleetEnabled: false,
    eventFeedClientPollMs: 500,
    eventFeedClientMinSnapshotIntervalMs: 1000,
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
  t.after(async () => { await sleep(40); server.close(); if (watcher) watcher.close(); });
  const A = await new Promise((res) => server.listen(0, '127.0.0.1', () => res({
    base: `http://127.0.0.1:${server.address().port}`, token, ...paths,
  })));
  let st = nodesStore.addNode(nodesStore.loadStoreStrict(A.nodesPath), {
    name: 'owner', remotePort: 41999, localPort: fake.address().port, nodeId: OWNER,
    token: 'TOK', direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@owner',
  });
  nodesStore.atomicWriteStore(A.nodesPath, st);
  // GET 1: snapshot con la ask aperta → la card resta (autorevole).
  await fetch(`${A.base}/api/asks`, { headers: H(A.token) });
  await sleep(1200); // la finestra (1000 ms) scade, l'owner nel frattempo chiude
  // GET 2 dentro la NUOVA finestra... la prima richesta ha esaurito la finestra
  // precedente: questa GET genera il secondo snapshot (con la ask) e apre una
  // finestra nuova; la chiusura dell'owner è già effettiva al prossimo tentativo.
  await fetch(`${A.base}/api/asks`, { headers: H(A.token) });
  const afterGets = hits.snap;
  // Nessun'altra GET: solo il retry programmato può chiudere l'alias.
  const closed = await waitUntil(async () => {
    const l = await fetch(`${A.base}/api/asks`, { headers: H(A.token) }).then((x) => x.json());
    const rec = (l.asks || []).find((a) => a.id === 'alias-retry');
    return !rec || rec.dismissed === true;
  }, { tries: 60, what: 'alias closed by the scheduled retry' });
  assert.ok(closed, 'the scheduled retry closes the alias without new GETs');
  assert.ok(hits.snap >= afterGets + 1, 'the retry went through the door: ' + hits.snap);
});

// R7: il validatore dello snapshot è UNO per entrambe le vie. Owner NON
// sottoscritto: uno snapshot dichiarato incompleto (resyncRequired) o di un
// altro owner non è autorevole, e l'alias aperto non si chiude.
function unsubRejectionTest(label, snapBody, subscribed = false) {
  test(`E2E: owner ${subscribed ? 'sottoscritto' : 'non sottoscritto'}, snapshot ${label} — l'alias NON si chiude`, async (t) => {
    const OWNER = '7'.repeat(31) + label.length;
    const hits = { snap: 0 };
    const fake = http.createServer((req, res) => {
      const url = req.url || '';
      const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (url === '/federation/health') return json(200, { ok: true, instanceId: OWNER, eventFeedV1: true });
      if (url.includes('/event-feed/snapshot')) { hits.snap += 1; res.writeHead(200, { 'content-type': 'application/json' }); res.end(snapBody()); return; }
      if (url.includes('/event-feed')) return json(409, { error: 'x', reason: 'reset-required' });
      return json(404, { error: 'no stub' });
    });
    await new Promise((r) => fake.listen(0, '127.0.0.1', r));
    t.after(() => { try { fake.close(); } catch (_) {} });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncval-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const configDir = path.join(dir, '.nexuscrew');
    fs.mkdirSync(configDir, { recursive: true });
    const paths = {
      home: dir, configDir,
      configPath: path.join(configDir, 'config.json'),
      nodesPath: path.join(configDir, 'nodes.json'),
      tokenPath: path.join(configDir, 'token'),
    };
    nodesStore.initStore(paths.nodesPath);
    const alias = {
      id: 'alias-val', question: 'alias con snapshot non valido', options: [],
      session: tmuxSessionForCell('dev'), ts: Date.now(), revision: 0,
      originNode: OWNER, ownerId: OWNER, ownerAskId: 'a3977abd',
    };
    fs.writeFileSync(path.join(configDir, 'asks.json'), JSON.stringify({ asks: [alias] }), { mode: 0o600 });
    const { server, token, watcher } = createServer({
      ...paths,
      filesRoot: path.join(dir, 'files'),
      port: 41999,
      fleetEnabled: false,
      eventFeedClientPollMs: 500,
      eventFeedClientMinSnapshotIntervalMs: 1000,
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
    t.after(async () => { await sleep(40); server.close(); if (watcher) watcher.close(); });
    const A = await new Promise((res) => server.listen(0, '127.0.0.1', () => res({
      base: `http://127.0.0.1:${server.address().port}`, token, ...paths,
    })));
    let st = nodesStore.addNode(nodesStore.loadStoreStrict(A.nodesPath), {
      name: 'owner', remotePort: 41999, localPort: fake.address().port, nodeId: OWNER,
      token: 'TOK', direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@owner',
    });
    if (subscribed) st = nodesStore.updateNode(st, 'owner', { eventsReceive: true });
    nodesStore.atomicWriteStore(A.nodesPath, st);
    const r = await fetch(`${A.base}/api/asks`, { headers: H(A.token) });
    assert.equal(r.status, 200);
    const list = await r.json();
    const rec = (list.asks || []).find((a) => a.id === 'alias-val');
    assert.ok(rec, 'the alias still exists');
    assert.notEqual(rec.dismissed, true, `an ${label} snapshot never closes an open alias`);
    assert.ok(hits.snap >= 1, 'the owner was contacted: ' + hits.snap);
  });
}
unsubRejectionTest('resyncRequired', () => JSON.stringify({
  ownerId: '7'.repeat(31) + '14', cursor: '1:1', viewEpoch: 1, notifications: [],
  asks: [], resyncRequired: true,
}));
unsubRejectionTest('ownerId sbagliato', () => JSON.stringify({
  ownerId: 'f'.repeat(32), cursor: '1:1', viewEpoch: 1, notifications: [], asks: [],
}));
// Il bloccante del re-audit (2026-09-29): uno snapshot senza `asks` (o con
// asks non array) passava il validatore come 'ok'; applySnapshot lo trasformava
// in [] e la riconciliazione chiudeva alias ancora APERTI — l'elenco mancante
// diventava un elenco vuoto autorevole. Col schema completo la forma è
// rifiutata dal validatore unico PRIMA di ogni applicazione: nessuna chiusura,
// su entrambe le vie.
unsubRejectionTest('senza elenco', () => JSON.stringify({
  ownerId: '7'.repeat(31) + '11', cursor: '1:1', viewEpoch: 1, notifications: [],
}));
unsubRejectionTest('senza elenco sottoscritto', () => JSON.stringify({
  ownerId: '7'.repeat(31) + '26', cursor: '1:1', viewEpoch: 1, notifications: [],
}), true);
unsubRejectionTest('asks stringa', () => JSON.stringify({
  ownerId: '7'.repeat(31) + '12', cursor: '1:1', viewEpoch: 1, notifications: [], asks: 'no-array',
}));

// Il retry programmato della riconciliazione (via NON sottoscritta): una
// lettura caduta in finestra riceve 'skipped' dalla porta e arma UN tentativo
// alla scadenza, per owner, senza duplicati. Il registro dei retry armati era
// un Set usato con .set() (che su Set non esiste): TypeError alla prima
// armatura e il retry NON partiva mai. Qui si esercita il ciclo intero —
// prima lettura a finestra aperta ('ok', l'alias resta perché l'ask è viva),
// seconda lettura in finestra ('skipped' → retry armato), poi il retry parte
// da solo e l'owner viene contattato una seconda volta.
test('E2E: retry programmato del reconcile — skipped in finestra arma un secondo tentativo', async (t) => {
  const OWNER = '7'.repeat(31) + '9';
  const hits = { snap: 0 };
  const fake = http.createServer((req, res) => {
    const url = req.url || '';
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (url === '/federation/health') return json(200, { ok: true, instanceId: OWNER, eventFeedV1: true });
    if (url.includes('/event-feed/snapshot')) {
      hits.snap += 1;
      return json(200, {
        ownerId: OWNER, cursor: '1:1', viewEpoch: 1, notifications: [],
        asks: [{ id: 'a3977abd', question: 'aperta davvero', session: 's' }],
      });
    }
    if (url.includes('/event-feed')) return json(409, { error: 'x', reason: 'reset-required' });
    return json(404, { error: 'no stub' });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  t.after(() => { try { fake.close(); } catch (_) {} });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncretry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir, configDir,
    configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'),
    tokenPath: path.join(configDir, 'token'),
  };
  nodesStore.initStore(paths.nodesPath);
  const alias = {
    id: 'alias-val', question: 'alias vivo sul owner', options: [],
    session: tmuxSessionForCell('dev'), ts: Date.now(), revision: 0,
    originNode: OWNER, ownerId: OWNER, ownerAskId: 'a3977abd',
  };
  fs.writeFileSync(path.join(configDir, 'asks.json'), JSON.stringify({ asks: [alias] }), { mode: 0o600 });
  const { server, token, watcher } = createServer({
    ...paths,
    filesRoot: path.join(dir, 'files'),
    port: 41999,
    fleetEnabled: false,
    eventFeedClientPollMs: 500,
    eventFeedClientMinSnapshotIntervalMs: 1000,
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
  t.after(async () => { await sleep(40); server.close(); if (watcher) watcher.close(); });
  const A = await new Promise((res) => server.listen(0, '127.0.0.1', () => res({
    base: `http://127.0.0.1:${server.address().port}`, token, ...paths,
  })));
  let st = nodesStore.addNode(nodesStore.loadStoreStrict(A.nodesPath), {
    name: 'owner', remotePort: 41999, localPort: fake.address().port, nodeId: OWNER,
    token: 'TOK', direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@owner',
  });
  nodesStore.atomicWriteStore(A.nodesPath, st);
  // Prima lettura: finestra aperta → snapshot valido → 'ok'. L'ask è viva
  // sull'owner, quindi l'alias NON si chiude.
  const first = await fetch(`${A.base}/api/asks`, { headers: H(A.token) });
  assert.equal(first.status, 200);
  assert.equal(hits.snap, 1, 'the first read contacts the owner once');
  // Seconda lettura SUBITO dopo: dentro la finestra → 'skipped', NESSUNA
  // richiesta nuova, e il retry programmato si arma senza errori.
  await fetch(`${A.base}/api/asks`, { headers: H(A.token) });
  assert.equal(hits.snap, 1, 'a read inside the window makes no new request');
  // Il retry parte DA SOLO alla scadenza della finestra (1 s in test).
  const retried = await waitUntil(async () => hits.snap >= 2, { tries: 50, what: 'armed retry fires' });
  assert.ok(retried, 'the armed retry contacts the owner again');
  // L'alias è sopravvissuto a tutto il giro: l'ask è ancora aperta là.
  const list = await fetch(`${A.base}/api/asks`, { headers: H(A.token) }).then((r) => r.json());
  const rec = (list.asks || []).find((a) => a.id === 'alias-val');
  assert.ok(rec, 'the alias still exists');
  assert.notEqual(rec.dismissed, true, 'a live ask never closes its alias');
});
