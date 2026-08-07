'use strict';
// tests/fleet-models-backup.test.js — «persistenti ed esportabili assieme agli
// engine» era il requisito, e il round-trip lo mancava.
//
// Prima: il backup portava solo celle ed engine. Un giro completo
// esporta → ripristina PERDEVA i modelli dichiarati, e l'engine che li usava
// veniva rifiutato al ripristino — fail-closed corretto, ma con i dati persi e
// nessuna spiegazione. Il requisito era soddisfatto solo dal file grezzo.
//
// Rilievo dell'audit indipendente (Q2): la stessa firma del difetto di
// `draftFrom`, a un confine diverso.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');

const PROFILO = 'claude.alibaba-token-plan';
const ID = 'modello-che-deve-sopravvivere';

function mondo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-models-backup-'));
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

const engineChe = (model) => ({
  id: 'importato', label: 'Importato',
  managed: { client: 'claude', provider: 'alibaba-token-plan', model, permissionPolicy: 'unsafe' },
});

test('il ripristino scrive i modelli PRIMA degli engine che li usano', async (t) => {
  // E' l'ordine che conta: senza, l'engine viene rifiutato perche' la
  // dichiarazione non c'e' ancora, e il ripristino fallisce su un backup sano.
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await fleet.restoreEngines([engineChe(ID)], { models: [{ id: ID, engine: PROFILO }] });
  const vista = await fleet.definitions();
  assert.ok(vista.models.some((m) => m.id === ID), 'il modello deve essere stato dichiarato');
  assert.ok(vista.engines.some((e) => e.id === 'importato'), 'e l\'engine deve esistere');
});

test('senza i modelli, lo stesso backup viene rifiutato', async (t) => {
  // Prova al contrario: e' cio' che accadeva prima, ed e' il motivo per cui i
  // modelli devono viaggiare col backup.
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await assert.rejects(() => fleet.restoreEngines([engineChe(ID)]),
    'un engine che usa un modello non dichiarato non deve passare');
});

test('un modello gia\' presente non viene duplicato dal ripristino', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await fleet.defineModel({ id: ID, engine: PROFILO, contextWindow: 262144 });
  await fleet.restoreEngines([engineChe(ID)], { models: [{ id: ID, engine: PROFILO }] });
  const vista = await fleet.definitions();
  assert.equal(vista.models.filter((m) => m.id === ID && m.engine === PROFILO).length, 1);
  // E la dichiarazione esistente non viene sovrascritta: i suoi dati restano.
  assert.equal(vista.models.find((m) => m.id === ID).contextWindow, 262144);
});

test('un modello malformato nel backup si rifiuta prima di scrivere', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  for (const cattivo of [[{ id: ID }], [{ engine: PROFILO }], [{ id: '', engine: PROFILO }], ['stringa']]) {
    await assert.rejects(() => fleet.restoreEngines([engineChe(ID)], { models: cattivo }));
  }
  const vista = await fleet.definitions();
  assert.ok(!vista.models, 'niente deve essere stato scritto');
});

test('un backup senza modelli continua a funzionare come prima', async (t) => {
  // Chi non usa modelli dichiarati non deve accorgersi di nulla.
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await fleet.restoreEngines([{
    id: 'semplice', label: 'Semplice', rc: true,
    command: path.join(w.home, 'bin', 'finto-client'), args: [], envKeys: [],
    promptMode: 'flag', promptFlag: '--sp',
  }]);
  assert.ok((await fleet.definitions()).engines.some((e) => e.id === 'semplice'));
});
