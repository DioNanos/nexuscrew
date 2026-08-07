'use strict';
// tests/fleet-declared-models-e2e.test.js — il giro completo della funzione.
//
// PERCHE' ESISTE: i test per fetta erano tutti verdi con la funzione ROTTA.
// `parseDefinitions` accettava il modello dichiarato, il CRUD lo scriveva e lo
// rileggeva — ma il boot lo rifiutava (il gate non riceveva le dichiarazioni)
// e la vista `definitions()` non lo esponeva (quindi la finestra era cieca).
// Ogni pezzo funzionava, la funzione no.
//
// L'ha trovato l'audit indipendente provando il percorso intero. Questo test
// e' quel percorso: DICHIARO → lo VEDO nella vista → la cella PARTE.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');

const PROFILO = 'claude.alibaba-token-plan';
const ID_NUOVO = 'qwen-uscito-stamattina';

function mondo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-models-e2e-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const cwd = path.join(home, 'Dev');
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, 'bin'));
  const command = path.join(home, 'bin', 'finto-client');
  fs.writeFileSync(command, '#!/bin/sh\necho ok\n');
  fs.chmodSync(command, 0o755);
  const defsPath = path.join(root, 'fleet.json');
  fs.writeFileSync(defsPath, JSON.stringify({
    schemaVersion: 1,
    engines: [{ id: 'e1', label: 'E1', rc: true, command, args: [], env: {}, promptMode: 'flag', promptFlag: '--sp' }],
    cells: [{ id: 'Dev', tmuxSession: 'work-x', cwd, engine: 'e1', boot: true }],
  }));
  const tmuxBin = path.join(home, 'bin', 'tmux-finto');
  fs.writeFileSync(tmuxBin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(tmuxBin, 0o755);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { home, defsPath, tmuxBin };
}

const fleetDi = (w) => createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });

test('dichiaro → lo VEDO nella vista → l\'engine si CONFIGURA', async (t) => {
  const fleet = await fleetDi(mondo(t));

  // 1. dichiaro
  await fleet.defineModel({ id: ID_NUOVO, engine: PROFILO, contextWindow: 500000 });

  // 2. la vista lo espone — e' da qui che legge la finestra, non dal file
  const vista = await fleet.definitions();
  assert.ok(Array.isArray(vista.models), 'definitions() deve esporre `models`');
  assert.equal(vista.models[0].id, ID_NUOVO);

  // 3. l'engine che lo usa si salva E risulta configurato: e' il passo che
  //    prima falliva, perche' il gate del BOOT non vedeva le dichiarazioni.
  await fleet.defineEngine({
    id: 'nuovo', label: 'Nuovo',
    managed: { client: 'claude', provider: 'alibaba-token-plan', model: ID_NUOVO, permissionPolicy: 'unsafe' },
  });
  const dopo = await fleet.definitions();
  const engine = dopo.engines.find((e) => e.id === 'nuovo');
  assert.ok(engine, 'l\'engine deve essere stato salvato');
  assert.ok(engine.managedInfo, 'la vista deve descrivere l\'engine gestito');
  assert.notEqual(engine.managedInfo.reason, 'invalid managed profile',
    'il modello dichiarato deve superare il gate anche qui: era il difetto D1');
});

test('un modello NON dichiarato resta rifiutato in ogni punto del giro', async (t) => {
  const fleet = await fleetDi(mondo(t));
  await assert.rejects(() => fleet.defineEngine({
    id: 'nuovo', label: 'Nuovo',
    managed: { client: 'claude', provider: 'alibaba-token-plan', model: 'mai-dichiarato', permissionPolicy: 'unsafe' },
  }), 'la protezione non deve essere stata svuotata');
});

test('ritirato il modello, la vista torna a non esporlo', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await fleet.defineModel({ id: ID_NUOVO, engine: PROFILO });
  assert.ok((await fleet.definitions()).models);
  await fleet.removeModel(ID_NUOVO, PROFILO);
  assert.ok(!(await fleet.definitions()).models, 'senza modelli la chiave non compare');
});

test('il modello per-cella non e\' una scorciatoia al catalogo', async (t) => {
  // La via che l'audit ha trovato aperta: `/fleet/engine` e' federata, quindi
  // un peer poteva mettere un id arbitrario in una cella di questa
  // installazione e il boot lo usava senza ricontrollarlo.
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await fleet.defineEngine({
    id: 'gest', label: 'Gest',
    managed: { client: 'claude', provider: 'alibaba-token-plan', model: 'qwen3.7-max', permissionPolicy: 'unsafe' },
  });
  await assert.rejects(() => fleet.editCell('Dev', { engine: 'gest', model: 'inventato-dal-peer' }),
    'un modello arbitrario per-cella deve essere rifiutato');
  // Ma un modello dichiarato per quel profilo passa anche per-cella.
  await fleet.defineModel({ id: ID_NUOVO, engine: PROFILO });
  await fleet.editCell('Dev', { engine: 'gest', model: ID_NUOVO });
  const cella = (await fleet.definitions()).cells.find((c) => c.id === 'Dev');
  assert.equal(cella.model, ID_NUOVO);
});

test('lo schema DESCRIVE il modello, e la descrizione e\' quella vera', async (t) => {
  // `define-model` e' federato: un client che amministra un nodo remoto ricava
  // da `schema()` la forma da compilare. Uno schema che tace, o che dichiara un
  // vincolo diverso da quello applicato, manda quel client a sbattere contro un
  // rifiuto che non sapeva prevedere.
  //
  // Per questo il test non si limita a leggere lo schema: prova il parser AI
  // CONFINI che lo schema dichiara. E' l'unico modo perche' i due non divergano
  // in silenzio.
  const w = mondo(t);
  const fleet = await fleetDi(w);
  const forma = fleet.schema().model;
  assert.ok(forma, 'lo schema deve descrivere il modello dichiarato');
  assert.deepEqual(Object.keys(forma).sort(),
    ['contextWindow', 'engine', 'id', 'label', 'maxTokens', 'reasoning'],
    'i campi descritti sono esattamente quelli che il parser accetta');
  assert.equal(forma.id.required, true);
  assert.equal(forma.engine.required, true);

  // I confini dichiarati sono quelli applicati, provati da entrambi i lati.
  const con = (patch) => fleet.defineModel({ id: `m-${Object.values(patch)[0]}`, engine: PROFILO, ...patch });
  await assert.rejects(() => con({ contextWindow: forma.contextWindow.min - 1 }));
  await con({ contextWindow: forma.contextWindow.min });
  await assert.rejects(() => con({ maxTokens: forma.maxTokens.max + 1 }));
  await con({ maxTokens: forma.maxTokens.max });
  // Un campo NON descritto non entra: lo schema e' chiuso da entrambe le parti.
  await assert.rejects(() => fleet.defineModel({ id: 'm-extra', engine: PROFILO, prezzo: 3 }));
});
