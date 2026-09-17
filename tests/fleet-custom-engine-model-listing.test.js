'use strict';
// tests/fleet-custom-engine-model-listing.test.js — i modelli DICHIARATI per un
// engine custom devono comparire nella lista che la finestra usa per il
// selettore.
//
// PERCHE' ESISTE: `status()` e `definitions()` costruivano `models` dal solo
// catalogo builtin del profilo (`profile.models`). Un profilo custom non ha
// catalogo, quindi la lista restava `[]` (o il solo pin per `pi`) anche con
// due modelli dichiarati in `definitions.models[]`: il boot li accettava, il
// selettore non li mostrava. Trovato sul Mac con quattro engine `*.macair`
// (readback 0.9.30, 2026-09-17): la funzione giusta esisteva gia'
// (`declaredModelsFor`), ma la vista non la chiamava.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');

const DICHIARATI = ['ornith-1.5-9b', 'spark-x2.5-4b'];

function mondo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-custom-listing-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.chmodSync(home, 0o700);
  const cwd = path.join(home, 'Dev');
  fs.mkdirSync(cwd);
  fs.mkdirSync(path.join(home, 'bin'));
  const defsPath = path.join(root, 'fleet.json');
  fs.writeFileSync(defsPath, JSON.stringify({ schemaVersion: 1, engines: [], cells: [] }));
  const tmuxBin = path.join(home, 'bin', 'tmux-finto');
  fs.writeFileSync(tmuxBin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(tmuxBin, 0o755);
  // Il client va trovato sotto la home, altrimenti l'engine non e' descritto
  // come configurato; qui interessa la LISTA, non il boot.
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  for (const client of ['claude', 'pi']) {
    const bin = path.join(home, '.local', 'bin', client);
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(bin, 0o755);
  }
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { home, defsPath, tmuxBin };
}

const fleetDi = (w) => createBuiltinFleet({ home: w.home, fleetDefsPath: w.defsPath, tmuxBin: w.tmuxBin });

async function dichiaraEngineCustom(fleet, { id, client, protocol, baseUrl }) {
  await fleet.defineEngine({
    id, label: id,
    managed: {
      client, provider: 'custom', model: DICHIARATI[1], permissionPolicy: 'standard',
      displayName: `${client} · locale`, baseUrl, protocol, providerId: id.replace('.', '-'),
      envKey: 'LMSTUDIO_API_KEY',
    },
  });
  for (const m of DICHIARATI) await fleet.defineModel({ id: m, engine: id, contextWindow: 262144, maxTokens: 8192 });
}

const ordinati = (xs) => [...xs].sort();

test('engine custom (claude): status() elenca i modelli dichiarati, non []', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await dichiaraEngineCustom(fleet, {
    id: 'claude.macair', client: 'claude', protocol: 'anthropic_messages', baseUrl: 'http://127.0.0.1:18134',
  });

  const stato = await fleet.status();
  const engine = stato.engines.find((e) => e.id === 'claude.macair');
  assert.ok(engine, 'l\'engine deve comparire nello status');
  assert.equal(engine.kind, 'managed');
  assert.deepEqual(ordinati(engine.models), ordinati(DICHIARATI),
    'i modelli dichiarati per l\'engine devono essere la lista del selettore');
});

test('engine custom (claude): definitions().managedInfo.models elenca i dichiarati', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await dichiaraEngineCustom(fleet, {
    id: 'claude.macair', client: 'claude', protocol: 'anthropic_messages', baseUrl: 'http://127.0.0.1:18134',
  });

  const vista = await fleet.definitions();
  const engine = vista.engines.find((e) => e.id === 'claude.macair');
  assert.ok(engine && engine.managedInfo, 'la vista deve descrivere l\'engine gestito');
  assert.deepEqual(ordinati(engine.managedInfo.models), ordinati(DICHIARATI));
});

test('engine custom (pi): status() elenca i dichiarati e non solo il pin', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await dichiaraEngineCustom(fleet, {
    id: 'pi.macair', client: 'pi', protocol: 'openai-completions', baseUrl: 'http://127.0.0.1:18134/v1',
  });

  const stato = await fleet.status();
  const engine = stato.engines.find((e) => e.id === 'pi.macair');
  assert.ok(engine, 'l\'engine deve comparire nello status');
  assert.deepEqual(ordinati(engine.models), ordinati(DICHIARATI));
  assert.ok(engine.models.includes(engine.model), 'il pin resta nella lista');
});

test('engine custom senza dichiarazioni: la lista resta vuota (nessuna invenzione)', async (t) => {
  const w = mondo(t);
  const fleet = await fleetDi(w);
  await fleet.defineEngine({
    id: 'claude.nudo', label: 'nudo',
    managed: {
      client: 'claude', provider: 'custom', model: 'qualcosa', permissionPolicy: 'standard',
      displayName: 'nudo', baseUrl: 'http://127.0.0.1:1', protocol: 'anthropic_messages',
      providerId: 'claude-nudo', envKey: 'LMSTUDIO_API_KEY',
    },
  });

  const stato = await fleet.status();
  const engine = stato.engines.find((e) => e.id === 'claude.nudo');
  assert.deepEqual(engine.models, []);
});
