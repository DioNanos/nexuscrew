'use strict';
// tests/fleet-engine-models-route.test.js — lotto 3a: la route API della
// scoperta modelli. Ogni endpoint HTTP dell'engine è un server finto su
// 127.0.0.1: nessuna chiamata a provider veri, mai (nemmeno al catalogo
// pubblico: il provider custom non ha mappatura host, quindi zero rete).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createServer } = require('../lib/server.js');

const FAKE_TMUX = path.join(__dirname, 'fixtures', 'fake-tmux.sh');
const KEY = 'sekret-route-key-do-not-leak';

function startFakeServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, body, headers: req.headers });
      handler(req, res);
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

// Server completo (bearer token attivo) con un fleet.json che dichiara un
// engine custom openai-compat puntato al server finto, più una dichiarazione
// utente di un modello.
async function bootWithCustomEngine(t, baseUrl, extraEngines = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncemr-'));
  process.env.FAKE_TMUX_LOG = path.join(dir, 'tmux.log');
  const defsPath = path.join(dir, 'fleet.json');
  fs.writeFileSync(defsPath, JSON.stringify({
    schemaVersion: 1,
    engines: [
      {
        id: 'myapi', label: 'My API', managed: {
          client: 'codex-vl', provider: 'custom', model: 'm-1', permissionPolicy: 'standard',
          displayName: 'My API', baseUrl, protocol: 'openai_responses',
          envKey: 'MY_API_KEY', providerId: 'my-api',
        },
      },
      ...extraEngines,
    ],
    models: [{ id: 'my-declared', engine: 'myapi', contextWindow: 123456, maxTokens: 4096 }],
    cells: [{ id: 'Dev', cwd: dir, engine: 'myapi', boot: false }],
  }), { mode: 0o600 });
  fs.chmodSync(defsPath, 0o600);
  const { server, token, watcher } = createServer({
    protectSharedTmuxServer: false,
    home: dir, tokenPath: path.join(dir, 'token'), filesRoot: path.join(dir, 'files'),
    tmuxBin: FAKE_TMUX, fleetDefsPath: defsPath,
    providerSecretsPath: path.join(dir, '.nexuscrew', 'providers.env'),
    providerShellPath: path.join(dir, '.config', 'ai-shell', 'providers.zsh'),
    providerKeysPath: path.join(dir, '.config', 'keys', 'ai.env'),
    providerSecurePath: path.join(dir, '.config', 'secure', '.env'),
    credentialsPath: path.join(dir, '.nexuscrew', 'credentials.json'),
  });
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  t.after(() => { server.close(); if (watcher) watcher.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  // La chiave entra nel local store del nodo: la scoperta la risolve con la
  // stessa strada del launcher e non deve mai farla uscire dalla risposta.
  const set = await fetch(`${base}/api/fleet/credentials/set`, {
    method: 'POST', headers: H, body: JSON.stringify({ envKey: 'MY_API_KEY', value: KEY }),
  });
  assert.equal(set.status, 200, 'credential set must succeed');
  return { base, H, dir };
}

test('ACL: senza token 401, con token 200; engine inesistente 404, engine non valido 400', async (t) => {
  const fake = await startFakeServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify({ data: [{ id: 'm-1' }] })));
  try {
    const { base, H } = await bootWithCustomEngine(t, fake.baseUrl);
    const anon = await fetch(`${base}/api/fleet/engine-models?engine=myapi`);
    assert.equal(anon.status, 401, 'no token -> no discovery');
    const badToken = await fetch(`${base}/api/fleet/engine-models?engine=myapi`, { headers: { authorization: 'Bearer wrong' } });
    assert.equal(badToken.status, 401, 'wrong token -> no discovery');
    const missing = await fetch(`${base}/api/fleet/engine-models?engine=nope`, { headers: H });
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, 'engine sconosciuto: nope');
    const invalid = await fetch(`${base}/api/fleet/engine-models?engine=${encodeURIComponent('../x')}`, { headers: H });
    assert.equal(invalid.status, 400);
    assert.equal((await invalid.json()).error, 'engine non valido');
    const ok = await fetch(`${base}/api/fleet/engine-models?engine=myapi`, { headers: H });
    assert.equal(ok.status, 200);
  } finally { await closeFakeServer(fake); }
});

