'use strict';
// tests/fleet-public-catalog.test.js — lotto 2: models.dev come terza fonte.
//
// Il catalogo pubblico arriva SEMPRE da un server HTTP finto su 127.0.0.1:
// ogni URL richiesto dal modulo viene dirottato lì, quindi nessuna chiamata
// a models.dev vero esce mai da questi test. Ogni test ha la propria HOME
// isolata (mkdtemp): la cache su disco non tocca lo stato dell'operatore.
// L'orologio è iniettato: i TTL scadono avanzando il contatore, senza attese.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const {
  createModelDiscovery,
  mergeModelRecords,
  publicCatalogProviderId,
  publicCatalogVendorProviderId,
  publicCatalogVendorSplit,
  publicCatalogRecords,
  resolvePublicCatalogRecords,
  DISCOVERY_PROPOSAL_CAP,
  PUBLIC_CATALOG_TTL_MS,
  PUBLIC_CATALOG_URL,
} = require('../lib/fleet/model-discovery.js');

function isolatedHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ncpc-home-'));
}

function startFakeServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body, headers: req.headers });
      handler(req, res, requests);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ baseUrl: `http://127.0.0.1:${server.address().port}`, requests, server });
    });
  });
}

async function closeFakeServer(fake) {
  fake.server.closeAllConnections?.();
  await new Promise((resolve) => fake.server.close(resolve));
}

function json(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
}

// Qualunque URL il modulo chieda finisce sul server finto: la rete vera non
// viene mai toccata da questi test.
function fakeFetchFor(fake) {
  return (url, init) => fetch(String(url).replace(/^https?:\/\/[^/]+/u, fake.baseUrl), init);
}

// Snapshot finto con la stessa forma di models.dev: provider -> { id, models }.
const CATALOG = {
  zai: {
    id: 'zai', name: 'Z.AI',
    models: {
      'glm-5.3': {
        id: 'glm-5.3', limit: { context: 200000, output: 32000 }, tool_call: true,
        modalities: { input: ['text'], output: ['text'] }, reasoning: false,
      },
      'glm-4.6v': {
        id: 'glm-4.6v', limit: { context: 200000 }, tool_call: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        status: 'deprecated',
      },
    },
  },
  'ollama-cloud': {
    id: 'ollama-cloud',
    models: {
      'qwen3.5:397b': {
        limit: { context: 262144, output: 16384 }, tool_call: true,
        modalities: { input: ['text'] }, reasoning: true,
      },
    },
  },
};

// --- Snapshot: scarico, cache su disco, TTL -----------------------------------

test('snapshot: scarica, cache 0600 su dir 0700, entro il TTL zero rete', async () => {
  let clock = 1_000_000;
  let hits = 0;
  const fake = await startFakeServer((req, res) => { hits += 1; json(res, 200, CATALOG); });
  const home = isolatedHome();
  try {
    const md = createModelDiscovery({ now: () => clock });
    const first = await md.fetchPublicCatalogSnapshot({ home, fetchImpl: fakeFetchFor(fake), ttlMs: 5000, timeoutMs: 500 });
    assert.equal(first.status, 'api');
    assert.ok(first.catalog);
    assert.equal(hits, 1);

    // entro il TTL: cache in-process, nessuna richiesta
    const second = await md.fetchPublicCatalogSnapshot({ home, fetchImpl: fakeFetchFor(fake), ttlMs: 5000, timeoutMs: 500 });
    assert.equal(second.status, 'cache');
    assert.equal(second.stale, false);
    assert.equal(hits, 1);

    // istanza NUOVA, stessa HOME: vale la cache su disco, sempre zero rete
    const md2 = createModelDiscovery({ now: () => clock });
    const third = await md2.fetchPublicCatalogSnapshot({ home, fetchImpl: fakeFetchFor(fake), ttlMs: 5000, timeoutMs: 500 });
    assert.equal(third.status, 'cache');
    assert.equal(hits, 1);

    // file di cache: permessi, forma, contenuto
    const cached = path.join(home, '.nexuscrew', 'model-discovery', 'public-catalog.json');
    const raw = JSON.parse(fs.readFileSync(cached, 'utf8'));
    assert.equal(raw.kind, 'public-catalog');
    assert.equal(raw.fetchedAt, first.fetchedAt);
    assert.ok(raw.providers.zai.models['glm-5.3']);
    assert.equal(fs.statSync(cached).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(cached)).mode & 0o777, 0o700);

    // noCache: si forza la rete anche dentro il TTL
    const forced = await md.fetchPublicCatalogSnapshot({ home, fetchImpl: fakeFetchFor(fake), ttlMs: 5000, timeoutMs: 500, noCache: true });
    assert.equal(forced.status, 'api');
    assert.equal(hits, 2);

    // TTL scaduto: si torna alla rete
    clock += 6000;
    const expired = await md.fetchPublicCatalogSnapshot({ home, fetchImpl: fakeFetchFor(fake), ttlMs: 5000, timeoutMs: 500 });
    assert.equal(expired.status, 'api');
    assert.equal(hits, 3);
  } finally { await closeFakeServer(fake); }
});

