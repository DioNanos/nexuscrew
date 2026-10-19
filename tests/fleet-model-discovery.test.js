'use strict';
// tests/fleet-model-discovery.test.js — lotto 1 del catalogo dinamico.
//
// Tutte le richieste finiscono su server HTTP finti su 127.0.0.1: nessuna
// chiamata a provider veri, mai. Ogni test ha la propria HOME isolata
// (mkdtemp): la cache su disco non tocca mai lo stato dell'operatore.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const {
  createModelDiscovery, mergeModelRecords, COLLECTOR_KINDS,
  DISCOVERY_PROPOSAL_CAP, collectorDefaultTtlMs,
} = require('../lib/fleet/model-discovery.js');
const { CAPS } = require('../lib/fleet/definitions.js');

function isolatedHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ncmd-home-'));
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

const KEY = 'sekret-key-do-not-leak';

// --- Collector: uno per tipo di endpoint -----------------------------------

test('collector openai-compat: elenca i modelli e porta la chiave come Bearer', async () => {
  const fake = await startFakeServer((req, res) => json(res, 200, { data: [{ id: 'g-1' }, { id: 'g-2' }, { id: '../bad' }] }));
  try {
    const md = createModelDiscovery();
    const out = await md.fetchEngineModels({
      engine: 'e-openai', collector: 'openai-compat', baseUrl: fake.baseUrl,
      apiKey: KEY, home: isolatedHome(),
    });
    assert.equal(out.status, 'api');
    assert.deepEqual(out.apiModels.map((m) => m.id), ['g-1', 'g-2']);
    assert.equal(fake.requests.length, 1);
    assert.equal(fake.requests[0].url, '/v1/models');
    assert.equal(fake.requests[0].headers.authorization, `Bearer ${KEY}`);
  } finally { await closeFakeServer(fake); }
});

test('collector anthropic: impagina con after_id e usa x-api-key + anthropic-version', async () => {
  const fake = await startFakeServer((req, res, fakeRequests) => {
    if (req.url.includes('after_id=')) return json(res, 200, { data: [{ id: 'a-3' }], has_more: false, last_id: 'a-3' });
    return json(res, 200, { data: [{ id: 'a-1' }, { id: 'a-2' }], has_more: true, last_id: 'a-2' });
  });
  try {
    const md = createModelDiscovery();
    const out = await md.fetchEngineModels({
      engine: 'e-anthropic', collector: 'anthropic', baseUrl: `${fake.baseUrl}/v1`,
      apiKey: KEY, home: isolatedHome(),
    });
    assert.deepEqual(out.apiModels.map((m) => m.id), ['a-1', 'a-2', 'a-3']);
    assert.equal(fake.requests.length, 2);
    assert.ok(fake.requests[1].url.includes('after_id=a-2'));
    for (const r of fake.requests) {
      assert.equal(r.headers['x-api-key'], KEY);
      assert.equal(r.headers['anthropic-version'], '2023-06-01');
      assert.equal(r.headers.authorization, undefined);
    }
  } finally { await closeFakeServer(fake); }
});

test('collector ollama: /api/tags elenca, /api/show SOLO per gli id richiesti', async () => {
  const fake = await startFakeServer((req, res) => {
    if (req.url === '/api/tags') {
      return json(res, 200, { models: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] });
    }
    if (req.url === '/api/show') {
      return json(res, 200, {
        model_info: { 'llama.context_length': 8192 },
        capabilities: ['tools', 'vision'],
      });
    }
    json(res, 404, {});
  });
  try {
    const md = createModelDiscovery();
    const out = await md.fetchEngineModels({
      engine: 'e-ollama', collector: 'ollama', baseUrl: fake.baseUrl,
      home: isolatedHome(), detailIds: ['a', 'not-listed'],
    });
    const byId = Object.fromEntries(out.apiModels.map((m) => [m.id, m]));
    assert.deepEqual(Object.keys(byId).sort(), ['a', 'b', 'c']);
    assert.equal(byId.a.contextWindow, 8192);
    assert.equal(byId.a.tools, true);
    assert.equal(byId.a.vision, true);
    // b e c restano SENZA campi inventati
    assert.equal(byId.b.contextWindow, undefined);
    assert.deepEqual(Object.keys(byId.b), ['id']);
    // una sola chiamata /api/show, per 'a'; mai per i non richiesti
    const shows = fake.requests.filter((r) => r.url === '/api/show');
    assert.equal(shows.length, 1);
    assert.equal(JSON.parse(shows[0].body).name, 'a');
  } finally { await closeFakeServer(fake); }
});

