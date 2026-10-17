'use strict';
// Ordine degli engine, flag `standard`, etichette in minuscolo, tetto del
// restore. Tutto in SOLA LETTURA sul fleet.json: un file vecchio non viene
// mai migrato, e' il payload che si ordina in uscita.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBuiltinFleet } = require('../lib/fleet/builtin.js');
const { CLIENT_ORDER, CLIENT_LABELS, ordinaEngine, defaultDefinitions } = require('../lib/fleet/managed.js');

// Mondo isolato: home e fleet.json in una dir temporanea, tmux finto che non
// fa nulla. definitions() non lancia nulla, ma il fleet vuole un binario.
function mondo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-engine-order-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.chmodSync(home, 0o700);
  fs.mkdirSync(path.join(home, 'bin'));
  const tmuxBin = path.join(home, 'bin', 'tmux-finto');
  fs.writeFileSync(tmuxBin, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(tmuxBin, 0o755);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, home, tmuxBin };
}

// Engine managed minimi per ogni client noto, piu' un derivato per claude e
// codex-vl e un custom fuori lista. Il seed/backfill non gira: il file e'
// gia' completo.
function engineDi(id, client, label) {
  if (client === null) return { id, label, rc: false, command: '/bin/sh', args: [], env: {}, promptMode: 'send-keys' };
  const provider = client === 'shell' ? 'local' : 'native';
  return { id, label, rc: false, managed: { client, provider, model: '', permissionPolicy: 'standard' } };
}

function scriviFleet(w, engines) {
  const defsPath = path.join(w.root, 'fleet.json');
  fs.writeFileSync(defsPath, JSON.stringify({ schemaVersion: 1, engines, cells: [] }));
  return defsPath;
}

test('defaultDefinitions(): il seed segue CLIENT_ORDER', () => {
  const d = defaultDefinitions();
  const ordine = d.engines.map((e) => e.managed.client);
  // I client seminati (claude, codex-vl, codex, pi, shell) compaiono nello
  // stesso ordine relativo di CLIENT_ORDER, qualunque sia l'ordine del CATALOG.
  const atteso = CLIENT_ORDER.filter((c) => ordine.includes(c));
  assert.deepEqual(ordine, atteso, 'seed allineato a CLIENT_ORDER');
  assert.equal(ordine[0], 'claude');
  assert.ok(ordine.indexOf('codex-vl') < ordine.indexOf('codex'), 'codex-vl prima di codex');
  assert.equal(ordine[ordine.length - 1], 'shell', 'shell chiude il seed');
});

test('ordinaEngine(): fuori lista in fondo, stabili, nessun engine perso', () => {
  const dentro = [
    engineDi('zz.custom', null, 'Il Mio'),
    engineDi('vl.native', 'vl'),
    engineDi('kimi.native', 'kimi'),
    engineDi('shell.local', 'shell'),
    engineDi('grok.native', 'grok'),
    engineDi('agy.native', 'agy'),
    engineDi('pi.native', 'pi'),
    engineDi('codex.native', 'codex'),
    engineDi('codex-vl.native', 'codex-vl'),
    engineDi('claude.native', 'claude'),
  ];
  const ordinati = ordinaEngine(dentro);
  assert.equal(ordinati.length, dentro.length, 'nessun engine perso');
  assert.deepEqual(ordinati.map((e) => e.id), [
    'claude.native', 'codex-vl.native', 'codex.native', 'pi.native',
    'agy.native', 'grok.native', 'shell.local',
    'zz.custom', 'vl.native', 'kimi.native',
  ], 'standard nell\'ordine, fuori lista in coda stabili nell\'ordine di inserimento');
  // stabilita': due fuori lista mantengono l'ordine relativo di partenza
  assert.ok(ordinati.findIndex((e) => e.id === 'zz.custom') < ordinati.findIndex((e) => e.id === 'vl.native'));
  // l'input non viene mutato
  assert.equal(dentro[0].id, 'zz.custom', 'array originale intatto');
});

test('fleet.definitions(): payload ordinato partendo da un fleet.json scritto al contrario, file mai riscritto', async (t) => {
  const w = mondo(t);
  // TUTTO al contrario: custom e fuori lista in testa, claude per ultimo.
  const alContrario = [
    engineDi('zz.custom', null, 'Il Mio'),
    engineDi('vl.native', 'vl', 'VL'),
    engineDi('kimi.native', 'kimi', 'Kimi Code CLI'),
    engineDi('shell.local', 'shell', 'Shell'),
    engineDi('grok.native', 'grok', 'Grok'),
    engineDi('agy.native', 'agy', 'Agy'),
    engineDi('pi.native', 'pi', 'Pi'),
    engineDi('codex.native', 'codex', 'Codex'),
    engineDi('codex-vl.native', 'codex-vl', 'Codex-VL'),
    engineDi('claude.native', 'claude', 'Claude Code'),
  ];
  const defsPath = scriviFleet(w, alContrario);
  const prima = fs.readFileSync(defsPath, 'utf8');
  const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: defsPath, tmuxBin: w.tmuxBin });
  const vista = fleet.definitions();
  assert.deepEqual(vista.engines.map((e) => e.id), [
    'claude.native', 'codex-vl.native', 'codex.native', 'pi.native',
    'agy.native', 'grok.native', 'shell.local',
    'zz.custom', 'vl.native', 'kimi.native',
  ], 'payload ordinato senza migrazione');
  assert.equal(fs.readFileSync(defsPath, 'utf8'), prima, 'il file resta byte-identico: ordine solo in lettura');
});

