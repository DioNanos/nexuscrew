'use strict';
// tests/fleet-model-crud.test.js — dichiarare e ritirare un modello.
//
// I modelli vivono in fleet.json accanto agli engine: stesso file, stesso
// backup, stessa esportazione. Qui si prova il giro completo — dichiaro, uso,
// ritiro — e le due cose che rendono la funzione sicura invece che comoda:
// la scrittura rivalida l'intero file, e un modello IN USO non si toglie in
// silenzio.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');

const PROFILO = 'claude.alibaba-token-plan';

function mondo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-model-crud-'));
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
const letto = (w) => JSON.parse(fs.readFileSync(w.defsPath, 'utf8'));

test('il giro completo: dichiaro, resta scritto, ritiro', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await fleet.defineModel({ id: 'qwen9-nuovo', engine: PROFILO, contextWindow: 1000000 });
  assert.deepEqual(letto(w).models, [{ id: 'qwen9-nuovo', engine: PROFILO, contextWindow: 1000000 }]);

  await fleet.removeModel('qwen9-nuovo', PROFILO);
  // Tolto l'ultimo, la chiave sparisce: il file torna com'era, senza un array
  // vuoto che resterebbe li' a fare rumore in un export.
  assert.ok(!Object.hasOwn(letto(w), 'models'));
});

test('la scrittura rivalida tutto: un campo fuori schema non entra', async (t) => {
  // Non si duplicano le regole nel comando: la validazione e' quella del
  // parser, e passa dallo stesso punto della scrittura.
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await assert.rejects(() => fleet.defineModel({ id: 'm1', engine: PROFILO, prezzo: 3 }));
  assert.ok(!Object.hasOwn(letto(w), 'models'), 'niente e\' stato scritto');
});

test('un modello IN USO non si toglie in silenzio', async (t) => {
  // Toglierlo lo renderebbe invalido al prossimo avvio, e il messaggio
  // arriverebbe a chi non sa cosa e' cambiato. Meglio rifiutare adesso,
  // dicendo CHI lo usa.
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await fleet.defineModel({ id: 'usato', engine: PROFILO });
  await fleet.defineEngine({
    id: 'e2', label: 'E2',
    managed: { client: 'claude', provider: 'alibaba-token-plan', model: 'usato', permissionPolicy: 'unsafe' },
  });
  await assert.rejects(() => fleet.removeModel('usato', PROFILO), (e) => {
    assert.equal(e.status, 409);
    assert.match(e.message, /e2/);
    return true;
  });
  assert.equal(letto(w).models.length, 1, 'resta dichiarato');
});

test('due volte lo stesso modello sullo stesso profilo e\' un errore', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await fleet.defineModel({ id: 'm1', engine: PROFILO });
  await assert.rejects(() => fleet.defineModel({ id: 'm1', engine: PROFILO, contextWindow: 2048 }));
  assert.equal(letto(w).models.length, 1);
});

test('ritirare un modello mai dichiarato e\' 404, non un no-op silenzioso', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await assert.rejects(() => fleet.removeModel('mai-visto', PROFILO), (e) => e.status === 404);
});

test('id o engine mancanti: 400 prima di toccare il file', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  for (const def of [{ id: 'm1' }, { engine: PROFILO }, {}]) {
    await assert.rejects(() => fleet.defineModel(def), (e) => e.status === 400);
  }
  await assert.rejects(() => fleet.removeModel('', PROFILO), (e) => e.status === 400);
  assert.ok(!Object.hasOwn(letto(w), 'models'));
});

test('un engine che usa un modello dichiarato si salva; senza dichiarazione no', async (t) => {
  // E' la ragione per cui questa funzione esiste: rende usabile un id che il
  // catalogo del pacchetto non conosce ancora.
  const w = mondo(t);
  const fleet = await fleetDi(w);
  const engine = {
    id: 'e3', label: 'E3',
    managed: { client: 'claude', provider: 'alibaba-token-plan', model: 'appena-uscito', permissionPolicy: 'unsafe' },
  };
  await assert.rejects(() => fleet.defineEngine(engine), 'senza dichiarazione deve essere rifiutato');
  await fleet.defineModel({ id: 'appena-uscito', engine: PROFILO });
  await fleet.defineEngine(engine);
  assert.ok(letto(w).engines.some((e) => e.id === 'e3'));
});
