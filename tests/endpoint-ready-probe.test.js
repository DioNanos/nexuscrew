'use strict';
// Sonda di prontezza sugli endpoint dichiarati a mano + prova modello sui custom.
//
// Un engine con `baseUrl` dichiarato a mano veniva dichiarato `ready` appena il
// binario esisteva e la credenziale era a posto: nessuno interrogava mai
// l'indirizzo, e un router spento lo si scopriva facendo partire la cella.
// Qui si verifica il contrario: che l'indirizzo venga interrogato, che l'esito
// sia nella cache per il TTL dichiarato, e che l'attesa non superi il budget.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  createEndpointProbe, modelsProbeUrl, endpointHost,
  ENDPOINT_PROBE_TIMEOUT_MS, ENDPOINT_PROBE_TTL_MS,
} = require('../lib/fleet/endpoint-probe.js');
const { describeManaged, normalizeManagedSpec } = require('../lib/fleet/managed.js');
const {
  probeCustomEndpoint, chatCompletionsUrl, findInCatalog,
} = require('../lib/fleet/model-probe.js');

// Una risposta finta con la stessa forma di quella vera: `status` numerico e
// `json()` che risolve il payload. Il resto del mondo fetch non viene toccato.
function reply(status, payload) {
  return { status, json: async () => payload };
}

// Un home finto con il binario del client al posto giusto: senza, `configured`
// e' falso per una ragione che non c'entra con la sonda, e il test non
// proverebbe nulla.
function fakeHome(client) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncd6home-'));
  const p = path.join(home, '.local', 'bin', client);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(p, 0o755);
  return home;
}

function customSpec(baseUrl) {
  return {
    client: 'codex', provider: 'custom', displayName: 'Router locale',
    protocol: 'openai_responses', baseUrl, envKey: 'LOCAL_ROUTER_KEY',
    providerId: 'local', model: 'bonsai-2-27b',
  };
}

// --- Punto 1: la sonda di prontezza -----------------------------------------

test('prontezza: 2xx -> ready, e il verdetto dice che l\'endpoint ha risposto', async () => {
  const seen = [];
  const probe = createEndpointProbe({
    fetchImpl: async (url) => { seen.push(url); return reply(200, { data: [] }); },
  });
  const v = await probe.refresh('http://127.0.0.1:8888');
  assert.equal(v.state, 'ready');
  assert.equal(v.reason, 'ready');
  assert.deepStrictEqual(seen, ['http://127.0.0.1:8888/v1/models']);
});

test('prontezza: il baseUrl che dichiara /v1 non lo ripete', () => {
  assert.equal(modelsProbeUrl('http://127.0.0.1:18080/v1'), 'http://127.0.0.1:18080/v1/models');
  assert.equal(modelsProbeUrl('http://127.0.0.1:18080/v1/'), 'http://127.0.0.1:18080/v1/models');
  assert.equal(modelsProbeUrl('http://192.168.0.151:8888'), 'http://192.168.0.151:8888/v1/models');
  // Non-HTTP: non si inventa una sonda.
  assert.equal(modelsProbeUrl('file:///tmp/x'), null);
  assert.equal(modelsProbeUrl(''), null);
});

test('prontezza: 401 e 403 dicono ready — l\'endpoint e\' vivo, l\'auth e\' del client', async () => {
  for (const status of [401, 403]) {
    const probe = createEndpointProbe({ fetchImpl: async () => reply(status, {}) });
    const v = await probe.refresh('http://127.0.0.1:9999');
    assert.equal(v.state, 'ready', `http ${status}`);
  }
});

test('prontezza: timeout -> non configurato, col motivo e con host:porta', async () => {
  const probe = createEndpointProbe({
    timeoutMs: 20,
    fetchImpl: async (url, opts) => {
      // Simula un endpoint che non risponde: si sblocca solo all'abort.
      await new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => {
          const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
        });
      });
      return reply(200, {});
    },
  });
  const v = await probe.refresh('http://192.168.0.151:8888');
  assert.equal(v.state, 'unreachable');
  assert.match(v.reason, /^endpoint unreachable: 192\.168\.0\.151:8888 \(timeout \(20ms\)\)$/);
});