test('fleet.definitions(): i derivati restano attaccati al loro client', async (t) => {
  const w = mondo(t);
  const defsPath = scriviFleet(w, [
    engineDi('claude.native', 'claude'),
    engineDi('claude.hosted', 'claude'),
    engineDi('codex-vl.native', 'codex-vl'),
    engineDi('codex-vl.ollama-cloud', 'codex-vl'),
    engineDi('codex.native', 'codex'),
    engineDi('pi.native', 'pi'),
    engineDi('pi.edge', 'pi'),
    engineDi('zz.custom', null),
  ]);
  const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: defsPath, tmuxBin: w.tmuxBin });
  const ids = fleet.definitions().engines.map((e) => e.id);
  // Il bootstrap aggiunge in backfill i client mancanti, nel nuovo ordine
  // (agy, grok, shell, poi i fuori lista kimi e vl): il custom scritto nel
  // file resta prima dei backfillati, perche' era gia' nell'array.
  assert.deepEqual(ids, [
    'claude.native', 'claude.hosted',
    'codex-vl.native', 'codex-vl.ollama-cloud',
    'codex.native',
    'pi.native', 'pi.edge',
    'agy.native', 'grok.native', 'shell.local',
    'zz.custom', 'kimi.native', 'vl.native',
  ], 'derivati dentro il gruppo del loro client, custom in coda');
});

test('fleet.definitions(): standard true solo per i client in CLIENT_ORDER', async (t) => {
  const w = mondo(t);
  const defsPath = scriviFleet(w, [
    engineDi('claude.native', 'claude'),
    engineDi('vl.native', 'vl'),
    engineDi('zz.custom', null),
  ]);
  const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: defsPath, tmuxBin: w.tmuxBin });
  const vista = fleet.definitions();
  const perId = new Map(vista.engines.map((e) => [e.id, e]));
  assert.equal(perId.get('claude.native').standard, true, 'claude e\' standard');
  assert.equal(perId.get('vl.native').standard, false, 'vl e\' supportato, non standard');
  assert.equal(perId.get('zz.custom').standard, false, 'custom mai standard');
  // il flag e' calcolato, non persistito: sul disco non esiste
  const suDisco = JSON.parse(fs.readFileSync(defsPath, 'utf8'));
  assert.ok(suDisco.engines.every((e) => e.standard === undefined), 'nessun campo standard scritto nel file');
});

test('fleet.definitions(): etichette in minuscolo, anche quelle scritte a mano; nel file restano come sono', async (t) => {
  const w = mondo(t);
  const defsPath = scriviFleet(w, [
    engineDi('claude.native', 'claude', 'Mio Claude'),
    engineDi('kimi.native', 'kimi', 'Kimi Code CLI'),
    engineDi('zz.custom', null, 'Il Mio Custom'),
  ]);
  const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: defsPath, tmuxBin: w.tmuxBin });
  const vista = fleet.definitions();
  const perId = new Map(vista.engines.map((e) => [e.id, e]));
  assert.equal(perId.get('claude.native').label, 'mio claude', 'label scritta a mano mostrata in minuscolo');
  assert.equal(perId.get('kimi.native').label, 'kimi code cli', 'label del client in minuscolo');
  assert.equal(perId.get('zz.custom').label, 'il mio custom', 'custom anch\'esso in minuscolo in uscita');
  assert.ok(vista.engines.every((e) => e.label === e.label.toLowerCase()), 'tutte le label del payload sono minuscole');
  const suDisco = JSON.parse(fs.readFileSync(defsPath, 'utf8'));
  assert.equal(suDisco.engines.find((e) => e.id === 'claude.native').label, 'Mio Claude', 'il file conserva il testo dell\'operatore');
});

test('CLIENT_LABELS: tutti i valori minuscoli e uguali al nome del client', () => {
  for (const [client, label] of Object.entries(CLIENT_LABELS)) {
    assert.equal(label, client, `label di ${client} = nome client`);
    assert.equal(label, label.toLowerCase(), `label di ${client} minuscola`);
  }
});

test('restore-engines: 65 e 128 modelli accettati, 129 rifiutati', async (t) => {
  const w = mondo(t);
  const defsPath = scriviFleet(w, [engineDi('claude.native', 'claude')]);
  const fleet = await createBuiltinFleet({ home: w.home, fleetDefsPath: defsPath, tmuxBin: w.tmuxBin });
  const engineChe = (suffisso) => ({
    id: `importato-${suffisso}`, label: 'Importato',
    managed: { client: 'claude', provider: 'native', model: '', permissionPolicy: 'standard' },
  });
  const modelli = (n) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, engine: 'claude.native' }));
  // 65: sopra il vecchio tetto hardcoded di 64, sotto MAX_MODELS
  await fleet.restoreEngines([engineChe('65')], { models: modelli(65) });
  // 128: esattamente MAX_MODELS
  await fleet.restoreEngines([engineChe('128')], { models: modelli(128) });
  // 129: oltre il tetto, rifiutato
  await assert.rejects(
    () => fleet.restoreEngines([engineChe('129')], { models: modelli(129) }),
    (e) => e.status === 400 && /troppi modelli/.test(e.message),
  );
});