test('la risposta porta record normalizzati con fieldSources e inApi, e mai la chiave', async (t) => {
  const fake = await startFakeServer((req, res) => {
    if (!req.url.includes('/v1/models')) {
      res.writeHead(404); res.end('{}'); return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [
      { id: 'm-1', contextWindow: 65536, maxTokens: 8192, tools: true },
      { id: 'm-2' },
    ] }));
  });
  try {
    const { base, H } = await bootWithCustomEngine(t, fake.baseUrl);
    const out = await (await fetch(`${base}/api/fleet/engine-models?engine=myapi`, { headers: H })).json();
    // La chiave dell'engine viaggia come Bearer verso l'endpoint...
    assert.equal(fake.requests[0].headers.authorization, `Bearer ${KEY}`);
    // ...ma non compare da nessuna parte nella risposta.
    assert.ok(!JSON.stringify(out).includes(KEY), 'the engine key must never appear in the response');
    assert.equal(out.engine, 'myapi');
    assert.equal(out.supported, true);
    assert.equal(out.source, 'api');
    assert.equal(out.status, 'api');
    assert.equal(out.stale, false);
    const byId = new Map(out.models.map((m) => [m.id, m]));
    const user = byId.get('my-declared');
    assert.ok(user, 'the user-declared model is in the proposal');
    assert.equal(user.contextWindow, 123456);
    assert.equal(user.fieldSources.contextWindow, 'user');
    assert.equal(user.inApi, false, 'declared but absent from the API listing');
    const m1 = byId.get('m-1');
    assert.equal(m1.contextWindow, 65536);
    assert.equal(m1.maxTokens, 8192);
    assert.equal(m1.tools, true);
    assert.equal(m1.fieldSources.contextWindow, 'api');
    assert.equal(m1.inApi, true);
    const m2 = byId.get('m-2');
    assert.equal(m2.inApi, true);
    assert.ok(!('contextWindow' in m2), 'absent fields stay absent');
  } finally { await closeFakeServer(fake); }
});

test('refresh=1 salta la cache: richiesta nuova, la lettura normale no', async (t) => {
  const fake = await startFakeServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify({ data: [{ id: 'm-1' }] })));
  try {
    const { base, H } = await bootWithCustomEngine(t, fake.baseUrl);
    await fetch(`${base}/api/fleet/engine-models?engine=myapi`, { headers: H });
    assert.equal(fake.requests.length, 1);
    // Entro il TTL: la cache serve, zero richieste nuove.
    await fetch(`${base}/api/fleet/engine-models?engine=myapi`, { headers: H });
    assert.equal(fake.requests.length, 1);
    // refresh=1: la cache si salta, una richiesta nuova parte.
    const forced = await (await fetch(`${base}/api/fleet/engine-models?engine=myapi&refresh=1`, { headers: H })).json();
    assert.equal(fake.requests.length, 2);
    assert.equal(forced.source, 'api');
    assert.ok(!JSON.stringify(forced).includes(KEY));
  } finally { await closeFakeServer(fake); }
});

test('due engine custom dello stesso client: cache separata, ognuno riceve i modelli del SUO endpoint', async (t) => {
  const fakeA = await startFakeServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify({ data: [{ id: 'only-a' }] })));
  const fakeB = await startFakeServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify({ data: [{ id: 'only-b' }] })));
  try {
    const { base, H, dir } = await bootWithCustomEngine(t, fakeA.baseUrl, [
      {
        id: 'myapi-b', label: 'My API B', managed: {
          client: 'codex-vl', provider: 'custom', model: 'm-1', permissionPolicy: 'standard',
          displayName: 'My API B', baseUrl: fakeB.baseUrl, protocol: 'openai_responses',
          envKey: 'MY_API_KEY', providerId: 'my-api-b',
        },
      },
    ]);
    const a = await (await fetch(`${base}/api/fleet/engine-models?engine=myapi`, { headers: H })).json();
    assert.equal(a.source, 'api');
    assert.ok(a.models.some((m) => m.id === 'only-a'));
    assert.equal(fakeA.requests.length, 1);
    // Same client, same shared profile, different endpoint: the second engine
    // must interrogate ITS endpoint — not serve the first engine's cache.
    const b = await (await fetch(`${base}/api/fleet/engine-models?engine=myapi-b`, { headers: H })).json();
    assert.equal(b.source, 'api');
    assert.equal(fakeB.requests.length, 1, 'myapi-b interrogates its own endpoint');
    assert.ok(b.models.some((m) => m.id === 'only-b'), 'its own models');
    assert.ok(!b.models.some((m) => m.id === 'only-a'), 'never the other endpoint\'s models');
    // the cache files are per declared engine: no shared profile-keyed file
    assert.ok(fs.existsSync(path.join(dir, '.nexuscrew', 'model-discovery', 'myapi.json')));
    assert.ok(fs.existsSync(path.join(dir, '.nexuscrew', 'model-discovery', 'myapi-b.json')));
    assert.ok(!fs.existsSync(path.join(dir, '.nexuscrew', 'model-discovery', 'codex-vl.custom.json')));
  } finally {
    await closeFakeServer(fakeA);
    await closeFakeServer(fakeB);
  }
});