test('collector llama-server (router --models-max 1): SOLO /v1/models e /props, mai richieste per modello', async () => {
  const fake = await startFakeServer((req, res) => {
    if (req.url === '/v1/models') {
      return json(res, 200, {
        data: [{ id: 'res-1' }, { id: 'res-2' }, { id: 'res-3' }, { id: 'res-4' }, { id: 'res-5' }],
      });
    }
    if (req.url === '/props') {
      return json(res, 200, {
        model_alias: 'res-2', n_ctx: 131072,
        modalities: { vision: true, audio: false },
        chat_template_caps: { tools: true },
      });
    }
    json(res, 404, {});
  });
  try {
    const md = createModelDiscovery();
    const out = await md.fetchEngineModels({
      engine: 'e-llama', collector: 'llama-server', baseUrl: fake.baseUrl,
      apiKey: KEY, home: isolatedHome(),
    });
    // IL vincolo: con 5 modelli elencati, le richieste totali sono esattamente
    // l'elenco + UN /props. Nessuna URL per singolo modello, mai.
    assert.deepEqual(fake.requests.map((r) => `${r.method} ${r.url}`), ['GET /v1/models', 'GET /props']);
    const byId = Object.fromEntries(out.apiModels.map((m) => [m.id, m]));
    // solo il residente dichiarato da /props viene arricchito
    assert.equal(byId['res-2'].contextWindow, 131072);
    assert.equal(byId['res-2'].vision, true);
    assert.equal(byId['res-2'].tools, true);
    assert.deepEqual(Object.keys(byId['res-1']), ['id']);
    // la chiave viaggia in header, come la usa il router
    for (const r of fake.requests) assert.equal(r.headers.authorization, `Bearer ${KEY}`);
  } finally { await closeFakeServer(fake); }
});

test('collector llama-server: /props che fallisce non butta la lista', async () => {
  const fake = await startFakeServer((req, res) => {
    if (req.url === '/v1/models') return json(res, 200, { data: [{ id: 'only' }] });
    json(res, 401, { error: 'Invalid API Key' });
  });
  try {
    const md = createModelDiscovery();
    const out = await md.fetchEngineModels({
      engine: 'e-llama2', collector: 'llama-server', baseUrl: fake.baseUrl,
      apiKey: KEY, home: isolatedHome(),
    });
    assert.equal(out.status, 'api');
    assert.deepEqual(out.apiModels.map((m) => m.id), ['only']);
  } finally { await closeFakeServer(fake); }
});

test('collector lmstudio: legge id e max_context_length', async () => {
  const fake = await startFakeServer((req, res) => json(res, 200, {
    data: [{ id: 'l-1', max_context_length: 4096, type: 'llm' }, { id: 'l-2' }],
  }));
  try {
    const md = createModelDiscovery();
    const out = await md.fetchEngineModels({
      engine: 'e-lmstudio', collector: 'lmstudio', baseUrl: fake.baseUrl, home: isolatedHome(),
    });
    assert.equal(fake.requests[0].url, '/api/v0/models');
    const byId = Object.fromEntries(out.apiModels.map((m) => [m.id, m]));
    assert.equal(byId['l-1'].contextWindow, 4096);
    assert.equal(byId['l-2'].contextWindow, undefined);
  } finally { await closeFakeServer(fake); }
});

// --- Errori, timeout, 401: ricaduta sul backup -------------------------------