test('prontezza: errore di rete e 5xx -> non configurato, con la causa', async () => {
  const net = createEndpointProbe({ fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  const nv = await net.refresh('http://127.0.0.1:18080');
  assert.equal(nv.state, 'unreachable');
  assert.match(nv.reason, /^endpoint unreachable: 127\.0\.0\.1:18080 \(connessione rifiutata\)$/);

  const five = createEndpointProbe({ fetchImpl: async () => reply(503, {}) });
  const fv = await five.refresh('http://127.0.0.1:18081');
  assert.equal(fv.state, 'unreachable');
  assert.match(fv.reason, /\(http 503\)$/);
});

test('prontezza: entro il TTL non si ri-sonda (niente tempesta di probe)', async () => {
  let calls = 0;
  let clock = 1000;
  const probe = createEndpointProbe({
    now: () => clock,
    fetchImpl: async () => { calls += 1; return reply(200, {}); },
  });
  await probe.status('http://127.0.0.1:8888');
  await probe.status('http://127.0.0.1:8888');
  await probe.status('http://127.0.0.1:8888');
  assert.equal(calls, 1, 'tre letture dentro il TTL = una sola sonda');
  clock += ENDPOINT_PROBE_TTL_MS + 1;
  await probe.status('http://127.0.0.1:8888');
  assert.equal(calls, 2, 'scaduto il TTL si ri-sonda, una volta');
  assert.equal(ENDPOINT_PROBE_TIMEOUT_MS, 1500);
  assert.equal(ENDPOINT_PROBE_TTL_MS, 30000);
});

test('prontezza: il percorso sincrono non attende e non mente', async () => {
  const probe = createEndpointProbe({ fetchImpl: async () => { throw new Error('ENOTFOUND'); } });
  // Mai sondato: non si sa, e non si dichiara ne' su ne' giu'.
  assert.equal(probe.read('http://127.0.0.1:8888'), null);
  assert.equal(probe.ensure('http://127.0.0.1:8888'), null);
  // Il rifornimento e' partito in sottofondo: un giro di microtask e c'e'.
  await new Promise((r) => setImmediate(r));
  assert.equal(probe.read('http://127.0.0.1:8888').state, 'unreachable');
});

test('prontezza: describeManaged mette il verdetto NEL CAMPO reason, senza toccare altro', async (t) => {
  const home = fakeHome('codex');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const spec = normalizeManagedSpec(customSpec('http://192.168.0.151:8888'));
  assert.ok(spec, 'spec custom valida');
  const cfgBase = { home, env: { LOCAL_ROUTER_KEY: 'k' } };

  // Senza verdetto l'engine e' pronto come prima: la sonda non lo peggiora.
  const before = describeManaged(spec, cfgBase);
  assert.equal(before.configured, true, `atteso pronto: ${before.reason}`);
  assert.equal(before.reason, 'ready');
  assert.equal(before.endpoint, 'http://192.168.0.151:8888');

  const reachable = describeManaged(spec, { ...cfgBase, endpointVerdict: { state: 'ready', reason: 'ready' } });
  assert.equal(reachable.configured, true);

  const down = describeManaged(spec, {
    ...cfgBase,
    endpointVerdict: { state: 'unreachable', reason: 'endpoint unreachable: 192.168.0.151:8888 (timeout (1500ms))' },
  });
  assert.equal(down.configured, false, 'un endpoint spento non e\' pronto');
  assert.equal(down.reason, 'endpoint unreachable: 192.168.0.151:8888 (timeout (1500ms))');
});

test('prontezza: senza verdetto il comportamento resta quello di prima', (t) => {
  const home = fakeHome('codex');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const spec = normalizeManagedSpec(customSpec('http://192.168.0.151:8888'));
  const info = describeManaged(spec, { home, env: { LOCAL_ROUTER_KEY: 'k' } });
  // La sonda non trasforma un engine sano in un engine rotto solo perche' non
  // e' ancora stata fatta: senza verdetto il motivo resta quello di sempre.
  assert.ok(!String(info.reason).includes('endpoint unreachable'),
    `senza verdetto non si dichiara irraggiungibile: ${info.reason}`);
});

test('prontezza: gli engine di CATALOGO non si sondano', () => {
  // Nessun `baseUrl` dichiarato: la sonda non deve nemmeno essere consultata.
  const probe = { ensure: () => { throw new Error('la sonda non va toccata per un engine di catalogo'); } };
  const spec = normalizeManagedSpec({
    client: 'claude', provider: 'zai', displayName: 'Z.AI', protocol: 'anthropic_messages', model: 'glm-4.6',
  });
  assert.ok(spec);
  const info = describeManaged(spec, { endpointProbe: probe });
  assert.ok(info, 'describeManaged non ha toccato la sonda');
  assert.ok(info.reason, 'un motivo c\'e\' sempre');
  assert.notEqual(info.endpoint, '');
});

// --- Punto 2: la prova modello sui custom -----------------------------------

const MODELS_OK = { data: [{ id: 'bonsai-2-27b' }, { id: 'spark-x2.5-4b' }] };

test('model-test custom: modello nella lista -> ok, e si ferma li\'', async () => {
  const calls = [];
  const out = await probeCustomEndpoint({
    endpoint: 'http://127.0.0.1:18080/v1', model: 'bonsai-2-27b',
    fetchImpl: async (url, opts) => { calls.push({ url, method: opts.method }); return reply(200, MODELS_OK); },
  });
  assert.equal(out.outcome, 'ok');
  assert.deepStrictEqual(calls.map((c) => c.method), ['GET'], 'nessun completamento quando la lista basta');
  assert.equal(calls[0].url, 'http://127.0.0.1:18080/v1/models');
});

test('model-test custom: modello ASSENTE dalla lista -> unknown-model', async () => {
  const out = await probeCustomEndpoint({
    endpoint: 'http://127.0.0.1:18080/v1', model: 'modello-inventato',
    fetchImpl: async () => reply(200, MODELS_OK),
  });
  assert.equal(out.outcome, 'unknown-model');
  assert.ok(!('detail' in out) || typeof out.detail === 'string');
});

test('model-test custom: lista non supportata -> si prova il completamento minimo', async () => {
  const calls = [];
  const out = await probeCustomEndpoint({
    endpoint: 'http://127.0.0.1:18080', model: 'bonsai-2-27b',
    fetchImpl: async (url, opts) => {
      calls.push({ url, method: opts.method, body: opts.body });
      if (opts.method === 'GET') return reply(404, {});
      return reply(200, { choices: [] });
    },
  });
  assert.equal(out.outcome, 'ok');
  assert.deepStrictEqual(calls.map((c) => c.method), ['GET', 'POST']);
  assert.equal(calls[1].url, 'http://127.0.0.1:18080/v1/chat/completions');
  const sent = JSON.parse(calls[1].body);
  assert.equal(sent.max_tokens, 1, 'completamento MINIMO');
  assert.equal(sent.model, 'bonsai-2-27b');
});

test('model-test custom: elenco VUOTO -> si prova comunque la via minima', async () => {
  const out = await probeCustomEndpoint({
    endpoint: 'http://127.0.0.1:18080', model: 'bonsai-2-27b',
    fetchImpl: async (url, opts) => (opts.method === 'GET' ? reply(200, { data: [] }) : reply(200, {})),
  });
  assert.equal(out.outcome, 'ok', 'una lista vuota non e\' un modello assente');
});

test('model-test custom: endpoint irraggiungibile e 401 hanno esiti distinti', async () => {
  const down = await probeCustomEndpoint({
    endpoint: 'http://127.0.0.1:18080', model: 'm',
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(down.outcome, 'unreachable');

  const denied = await probeCustomEndpoint({
    endpoint: 'http://127.0.0.1:18080', model: 'm',
    fetchImpl: async () => reply(401, {}),
  });
  assert.equal(denied.outcome, 'auth');

  const t = await probeCustomEndpoint({
    endpoint: 'http://127.0.0.1:18080', model: 'm', timeoutMs: 20,
    fetchImpl: async (url, opts) => {
      await new Promise((resolve, reject) => {
        opts.signal.addEventListener('abort', () => { const e = new Error('a'); e.name = 'AbortError'; reject(e); });
      });
      return reply(200, {});
    },
  });
  assert.equal(t.outcome, 'unreachable');
  assert.match(t.detail, /timeout \(20ms\)/);
});

test('model-test custom: la credenziale viaggia nell\'header e NON entra nell\'esito', async () => {
  let sentHeaders = null;
  const out = await probeCustomEndpoint({
    endpoint: 'http://127.0.0.1:18080', model: 'bonsai-2-27b', credential: 'sk-segreta',
    fetchImpl: async (url, opts) => { sentHeaders = opts.headers; return reply(200, MODELS_OK); },
  });
  assert.equal(sentHeaders.authorization, 'Bearer sk-segreta');
  assert.ok(!JSON.stringify(out).includes('sk-segreta'), 'la chiave non compare in nessun esito');
});

test('model-test custom: senza credenziale non si inventa un header', async () => {
  let sentHeaders = null;
  await probeCustomEndpoint({
    endpoint: 'http://127.0.0.1:18080', model: 'm',
    fetchImpl: async (url, opts) => { sentHeaders = opts.headers; return reply(200, MODELS_OK); },
  });
  assert.equal(sentHeaders.authorization, undefined);
});

test('model-test custom: la forma dell\'esito e\' quella della prova di catalogo', async () => {
  const out = await probeCustomEndpoint({
    endpoint: 'http://127.0.0.1:18080', model: 'bonsai-2-27b',
    fetchImpl: async () => reply(200, MODELS_OK),
  });
  // Gli stessi campi che la route /model-test gia' restituisce per il catalogo.
  assert.deepStrictEqual(Object.keys(out).sort(), ['latencyMs', 'outcome']);
  assert.ok(Number.isInteger(out.latencyMs));
  assert.equal(chatCompletionsUrl('http://127.0.0.1:18080/v1'), 'http://127.0.0.1:18080/v1/chat/completions');
  assert.equal(chatCompletionsUrl('http://127.0.0.1:18080'), 'http://127.0.0.1:18080/v1/chat/completions');
});

test('model-test custom: findInCatalog accetta le due forme note, e non indovina', () => {
  assert.equal(findInCatalog({ data: [{ id: 'x' }] }, 'x'), true);
  assert.equal(findInCatalog({ models: [{ name: 'y' }] }, 'y'), true);
  assert.equal(findInCatalog({ data: [{ id: 'x:0731' }] }, 'x'), true);
  assert.equal(findInCatalog({ data: [{ id: 'x' }] }, 'z'), false);
  assert.equal(findInCatalog({ qualcosa: 1 }, 'x'), null, 'forma ignota: unverified, non un falso negativo');
});

test('prontezza: host:porta nel messaggio, con la porta di default se assente', () => {
  assert.equal(endpointHost('http://192.168.0.151:8888/v1'), '192.168.0.151:8888');
  assert.equal(endpointHost('https://example.com/v1'), 'example.com:443');
  assert.equal(endpointHost('http://example.com'), 'example.com:80');
  assert.equal(endpointHost('non-un-url'), 'non-un-url');
});

// --- Integrazione: la route serve davvero un engine dichiarato --------------

test('integrazione: il fleet risponde alla prova su un engine dichiarato, non 404', async (t) => {
  const { createBuiltinFleet } = require('../lib/fleet/builtin.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncd6-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 }); fs.chmodSync(home, 0o700);
  fs.mkdirSync(path.join(home, 'Dev'));
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const bin = path.join(home, '.local', 'bin', 'codex');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n'); fs.chmodSync(bin, 0o755);
  const defsPath = path.join(root, 'fleet.json');
  fs.writeFileSync(defsPath, JSON.stringify({ schemaVersion: 1, engines: [], cells: [] }));
  const tmuxBin = path.join(root, 'tmux-fake');
  fs.writeFileSync(tmuxBin, '#!/bin/sh\nexit 0\n'); fs.chmodSync(tmuxBin, 0o755);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const fleet = await createBuiltinFleet({ home, fleetDefsPath: defsPath, tmuxBin });
  await fleet.defineEngine({
    id: 'router.locale', label: 'Router locale',
    managed: {
      client: 'codex', provider: 'custom', model: 'bonsai-2-27b', permissionPolicy: 'standard',
      displayName: 'Router locale', baseUrl: 'http://127.0.0.1:18888/v1',
      protocol: 'openai_responses', providerId: 'router-locale', envKey: 'LOCAL_API_KEY',
    },
  });

  const ok = await fleet.testModel('router.locale', 'bonsai-2-27b', {
    fetchImpl: async () => reply(200, { data: [{ id: 'bonsai-2-27b' }] }),
  });
  assert.equal(ok.engine, 'router.locale');
  assert.equal(ok.model, 'bonsai-2-27b');
  assert.equal(ok.outcome, 'ok', `esito: ${JSON.stringify(ok)}`);

  const missing = await fleet.testModel('router.locale', 'non-esiste', {
    fetchImpl: async () => reply(200, { data: [{ id: 'bonsai-2-27b' }] }),
  });
  assert.equal(missing.outcome, 'unknown-model');

  // Un engine che non esiste resta un 404: la prova non si inventa un soggetto.
  await assert.rejects(() => fleet.testModel('non-esiste', 'm'), (e) => e.status === 404);
  await fleet.close();
});
