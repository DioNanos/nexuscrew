'use strict';
// tests/snapshot-authority-property.test.js — PROPRIETÀ di autorità dello
// snapshot sulla chiusura degli alias importati.
//
// PROPRIETÀ: un alias importato ancora aperto si chiude SE E SOLO SE lo
// snapshot dell'owner che attraversa il sistema VERO (porta del feed client +
// riconciliazione del server, entrambi in esecuzione reale) è PIENAMENTE
// VALIDO e NON elenca l'ask dell'alias.
//
// «Pienamente valido» è il contratto DECISION-RELEVANT che il lato owner
// davvero emette (lib/notify/event-feed-routes.js, buildSnapshot), ridotto ai
// campi da cui la decisione di chiusura dipende:
//   - ownerId è esattamente quello atteso (stringa);
//   - resyncRequired non dichiara incompletezza e non è malformato
//     (assente o false; qualunque altro valore non è una forma dell'owner);
//   - `asks` ESISTE ed è un array: è il campo che la decisione legge, un
//     elenco inesistente non è un elenco autorevole;
//   - ogni elemento è un oggetto con id stringa 1..64 e sotto i 16 KiB
//     (i cap che il client stesso dichiara su snapshot ed elementi);
//   - l'elenco sta sotto il cap di pagina (100): a quel cap l'owner marca
//     resyncRequired, quindi un elenco al cap senza marcatore non prova
//     l'assenza di nessuna domanda;
//   - il corpo sta sotto i 3 MiB e la risposta è HTTP 200.
// I campi che la decisione NON legge (cursor, viewEpoch, notifications,
// fleetState, v, peerId…) sono comunque esercitati dal generatore, ma non
// fanno autorità qui: la proprietà misura la chiusura, non la view.
//
// MECCANICA: per OGNI caso un ricevente VERO (createServer) con un alias
// aperto nello store e un owner finto via HTTP che serve lo snapshot del
// caso; una sola GET /api/asks aziona la riconciliazione reale; l'esito è
// ciò che lo store dichiara dopo (alias.dismissed). SEME FISSO: la sequenza
// dei casi è riproducibile bit a bit.
//
// Il caso #0 è la FORMA MINIMA del difetto noto del validatore (lo snapshot
// senza `asks`); i casi #1..#5 sono i controlli di direzione (valido pulito
// chiude, valido che elenca non chiude, sulle due vie); da #6 in poi il
// generatore a seme mescola forme valide e malformate: campi mancanti, tipi
// sbagliati, annidamenti strani, valori al limite (id 64/64+1 caratteri,
// elemento 16 KiB e oltre, elenco 100/101, resyncRequired true/1/false).
// Sulla base congelata questa proprietà TROVA controesempi: il difetto è
// noto, e l'asserzione finale fallisce riportando il primo, minimale.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../lib/server.js');
const nodesStore = require('../lib/nodes/store.js');
const { tmuxSessionForCell } = require('../lib/fleet/definitions.js');

// --- costanti dell'esperimento ------------------------------------------------
const SEED = 0x0953;               // seme fisso: sequenza riproducibile
const CANON_CASES = 6;             // casi deterministici in testa
const RANDOM_CASES = 315;          // casi generati a seme
const TOTAL_CASES = CANON_CASES + RANDOM_CASES; // 321 ≥ 300
const CONCURRENCY = 3;             // casi indipendenti: server/store/dir propri
const CASE_TIMEOUT_MS = 15000;     // guardia anti-appendimento, non un'esito
const ASK_OWNER_ID = 'a3977abd';   // identità canonica dell'alias su ogni caso
const SNAPSHOT_MAX_ASKS = 100;     // cap di pagina del lato owner
const SNAPSHOT_ELEMENT_MAX_BYTES = 16 * 1024;
const SNAPSHOT_MAX_BYTES = 3 * 1024 * 1024;
const SNAPSHOT_ID_MAX_CHARS = 64;