test('401, connessione rifiutata e timeout: prima la cache buona, poi il backup; la chiave non esce MAI', async () => {
  let fail = false;
  const fake = await startFakeServer((req, res) => {
    if (fail) return json(res, 401, { error: `unauthorized bearer ${KEY}` });
    json(res, 200, { data: [{ id: 'live-1' }] });
  });
  const home = isolatedHome();
  const md = createModelDiscovery();
  const opts = { engine: 'e-fallback', collector: 'openai-compat', baseUrl: fake.baseUrl, apiKey: KEY, home, timeoutMs: 1500, ttlMs: 100 };
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  try {
    // primo giro: API buona
    const first = await md.discoverEngine({ ...opts, backupModels: [{ id: 'bak-1', contextWindow: 1024 }] });
    assert.equal(first.source, 'api');
    assert.ok(first.models.some((m) => m.id === 'live-1'));

    // il TTL scade, si ritenta, e ora il server risponde 401 (il body contiene
    // la chiave: non deve sopravvivere da nessuna parte, nemmeno nell'error)
    await delay(150);
    fail = true;
    const stale = await md.discoverEngine({ ...opts, backupModels: [{ id: 'bak-1', contextWindow: 1024 }] });
    assert.equal(stale.source, 'cache');
    assert.equal(stale.stale, true);
    assert.ok(stale.error.includes('HTTP 401'));
    assert.ok(!stale.error.includes(KEY));
    assert.ok(!JSON.stringify(stale).includes(KEY));
    // l'ultimo valore buono vince sul backup per i campi, e resta nella lista
    const live = stale.models.find((m) => m.id === 'live-1');
    assert.equal(live.source, 'api');
    const bak = stale.models.find((m) => m.id === 'bak-1');
    assert.equal(bak.source, 'backup');
    assert.equal(bak.inApi, false);

    // niente cache su disco: resta solo il backup
    const noCache = await md.discoverEngine({ ...opts, noCache: true, home: isolatedHome(), backupModels: [{ id: 'bak-1', contextWindow: 1024 }] });
    assert.equal(noCache.source, 'backup');
    assert.deepEqual(noCache.models.map((m) => m.id), ['bak-1']);
    assert.ok(!noCache.error.includes(KEY));
  } finally { await closeFakeServer(fake); }

  // connessione rifiutata (server spento: un router locale spento non è un errore)
  const dead = await md.discoverEngine({
    engine: 'e-dead', collector: 'openai-compat', baseUrl: fake.baseUrl,
    apiKey: KEY, home: isolatedHome(), backupModels: [{ id: 'bak-1' }],
  });
  assert.equal(dead.source, 'backup');
  assert.equal(dead.error, 'network error');
  assert.ok(!JSON.stringify(dead).includes(KEY));

  // timeout: il server non risponde entro il budget
  const slow = await startFakeServer((req, res) => { setTimeout(() => json(res, 200, { data: [] }), 400); });
  try {
    const timed = await md.discoverEngine({
      engine: 'e-slow', collector: 'openai-compat', baseUrl: slow.baseUrl,
      timeoutMs: 60, home: isolatedHome(), backupModels: [{ id: 'bak-1' }],
    });
    assert.equal(timed.source, 'backup');
    assert.ok(timed.error.includes('timeout'));
    assert.ok(!timed.error.includes(KEY));
  } finally { await closeFakeServer(slow); }
});

// --- Cache su disco con TTL ---------------------------------------------------

