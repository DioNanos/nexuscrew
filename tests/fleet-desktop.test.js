'use strict';
// desktop.local: engine predefinito (non-managed) che entra in un container
// desktop via `docker exec` e precompila panelUrl al pannello noVNC/KasmVNC del
// container. Il valore precompilato resta sovrascrivibile per-cella (D8 backend,
// NexusCrew 0.8.53).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseDefinitions } = require('../lib/fleet/definitions.js');
const { defaultDesktopEngine, backfillDesktopEngine } = require('../lib/fleet/builtin.js');
const { loadDefinitions, atomicWrite } = require('../lib/fleet/definitions.js');

test('l\'engine Desktop supera la trust boundary che il salvataggio applica', () => {
  // La prova che il difetto non torna: si chiama la funzione VERA del prodotto,
  // non una sua imitazione. Se docker non e' installato su questa macchina il
  // caso non e' esprimibile e il test lo dichiara invece di fingere di averlo
  // verificato — un verde per assenza di condizioni resta un verde muto.
  const { validateCommandTrust } = require('../lib/fleet/definitions.js');
  const eng = defaultDesktopEngine();
  const esito = validateCommandTrust(eng.command);
  if (esito.ok) { assert.equal(esito.reason, 'trusted'); return; }
  assert.notEqual(esito.reason, 'command deve essere un path assoluto',
    'il command e\' di nuovo relativo: l\'engine sarebbe offerto e poi rifiutato');
  assert.match(esito.reason, /non accessibile/,
    `docker assente qui: atteso un rifiuto che NOMINA la causa, ricevuto "${esito.reason}"`);
});

test('defaultDesktopEngine: comando esatto che entra nel container, panelUrl precompilato', () => {
  const eng = defaultDesktopEngine();
  assert.equal(eng.id, 'desktop.local');
  // Il command NON si confronta con la stringa 'docker': quel test passava
  // mentre l'engine era inutilizzabile. Cio' che conta e' che superi la stessa
  // trust boundary che il salvataggio applichera' — un engine built-in offerto
  // nell'elenco e poi rifiutato al salvataggio e' peggio di uno assente.
  assert.ok(path.isAbsolute(eng.command),
    `command deve essere un path assoluto, e' ${eng.command}`);
  assert.equal(path.basename(eng.command), 'docker');
  assert.deepEqual(eng.args, ['exec', '-it', '-u', 'abc', 'ai-desktop', 'bash']);
  assert.equal(eng.promptMode, 'send-keys');
  assert.equal(eng.panelUrl, 'https://127.0.0.1:6901');
  // -u abc non e' un dettaglio: senza, si entra come root e Chromium nel
  // container rifiuta di partire.
  assert.ok(eng.args.includes('-u') && eng.args[eng.args.indexOf('-u') + 1] === 'abc');
});

test('desktop.local: il campo panelUrl arriva valorizzato attraverso parseDefinitions', () => {
  const def = { schemaVersion: 1, engines: [defaultDesktopEngine()], cells: [{ id: 'Desk', cwd: '/tmp', engine: 'desktop.local' }] };
  const parsed = parseDefinitions(def);
  assert.ok(parsed, 'definizione con desktop.local valida');
  assert.equal(parsed.engines[0].panelUrl, 'https://127.0.0.1:6901');
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.cells[0], 'panelUrl'), false,
    'la cella non eredita automaticamente panelUrl in fase di parse: e\' un campo suo, opzionale');
});

test('desktop.local: una cella puo\' sovrascrivere il panelUrl precompilato con uno proprio', () => {
  const def = {
    schemaVersion: 1,
    engines: [defaultDesktopEngine()],
    cells: [{ id: 'Desk', cwd: '/tmp', engine: 'desktop.local', panelUrl: 'https://localhost:6901' }],
  };
  const parsed = parseDefinitions(def);
  assert.ok(parsed);
  assert.equal(parsed.engines[0].panelUrl, 'https://127.0.0.1:6901', 'default engine invariato');
  assert.equal(parsed.cells[0].panelUrl, 'https://localhost:6901', 'override per-cella preservato, distinto dal default');
});