test('snapshot: errore = ultimo buono (stale), poi niente; mai obbligatorio', async () => {
  let clock = 1_000_000;
  let broken = false;
  const fake = await startFakeServer((req, res) => {
    if (broken) return json(res, 500, { error: 'boom' });
    json(res, 200, CATALOG);
  });
  const home = isolatedHome();
  try {
    const md = createModelDiscovery({ now: () => clock });
    const good = await md.fetchPublicCatalogSnapshot({ home, fetchImpl: fakeFetchFor(fake), ttlMs: 1000, timeoutMs: 500 });
    assert.equal(good.status, 'api');

    broken = true;
    clock += 2000; // TTL scaduto: si ritenta, si fallisce, si ricade
    const stale = await md.fetchPublicCatalogSnapshot({ home, fetchImpl: fakeFetchFor(fake), ttlMs: 1000, timeoutMs: 500 });
    assert.equal(stale.status, 'cache');
    assert.equal(stale.stale, true);
    assert.ok(stale.error.length > 0);
    assert.ok(stale.catalog); // l'ultimo buono serve

    // senza cache su disco e in errore: status none, catalogo assente
    const none = await md.fetchPublicCatalogSnapshot({ home: isolatedHome(), fetchImpl: fakeFetchFor(fake), ttlMs: 1000, timeoutMs: 500 });
    assert.equal(none.status, 'none');
    assert.equal(none.catalog, null);
    assert.ok(none.error.length > 0);
  } finally { await closeFakeServer(fake); }
  const badJson = await startFakeServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('<html>not json</html>'); });
  try {
    const md4 = createModelDiscovery();
    const out = await md4.fetchPublicCatalogSnapshot({ home: isolatedHome(), fetchImpl: fakeFetchFor(badJson), ttlMs: 1000, timeoutMs: 500 });
    assert.equal(out.status, 'none');
    assert.equal(out.catalog, null);
  } finally { await closeFakeServer(badJson); }
});

// --- noCache: stesso contratto del layer API -----------------------------------

test('noCache vale anche per lo snapshot pubblico: niente scrittura, niente ripiego, status none', async () => {
  let clock = 1_000_000;
  let broken = false;
  const fake = await startFakeServer((req, res) => {
    if (broken) return json(res, 500, { error: 'boom' });
    json(res, 200, CATALOG);
  });
  const home = isolatedHome();
  try {
    const md = createModelDiscovery({ now: () => clock });
    // populate the disk snapshot the normal way
    const good = await md.fetchPublicCatalogSnapshot({ home, fetchImpl: fakeFetchFor(fake), ttlMs: 1000, timeoutMs: 500 });
    assert.equal(good.status, 'api');
    const cached = path.join(home, '.nexuscrew', 'model-discovery', 'public-catalog.json');
    const before = fs.readFileSync(cached, 'utf8');

    // network down + noCache: the stale snapshot is NOT a ripiego — status none
    broken = true;
    clock += 2000;
    const forced = await md.fetchPublicCatalogSnapshot({ home, fetchImpl: fakeFetchFor(fake), ttlMs: 1000, timeoutMs: 500, noCache: true });
    assert.equal(forced.status, 'none');
    assert.equal(forced.catalog, null);
    assert.ok(forced.error.length > 0);
    assert.equal(fs.readFileSync(cached, 'utf8'), before, 'a forced attempt never touches the file');

    // network back + noCache: answers 'api' but does not write the snapshot
    broken = false;
    clock += 2000;
    const fresh = await md.fetchPublicCatalogSnapshot({ home, fetchImpl: fakeFetchFor(fake), ttlMs: 1000, timeoutMs: 500, noCache: true });
    assert.equal(fresh.status, 'api');
    assert.ok(fresh.catalog);
    assert.equal(fs.readFileSync(cached, 'utf8'), before, 'a forced read must not rewrite the snapshot');
  } finally { await closeFakeServer(fake); }
});