// PRNG deterministico (mulberry32): tutta la casualità dell'harness esce da qui.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const chance = (p) => rnd() < p;
const pick = (arr) => arr[Math.min(arr.length - 1, Math.floor(rnd() * arr.length))];
const hexId = (n) => Array.from({ length: n }, () => '0123456789abcdef'[Math.floor(rnd() * 16)]).join('');
// owner unici e deterministici per indice: 32 caratteri esadecimali.
const ownerFor = (i) => (4096 + i).toString(16).padStart(32, '0');

// --- l'ORACOLO: quando uno snapshot è pienamente valido per chiudere --------
// Funzione PURA: decide l'atteso in base al contratto dell'owner, senza
// leggere il codice sotto esame.
function oracle(owner, status, body) {
  if (status !== 200) return { valid: false, why: `HTTP ${status}` };
  let snap;
  try { snap = JSON.parse(body); } catch (_) { return { valid: false, why: 'corpo non JSON' }; }
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) {
    return { valid: false, why: 'non è un oggetto JSON' };
  }
  if (snap.ownerId !== owner) return { valid: false, why: 'ownerId non è quello atteso' };
  if (!(snap.resyncRequired === undefined || snap.resyncRequired === false)) {
    return { valid: false, why: 'resyncRequired dichiara incompletezza o è malformato' };
  }
  if (!Array.isArray(snap.asks)) {
    return { valid: false, why: 'asks non è un array (campo mancante o tipo sbagliato)' };
  }
  if (snap.asks.length >= SNAPSHOT_MAX_ASKS) {
    return { valid: false, why: `elenco al cap di pagina (${SNAPSHOT_MAX_ASKS}): l'assenza non è provabile` };
  }
  for (const a of snap.asks) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) {
      return { valid: false, why: 'elemento di asks non è un oggetto' };
    }
    if (typeof a.id !== 'string' || a.id.length === 0 || a.id.length > SNAPSHOT_ID_MAX_CHARS) {
      return { valid: false, why: 'id dell\'elemento non è una stringa 1..64' };
    }
    if (Buffer.byteLength(JSON.stringify(a), 'utf8') > SNAPSHOT_ELEMENT_MAX_BYTES) {
      return { valid: false, why: 'elemento di asks oltre i 16 KiB' };
    }
  }
  if (Buffer.byteLength(body, 'utf8') > SNAPSHOT_MAX_BYTES) {
    return { valid: false, why: 'corpo oltre i 3 MiB' };
  }
  const contains = snap.asks.some((a) => String(a.id) === ASK_OWNER_ID);
  return { valid: true, why: 'pienamente valido', contains };
}