test('cache su disco con TTL: entro il TTL non si ritocca la rete, con noCache si', async () => {
  let hits = 0;
  const fake = await startFakeServer((req, res) => { hits += 1; json(res, 200, { data: [{ id: 'c-1' }] }); });
  const home = isolatedHome();
  try {
    const md = createModelDiscovery();
    const first = await md.discoverEngine({ engine: 'e-cache', collector: 'openai-compat', baseUrl: fake.baseUrl, home, ttlMs: 5000 });
    assert.equal(first.source, 'api');
    assert.equal(hits, 1);
    const cachedFile = path.join(home, '.nexuscrew', 'model-discovery', 'e-cache.json');
    const raw = JSON.parse(fs.readFileSync(cachedFile, 'utf8'));
    assert.equal(raw.engine, 'e-cache');
    assert.deepEqual(raw.models.map((m) => m.id), ['c-1']);
    assert.equal(fs.statSync(cachedFile).mode & 0o777, 0o600);
    // la cache non contiene MAI la chiave
    assert.ok(!fs.readFileSync(cachedFile, 'utf8').includes(KEY));

    const second = await md.discoverEngine({ engine: 'e-cache', collector: 'openai-compat', baseUrl: fake.baseUrl, home, ttlMs: 5000 });
    assert.equal(second.source, 'cache');
    assert.equal(second.stale, false);
    assert.equal(hits, 1);

    const forced = await md.discoverEngine({ engine: 'e-cache', collector: 'openai-compat', baseUrl: fake.baseUrl, home, ttlMs: 5000, noCache: true });
    assert.equal(forced.source, 'api');
    assert.equal(hits, 2);

    // TTL scaduto: si torna alla rete
    const third = await md.discoverEngine({ engine: 'e-cache', collector: 'openai-compat', baseUrl: fake.baseUrl, home, ttlMs: 0 });
    assert.equal(third.source, 'api');
    assert.equal(hits, 3);
  } finally { await closeFakeServer(fake); }
});

// --- Precedenza per campo, inApi, tetto ---------------------------------------

test('precedenza per campo: utente > API > catalogo pubblico (innesto lotto 2) > backup', () => {
  const merged = mergeModelRecords({
    userModels: [{ id: 'x', contextWindow: 111 }],
    apiModels: [{ id: 'x', contextWindow: 222, tools: true }, { id: 'y' }],
    publicCatalogModels: [{ id: 'x', maxTokens: 555 }],
    backupModels: [{ id: 'x', contextWindow: 999, maxTokens: 999, vision: true }, { id: 'z' }],
    apiKnown: true,
    fetchedAt: 123456,
  });
  const byId = Object.fromEntries(merged.map((m) => [m.id, m]));
  const x = byId.x;
  assert.equal(x.contextWindow, 111); // utente vince sempre, mai riscritto
  assert.equal(x.tools, true);        // API dove l'utente non parla
  assert.equal(x.maxTokens, 555);     // catalogo pubblico sopra il backup (lotto 2)
  assert.equal(x.vision, true);       // backup per ciò che nessun altro dice
  assert.equal(x.source, 'user');
  assert.deepEqual(x.fieldSources, { contextWindow: 'user', tools: 'api', maxTokens: 'public', vision: 'backup' });
  assert.equal(byId.y.source, 'api');
  assert.equal(byId.y.inApi, true);
  assert.equal(byId.z.source, 'backup');
  // un modello non presente nelle API non si cancella: si marca
  assert.equal(byId.z.inApi, false);
  assert.equal(byId.x.inApi, true); // dichiarato dall'utente E vivo nelle API
});

test('inApi resta ASSENTE quando l\'API non ha risposto (sconosciuto non è falso)', () => {
  const merged = mergeModelRecords({
    apiModels: [], backupModels: [{ id: 'z' }], apiKnown: false, fetchedAt: 1,
  });
  assert.equal(merged.length, 1);
  assert.equal('inApi' in merged[0], false);
});

test('tetto: la proposta non supera 128 e i modelli utente non vengono tagliati', () => {
  const apiModels = Array.from({ length: 200 }, (_, i) => ({ id: `api-${i}` }));
  const merged = mergeModelRecords({
    userModels: [{ id: 'keep-me' }], apiModels, fetchedAt: 1,
  });
  assert.equal(merged.length, DISCOVERY_PROPOSAL_CAP);
  assert.equal(merged[0].id, 'keep-me');
  assert.equal(merged[1].id, 'api-0');
  // il numero è lo stesso del gate del file: la scoperta propone, non riempie
  assert.equal(DISCOVERY_PROPOSAL_CAP, CAPS.MAX_MODELS);
});