test('backfillDesktopEngine: idempotente, non distruttivo su collisione id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncdesktopbf-'));
  try {
    const dp = (engines) => {
      const p = path.join(root, `f-${Math.random().toString(36).slice(2)}.json`);
      atomicWrite(p, { schemaVersion: 1, engines, cells: [] });
      return p;
    };
    const base = [{ id: 'claude.native', label: 'Claude', rc: true, managed: { client: 'claude', provider: 'native', permissionPolicy: 'unsafe' } }];
    const p1 = dp(base);
    const a1 = backfillDesktopEngine(p1, loadDefinitions(p1));
    assert.ok(a1.engines.some((e) => e.id === 'desktop.local'));
    const desk = a1.engines.find((e) => e.id === 'desktop.local');
    assert.equal(desk.panelUrl, 'https://127.0.0.1:6901');
    assert.deepEqual(desk.args, ['exec', '-it', '-u', 'abc', 'ai-desktop', 'bash']);
    // idempotente
    const a1b = backfillDesktopEngine(p1, a1);
    assert.equal(a1b.engines.filter((e) => e.id === 'desktop.local').length, 1);
    // collisione id: engine custom con id desktop.local -> preservato, non sovrascritto
    const p2 = dp([{ id: 'desktop.local', label: 'Custom', command: '/bin/x', args: [], promptMode: 'flag', promptFlag: '-p' }]);
    const a2 = backfillDesktopEngine(p2, loadDefinitions(p2));
    assert.equal(a2.engines.length, 1);
    assert.equal(a2.engines[0].command, '/bin/x', 'collisione: custom desktop.local preservato');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("RIPARAZIONE: un desktop.local gia' salvato con command relativo viene corretto", () => {
  // Il caso vero, e quello che il fix del default NON copre: su una macchina
  // gia' configurata l'engine esiste, quindi il backfill lo salta e il comando
  // rotto resta. E' esattamente la situazione in cui il difetto e' stato visto.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-desk-'));
  const file = path.join(dir, 'fleet.json');
  const rotto = { ...defaultDesktopEngine(), command: 'docker' };
  atomicWrite(file, { schemaVersion: 1, engines: [rotto], cells: [] });

  const dopo = backfillDesktopEngine(file, loadDefinitions(file));
  const voce = dopo.engines.find((e) => e.id === 'desktop.local');
  assert.ok(path.isAbsolute(voce.command), `command ancora relativo: ${voce.command}`);
  assert.equal(path.basename(voce.command), 'docker');
  // E la riparazione dev'essere DUREVOLE, non solo in memoria: quello che
  // conta e' cosa trovera' il prossimo avvio su disco.
  const daDisco = loadDefinitions(file).engines.find((e) => e.id === 'desktop.local');
  assert.equal(daDisco.command, voce.command, 'riparato in memoria ma non su disco');
  fs.rmSync(dir, { recursive: true, force: true });
});

test("RIPARAZIONE: non tocca una scelta dell'utente", () => {
  // Il verso opposto, senza il quale la riparazione sarebbe una sovrascrittura
  // travestita: un path assoluto o un comando diverso restano com'erano.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-desk2-'));
  const file = path.join(dir, 'fleet.json');
  const scelto = { ...defaultDesktopEngine(), command: '/opt/mio/podman' };
  atomicWrite(file, { schemaVersion: 1, engines: [scelto], cells: [] });

  const dopo = backfillDesktopEngine(file, loadDefinitions(file));
  assert.equal(dopo.engines.find((e) => e.id === 'desktop.local').command, '/opt/mio/podman');
  fs.rmSync(dir, { recursive: true, force: true });
});