// --- generatore: snapshot validi e malformati --------------------------------
// Forma di partenza: quella dell'owner vero (buildSnapshot), con l'ask
// dell'alias elencato o no. Poi 0..3 mutazioni casuali distinte.
const MUTATIONS = [
  ['drop-asks', (s) => { delete s.asks; }],
  ['drop-ownerId', (s) => { delete s.ownerId; }],
  ['drop-cursor', (s) => { delete s.cursor; }],
  ['drop-viewEpoch', (s) => { delete s.viewEpoch; }],
  ['drop-notifications', (s) => { delete s.notifications; }],
  ['drop-fleetState', (s) => { delete s.fleetState; }],
  ['drop-v', (s) => { delete s.v; }],
  ['asks-tipo-sbagliato', (s) => {
    s.asks = pick([{}, 'non sono un array', 42, null, true, { 0: { id: 'x' } }]);
  }],
  ['asks-elem-null', (s) => { if (Array.isArray(s.asks)) s.asks[0] = null; }],
  ['asks-elem-stringa', (s) => { if (Array.isArray(s.asks)) s.asks.push('elemento scalare'); }],
  ['asks-elem-id-numero', (s) => { if (Array.isArray(s.asks)) s.asks.push({ id: 123 }); }],
  ['asks-elem-id-vuoto', (s) => { if (Array.isArray(s.asks)) s.asks.push({ id: '' }); }],
  ['asks-elem-id-65', (s) => { if (Array.isArray(s.asks)) s.asks.push({ id: hexId(65) }); }],
  ['asks-elem-id-64', (s) => { if (Array.isArray(s.asks)) s.asks.push({ id: hexId(64) }); }], // limite VALIDO
  ['asks-elem-grosso', (s) => { if (Array.isArray(s.asks)) s.asks.push({ id: hexId(8), filler: 'x'.repeat(17 * 1024) }); }],
  ['asks-al-cap-100', (s) => {
    s.asks = Array.from({ length: SNAPSHOT_MAX_ASKS }, () => ({ id: hexId(8), question: 'q', session: 's' }));
  }],
  ['asks-oltre-cap-101', (s) => {
    s.asks = Array.from({ length: SNAPSHOT_MAX_ASKS + 1 }, () => ({ id: hexId(8), question: 'q', session: 's' }));
  }],
  ['owner-altro', (s) => { s.ownerId = hexId(32); }],
  ['owner-numero', (s) => { s.ownerId = 42; }],
  ['resync-true', (s) => { s.resyncRequired = true; }],
  ['resync-truthy-1', (s) => { s.resyncRequired = 1; }],
  ['resync-false', (s) => { s.resyncRequired = false; }], // forma valida: non dichiara nulla
  ['viewEpoch-stringa', (s) => { s.viewEpoch = '1'; }],
  ['viewEpoch-null', (s) => { s.viewEpoch = null; }],
  ['notifications-tipo', (s) => { s.notifications = 'non sono un array'; }],
  ['annidamento-strano', (s) => {
    if (Array.isArray(s.asks)) s.asks.push({ id: hexId(8), deep: { a: [{ b: { c: [1, 2, { d: 'x' }] } }] }, arr: [[['x']]] });
  }],
  ['id-duplicati', (s) => {
    if (Array.isArray(s.asks) && s.asks.length) s.asks.push({ ...s.asks[0] });
  }],
  ['extra-campi', (s) => { s.sconosciuto = { annidato: { ancora: [1, 2, 3] } }; }],
];

function baseSnapshot(owner, listAsk) {
  const snap = {
    v: 1,
    ownerId: owner,
    peerId: hexId(32),
    viewEpoch: 1,
    cursor: '1:1',
    askReplyAccess: chance(0.5),
    asks: [],
    notifications: [],
    fleetState: { available: false, cells: [] },
    nodeState: { nodeId: owner },
    historyStatus: { size: 0 },
  };
  const n = Math.floor(rnd() * 4); // 0..3 domande di riempimento
  for (let k = 0; k < n; k++) snap.asks.push({ id: hexId(8), question: `q${k}`, session: 's' });
  if (listAsk) snap.asks.push({ id: ASK_OWNER_ID, question: 'la domanda dell\'alias', session: 's' });
  const m = Math.floor(rnd() * 3);
  for (let k = 0; k < m; k++) snap.notifications.push({ eventId: hexId(12), type: 'notify', title: 't' });
  return snap;
}

function randomCase(i) {
  const owner = ownerFor(i);
  const mode = chance(0.5) ? 'sub' : 'unsub';
  // Il 6% dei casi è di trasporto: errori HTTP e corpi che non sono JSON.
  if (chance(0.06)) {
    const kind = pick(['http-500', 'non-json', 'vuoto', 'oversize']);
    if (kind === 'http-500') return { i, owner, mode, status: 500, body: '{"error":"owner esploso"}' };
    if (kind === 'non-json') return { i, owner, mode, status: 200, body: '{questo non è json' };
    if (kind === 'vuoto') return { i, owner, mode, status: 200, body: '' };
    return {
      i, owner, mode, status: 200,
      body: JSON.stringify({ ...baseSnapshot(owner, chance(0.5)), filler: 'x'.repeat(4 * 1024 * 1024) }),
    };
  }
  const snap = baseSnapshot(owner, chance(0.4));
  if (chance(0.55)) {
    const howMany = 1 + Math.floor(rnd() * 3); // 1..3 mutazioni distinte
    const pool = [...MUTATIONS];
    for (let k = 0; k < howMany && pool.length; k++) {
      const idx = Math.floor(rnd() * pool.length) % pool.length;
      const [, mut] = pool.splice(idx, 1)[0];
      mut(snap);
    }
  }
  return { i, owner, mode, status: 200, body: JSON.stringify(snap) };
}