test('collettori e TTL: cinque tipi, locali più freschi dei remoti', () => {
  assert.deepEqual([...COLLECTOR_KINDS], ['openai-compat', 'anthropic', 'ollama', 'llama-server', 'lmstudio']);
  assert.equal(collectorDefaultTtlMs('ollama'), collectorDefaultTtlMs('llama-server'));
  assert.equal(collectorDefaultTtlMs('lmstudio'), collectorDefaultTtlMs('llama-server'));
  assert.ok(collectorDefaultTtlMs('openai-compat') > collectorDefaultTtlMs('ollama'));
  assert.ok(collectorDefaultTtlMs('anthropic') > collectorDefaultTtlMs('lmstudio'));
});

// --- Per engine: piano che usa endpoint e chiave già configurati --------------

test('engineModelDiscoveryPlan: endpoint e chiave dello stesso motore, senza mai scriverle', async () => {
  const managed = require('../lib/fleet/managed.js');
  const home = isolatedHome();
  const plan = managed.engineModelDiscoveryPlan(
    { id: 'claude.ollama-cloud', provider: 'ollama-cloud', protocol: 'anthropic_messages', endpoint: 'https://ollama.com', auth: 'OLLAMA_API_KEY' },
    {}, { env: { OLLAMA_API_KEY: 'engine-own-key' } }, home,
  );
  assert.equal(plan.engine, 'claude.ollama-cloud');
  assert.equal(plan.collector, 'ollama');
  assert.equal(plan.baseUrl, 'https://ollama.com');
  assert.equal(plan.apiKey, 'engine-own-key');
  // il piano non lascia tracce su disco
  assert.ok(!fs.existsSync(path.join(home, '.nexuscrew')));
  // un profilo senza endpoint HTTP interrogabile non ha piano
  assert.equal(managed.engineModelDiscoveryPlan(
    { id: 'claude.native', provider: 'native', auth: 'login', protocol: 'anthropic_messages', endpoint: 'Anthropic account' },
    {}, { env: {} }, home,
  ), null);
  // the cache key follows the DECLARED engine id: two custom engines sharing
  // one profile must never share a cache file
  const declared = managed.engineModelDiscoveryPlan(
    { id: 'codex-vl.custom', provider: 'custom', protocol: 'openai_responses', endpoint: 'https://gw.example.test/v1' },
    { baseUrl: 'https://gw.example.test/v1' }, { env: {} }, home, 'my-api-b',
  );
  assert.equal(declared.engine, 'my-api-b');
  assert.equal(declared.collector, 'openai-compat');
  assert.equal(declared.baseUrl, 'https://gw.example.test/v1');
});

test('cache per engine dichiarato: endpoint cambiato si rilegge, il record porta l\'impronta e non la chiave', async () => {
  const fakeA = await startFakeServer((req, res) => json(res, 200, { data: [{ id: 'from-a' }] }));
  const fakeB = await startFakeServer((req, res) => json(res, 200, { data: [{ id: 'from-b' }] }));
  const home = isolatedHome();
  try {
    const md = createModelDiscovery();
    const first = await md.discoverEngine({
      engine: 'e-ep', collector: 'openai-compat', baseUrl: fakeA.baseUrl,
      apiKey: KEY, home, ttlMs: 60000,
    });
    assert.equal(first.source, 'api');
    assert.deepEqual(first.models.map((m) => m.id), ['from-a']);
    // the record stores a truncated sha256 of the normalized base URL: enough
    // to detect a config change, never the key nor anything derived from it
    const raw = JSON.parse(fs.readFileSync(path.join(home, '.nexuscrew', 'model-discovery', 'e-ep.json'), 'utf8'));
    assert.match(raw.endpoint, /^[0-9a-f]{16}$/u);
    assert.ok(!JSON.stringify(raw).includes(KEY));
    assert.ok(!JSON.stringify(raw).includes(fakeA.baseUrl), 'the endpoint travels as a fingerprint, not as a URL');
    // same engine, DIFFERENT endpoint, TTL still valid: the record does not
    // apply — the new endpoint is interrogated and the old listing is not served
    const second = await md.discoverEngine({
      engine: 'e-ep', collector: 'openai-compat', baseUrl: fakeB.baseUrl,
      apiKey: KEY, home, ttlMs: 60000,
    });
    assert.equal(second.source, 'api');
    assert.deepEqual(second.models.map((m) => m.id), ['from-b']);
    assert.equal(fakeB.requests.length, 1);
    // legacy record without a fingerprint: ignored without errors, not served,
    // not used as last-good, not force-deleted
    const legacyPath = path.join(home, '.nexuscrew', 'model-discovery', 'e-legacy.json');
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(legacyPath, JSON.stringify({
      version: 1, engine: 'e-legacy', collector: 'openai-compat',
      fetchedAt: Date.now(), models: [{ id: 'stale-legacy' }],
    }));
    const legacy = await md.discoverEngine({
      engine: 'e-legacy', collector: 'openai-compat', baseUrl: fakeA.baseUrl,
      apiKey: KEY, home, ttlMs: 60000,
    });
    assert.equal(legacy.source, 'api', 'the legacy record is not a usable cache hit');
    assert.deepEqual(legacy.models.map((m) => m.id), ['from-a']);
    assert.ok(fs.existsSync(legacyPath));
    const dead = await md.discoverEngine({
      engine: 'e-legacy', collector: 'openai-compat', baseUrl: 'http://127.0.0.1:1',
      apiKey: KEY, home, ttlMs: 60000, timeoutMs: 250,
    });
    assert.equal(dead.source, 'backup', 'a record from another endpoint is never the last-good value');
  } finally {
    await closeFakeServer(fakeA);
    await closeFakeServer(fakeB);
  }
});