test('errore di rete: risposta 200 con esito honest (backup/stale) e messaggio a stringa fissa', async (t) => {
  const fake = await startFakeServer((_req, res) => res.writeHead(200, { 'content-type': 'application/json' })
    .end(JSON.stringify({ data: [{ id: 'm-1' }] })));
  try {
    const { base, H, dir } = await bootWithCustomEngine(t, fake.baseUrl);
    // Prima lettura buona (popola la cache su disco della home del server).
    await fetch(`${base}/api/fleet/engine-models?engine=myapi`, { headers: H });
    await closeFakeServer(fake);
    // Entro il TTL la cache buona serve senza rete; forzando la SCADENZA sul
    // file (fetchedAt indietro) con endpoint morto, torna l'ultimo valore
    // buono marcato stale.
    // The cache file is keyed by the DECLARED engine id (myapi), not by the
    // shared custom profile: two custom engines never share a listing.
    const cacheFile = path.join(dir, '.nexuscrew', 'model-discovery', 'myapi.json');
    const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    cached.fetchedAt -= 48 * 3600 * 1000;
    fs.writeFileSync(cacheFile, JSON.stringify(cached));
    const staleOut = await (await fetch(`${base}/api/fleet/engine-models?engine=myapi`, { headers: H })).json();
    assert.equal(staleOut.source, 'cache');
    assert.equal(staleOut.stale, true);
    assert.equal(typeof staleOut.error, 'string');
    assert.ok(staleOut.error.length > 0 && staleOut.error.length < 64, 'fixed short reason');
    assert.ok(!JSON.stringify(staleOut).includes(KEY), 'no key in the stale path either');
    assert.ok(!staleOut.error.includes(fake.baseUrl), 'the error never names the endpoint');
    // Senza cache (engine con endpoint mai interrogato e morto): backup.
    const dead = await startFakeServer(() => { throw new Error('unreachable'); });
    await closeFakeServer(dead);
    const fresh = await bootWithCustomEngine(t, `http://127.0.0.1:1`, []);
    const backupOut = await (await fetch(`${fresh.base}/api/fleet/engine-models?engine=myapi`, { headers: fresh.H })).json();
    assert.equal(backupOut.source, 'backup');
    assert.equal(backupOut.models.length, 1, 'user/backup layers still propose');
    assert.equal(backupOut.models[0].fieldSources.contextWindow, 'user');
    assert.ok(!('inApi' in backupOut.models[0]), 'inApi stays absent when the API never answered');
    assert.ok(!JSON.stringify(backupOut).includes(KEY));
    void dir;
  } finally {
    // Il primo fake è già chiuso dentro il test; il secondo vive in `fresh`.
    await closeFakeServer(fake).catch(() => {});
  }
});

test('engine senza listing HTTP (login/native): supported=false, zero rete', async (t) => {
  const fake = await startFakeServer(() => { throw new Error('no request expected'); });
  try {
    const { base, H } = await bootWithCustomEngine(t, fake.baseUrl);
    const out = await (await fetch(`${base}/api/fleet/engine-models?engine=claude.native`, { headers: H })).json();
    assert.equal(out.supported, false);
    assert.equal(out.source, 'unsupported');
    assert.deepEqual(out.models, []);
    assert.equal(fake.requests.length, 0, 'no HTTP request at all');
  } finally { await closeFakeServer(fake); }
});

// --- Lotto 3b: proposte del catalogo interno per i campi mancanti --------------
// Provider builtin chiamato DIRETTAMENTE con fetch stubbata: la rete non esiste,
// nessun provider vero, nemmeno il catalogo pubblico (la fetch iniettata serve
// anche quello e risponde con uno snapshot non valido, quindi lo skip è netto).
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');

test('backupValues: il catalogo interno propone i campi che nessun layer ha riempito', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncembv-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const defsPath = path.join(dir, 'fleet.json');
  fs.writeFileSync(defsPath, JSON.stringify({ schemaVersion: 1, engines: [], cells: [] }), { mode: 0o600 });
  fs.chmodSync(defsPath, 0o600);
  // Engines and cells are empty: this test reads the discovery plan and never
  // touches a session. Without the explicit opt-out the fleet bootstrap guards
  // the shared server with the REAL tmux binary and leaves an empty, guarded,
  // immortal server behind (suite containment failure, reproduced 2026-10-19).
  const fleet = await createBuiltinFleet({ home: dir, fleetDefsPath: defsPath, protectSharedTmuxServer: false });
  t.after(() => fleet.close());
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    calls.push(String(url));
    // Listing Anthropic-style: id nudi, nessun descrittore.
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'qwen3.8-max' }, { id: 'unknown-model' }] }) };
  };
  const out = await fleet.discoverEngineModels('claude.alibaba-token-plan', { fetchImpl });
  assert.equal(out.supported, true);
  const byId = new Map(out.models.map((m) => [m.id, m]));
  const qwen = byId.get('qwen3.8-max');
  assert.ok(qwen, 'il modello del listing è nella proposta');
  assert.ok(!('contextWindow' in qwen), 'l\'API non ha dato il campo: resta assente');
  // La proposta del catalogo interno viaggia separata: non è un valore, è il
  // valore di backup che il dialogo mostra già pronto.
  assert.equal(qwen.backupValues.contextWindow, 983616);
  assert.equal(qwen.backupValues.maxTokens, 131072);
  assert.ok(!('backupValues' in byId.get('unknown-model')), 'ciò che il database interno non conosce non ha proposte');
  // Nessuna rete: la sola fetch è lo stub, e nessuna risposta porta la chiave.
  assert.ok(calls.length >= 1);
  assert.ok(!JSON.stringify(out).includes(KEY));
});