function buildCases() {
  const cases = [];
  const minNoAsks = (owner) => ({ ownerId: owner, cursor: '1:1', viewEpoch: 1, notifications: [] });
  const validClean = (owner) => ({
    v: 1, ownerId: owner, peerId: 'p'.repeat(32), viewEpoch: 1, cursor: '1:1',
    askReplyAccess: false, asks: [], notifications: [],
    fleetState: { available: false, cells: [] }, nodeState: { nodeId: owner }, historyStatus: { size: 0 },
  });
  const validWithAsk = (owner) => ({
    ...validClean(owner), asks: [{ id: ASK_OWNER_ID, question: 'la domanda dell\'alias', session: 's' }],
  });
  // #0: la forma MINIMA del difetto noto — snapshot senza `asks`, via sottoscritta.
  cases.push({ i: 0, owner: ownerFor(0), mode: 'sub', status: 200, body: JSON.stringify(minNoAsks(ownerFor(0))) });
  // #1: stessa forma sulla via non sottoscritta.
  cases.push({ i: 1, owner: ownerFor(1), mode: 'unsub', status: 200, body: JSON.stringify(minNoAsks(ownerFor(1))) });
  // #2/#3: controllo di direzione — valido e pulito: l'alias DEVE chiudersi.
  cases.push({ i: 2, owner: ownerFor(2), mode: 'sub', status: 200, body: JSON.stringify(validClean(ownerFor(2))) });
  cases.push({ i: 3, owner: ownerFor(3), mode: 'unsub', status: 200, body: JSON.stringify(validClean(ownerFor(3))) });
  // #4/#5: controllo di direzione — valido che elenca l'ask: NON deve chiudersi.
  cases.push({ i: 4, owner: ownerFor(4), mode: 'sub', status: 200, body: JSON.stringify(validWithAsk(ownerFor(4))) });
  cases.push({ i: 5, owner: ownerFor(5), mode: 'unsub', status: 200, body: JSON.stringify(validWithAsk(ownerFor(5))) });
  for (let i = CANON_CASES; i < TOTAL_CASES; i++) cases.push(randomCase(i));
  return cases;
}