// --- Lotto 3b: i modelli spariti restano --------------------------------------

test('un modello che era nelle API e non c\'è più resta nella proposta: layer known, inApi false', async () => {
  let listing = [{ id: 'gone-soon', contextWindow: 4096 }, { id: 'stays' }];
  const fake = await startFakeServer((req, res) => { json(res, 200, { data: listing }); });
  const home = isolatedHome();
  try {
    const md = createModelDiscovery();
    const first = await md.discoverEngine({ engine: 'e-gone', collector: 'openai-compat', baseUrl: fake.baseUrl, home, ttlMs: 0 });
    assert.deepEqual(first.models.map((m) => m.id), ['gone-soon', 'stays']);
    // Il provider ritira il modello: il listing fresco non lo contiene più e
    // NESSUN layer (utente, backup) lo dichiara. Senza il delta della cache
    // sparirebbe dalla proposta in silenzio.
    listing = [{ id: 'stays' }];
    const second = await md.discoverEngine({ engine: 'e-gone', collector: 'openai-compat', baseUrl: fake.baseUrl, home, ttlMs: 0 });
    const byId = Object.fromEntries(second.models.map((m) => [m.id, m]));
    const gone = byId['gone-soon'];
    assert.ok(gone, 'il modello sparito NON sparisce dalla proposta');
    assert.equal(gone.inApi, false);
    assert.equal(gone.source, 'known');
    assert.ok(!('contextWindow' in gone), 'il layer known porta solo l\'id: nessun campo, nessuna invenzione');
    // la cache appena scritta conserva SOLO il listing nuovo: la storia no
    const raw = JSON.parse(fs.readFileSync(path.join(home, '.nexuscrew', 'model-discovery', 'e-gone.json'), 'utf8'));
    assert.deepEqual(raw.models.map((m) => m.id), ['stays']);
    // la lettura successiva confronta col listing NUOVO: il delta si esaurisce,
    // il modello non risuscita per sempre
    const third = await md.discoverEngine({ engine: 'e-gone', collector: 'openai-compat', baseUrl: fake.baseUrl, home, ttlMs: 0 });
    assert.deepEqual(third.models.map((m) => m.id), ['stays']);
  } finally { await closeFakeServer(fake); }
});