test('il noCache del wrapper raggiunge il layer pubblico: il catalogo si riscarica, senza riscrivere il file', async () => {
  let clock = 1_000_000;
  let engineHits = 0;
  let catalogHits = 0;
  const engineServer = await startFakeServer((req, res) => { engineHits += 1; json(res, 200, { data: [{ id: 'glm-5.3' }] }); });
  const catalogServer = await startFakeServer((req, res) => { catalogHits += 1; json(res, 200, CATALOG); });
  const home = isolatedHome();
  try {
    const md = createModelDiscovery({ now: () => clock });
    const opts = () => ({
      engine: 'pc-refresh', collector: 'openai-compat', baseUrl: engineServer.baseUrl,
      home, ttlMs: 5000, timeoutMs: 500,
      publicCatalog: { provider: 'zai', ttlMs: 5000, timeoutMs: 500, fetchImpl: fakeFetchFor(catalogServer) },
    });
    const first = await md.discoverEngine(opts());
    assert.equal(first.source, 'api');
    assert.equal(first.publicCatalog.status, 'api');
    assert.equal(engineHits, 1);
    assert.equal(catalogHits, 1);
    const cached = path.join(home, '.nexuscrew', 'model-discovery', 'public-catalog.json');
    const before = fs.readFileSync(cached, 'utf8');

    // still inside both TTLs: a forced refresh must re-fetch BOTH layers
    clock += 1000;
    const forced = await md.discoverEngine({ ...opts(), noCache: true });
    assert.equal(forced.source, 'api');
    assert.equal(engineHits, 2);
    assert.equal(catalogHits, 2, 'the forced refresh reaches the public layer too');
    assert.equal(forced.publicCatalog.status, 'api');
    assert.equal(fs.readFileSync(cached, 'utf8'), before, 'the forced read leaves the snapshot alone');
  } finally {
    await closeFakeServer(engineServer);
    await closeFakeServer(catalogServer);
  }
});

// --- Mappatura -----------------------------------------------------------------

