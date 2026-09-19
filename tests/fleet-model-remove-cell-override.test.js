'use strict';
// tests/fleet-model-remove-cell-override.test.js — chi USA davvero un modello.
//
// Ritirare un modello che qualcuno usa lo renderebbe invalido al prossimo
// avvio, e il messaggio arriverebbe a chi non sa cosa e' cambiato: la diagnosi
// d'uso esiste per questo. Ma guardava solo gli ENGINE: una CELLA che sovrascrive
// il modello per il proprio engine non veniva contata, quindi la rimozione
// passava e lasciava una cella che punta a un modello che non c'e' piu'.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');
const { profileFor } = require('../lib/fleet/managed.js');

// Una definizione valida, poi l'engine managed e il modello dichiarato via CRUD:
// cosi' la fixture e' quella che il prodotto accetta davvero, non una a mano.
function mondo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-rm-override-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const cwd = path.join(home, 'Dev');
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const bin = path.join(home, '.local', 'bin', 'claude');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(bin, 0o755);
  const defsPath = path.join(root, 'fleet.json');
  fs.writeFileSync(defsPath, JSON.stringify({
    schemaVersion: 1,
    engines: [{
      id: 'e1', label: 'E1', rc: true, command: bin, args: [], env: {},
      promptMode: 'flag', promptFlag: '--sp',
    }],
    cells: [{ id: 'Dev', tmuxSession: 'work-rm', cwd, engine: 'e1', boot: false, prompt: 'p' }],
  }));
  const tmuxBin = path.join(home, 'bin', 'tmux-finto');
  fs.mkdirSync(path.dirname(tmuxBin), { recursive: true });
  fs.writeFileSync(tmuxBin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(tmuxBin, 0o755);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { home, defsPath, tmuxBin, cwd };
}

// `usedByEngine`: il modello e' quello RISOLTO dall'engine (managed.model).
// Altrimenti l'engine dichiara un ALTRO modello e il legame passa solo da una
// cella: e' il caso che il difetto non vedeva.
async function fleetCon(t, { usedByEngine }) {
  const w = mondo(t);
  const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
  await fleet.defineEngine({
    id: 'e2', label: 'E2',
    managed: {
      client: 'claude', provider: 'custom', model: usedByEngine ? 'model-a' : 'model-other',
      permissionPolicy: 'standard', displayName: 'Locale', baseUrl: 'http://127.0.0.1:1/v1',
      protocol: 'anthropic_messages', providerId: 'locale', envKey: 'LOCAL_API_KEY',
    },
  });
  await fleet.defineModel({ id: 'model-a', engine: 'e2', contextWindow: 8192, maxTokens: 4096 });
  return { fleet, w };
}

const defs = (w) => JSON.parse(fs.readFileSync(w.defsPath, 'utf8'));

test('modello usato da un ENGINE: 409 e l\'engine e\' nominato', async (t) => {
  const { fleet } = await fleetCon(t, { usedByEngine: true });
  await assert.rejects(() => fleet.removeModel('model-a', 'e2'), (e) => {
    assert.equal(e.status, 409);
    assert.match(e.message, /modello in uso/);
    assert.match(e.message, /e2/);
    return true;
  });
  await fleet.close();
});

test('modello usato SOLO da una CELLA che lo sovrascrive: 409, e la cella e\' nominata', async (t) => {
  const { fleet, w } = await fleetCon(t, { usedByEngine: false });
  await fleet.editCell('Dev', { models: { e2: 'model-a' } });
  assert.equal(defs(w).cells[0].models.e2, 'model-a');

  await assert.rejects(() => fleet.removeModel('model-a', 'e2'), (e) => {
    assert.equal(e.status, 409, 'una cella che lo usa non e\' una rimozione valida');
    assert.match(e.message, /Dev/, 'la cella che lo usa deve essere nominata');
    return true;
  });
  // E il modello e' ancora dichiarato: il rifiuto non e' una scrittura parziale.
  assert.ok(defs(w).models.some((m) => m.id === 'model-a' && m.engine === 'e2'));
  await fleet.close();
});

test('modello usato dall\'override SINGOLO della cella: 409', async (t) => {
  const { fleet, w } = await fleetCon(t, { usedByEngine: false });
  // L'override singolo vale per l'engine DELLA cella: perche' sia un uso del
  // modello chiesto, la cella deve girare proprio su quell'engine.
  await fleet.editCell('Dev', { engine: 'e2', model: 'model-a' });
  assert.equal(defs(w).cells[0].model, 'model-a');
  assert.equal(defs(w).cells[0].engine, 'e2');

  await assert.rejects(() => fleet.removeModel('model-a', 'e2'), (e) => {
    assert.equal(e.status, 409, 'cell.model e\' un uso a tutti gli effetti');
    assert.match(e.message, /Dev/);
    return true;
  });
  await fleet.close();
});

test('modello dichiarato sotto il PROFILO e usato da una cella: 409', async (t) => {
  const { fleet, w } = await fleetCon(t, { usedByEngine: false });
  // La seconda chiave con cui si dichiara un modello e' l'id del PROFILO
  // dell'engine: `cell.models` accetta solo id di engine, quindi per una cella
  // l'unico modo di usarlo e' il proprio engine — che risolve il modello dal
  // profilo. E' il ramo che senza la correzione passava in silenzio.
  const prof = profileFor('claude', 'custom', '');
  assert.ok(prof && prof.id, 'il profilo esiste');
  await fleet.defineModel({ id: 'model-p', engine: prof.id, contextWindow: 8192, maxTokens: 4096 });
  await fleet.editCell('Dev', { engine: 'e2', model: 'model-p' });
  assert.equal(defs(w).cells[0].model, 'model-p');

  await assert.rejects(() => fleet.removeModel('model-p', prof.id), (e) => {
    assert.equal(e.status, 409);
    assert.match(e.message, /Dev/);
    return true;
  });
  await fleet.close();
});

test('nessuno lo usa: la rimozione passa e il modello sparisce davvero', async (t) => {
  const { fleet, w } = await fleetCon(t, { usedByEngine: false });
  const out = await fleet.removeModel('model-a', 'e2');
  assert.equal(out.ok, true);
  assert.equal(out.id, 'model-a');
  assert.equal(out.engine, 'e2');
  assert.ok(!(defs(w).models || []).some((m) => m.id === 'model-a'), 'la voce e\' stata tolta');
  await fleet.close();
});

test('una cella che usa un ALTRO modello non blocca la rimozione', async (t) => {
  const { fleet, w } = await fleetCon(t, { usedByEngine: false });
  await fleet.editCell('Dev', { models: { e2: 'model-other' } });
  const out = await fleet.removeModel('model-a', 'e2');
  assert.equal(out.ok, true, 'la diagnosi deve essere per il modello CHIESTO, non per "una cella lo nomina"');
  assert.ok(!(defs(w).models || []).some((m) => m.id === 'model-a'));
  await fleet.close();
});
