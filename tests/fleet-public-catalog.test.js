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
  publicCatalogIdCandidates,
  publicCatalogRecords,
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

test('mappatura id modello: maiuscole, prefisso vendor/, suffissi :cloud e -cloud; il resto non si tocca', () => {
  // candidati in ordine: esatto, minuscolo, senza prefisso, senza suffisso
  assert.deepEqual(publicCatalogIdCandidates('GLM-5.3'), ['GLM-5.3', 'glm-5.3']);
  assert.deepEqual(publicCatalogIdCandidates('z-ai/glm-5.3'), ['z-ai/glm-5.3', 'glm-5.3']);
  assert.ok(publicCatalogIdCandidates('glm-5.3:cloud').includes('glm-5.3'));
  assert.ok(publicCatalogIdCandidates('glm-5.3-cloud').includes('glm-5.3'));
  // il marker di variante di contesto NON si normalizza: ereditare i limiti
  // del modello base sarebbero numeri sbagliati
  assert.deepEqual(publicCatalogIdCandidates('glm-5.3[1m]'), ['glm-5.3[1m]']);
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
  // provider senza modelli / id provider inesistente: nessun dato
  assert.deepEqual(publicCatalogRecords(CATALOG, 'nope', ['glm-5.3']), []);
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

test('innesto: provider senza mappatura = nessuna rete, nessun layer pubblico', async () => {
  let clock = 1_000_000;
  let catalogHits = 0;
  const engineServer = await startFakeServer((req, res) => json(res, 200, { data: [{ id: 'm-1' }] }));
  const catalogServer = await startFakeServer((req, res) => { catalogHits += 1; json(res, 200, CATALOG); });
  const home = isolatedHome();
  try {
    const md = createModelDiscovery({ now: () => clock });
    const out = await md.discoverEngine({
      engine: 'pc-unmapped', collector: 'openai-compat', baseUrl: engineServer.baseUrl,
      home, ttlMs: 5000, timeoutMs: 500,
      publicCatalog: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', fetchImpl: fakeFetchFor(catalogServer) },
    });
    assert.equal(out.source, 'api');
    assert.equal(out.publicCatalog.providerId, null);
    assert.equal(out.publicCatalog.status, 'skipped');
    assert.equal(out.publicCatalog.records, 0);
    // l'engine ha risposto; il catalogo non è stato nemmeno richiesto
    assert.equal(catalogHits, 0);
    assert.ok(!fs.existsSync(path.join(home, '.nexuscrew', 'model-discovery', 'public-catalog.json')));
  } finally {
    await closeFakeServer(engineServer);
    await closeFakeServer(catalogServer);
  }
});

test('costanti pubbliche: URL fisso e TTL di un giorno', () => {
  assert.equal(PUBLIC_CATALOG_URL, 'https://models.dev/api.json');
  assert.equal(PUBLIC_CATALOG_TTL_MS, 24 * 60 * 60 * 1000);
});