test('mappatura provider: tabella esplicita, host esatto, e il resto = nessun dato', () => {
  // tipi di engine noti → id del catalogo pubblico
  assert.equal(publicCatalogProviderId({ provider: 'zai' }), 'zai');
  assert.equal(publicCatalogProviderId({ provider: 'zai-a' }), 'zai');
  assert.equal(publicCatalogProviderId({ provider: 'zai-p' }), 'zai');
  assert.equal(publicCatalogProviderId({ provider: 'ollama-cloud' }), 'ollama-cloud');
  assert.equal(publicCatalogProviderId({ provider: 'opencode-go' }), 'opencode-go');
  assert.equal(publicCatalogProviderId({ provider: 'anthropic' }), 'anthropic');
  assert.equal(publicCatalogProviderId({ provider: 'openai' }), 'openai');
  assert.equal(publicCatalogProviderId({ provider: 'openai-api' }), 'openai');
  assert.equal(publicCatalogProviderId({ provider: 'deepseek' }), 'deepseek');
  assert.equal(publicCatalogProviderId({ provider: 'openrouter' }), 'openrouter');
  assert.equal(publicCatalogProviderId({ provider: 'nvidia' }), 'nvidia');
  assert.equal(publicCatalogProviderId({ provider: 'xai' }), 'xai');
  // engine custom: solo l'host ESATTO del base URL
  assert.equal(publicCatalogProviderId({ provider: 'custom', baseUrl: 'https://api.z.ai/api/v1' }), 'zai');
  assert.equal(publicCatalogProviderId({ provider: 'custom', baseUrl: 'https://ollama.com/v1' }), 'ollama-cloud');
  assert.equal(publicCatalogProviderId({ provider: 'custom', baseUrl: 'https://api.openai.com/v1' }), 'openai');
  assert.equal(publicCatalogProviderId({ provider: 'custom', baseUrl: 'https://integrate.api.nvidia.com/v1' }), 'nvidia');
  // host somigliante o provider sconosciuto: NESSUN dato, mai un guess
  assert.equal(publicCatalogProviderId({ provider: 'custom', baseUrl: 'https://api.z.ai.example.net/v1' }), null);
  assert.equal(publicCatalogProviderId({ provider: 'kimi-code' }), null);
  assert.equal(publicCatalogProviderId({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434' }), null);
  assert.equal(publicCatalogProviderId({}), null);
});

test('mappatura id modello: vendor riconosciuto da tabella esplicita, il resto non si tocca', () => {
  // prefisso vendor: SOLO la tabella esplicita decide chi è un vendor
  assert.deepEqual(publicCatalogVendorSplit('z-ai/glm-5.3'), { providerId: 'zai', rest: 'glm-5.3' });
  assert.equal(publicCatalogVendorProviderId('zai'), 'zai');
  assert.equal(publicCatalogVendorProviderId('ANTHROPIC'), 'anthropic');
  assert.equal(publicCatalogVendorProviderId('openai'), 'openai');
  // primo segmento NON in tabella: non è un vendor, non si rimuove mai
  assert.equal(publicCatalogVendorProviderId('mystery'), null);
  assert.equal(publicCatalogVendorSplit('mystery/glm-5.3'), null);
  assert.equal(publicCatalogVendorSplit('glm-5.3'), null);
  assert.equal(publicCatalogVendorSplit('/glm-5.3'), null);
  // comportamento: il namespace del vendor riconosciuto batte la chiave
  // esatta globale di un gateway, e il vendor si riconosce anche a maiuscole
  const cat = {
    gateway: { models: { 'z-ai/glm-5.3': { limit: { context: 111 } } } },
    zai: { models: { 'glm-5.3': { limit: { context: 200000 } } } },
  };
  const out = publicCatalogRecords(cat, null, ['z-ai/glm-5.3', 'Z-AI/glm-5.3', 'mystery/glm-5.3']);
  assert.deepEqual(out.map((r) => r.id), ['z-ai/glm-5.3', 'Z-AI/glm-5.3']);
  assert.equal(out[0].contextWindow, 200000); // namespace z-ai, non il gateway
  assert.equal(out[1].contextWindow, 200000);
});

test('mappatura record: campi normalizzati, assenti restano assenti, senza match nessun dato', () => {
  const out = publicCatalogRecords(CATALOG, 'zai', [
    'glm-5.3',            // match esatto
    'GLM-4.6V',           // match case-insensitive
    'glm-5.3[1m]',        // nessun match: NESSUN record
    'not-a-model',        // nessun match
    'glm-5.3',            // duplicato ignorato
  ]);
  assert.deepEqual(out.map((r) => r.id), ['glm-5.3', 'GLM-4.6V']);
  const exact = out[0];
  assert.equal(exact.contextWindow, 200000); // limit.context
  assert.equal(exact.maxTokens, 32000);      // limit.output
  assert.equal(exact.tools, true);           // tool_call
  assert.equal(exact.vision, false);         // modalities.input senza image
  assert.equal(exact.reasoning, false);
  assert.equal('deprecated' in exact, false); // non deprecato → assente
  const upper = out[1];
  assert.equal(upper.vision, true);           // input con image
  assert.equal(upper.deprecated, true);       // status deprecated
  assert.equal('maxTokens' in upper, false);  // limit.output assente → assente
  assert.equal('reasoning' in upper, false);  // assente → assente
  // provider assente dal catalogo: il fallback per id risolve comunque
  // globalmente, l'id della riga resta quello dell'API
  const byId = publicCatalogRecords(CATALOG, 'nope', ['glm-5.3']);
  assert.equal(byId.length, 1);
  assert.equal(byId[0].id, 'glm-5.3');
  assert.equal(byId[0].contextWindow, 200000);
  assert.deepEqual(publicCatalogRecords(null, 'zai', ['glm-5.3']), []);
  // suffisso cloud: l'id dell'API resta quello, i dati arrivano dal catalogo
  const cloud = publicCatalogRecords(CATALOG, 'ollama-cloud', ['qwen3.5:397b']);
  assert.equal(cloud.length, 1);
  assert.equal(cloud[0].id, 'qwen3.5:397b');
  assert.equal(cloud[0].contextWindow, 262144);
});

// --- Innesto: precedenza per campo sui quattro layer ---------------------------

test('innesto: utente > API > catalogo pubblico > backup, campo per campo, con fieldSources', () => {
  const merged = mergeModelRecords({
    userModels: [{ id: 'q', contextWindow: 111, reasoning: true }],
    apiModels: [{ id: 'q', contextWindow: 222, tools: true }, { id: 'only-api' }],
    publicCatalogModels: [{ id: 'q', contextWindow: 333, maxTokens: 555, deprecated: true }],
    backupModels: [{ id: 'q', contextWindow: 999, maxTokens: 999, vision: true, deprecated: true }],
    apiKnown: true,
    fetchedAt: 42,
  });
  const q = merged.find((m) => m.id === 'q');
  assert.equal(q.contextWindow, 111);   // utente sopra tutti
  assert.equal(q.tools, true);          // API dove l'utente tace
  assert.equal(q.maxTokens, 555);       // catalogo pubblico sopra il backup
  assert.equal(q.vision, true);         // backup per il resto
  assert.equal(q.reasoning, true);      // utente
  assert.equal(q.deprecated, true);     // pubblico (il backup diceva uguale)
  assert.deepEqual(q.fieldSources, {
    contextWindow: 'user', reasoning: 'user', tools: 'api',
    maxTokens: 'public', deprecated: 'public', vision: 'backup',
  });
  // un modello noto solo all'API resta, senza campi inventati
  const onlyApi = merged.find((m) => m.id === 'only-api');
  assert.equal(onlyApi.source, 'api');
  assert.equal('contextWindow' in onlyApi, false);
  assert.equal('deprecated' in onlyApi, false);
});

test('innesto end-to-end: discoverEngine con publicCatalog, cache valida = zero richieste extra', async () => {
  let clock = 1_000_000;
  let engineHits = 0;
  let catalogHits = 0;
  const engineServer = await startFakeServer((req, res) => { engineHits += 1; json(res, 200, { data: [{ id: 'glm-5.3' }, { id: 'glm-4.6v' }] }); });
  const catalogServer = await startFakeServer((req, res) => { catalogHits += 1; json(res, 200, CATALOG); });
  const home = isolatedHome();
  try {
    const md = createModelDiscovery({ now: () => clock });
    const opts = {
      engine: 'pc-engine', collector: 'openai-compat', baseUrl: engineServer.baseUrl,
      home, ttlMs: 5000, timeoutMs: 500,
      publicCatalog: { provider: 'zai', ttlMs: 5000, timeoutMs: 500, fetchImpl: fakeFetchFor(catalogServer) },
      backupModels: [{ id: 'wired-only', contextWindow: 8192 }],
    };
    const first = await md.discoverEngine(opts);
    assert.equal(first.source, 'api');
    assert.equal(first.publicCatalog.status, 'api');
    assert.equal(first.publicCatalog.providerId, 'zai');
    assert.equal(first.publicCatalog.records, 2); // glm-5.3 e glm-4.6v; wired-only non è nel catalogo
    assert.equal(engineHits, 1);
    assert.equal(catalogHits, 1);

    // glm-4.6v: campi dal catalogo pubblico, deprecation inclusa, fieldSources
    const vision = first.models.find((m) => m.id === 'glm-4.6v');
    assert.equal(vision.contextWindow, 200000);
    assert.equal(vision.vision, true);
    assert.equal(vision.deprecated, true);
    assert.equal(vision.fieldSources.contextWindow, 'public');
    assert.equal(vision.fieldSources.deprecated, 'public');
    // wired-only: resta di backup, il catalogo non ha nulla da dire
    const wired = first.models.find((m) => m.id === 'wired-only');
    assert.equal(wired.source, 'backup');
    assert.equal(wired.contextWindow, 8192);
    assert.equal('deprecated' in wired, false);

    // secondo giro, TTL validi: NESSUNA nuova richiesta, né engine né catalogo
    const second = await md.discoverEngine(opts);
    assert.equal(second.source, 'cache');
    assert.equal(second.publicCatalog.status, 'cache');
    assert.equal(second.publicCatalog.records, 2);
    assert.equal(engineHits, 1);
    assert.equal(catalogHits, 1);
  } finally {
    await closeFakeServer(engineServer);
    await closeFakeServer(catalogServer);
  }
});

test('provider senza mappatura: fallback per id con UN solo fetch fisso e keyless; senza id nessun fetch', async () => {
  let clock = 1_000_000;
  let catalogHits = 0;
  const engineServer = await startFakeServer((req, res) => json(res, 200, { data: [{ id: 'm-1' }] }));
  const emptyServer = await startFakeServer((req, res) => json(res, 200, { data: [] }));
  const catalogServer = await startFakeServer((req, res) => { catalogHits += 1; json(res, 200, CATALOG); });
  try {
    const md = createModelDiscovery({ now: () => clock });
    const home = isolatedHome();
    const out = await md.discoverEngine({
      engine: 'pc-unmapped', collector: 'openai-compat', baseUrl: engineServer.baseUrl,
      home, ttlMs: 5000, timeoutMs: 500,
      publicCatalog: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', fetchImpl: fakeFetchFor(catalogServer) },
    });
    assert.equal(out.source, 'api');
    assert.equal(out.publicCatalog.providerId, null);
    assert.equal(out.publicCatalog.status, 'api');
    // m-1 non è nel catalogo: zero record, ma il by-id è stato tentato
    assert.equal(out.publicCatalog.records, 0);
    assert.deepEqual(out.publicCatalog.byId, { rows: 0, enriched: 0, conflicts: 0, noData: 0 });
    assert.equal(catalogHits, 1);
    // la richiesta al catalogo è l'URL pubblico fisso: nessun nome di modello
    // locale, nessun URL/chiave dell'endpoint dentro la richiesta
    assert.equal(catalogServer.requests[0].url, '/api.json');
    assert.equal(catalogServer.requests[0].method, 'GET');
    assert.ok(!catalogServer.requests[0].headers.authorization);
    assert.ok(!catalogServer.requests[0].headers['x-api-key']);
    assert.equal(catalogServer.requests[0].body, '');

    // proposal vuota (nessun id da arricchire): NESSUN fetch, status skipped
    const home2 = isolatedHome();
    const skipped = await md.discoverEngine({
      engine: 'pc-empty', collector: 'openai-compat', baseUrl: emptyServer.baseUrl,
      home: home2, ttlMs: 5000, timeoutMs: 500,
      publicCatalog: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', fetchImpl: fakeFetchFor(catalogServer) },
    });
    assert.equal(skipped.publicCatalog.status, 'skipped');
    assert.equal(skipped.publicCatalog.records, 0);
    assert.equal(catalogHits, 1);
    assert.ok(!fs.existsSync(path.join(home2, '.nexuscrew', 'model-discovery', 'public-catalog.json')));
  } finally {
    await closeFakeServer(engineServer);
    await closeFakeServer(emptyServer);
    await closeFakeServer(catalogServer);
  }
});

// --- By-id fallback: tiers, consensus, conflicts ------------------------------

test('global tiers: exact beats folded, folded collects all case variants, cloud suffix strips', () => {
  const cat = {
    a: { models: { 'm-x': { limit: { context: 128000, output: 8192 }, reasoning: false } } },
    b: { models: { 'm-X': { limit: { context: 128000, output: 16384 } } } },
    c: { models: { 'm-y': { limit: { context: 99000 }, tool_call: true } } },
  };
  // exact tier wins alone: the folded 'M-X' of provider b is never consulted
  const exact = resolvePublicCatalogRecords(cat, null, ['m-x']);
  assert.equal(exact.records.length, 1);
  assert.equal(exact.records[0].contextWindow, 128000);
  assert.equal(exact.records[0].maxTokens, 8192);
  assert.equal(exact.records[0].reasoning, false);
  // case-folded tier takes ALL case variants as candidates and agrees per field
  const folded = resolvePublicCatalogRecords(cat, null, ['M-X']);
  assert.equal(folded.records.length, 1);
  assert.equal(folded.records[0].contextWindow, 128000);  // 128000/128000 agree
  assert.equal('maxTokens' in folded.records[0], false);  // 8192 vs 16384: conflict
  assert.equal(folded.records[0].reasoning, false);       // one value, one abstains
  assert.equal(folded.byId.conflicts, 1);
  // ':cloud' service suffix is the ONLY stripped form
  const cloud = resolvePublicCatalogRecords(cat, null, ['m-y:cloud', 'm-y-cloud']);
  assert.deepEqual(cloud.records.map((r) => r.id), ['m-y:cloud', 'm-y-cloud']);
  assert.equal(cloud.records[0].contextWindow, 99000);
  assert.equal(cloud.records[0].tools, true);
  // context-variant markers and tag/version suffixes are never stripped
  const intact = resolvePublicCatalogRecords(cat, null, ['m-x[1m]', 'm-x:397b', 'm-x-v2']);
  assert.deepEqual(intact.records, []);
});

test('per-field consensus: absent abstains, false is a value, disagreement leaves the field out', () => {
  const cat = {
    a: { models: { 'm': { limit: { context: 128000 }, reasoning: false } } },
    b: { models: { 'm': { limit: { context: 128000, output: 8192 } } } },
    c: { models: { 'm': { limit: { output: 16384 } } } },
  };
  const { records, byId } = resolvePublicCatalogRecords(cat, null, ['m']);
  assert.equal(records.length, 1);
  assert.equal(records[0].id, 'm');
  assert.equal(records[0].contextWindow, 128000); // 128k/128k/absent -> 128k
  assert.equal('maxTokens' in records[0], false); // 8k/16k -> absent
  assert.equal(records[0].reasoning, false);      // false/absent -> false
  assert.equal('tools' in records[0], false);
  assert.equal('vision' in records[0], false);
  assert.equal('deprecated' in records[0], false);
  assert.deepEqual(byId, { rows: 1, enriched: 1, conflicts: 1, noData: 3 });
});

test('a conflict does not descend to a weaker tier to dodge itself', () => {
  const cat = {
    p1: { models: { 'm-x': { limit: { context: 128000, output: 8192 } } } },
    p2: { models: { 'm-x': { limit: { context: 128000, output: 16384 }, tool_call: true } } },
    // weaker (case-folded) tier: agrees on output with p2 and has vision, but
    // the exact tier already has candidates, so this is never consulted
    p3: { models: { 'M-X': { limit: { context: 128000, output: 16384 }, modalities: { input: ['text', 'image'] } } } },
  };
  const { records, byId } = resolvePublicCatalogRecords(cat, null, ['m-x']);
  assert.equal(records.length, 1);
  assert.equal(records[0].contextWindow, 128000);       // agreed in the exact tier
  assert.equal('maxTokens' in records[0], false);       // 8k vs 16k conflict, NOT resolved via p3
  assert.equal(records[0].tools, true);                 // true/absent -> true
  assert.equal('vision' in records[0], false);          // only the weaker tier knows it
  assert.equal(byId.conflicts, 1);
});

test('a conflict inside the mapped provider namespace is counted, once', () => {
  // Case-folded collision in the engine's own provider: the field stays absent
  // (a weaker tier must not dodge it) and the diagnostic counter must see it.
  const cat = {
    openai: { models: { Foo: { limit: { context: 8192 } }, foo: { limit: { context: 16384 } } } },
    // A global candidate for the same id would agree on nothing useful here:
    // the blocked field is not consulted again, so it cannot be counted twice.
    acme: { models: { fOo: { limit: { context: 4096 } } } },
  };
  const out = resolvePublicCatalogRecords(cat, 'openai', ['fOo']);
  assert.deepEqual(out.records, []);
  assert.equal(out.byId.conflicts, 1);
});

test('mapped field wins and is never replaced by global consensus; missing fields are completed', () => {
  const cat = {
    zai: {
      models: {
        'glm-5.3': { limit: { context: 200000, output: 32000 }, tool_call: true },
      },
    },
    gateway: {
      models: {
        'glm-5.3': { limit: { context: 999999 }, modalities: { input: ['text', 'image'] }, reasoning: false },
      },
    },
    gateway2: { models: { 'glm-5.3': { limit: { context: 888888 } } } },
  };
  const { records, byId } = resolvePublicCatalogRecords(cat, 'zai', ['glm-5.3']);
  assert.equal(records.length, 1);
  // fields present in the mapped namespace stay, even where the global
  // candidates disagree (999999 vs 888888 never touches contextWindow)
  assert.equal(records[0].contextWindow, 200000);
  assert.equal(records[0].maxTokens, 32000);
  assert.equal(records[0].tools, true);
  // fields the mapped namespace lacks are completed by the by-id fallback
  assert.equal(records[0].vision, true);   // zai abstains, gateway says true
  assert.equal(records[0].reasoning, false);
  assert.deepEqual(byId, { rows: 1, enriched: 1, conflicts: 0, noData: 1 });
});

test('inverted provider and key order in the snapshot: same records, same counters', () => {
  const direct = {
    a: { models: { 'm-x': { limit: { context: 128000, output: 8192 }, reasoning: false } } },
    b: { models: { 'm-x': { limit: { context: 128000 }, tool_call: true } } },
    c: { models: { 'other': { limit: { context: 4096 } } } },
  };
  const reversed = {};
  for (const provId of Object.keys(direct).reverse()) {
    const models = {};
    for (const key of Object.keys(direct[provId].models).reverse()) models[key] = direct[provId].models[key];
    reversed[provId] = { ...direct[provId], models };
  }
  const ids = ['m-x', 'other', 'absent-model'];
  const one = resolvePublicCatalogRecords(direct, null, ids);
  const two = resolvePublicCatalogRecords(reversed, null, ids);
  assert.deepEqual(two.records, one.records);
  assert.deepEqual(two.byId, one.byId);
  assert.equal(one.records.length, 2);
  assert.equal(one.records[0].contextWindow, 128000);
  assert.equal(one.records[0].maxTokens, 8192); // one value, the other abstains
  assert.equal(one.records[0].tools, true);
  assert.equal(one.records[0].reasoning, false);
});

test('no new models: only proposal ids come out, and cap/order are untouched', async () => {
  const cat = {
    p: {
      models: Object.fromEntries([
        ...Array.from({ length: 130 }, (_, i) => [`api-${i}`, { limit: { context: 4096 } }]),
        ['user-1', { limit: { context: 8192 } }],
        ['user-2', { limit: { context: 8192 } }],
        ['ghost', { limit: { context: 1000000 } }],
      ]),
    },
  };
  const proposal = [
    ...Array.from({ length: 130 }, (_, i) => ({ id: `api-${i}` })),
  ];
  const userModels = [{ id: 'user-1' }, { id: 'user-2' }];
  // the resolver only ever returns ids it was given
  const { records } = resolvePublicCatalogRecords(cat, null, [...userModels, ...proposal].map((m) => m.id));
  const outIds = new Set(records.map((r) => r.id));
  assert.equal(outIds.has('ghost'), false);
  const merged = mergeModelRecords({
    userModels,
    apiModels: proposal,
    publicCatalogModels: records,
    apiKnown: true,
    fetchedAt: 42,
  });
  assert.equal(merged.length, DISCOVERY_PROPOSAL_CAP); // cap unchanged
  assert.deepEqual(merged.slice(0, 2).map((m) => m.id), ['user-1', 'user-2']); // order: user first
  assert.equal(merged[2].contextWindow, 4096); // public default arrived on an api row
  assert.ok(merged.every((m) => m.id.startsWith('api-') || m.id === 'user-1' || m.id === 'user-2'));

  // end to end: the merged proposal never grows a catalog-only id
  let clock = 1_000_000;
  const engineServer = await startFakeServer((req, res) => json(res, 200, { data: [{ id: 'm-x' }] }));
  const catalogServer = await startFakeServer((req, res) => json(res, 200, {
    a: { models: { 'm-x': { limit: { context: 128000 } } } },
    b: { models: { ghost: { limit: { context: 1000000 } } } },
  }));
  try {
    const md = createModelDiscovery({ now: () => clock });
    const out = await md.discoverEngine({
      engine: 'pc-noghost', collector: 'openai-compat', baseUrl: engineServer.baseUrl,
      home: isolatedHome(), ttlMs: 5000, timeoutMs: 500,
      publicCatalog: { provider: 'custom', baseUrl: engineServer.baseUrl, fetchImpl: fakeFetchFor(catalogServer) },
    });
    assert.deepEqual(out.models.map((m) => m.id), ['m-x']);
    assert.equal(out.models[0].contextWindow, 128000);
    assert.equal(out.models[0].fieldSources.contextWindow, 'public');
  } finally {
    await closeFakeServer(engineServer);
    await closeFakeServer(catalogServer);
  }
});

test('local endpoints join by id, user values stay on top, nothing local reaches the catalog', async () => {
  let clock = 1_000_000;
  const engineServer = await startFakeServer((req, res) => {
    // ollama collector: /api/tags with local model names
    json(res, 200, { models: [{ name: 'glm-5.3' }, { name: 'local-only-model' }] });
  });
  const catalogServer = await startFakeServer((req, res) => json(res, 200, CATALOG));
  const home = isolatedHome();
  try {
    const md = createModelDiscovery({ now: () => clock });
    const out = await md.discoverEngine({
      engine: 'pc-local', collector: 'ollama', baseUrl: engineServer.baseUrl,
      home, ttlMs: 5000, timeoutMs: 500,
      userModels: [{ id: 'glm-5.3', contextWindow: 111 }],
      publicCatalog: { provider: 'ollama', baseUrl: engineServer.baseUrl, fetchImpl: fakeFetchFor(catalogServer) },
    });
    assert.equal(out.source, 'api');
    assert.equal(out.publicCatalog.providerId, null); // local runtime: unmapped
    assert.equal(out.publicCatalog.records, 1);       // glm-5.3 resolved by id
    assert.deepEqual(out.publicCatalog.byId, { rows: 1, enriched: 1, conflicts: 0, noData: 1 });
    const enriched = out.models.find((m) => m.id === 'glm-5.3');
    assert.equal(enriched.contextWindow, 111); // user declaration beats the default
    assert.equal(enriched.fieldSources.contextWindow, 'user');
    assert.equal(enriched.maxTokens, 32000);   // completed from the catalog
    assert.equal(enriched.fieldSources.maxTokens, 'public');
    const localOnly = out.models.find((m) => m.id === 'local-only-model');
    assert.ok(localOnly, 'a model unknown to the catalog stays in the proposal');
    assert.equal('contextWindow' in localOnly, false);
    // the one catalog request is the fixed public snapshot: no local model
    // names, no local URL, no key anywhere in it
    assert.equal(catalogServer.requests.length, 1);
    assert.equal(catalogServer.requests[0].url, '/api.json');
    assert.ok(!catalogServer.requests[0].headers.authorization);
    assert.equal(catalogServer.requests[0].body, '');
  } finally {
    await closeFakeServer(engineServer);
    await closeFakeServer(catalogServer);
  }
});

test('known-gone ids of the proposal are enrichable too', async () => {
  let clock = 1_000_000;
  let engineListing = [{ id: 'm-x' }, { id: 'm-old' }];
  const engineServer = await startFakeServer((req, res) => json(res, 200, { data: engineListing }));
  const catalogServer = await startFakeServer((req, res) => json(res, 200, {
    a: { models: { 'm-x': { limit: { context: 128000 } }, 'm-old': { limit: { context: 99000 } } } },
  }));
  const home = isolatedHome();
  try {
    const md = createModelDiscovery({ now: () => clock });
    const opts = () => ({
      engine: 'pc-known', collector: 'openai-compat', baseUrl: engineServer.baseUrl,
      home, ttlMs: 5000, timeoutMs: 500,
      publicCatalog: { provider: 'custom', baseUrl: engineServer.baseUrl, fetchImpl: fakeFetchFor(catalogServer) },
    });
    const first = await md.discoverEngine(opts());
    assert.deepEqual(first.models.map((m) => m.id), ['m-x', 'm-old']);
    // the API drops m-old: a fresh read turns it into a known-gone row, and
    // the by-id fallback still enriches it
    engineListing = [{ id: 'm-x' }];
    clock += 6000;
    const second = await md.discoverEngine(opts());
    const old = second.models.find((m) => m.id === 'm-old');
    assert.ok(old, 'the known-gone row stays in the proposal');
    assert.equal(old.inApi, false);
    assert.equal(old.contextWindow, 99000);
    assert.equal(old.fieldSources.contextWindow, 'public');
  } finally {
    await closeFakeServer(engineServer);
    await closeFakeServer(catalogServer);
  }
});

test('costanti pubbliche: URL fisso e TTL di un giorno', () => {
  assert.equal(PUBLIC_CATALOG_URL, 'https://models.dev/api.json');
  assert.equal(PUBLIC_CATALOG_TTL_MS, 24 * 60 * 60 * 1000);
});
