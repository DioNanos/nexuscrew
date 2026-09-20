'use strict';
// tests/fleet-capability-profiles-preserve.test.js — capabilityProfiles nel
// round-trip delle mutazioni.
//
// PERCHE' ESISTE: `draftFrom` copiava schemaVersion/models/engines/cells ma
// NON `capabilityProfiles`. Ogni mutazione ricostruisce il file dalla bozza,
// quindi: (a) con una cella che riferisce un profilo la scrittura veniva
// RIFIUTATA (profilo non dichiarato) e fleet.json diventava non scrivibile;
// (b) senza riferimenti la scrittura passava e CANCELLAVA in silenzio la
// chiave. In piu' la vista `definitions()` non la esponeva: la finestra non
// poteva vederla. Questi test riproducono il percorso del prodotto su un
// fleet.json temporaneo (mai il vero ~/.nexuscrew).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');

const PROFILO = 'worker-test';

function mondo(t, defs) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-capprof-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  const cwd = path.join(home, 'Dev');
  fs.mkdirSync(cwd);
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const command = path.join(bin, 'finto-client');
  fs.writeFileSync(command, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(command, 0o755);
  const defsPath = path.join(root, 'fleet.json');
  fs.writeFileSync(defsPath, JSON.stringify(defs));
  const tmuxBin = path.join(bin, 'tmux-finto');
  fs.writeFileSync(tmuxBin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(tmuxBin, 0o755);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { home, defsPath, tmuxBin };
}

function defsBase(extra = {}) {
  return {
    schemaVersion: 1,
    engines: [{ id: 'e1', label: 'E1', command: '/bin/true', args: [], env: {}, promptMode: 'send-keys' }],
    cells: [{ id: 'Dev', cwd: '/tmp', engine: 'e1', boot: false, ...extra.cell }],
    ...extra.top,
  };
}

const PROFILI = { [PROFILO]: { mcp: ['nexuscrew', 'memory'], skills: [], ondemand: [] } };

test('(a) cella con profilo: edit-cell (anche patch vuota) conserva profili e riferimento', async (t) => {
  const w = mondo(t, defsBase({ cell: { capabilityProfile: PROFILO }, top: { capabilityProfiles: PROFILI } }));
  const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
  await fleet.editCell('Dev', {}); // patch vuota: la scrittura avviene comunque
  const onDisk = JSON.parse(fs.readFileSync(w.defsPath, 'utf8'));
  assert.deepEqual(onDisk.capabilityProfiles, PROFILI, 'i profili devono sopravvivere alla scrittura');
  assert.equal(onDisk.cells[0].capabilityProfile, PROFILO, 'il riferimento della cella deve restare');
});

test('(b) profili senza riferimenti: patch no-op non li cancella', async (t) => {
  const w = mondo(t, defsBase({ top: { capabilityProfiles: PROFILI } }));
  const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
  await fleet.editCell('Dev', { label: 'Nuova etichetta' });
  const onDisk = JSON.parse(fs.readFileSync(w.defsPath, 'utf8'));
  assert.equal(onDisk.cells[0].label, 'Nuova etichetta', 'la patch deve applicarsi');
  assert.deepEqual(onDisk.capabilityProfiles, PROFILI, 'i profili non devono sparire in silenzio');
});

test('(c) la vista definitions espone capabilityProfiles come nel file', async (t) => {
  const w = mondo(t, defsBase({ cell: { capabilityProfile: PROFILO }, top: { capabilityProfiles: PROFILI } }));
  const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
  const vista = await fleet.definitions();
  assert.ok(vista.capabilityProfiles, 'definitions() deve esporre capabilityProfiles');
  assert.deepEqual(vista.capabilityProfiles, PROFILI, 'la vista deve restituire i profili dichiarati');
});

test('(d) documento senza profili: nessuna chiave aggiunta', async (t) => {
  const w = mondo(t, defsBase());
  const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });
  await fleet.editCell('Dev', { label: 'Etichetta' });
  const raw = fs.readFileSync(w.defsPath, 'utf8');
  const onDisk = JSON.parse(raw);
  assert.equal(onDisk.cells[0].label, 'Etichetta');
  assert.equal(Object.prototype.hasOwnProperty.call(onDisk, 'capabilityProfiles'), false, 'senza profili la chiave non deve apparire');
});
