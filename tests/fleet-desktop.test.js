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
const { defaultDesktopEngine, backfillDesktopEngine, createBuiltinFleet } = require('../lib/fleet/builtin.js');
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

test('IL BOOTSTRAP ripara: la correzione arriva ad avvio, non solo chiamando la funzione', async () => {
  // Il test qui sopra chiamava la riparazione DIRETTAMENTE ed era verde mentre
  // la funzione non aveva alcun chiamante: scritta, testata e mai eseguita.
  // Il difetto e' stato trovato aggiornando una macchina vera, dove dopo il
  // riavvio il comando era ancora relativo. Questo esercita il percorso REALE —
  // se l'aggancio al bootstrap sparisce, questo diventa rosso e quello sopra no.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-boot-'));
  const defsPath = path.join(home, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{ ...defaultDesktopEngine(), command: 'docker' }],
    cells: [],
  });

  await createBuiltinFleet({ home, fleetDefsPath: defsPath });

  const daDisco = loadDefinitions(defsPath).engines.find((e) => e.id === 'desktop.local');
  assert.ok(path.isAbsolute(daDisco.command),
    `dopo l'avvio il comando e' ancora relativo (${daDisco.command}): la riparazione non gira`);
  assert.equal(path.basename(daDisco.command), 'docker');
  fs.rmSync(home, { recursive: true, force: true });
});

test("IL BOOTSTRAP non AGGIUNGE desktop.local a chi non ce l'ha", async () => {
  // Il verso opposto, e la decisione di progetto che va preservata: la
  // riparazione non deve trasformarsi in un backfill universale, perche'
  // l'engine presuppone un container con un nome preciso che quasi nessuna
  // installazione avra'.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-boot2-'));
  const defsPath = path.join(home, 'fleet.json');
  atomicWrite(defsPath, { schemaVersion: 1, engines: [], cells: [] });

  await createBuiltinFleet({ home, fleetDefsPath: defsPath });

  const dopo = loadDefinitions(defsPath).engines.find((e) => e.id === 'desktop.local');
  assert.equal(dopo, undefined, 'il bootstrap ha aggiunto un engine che deve restare manuale');
  fs.rmSync(home, { recursive: true, force: true });
});

// --- I quattro casi che l'audit indipendente ha riprodotto ------------------