test('noCache calcola comunque il delta degli spariti, ma la risposta non esce mai dal file', async () => {
  let listing = [{ id: 'v-1' }, { id: 'v-2' }];
  const fake = await startFakeServer((req, res) => { json(res, 200, { data: listing }); });
  const home = isolatedHome();
  try {
    const md = createModelDiscovery();
    await md.discoverEngine({ engine: 'e-nc', collector: 'openai-compat', baseUrl: fake.baseUrl, home, ttlMs: 5000 });
    listing = [{ id: 'v-1' }];
    const forced = await md.discoverEngine({ engine: 'e-nc', collector: 'openai-compat', baseUrl: fake.baseUrl, home, ttlMs: 5000, noCache: true });
    assert.equal(forced.source, 'api');
    const byId = Object.fromEntries(forced.models.map((m) => [m.id, m]));
    assert.equal(byId['v-1'].inApi, true);
    assert.equal(byId['v-2'].inApi, false, 'il rinfresco manuale vede comunque chi è sparito');
    // e con noCache il file non si è toccato: resta il listing di ieri
    const raw = JSON.parse(fs.readFileSync(path.join(home, '.nexuscrew', 'model-discovery', 'e-nc.json'), 'utf8'));
    assert.deepEqual(raw.models.map((m) => m.id), ['v-1', 'v-2']);
  } finally { await closeFakeServer(fake); }
});

test('una risposta API riuscita ma vuota sostituisce il listing precedente', async () => {
  let listing = [{ id: 'm1' }];
  let fail = false;
  const fake = await startFakeServer((req, res) => {
    if (fail) return json(res, 500, { error: 'boom' });
    json(res, 200, { data: listing });
  });
  const home = isolatedHome();
  const cacheFile = path.join(home, '.nexuscrew', 'model-discovery', 'e-empty.json');
  try {
    const md = createModelDiscovery();
    const first = await md.discoverEngine({ engine: 'e-empty', collector: 'openai-compat', baseUrl: fake.baseUrl, home, ttlMs: 0 });
    assert.equal(first.source, 'api');
    assert.deepEqual(first.models.map((m) => m.id), ['m1']);

    // the provider dropped EVERY model: a successful empty listing is a valid
    // answer — it replaces the previous one on disk, and the delta burns down
    listing = [];
    const second = await md.discoverEngine({ engine: 'e-empty', collector: 'openai-compat', baseUrl: fake.baseUrl, home, ttlMs: 0 });
    assert.equal(second.source, 'api');
    assert.deepEqual(second.disappeared, ['m1'], 'primo delta: m1 è sparito');
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    assert.deepEqual(raw.models, [], 'la cache registra il listing vuoto riuscito');

    const third = await md.discoverEngine({ engine: 'e-empty', collector: 'openai-compat', baseUrl: fake.baseUrl, home, ttlMs: 0 });
    assert.deepEqual(third.disappeared || [], [], 'secondo delta: esaurito');
    assert.deepEqual(third.models.map((m) => m.id), [], 'la proposta segue il listing vuoto');

    // an ERROR is still different from a successful empty listing: it rewrites
    // nothing, and the last good value (the empty one) serves as stale
    fail = true;
    const beforeError = fs.readFileSync(cacheFile, 'utf8');
    const fourth = await md.discoverEngine({ engine: 'e-empty', collector: 'openai-compat', baseUrl: fake.baseUrl, home, ttlMs: 0 });
    assert.equal(fourth.source, 'cache');
    assert.equal(fourth.stale, true);
    assert.deepEqual(fourth.models.map((m) => m.id), [], 'l\'ultimo valore buono era il listing vuoto');
    assert.equal(fs.readFileSync(cacheFile, 'utf8'), beforeError, 'un errore non riscrive niente');
  } finally { await closeFakeServer(fake); }
});

test('layer known: id nudi, sotto ogni altro layer, non vincono mai un campo', () => {
  const merged = mergeModelRecords({
    userModels: [{ id: 'k-1', contextWindow: 111 }],
    apiModels: [{ id: 'k-1', maxTokens: 222 }],
    knownModels: [{ id: 'k-1' }, { id: 'k-2' }],
    apiKnown: true,
  });
  const byId = Object.fromEntries(merged.map((m) => [m.id, m]));
  assert.equal(byId['k-1'].contextWindow, 111);
  assert.equal(byId['k-1'].maxTokens, 222);
  assert.equal(byId['k-1'].source, 'user');
  assert.equal(byId['k-2'].inApi, false);
  assert.equal(byId['k-2'].source, 'known');
  assert.ok(!('contextWindow' in byId['k-2']));
});
