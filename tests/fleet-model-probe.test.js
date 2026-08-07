'use strict';
// tests/fleet-model-probe.test.js — la prova sull'API.
//
// Oggi un id sbagliato si scopre quando la cella non parte, e il messaggio non
// distingue il nome del modello dalla chiave dalla rete. Questi test fissano le
// tre cose che rendono la prova utile invece che rassicurante:
//   1. `unverified` non e' `ok` — una prova non ottenuta non autorizza a dire
//      che funziona;
//   2. la credenziale non compare mai in cio' che esce;
//   3. il testo remoto non entra nell'esito: esce un enum e una latenza.
const { test } = require('node:test');
const assert = require('node:assert');
const { probeModel, OUTCOMES } = require('../lib/fleet/model-probe.js');

const profilo = (extra = {}) => ({
  id: 'claude.x', protocol: 'anthropic_messages', endpoint: 'https://api.esempio.test', ...extra,
});
const rispostaCon = (status, body) => async () => ({
  status, json: async () => body,
});

test('il modello c\'e\' nel catalogo: ok, con la latenza', async () => {
  const out = await probeModel({
    profile: profilo(), credential: 'K', model: 'qwen9',
    fetchImpl: rispostaCon(200, { data: [{ id: 'qwen9' }, { id: 'altro' }] }),
  });
  assert.equal(out.outcome, 'ok');
  assert.ok(Number.isInteger(out.latencyMs));
});

test('il modello NON c\'e\': unknown-model, che e\' la risposta utile', async () => {
  const out = await probeModel({
    profile: profilo(), credential: 'K', model: 'qwen-inventato',
    fetchImpl: rispostaCon(200, { data: [{ id: 'qwen9' }] }),
  });
  assert.equal(out.outcome, 'unknown-model');
});

test('401 e 403 sono un problema di credenziale, non di modello', async () => {
  for (const status of [401, 403]) {
    const out = await probeModel({
      profile: profilo(), credential: 'K', model: 'qwen9', fetchImpl: rispostaCon(status, {}),
    });
    assert.equal(out.outcome, 'auth', `http ${status}`);
  }
});

test('senza credenziale non si chiama nemmeno: e\' gia\' un esito', async () => {
  let chiamato = false;
  const out = await probeModel({
    profile: profilo(), credential: '', model: 'qwen9',
    fetchImpl: async () => { chiamato = true; return { status: 200, json: async () => ({}) }; },
  });
  assert.equal(out.outcome, 'auth');
  assert.equal(chiamato, false, 'una chiamata che sarebbe rifiutata comunque non si fa');
});

test('un fornitore che non espone il catalogo da\' unverified, NON unknown-model', async () => {
  // La differenza che conta: «non lo so» non deve leggersi come «non esiste»,
  // altrimenti il modello giusto verrebbe dichiarato inesistente.
  for (const status of [404, 405, 501]) {
    const out = await probeModel({
      profile: profilo(), credential: 'K', model: 'qwen9', fetchImpl: rispostaCon(status, {}),
    });
    assert.equal(out.outcome, 'unverified', `http ${status}`);
  }
});

test('un catalogo in una forma che non si sa leggere e\' unverified', async () => {
  // Non si indovina: un elenco illeggibile produrrebbe un falso negativo, cioe'
  // il peggior esito possibile per chi sta verificando un id.
  const out = await probeModel({
    profile: profilo(), credential: 'K', model: 'qwen9',
    fetchImpl: rispostaCon(200, { qualcosa: 'di inatteso' }),
  });
  assert.equal(out.outcome, 'unverified');
});

test('rete giu\' o timeout: unreachable, distinti nel dettaglio', async () => {
  const giu = await probeModel({
    profile: profilo(), credential: 'K', model: 'qwen9',
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.equal(giu.outcome, 'unreachable');

  const scaduto = await probeModel({
    profile: profilo(), credential: 'K', model: 'qwen9', timeoutMs: 500,
    fetchImpl: async (_u, init) => new Promise((_r, reject) => {
      init.signal.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
      });
    }),
  });
  assert.equal(scaduto.outcome, 'unreachable');
  assert.match(scaduto.detail, /timeout/);
});

test('la credenziale non esce MAI nell\'esito', async () => {
  const segreto = 'sk-questa-non-deve-uscire';
  const esiti = [];
  for (const impl of [
    rispostaCon(200, { data: [{ id: 'qwen9' }] }),
    rispostaCon(401, { error: `bad key ${segreto}` }),
    async () => { throw new Error(`connessione fallita con ${segreto}`); },
  ]) {
    esiti.push(await probeModel({ profile: profilo(), credential: segreto, model: 'qwen9', fetchImpl: impl }));
  }
  assert.ok(!JSON.stringify(esiti).includes(segreto), 'credenziale trapelata');
});

test('il testo remoto non entra nell\'esito', async () => {
  // Un fornitore puo' rispondere qualunque cosa: nell'esito esce un enum, una
  // latenza e al massimo un dettaglio nostro.
  const out = await probeModel({
    profile: profilo(), credential: 'K', model: 'qwen9',
    fetchImpl: rispostaCon(200, { data: [{ id: 'qwen9', descrizione: 'TESTO-REMOTO-DA-NON-PROPAGARE' }] }),
  });
  assert.ok(!JSON.stringify(out).includes('TESTO-REMOTO'));
  assert.deepEqual(Object.keys(out).sort(), ['latencyMs', 'outcome']);
});

test('ogni esito appartiene all\'enum dichiarato', async () => {
  const casi = [
    rispostaCon(200, { data: [{ id: 'qwen9' }] }),
    rispostaCon(200, { data: [] }),
    rispostaCon(401, {}),
    rispostaCon(404, {}),
    rispostaCon(500, {}),
    async () => { throw new Error('giu'); },
  ];
  for (const impl of casi) {
    const out = await probeModel({ profile: profilo(), credential: 'K', model: 'qwen9', fetchImpl: impl });
    assert.ok(OUTCOMES.includes(out.outcome), `esito fuori enum: ${out.outcome}`);
  }
});

test('un endpoint non interrogabile non produce una prova inventata', async () => {
  // Account gestiti ("Anthropic account", "AWS Bedrock"): non c'e' un URL da
  // chiamare, e dichiarare `ok` sarebbe una bugia comoda.
  const out = await probeModel({
    profile: profilo({ endpoint: 'Anthropic account' }), credential: 'K', model: 'qwen9',
    fetchImpl: async () => { throw new Error('non deve essere chiamato'); },
  });
  assert.equal(out.outcome, 'unverified');
});

test('il tag del modello: corrispondenza esatta o sul nome base', async () => {
  // `deepseek-v4-flash` e `deepseek-v4-flash:0731` sono lo stesso modello per
  // alcuni fornitori e non per altri: si accettano entrambe le direzioni.
  const conTag = await probeModel({
    profile: profilo(), credential: 'K', model: 'deepseek-v4-flash:0731',
    fetchImpl: rispostaCon(200, { models: [{ name: 'deepseek-v4-flash' }] }),
  });
  assert.equal(conTag.outcome, 'ok');
  const senzaTag = await probeModel({
    profile: profilo(), credential: 'K', model: 'deepseek-v4-flash',
    fetchImpl: rispostaCon(200, { models: [{ name: 'deepseek-v4-flash:0731' }] }),
  });
  assert.equal(senzaTag.outcome, 'ok');
});
