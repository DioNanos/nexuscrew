'use strict';

// La cache su disco della scoperta modelli: cosa vuol dire `noCache`.
//
// PERCHE' QUESTI TEST. `noCache: true` deve voler dire UNA cosa sola — nessuna
// cache — e oggi ne fa tre di diverse: salta solo il ramo "valore fresco", ma
// la cache la LEGGE comunque (per ricadere sull'ultimo buono in caso di errore)
// e la SCRIVE comunque quando l'API risponde. Il caso che ha morso davvero:
// un `node --test` senza HOME isolata ha scritto la cache nella home REALE
// dell'operatore, con i modelli finti del test; in produzione un file cosi'
// avvelena la scoperta vera. Ogni test qui passa una `home` temporanea
// ESPLICITA: la home reale non si tocca mai (vedi tests/real-home-guard.cjs).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createModelDiscovery } = require('../lib/fleet/model-discovery.js');

const homeTemporanea = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nc-md-cache-'));
const cacheDi = (home, engine = 'ollama-cloud') => path.join(home, '.nexuscrew', 'model-discovery', `${engine}.json`);

const fetchOk = async () => ({ ok: true, json: async () => ({ models: [{ name: 'glm-5.2' }, { name: 'deepseek-v4-pro' }] }) });
const fetchGiu = async () => { throw new Error('api giu'); };

const scopri = (md, home, extra = {}) => md.fetchEngineModels({
  engine: 'ollama-cloud', collector: 'ollama', baseUrl: 'https://ollama.com',
  apiKey: 'test-key', home, ...extra,
});

test('noCache: true non LEGGE la cache (su errore la ricaduta e\' il backup, non l\'ultimo buono)', async (t) => {
  const home = homeTemporanea();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const md = createModelDiscovery();

  // premessa: una lettura riuscita riempie la cache
  await scopri(md, home, { fetchImpl: fetchOk });
  assert.equal(fs.existsSync(cacheDi(home)), true, 'la cache esiste dopo una lettura riuscita');
  const prima = fs.readFileSync(cacheDi(home), 'utf8');

  // il soggetto: con noCache e API giu', la cache non si legge
  const esito = await scopri(md, home, { noCache: true, fetchImpl: fetchGiu });
  assert.equal(esito.status, 'backup', `atteso backup, ottenuto ${esito.status}`);
  assert.deepEqual(esito.apiModels, [], 'nessun modello dall\'ultimo buono');
  assert.equal(fs.readFileSync(cacheDi(home), 'utf8'), prima, 'la cache non viene nemmeno riscritta');
});

test('noCache: true non SCRIVE la cache (nemmeno quando l\'API risponde)', async (t) => {
  const home = homeTemporanea();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const md = createModelDiscovery();

  const esito = await scopri(md, home, { noCache: true, fetchImpl: fetchOk });
  assert.equal(esito.status, 'api', 'la lettura e\' avvenuta');
  assert.ok(esito.apiModels.length > 0, 'e ha prodotto modelli');
  assert.equal(fs.existsSync(cacheDi(home)), false, 'ma niente e\' finito su disco');
});

test('senza noCache l\'ultimo buono resta la ricaduta (contratto del lotto 1)', async (t) => {
  const home = homeTemporanea();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const md = createModelDiscovery();

  await scopri(md, home, { fetchImpl: fetchOk });
  // `ttlMs: 0` rende stantio il valore in cache: si passa dall'API, che e' giu'.
  const esito = await scopri(md, home, { ttlMs: 0, fetchImpl: fetchGiu });
  assert.equal(esito.status, 'cache', `atteso cache, ottenuto ${esito.status}`);
  assert.equal(esito.stale, true, 'dichiarato stantio');
  assert.deepEqual(esito.apiModels.map((m) => m.id).sort(), ['deepseek-v4-pro', 'glm-5.2']);
});

test('senza cache e senza API il risultato e\' il backup vuoto (non un errore)', async (t) => {
  const home = homeTemporanea();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const md = createModelDiscovery();

  const esito = await scopri(md, home, { fetchImpl: fetchGiu });
  assert.equal(esito.status, 'backup');
  assert.deepEqual(esito.apiModels, []);
});