test("il resolver non propone un eseguibile che il salvataggio rifiuterebbe", () => {
  // L'audit ha mostrato un docker 0777 scelto dal resolver e poi rifiutato come
  // world-writable: il default proposto non superava la validazione che lo
  // attendeva. Ora la decisione la prende la STESSA funzione, quindi le due non
  // possono divergere — e questo test lo verifica sul comportamento, non
  // leggendo il sorgente.
  const { validateCommandTrust } = require('../lib/fleet/definitions.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-path-'));
  const cattivo = path.join(dir, 'docker');
  fs.writeFileSync(cattivo, '#!/bin/sh\n', { mode: 0o777 });
  fs.chmodSync(cattivo, 0o777);

  const vecchioPath = process.env.PATH;
  process.env.PATH = dir; // solo il candidato world-writable
  try {
    const eng = defaultDesktopEngine();
    // O lo scarta (e resta il fallback), o quel che propone passa la boundary.
    if (eng.command === cattivo) {
      assert.fail('proposto un eseguibile world-writable che il salvataggio rifiuta');
    }
    const esito = validateCommandTrust(eng.command);
    assert.ok(esito.ok || /non accessibile/.test(esito.reason),
      `default non salvabile e senza causa chiara: ${esito.reason}`);
  } finally {
    process.env.PATH = vecchioPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("RIPARAZIONE: un percorso relativo scelto dall'utente non e' un residuo", () => {
  // `vendor/docker` ha lo stesso basename del residuo, ma e' una scelta: punta
  // a un binario proprio. L'audit lo ha visto sovrascritto col Docker di
  // sistema — riparare non deve mai voler dire sostituire.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-vend-'));
  const file = path.join(dir, 'fleet.json');
  atomicWrite(file, {
    schemaVersion: 1,
    engines: [{ ...defaultDesktopEngine(), command: 'vendor/docker' }],
    cells: [],
  });
  backfillDesktopEngine(file, loadDefinitions(file));
  const daDisco = loadDefinitions(file).engines.find((e) => e.id === 'desktop.local');
  assert.equal(daDisco.command, 'vendor/docker', 'una scelta relativa e\' stata sovrascritta');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('RIPARAZIONE: se non riesce a scrivere lo DICE, invece di tacere', () => {
  // Prima l\'errore era inghiottito: su uno store non scrivibile il comando
  // restava rotto e l\'avvio sembrava aver fatto il suo lavoro.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ro-'));
  const file = path.join(dir, 'fleet.json');
  atomicWrite(file, {
    schemaVersion: 1,
    engines: [{ ...defaultDesktopEngine(), command: 'docker' }],
    cells: [],
  });
  const detto = [];
  const { riparaDesktopEngine } = require('../lib/fleet/builtin.js');
  fs.chmodSync(dir, 0o500); // directory non scrivibile: il rename fallisce
  try {
    riparaDesktopEngine(file, loadDefinitions(file), (m) => detto.push(m));
    assert.ok(detto.length > 0, 'fallimento silenzioso: nessun messaggio');
    assert.match(detto.join('\n'), /desktop\.local/);
  } finally {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RIPARAZIONE: una scrittura concorrente non viene persa', () => {
  // L\'audit ha iniettato un writer fra la lettura e il rename: la riparazione
  // tornava col proprio draft e la modifica altrui spariva. Qui il concorrente
  // scrive PRIMA che la riparazione persista, partendo da uno stato gia\' letto.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-conc-'));
  const file = path.join(dir, 'fleet.json');
  atomicWrite(file, {
    schemaVersion: 1,
    engines: [{ ...defaultDesktopEngine(), command: 'docker', label: 'Prima' }],
    cells: [],
  });
  const stantio = loadDefinitions(file); // lo stato "vecchio", come all'avvio

  // Un altro writer salva nel frattempo — letto e riscritto da fuori, come
  // farebbe l'interfaccia, senza passare per gli helper interni.
  const altro = JSON.parse(fs.readFileSync(file, 'utf8'));
  altro.engines.find((e) => e.id === 'desktop.local').label = 'Scelta concorrente';
  atomicWrite(file, altro);

  const { riparaDesktopEngine } = require('../lib/fleet/builtin.js');
  riparaDesktopEngine(file, stantio);

  const daDisco = loadDefinitions(file).engines.find((e) => e.id === 'desktop.local');
  assert.equal(daDisco.label, 'Scelta concorrente', 'la scrittura concorrente e\' stata persa');
  fs.rmSync(dir, { recursive: true, force: true });
});

test("il resolver guarda TUTTA la catena, non il solo genitore", () => {
  // Un audit ha mostrato che fermarsi al genitore lascia passare
  // /antenato0777/child0755/docker: il binario e la sua directory sono
  // ineccepibili, ma chi scrive nell'antenato puo' rinominare `child` e
  // sostituire l'intero percorso.
  const radice = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-anc-'));
  const antenato = path.join(radice, 'antenato');
  const child = path.join(antenato, 'child');
  fs.mkdirSync(child, { recursive: true });
  fs.chmodSync(child, 0o755);
  fs.chmodSync(antenato, 0o777); // scrivibile da chiunque, senza sticky
  const bin = path.join(child, 'docker');
  fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
  fs.chmodSync(bin, 0o755);

  const vecchioPath = process.env.PATH;
  process.env.PATH = child;
  try {
    const eng = defaultDesktopEngine();
    assert.notEqual(eng.command, bin,
      'proposto un binario sotto un antenato scrivibile da chiunque: e\' sostituibile rinominando la directory');
  } finally {
    process.env.PATH = vecchioPath;
    fs.chmodSync(antenato, 0o755);
    fs.rmSync(radice, { recursive: true, force: true });
  }
});

test("IL BOOTSTRAP passa il logger: il fallimento non resta muto", async () => {
  // L'audit ha verificato che il callback funziona SE qualcuno lo passa — e che
  // il bootstrap non lo passava. Il messaggio si fermava a un parametro che
  // nessuno forniva: esattamente il silenzio che si voleva togliere.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-log-'));
  const defsPath = path.join(home, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{ ...defaultDesktopEngine(), command: 'docker' }],
    cells: [],
  });
  const detto = [];
  fs.chmodSync(home, 0o500); // lo store non e' scrivibile: la riparazione fallisce
  try {
    await createBuiltinFleet({ home, fleetDefsPath: defsPath, log: (m) => detto.push(String(m)) });
    assert.ok(detto.some((m) => /desktop\.local/.test(m)),
      `l'avvio non ha detto nulla del fallimento: ${JSON.stringify(detto.slice(0, 5))}`);
  } finally {
    fs.chmodSync(home, 0o700);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("RIPARAZIONE: se la configurazione non si rilegge, non si scrive", () => {
  // `loadDefinitions` non lancia: restituisce null. Un catch da solo non lo
  // intercettava, e si sarebbe deciso su uno stato mai letto.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-nul-'));
  const file = path.join(dir, 'fleet.json');
  atomicWrite(file, {
    schemaVersion: 1,
    engines: [{ ...defaultDesktopEngine(), command: 'docker' }],
    cells: [],
  });
  const stato = loadDefinitions(file);
  fs.writeFileSync(file, '{ questo non e json'); // rilettura destinata a fallire
  const { riparaDesktopEngine } = require('../lib/fleet/builtin.js');
  const esito = riparaDesktopEngine(file, stato);
  assert.ok(esito && Array.isArray(esito.engines), 'restituito uno stato inutilizzabile');
  assert.equal(fs.readFileSync(file, 'utf8'), '{ questo non e json',
    'ha scritto pur non avendo potuto rileggere');
  fs.rmSync(dir, { recursive: true, force: true });
});