// --- owner finto: UN server HTTP condiviso, risposta per token di caso -------
// Il ricevente autentica la richiesta dello snapshot con il token del peer:
// è quella la chiave con cui l'owner finto sceglie la risposta del caso.
function startFakeOwner(specs, counters) {
  const srv = http.createServer((req, res) => {
    const url = req.url || '';
    const token = String((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    const send = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };
    if (url.includes('/event-feed/snapshot')) {
      const spec = specs.get(token);
      if (!spec) { counters.unknownToken += 1; return send(404, { error: 'token sconosciuto' }); }
      counters.hits.set(token, (counters.hits.get(token) || 0) + 1);
      return send(spec.status, spec.body);
    }
    if (url.includes('/federation/health')) {
      return send(200, { ok: true, instanceId: token, eventFeedV1: true });
    }
    if (url.includes('/event-feed')) return send(409, { error: 'reset-required' });
    return send(404, { error: 'no stub' });
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve(srv)));
}

// --- un caso: ricevente VERO + alias aperto + una GET che aziona il reconcile --
async function runCase(c, fakeOwnerPort, rootDir) {
  const dir = path.join(rootDir, `case-${c.i}`);
  const configDir = path.join(dir, '.nexuscrew');
  fs.mkdirSync(configDir, { recursive: true });
  const paths = {
    home: dir, configDir,
    configPath: path.join(configDir, 'config.json'),
    nodesPath: path.join(configDir, 'nodes.json'),
    tokenPath: path.join(configDir, 'token'),
  };
  nodesStore.initStore(paths.nodesPath);
  // L'alias importato APERTO: identità canonica (ownerId, ownerAskId).
  const alias = {
    id: `alias-${c.i}`, question: 'alias della proprietà', options: [],
    session: tmuxSessionForCell('dev'), ts: 1700000000000, revision: 0,
    originNode: c.owner, ownerId: c.owner, ownerAskId: ASK_OWNER_ID,
    answered: false, dismissed: false,
  };
  fs.writeFileSync(path.join(configDir, 'asks.json'), JSON.stringify({ asks: [alias] }), { mode: 0o600 });

  const { server, token, watcher } = createServer({
    ...paths,
    filesRoot: path.join(dir, 'files'),
    port: 41999,
    fleetEnabled: false,
    // Il poll di fondo resta DORMIENTE: la sola via che tocca l'owner è la
    // porta aperta dalla GET (una richiesta per caso, deterministica).
    eventFeedClientPollMs: 3600000,
    eventFeedClientMinSnapshotIntervalMs: 1000,
    sessionExistsSeam: () => true,
    pasteSeam: () => true,
    askSubmit: () => ({ outcome: 'submitted', submitted: true }),
    settingsSeams: {
      platform: 'linux', uid: 1000,
      execImpl: () => { throw new Error('exec disabilitato nel test'); },
      serviceInstallPath: path.join(dir, 'systemd', 'nexuscrew.service'),
      keygen: () => 'ssh-ed25519 AAAAC3FAKEKEY nexuscrew-test',
      spawnImpl: () => ({ pid: 4193999, unref() {} }),
      sshVersion: () => ({ major: 9, minor: 6 }),
    },
  });
  const base = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
  let st = nodesStore.addNode(nodesStore.loadStoreStrict(paths.nodesPath), {
    name: 'owner', remotePort: 41999, localPort: fakeOwnerPort, nodeId: c.owner,
    token: `tok-${c.i}`, direction: 'outbound', shared: true, visibility: 'network', ssh: 'u@owner',
  });
  if (c.mode === 'sub') st = nodesStore.updateNode(st, 'owner', { eventsReceive: true });
  nodesStore.atomicWriteStore(paths.nodesPath, st);

  const out = { closed: null, found: null, http: null, anomaly: null };
  let guard = null;
  try {
    const timeoutP = new Promise((resolve) => {
      guard = setTimeout(() => resolve(null), CASE_TIMEOUT_MS);
      if (typeof guard.unref === 'function') guard.unref();
    });
    const r = await Promise.race([
      fetch(`http://127.0.0.1:${base}/api/asks`, { headers: { authorization: `Bearer ${token}` } }),
      timeoutP,
    ]);
    if (!r) { out.anomaly = 'GET appesa oltre la guardia'; return out; }
    out.http = r.status;
    if (r.status !== 200) { out.anomaly = `GET /api/asks → ${r.status}`; return out; }
    const list = await r.json();
    const rec = (list.asks || []).find((a) => a.id === alias.id);
    out.found = !!rec;
    if (!rec) { out.anomaly = 'alias scomparso dallo store'; return out; }
    out.closed = rec.dismissed === true || rec.answered === true;
  } finally {
    if (guard) clearTimeout(guard);
    try { server.close(); } catch (_) { /* già chiuso */ }
    try { if (watcher) watcher.close(); } catch (_) { /* già chiuso */ }
  }
  return out;
}

// --- il test di proprietà ----------------------------------------------------
test('proprietà: l\'alias importato si chiude se e solo se lo snapshot è pienamente valido e non lo elenca', { timeout: 600000 }, async (t) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-prop-'));
  const cases = buildCases();
  const specs = new Map(cases.map((c) => [`tok-${c.i}`, { status: c.status, body: c.body }]));
  const counters = { hits: new Map(), unknownToken: 0 };
  const fakeOwner = await startFakeOwner(specs, counters);
  t.after(async () => {
    await new Promise((r) => setTimeout(r, 120)); // assestamento delle socket
    try { fakeOwner.close(); } catch (_) { /* già chiuso */ }
    try { fs.rmSync(rootDir, { recursive: true, force: true }); } catch (_) { /* best-effort */ }
  });

  const results = new Array(cases.length).fill(null);
  let next = 0;
  async function worker() {
    for (;;) {
      const idx = next++;
      if (idx >= cases.length) return;
      const c = cases[idx];
      results[idx] = await runCase(c, fakeOwner.address().port, rootDir);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  // Sanezza della meccanica: ogni caso deve aver consultato l'owner esattamente
  // dalla propria porta, e nessun caso deve essere andato in anomalia.
  const anomalies = [];
  const noHit = [];
  for (const c of cases) {
    const r = results[c.i];
    if (!r) { anomalies.push(`caso #${c.i}: nessun esito`); continue; }
    if (r.anomaly) anomalies.push(`caso #${c.i}: ${r.anomaly}`);
    if ((counters.hits.get(`tok-${c.i}`) || 0) < 1) noHit.push(c.i);
  }
  assert.deepStrictEqual(anomalies, [], 'meccanica integra: nessuna anomalia di esecuzione');
  assert.deepStrictEqual(noHit, [], 'meccanica integra: la porta ha consultato l\'owner in ogni caso');
  assert.equal(counters.unknownToken, 0, 'meccanica integra: nessun token sconosciuto all\'owner finto');

  // La proprietà.
  const violations = [];
  const stats = { total: cases.length, sub: 0, unsub: 0, validClean: 0, validListed: 0, invalid: 0, closed: 0, byWhy: {} };
  for (const c of cases) {
    const r = results[c.i];
    const v = oracle(c.owner, c.status, c.body);
    const expected = v.valid && !v.contains;
    const actual = r.closed === true;
    if (c.mode === 'sub') stats.sub += 1; else stats.unsub += 1;
    if (v.valid && !v.contains) stats.validClean += 1;
    else if (v.valid && v.contains) stats.validListed += 1;
    else stats.invalid += 1;
    if (actual) stats.closed += 1;
    stats.byWhy[v.why] = (stats.byWhy[v.why] || 0) + 1;
    if (expected !== actual) {
      violations.push({
        i: c.i, mode: c.mode, why: v.why, contains: !!v.contains,
        expected, actual,
        body: c.body.length > 400 ? `${c.body.slice(0, 400)}…` : c.body,
      });
    }
  }

  const line = (x) => `${x}`.slice(0, 200);
  const detail = violations.slice(0, 5).map((x) => [
    `— caso #${x.i} [${x.mode === 'sub' ? 'sottoscritta' : 'non sottoscritta'}]`,
    `  snapshot: ${line(x.body)}`,
    `  oracolo: ${x.why} · elenca l'ask: ${x.contains ? 'sì' : 'no'}`,
    `  atteso: alias ${x.expected ? 'CHIUSO' : 'APERTO'} · effettivo: alias ${x.actual ? 'CHIUSO' : 'APERTO'}`,
  ].join('\n')).join('\n');
  t.diagnostic(`casi=${stats.total} (sottoscritta ${stats.sub}, non sottoscritta ${stats.unsub}) · `
    + `validi puliti ${stats.validClean}, validi che elencano ${stats.validListed}, non validi ${stats.invalid} · chiusi ${stats.closed} · violazioni ${violations.length}`);

  assert.equal(violations.length, 0,
    `la proprietà è violata in ${violations.length} casi (primi ${Math.min(5, violations.length)}):\n${detail}`);
});
