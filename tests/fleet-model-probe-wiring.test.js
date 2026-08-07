'use strict';
// tests/fleet-model-probe-wiring.test.js — l'innesto della prova nel fleet.
//
// La prova vive nel builtin e non nelle route per una ragione precisa: la
// credenziale si risolve dove gia' si risolve per l'avvio di una cella, quindi
// non attraversa il router e non puo' finire in una risposta per distrazione.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');
const { OUTCOMES } = require('../lib/fleet/model-probe.js');

const PROFILO = 'claude.alibaba-token-plan';

// Il fleet builtin diventa `available` solo con un mondo completo: home con i
// permessi giusti, un comando eseguibile e un fleet.json valido. Un mondo
// povero produce un provider VUOTO — che nel primo giro mi ha fatto leggere
// «capabilities: []» come se la mia modifica non fosse stata applicata.
function mondo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-model-wiring-'));
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

test('la prova e\' dichiarata fra le capacita\' del provider', async (t) => {
  const fleet = await fleetDi(mondo(t));
  assert.ok(fleet.capabilities().includes('model-test'));
  assert.equal(typeof fleet.testModel, 'function');
});

test('l\'esito riporta COSA e\' stato provato, non solo com\'e\' andata', async (t) => {
  // Un esito senza il suo soggetto e' inservibile in una schermata con piu'
  // modelli: non si saprebbe a quale riga appartiene.
  const fleet = await fleetDi(mondo(t));
  const out = await fleet.testModel(PROFILO, 'qwen3.8-max', {
    fetchImpl: async () => ({ status: 200, json: async () => ({ data: [{ id: 'qwen3.8-max' }] }) }),
  });
  assert.equal(out.engine, PROFILO);
  assert.equal(out.model, 'qwen3.8-max');
  assert.ok(OUTCOMES.includes(out.outcome));
});

test('un profilo sconosciuto e\' 404, non un esito inventato', async (t) => {
  const fleet = await fleetDi(mondo(t));
  await assert.rejects(() => fleet.testModel('non.esiste', 'qwen'), (e) => e.status === 404);
});

test('un id malformato si rifiuta prima di chiamare chiunque', async (t) => {
  const fleet = await fleetDi(mondo(t));
  for (const cattivo of ['', '   ', 'x'.repeat(129)]) {
    await assert.rejects(() => fleet.testModel(PROFILO, cattivo), (e) => e.status === 400);
  }
});

test('senza credenziale configurata: `auth`, e nessuna chiamata parte', async (t) => {
  // Il mondo di prova non ha chiavi. Dirlo subito evita una richiesta che
  // sarebbe rifiutata comunque, e distingue «manca la chiave» da «il modello
  // non esiste» — che e' tutto il punto di questa prova.
  const fleet = await fleetDi(mondo(t));
  let chiamato = false;
  const out = await fleet.testModel(PROFILO, 'qwen3.8-max', {
    fetchImpl: async () => { chiamato = true; return { status: 200, json: async () => ({}) }; },
  });
  assert.equal(out.outcome, 'auth');
  assert.equal(chiamato, false);
});