test('refresh della scoperta arriva fino al layer pubblico: il catalogo si riscarica davvero', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncempr-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const defsPath = path.join(dir, 'fleet.json');
  fs.writeFileSync(defsPath, JSON.stringify({ schemaVersion: 1, engines: [], cells: [] }), { mode: 0o600 });
  fs.chmodSync(defsPath, 0o600);
  // Engines and cells are empty: this test only drives model discovery. See
  // the note in the backupValues test about the shared-server opt-out.
  const fleet = await createBuiltinFleet({ home: dir, fleetDefsPath: defsPath, protectSharedTmuxServer: false });
  t.after(() => fleet.close());
  let context = 100;
  let publicCalls = 0;
  let engineCalls = 0;
  const fetchImpl = async (url) => {
    if (String(url).includes('models.dev')) {
      publicCalls += 1;
      return { ok: true, status: 200, json: async () => ({ zai: { id: 'zai', models: { 'glm-5.3': { limit: { context } } } } }) };
    }
    engineCalls += 1;
    return { ok: true, status: 200, json: async () => ({ data: [{ id: 'glm-5.3' }] }) };
  };
  const first = await fleet.discoverEngineModels('claude.zai', { fetchImpl });
  assert.equal(first.source, 'api');
  assert.equal(first.models.find((m) => m.id === 'glm-5.3').contextWindow, 100, 'il contesto arriva dal catalogo pubblico');
  context = 200;
  // refresh: must reach BOTH layers; the public catalog cannot stay on the
  // previous snapshot while the engine listing is re-read
  const forced = await fleet.discoverEngineModels('claude.zai', { fetchImpl, refresh: true });
  assert.equal(forced.source, 'api');
  assert.equal(publicCalls, 2, 'il refresh raggiunge anche il fetch del catalogo pubblico');
  assert.equal(engineCalls, 2);
  assert.equal(forced.models.find((m) => m.id === 'glm-5.3').contextWindow, 200, 'il valore nuovo del catalogo entra nella risposta');
});

test('backupValues: variante con tag dell\'engine cloud risale al nome base del catalogo interno', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncembv2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const defsPath = path.join(dir, 'fleet.json');
  fs.writeFileSync(defsPath, JSON.stringify({ schemaVersion: 1, engines: [], cells: [] }), { mode: 0o600 });
  fs.chmodSync(defsPath, 0o600);
  const fleet = await createBuiltinFleet({ home: dir, fleetDefsPath: defsPath, protectSharedTmuxServer: false });
  t.after(() => fleet.close());
  const fetchImpl = async (url, opts = {}) => {
    // /api/tags elenca la variante col tag; il catalogo cablato conosce il
    // nome base: il merge (id esatti) non li unisce, la proposta sì.
    if (String(url).includes('/api/tags')) {
      return { ok: true, status: 200, json: async () => ({ models: [{ name: 'deepseek-v4-flash:0731' }] }) };
    }
    if (String(url).includes('/api/show')) {
      return { ok: true, status: 200, json: async () => ({ model_info: {} }) };
    }
    // Catalogo pubblico: snapshot non valido -> layer saltato, zero digressioni.
    return { ok: true, status: 200, json: async () => ({ data: [] }) };
  };
  const out = await fleet.discoverEngineModels('codex-vl.ollama-cloud', { fetchImpl, ttlMs: 60000 });
  assert.equal(out.supported, true);
  const variant = out.models.find((m) => m.id === 'deepseek-v4-flash:0731');
  assert.ok(variant, 'la variante del listing è nella proposta');
  assert.ok(!('contextWindow' in variant), 'nessun layer ha riempito il campo');
  assert.equal(variant.backupValues.contextWindow, 1048576, 'la proposta risale al nome base del catalogo interno');
});
