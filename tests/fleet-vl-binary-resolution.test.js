'use strict';
// Contratto del binario vl dichiarato (vlBinary) — la risoluzione e' UNA sola
// e governa tre cose insieme: il verdetto di `configured`, il binario che
// composeClientInvocation lancia e il binario che i gate di versione
// (VL_SYSTEM_APPEND_FILE, VL_EFFORT) interrogano.
//
// Il difetto che questo file chiude: `describeManaged` risolveva il client
// SOLO dal PATH (findBinary). Un engine con `vlBinary` dichiarato e valido,
// su un nodo dove `vl` non e' nel PATH, risultava «non configurato» — e il
// ramo vl di resolveManagedEngine, che legge lo stesso verdetto, rifiutava il
// lancio. Il campo dichiarato non era onesto: diceva «il binario e' questo» e
// il sistema lo ignorava.
//
// Regole ferme:
// - dichiarato e valido -> il binario dichiarato governa tutto (verdetto,
//   probe, spawn). Il PATH non viene nemmeno consultato.
// - dichiarato e NON valido -> rifiuto DICHIARATO. MAI un ripiego silenzioso
//   sul PATH: un binario rotto che si nasconde dietro un altro e' il difetto
//   piu' pericoloso dei due.
// - non dichiarato -> il comportamento di sempre: PATH, come prima.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describeManaged, resolveManagedEngine, resolveVlBinary } = require('../lib/fleet/managed.js');

const PROBE = (v) => () => `vl ${v}\n`;

// Home SENZA vl nel PATH: il PATH e' il caso che deve valere il binario
// dichiarato, non il contrario.
function homeSenzaVl() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlbin-'));
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  // Il catalogo dell'operatore: e' la sorgente di un engine native senza
  // vlConfigFile dichiarato. Senza di esso il lancio nativo e' un rifiuto
  // dichiarato, non un avvio sui default del runtime.
  const catalogoVl = path.join(home, '.config', 'vl');
  fs.mkdirSync(catalogoVl, { recursive: true });
  fs.writeFileSync(path.join(catalogoVl, 'config.toml'), '[profiles.work]\nmodel = "m-work"\n');
  return home;
}

function vlEseguibile(file, version = '0.5.0') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then printf "vl ${version}\\n"; fi\nexit 0\n`, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}

function vlNative(extra = {}) {
  return { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard', ...extra };
}

// --- il verdetto di configured -----------------------------------------------

test('vlBinary valido: il verdetto e\' "configurato" SENZA vl nel PATH', () => {
  const home = homeSenzaVl();
  try {
    const bin = vlEseguibile(path.join(home, 'opt', 'vl-0.5'));
    const info = describeManaged(vlNative({ vlBinary: bin }), { home, platform: 'linux', env: {} });
    assert.equal(info.configured, true, `motivo: ${info.reason}`);
    assert.equal(info.reason, 'ready');
    assert.equal(info.binary, fs.realpathSync(bin), 'il binario dichiarato e\' quello che governa');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('vlBinary valido: il binario dichiarato vince sul vl presente nel PATH', () => {
  const home = homeSenzaVl();
  try {
    const nelPath = vlEseguibile(path.join(home, '.local', 'bin', 'vl'), '0.4.0');
    const dichiarato = vlEseguibile(path.join(home, 'opt', 'vl-0.5'), '0.5.0');
    const info = describeManaged(vlNative({ vlBinary: dichiarato }), { home, platform: 'linux', env: {} });
    assert.equal(info.configured, true, `motivo: ${info.reason}`);
    assert.equal(info.binary, fs.realpathSync(dichiarato), 'vince il dichiarato, non il PATH');
    assert.notEqual(info.binary, fs.realpathSync(nelPath));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('vlBinary assente: il PATH comanda come prima (nessun regresso)', () => {
  const home = homeSenzaVl();
  try {
    const nelPath = vlEseguibile(path.join(home, '.local', 'bin', 'vl'));
    const info = describeManaged(vlNative(), { home, platform: 'linux', env: {} });
    assert.equal(info.configured, true, `motivo: ${info.reason}`);
    assert.equal(info.binary, fs.realpathSync(nelPath));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// --- il rifiuto dichiarato: MAI ripiego sul PATH ------------------------------

test('vlBinary inesistente: rifiuto DICHIARATO, MAI ripiego sul PATH', () => {
  const home = homeSenzaVl();
  try {
    // vl nel PATH: il ripiego ci sarebbe, e deve NON accadere.
    vlEseguibile(path.join(home, '.local', 'bin', 'vl'));
    const mancante = path.join(home, 'opt', 'vl-che-non-esiste');
    const info = describeManaged(vlNative({ vlBinary: mancante }), { home, platform: 'linux', env: {} });
    assert.equal(info.configured, false, 'un binario dichiarato rotto non e\' "configurato"');
    assert.match(info.reason, /vlBinary/, 'il motivo nomina il campo');
    assert.match(info.reason, /nessun ripiego sul PATH/, 'il motivo dichiara l\'assenza di ripiego');
    assert.equal(info.binary, '', 'nessun binario esposto: la UI non puo\' credere al PATH');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('vlBinary non eseguibile: rifiuto DICHIARATO', () => {
  const home = homeSenzaVl();
  try {
    vlEseguibile(path.join(home, '.local', 'bin', 'vl'));
    const file = path.join(home, 'opt', 'vl-non-eseguibile');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'non eseguibile\n', { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    const info = describeManaged(vlNative({ vlBinary: file }), { home, platform: 'linux', env: {} });
    assert.equal(info.configured, false);
    assert.match(info.reason, /non eseguibile/);
    assert.equal(info.binary, '');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('vlBinary che non e\' un file regolare (directory): rifiuto DICHIARATO', () => {
  const home = homeSenzaVl();
  try {
    vlEseguibile(path.join(home, '.local', 'bin', 'vl'));
    const dir = path.join(home, 'opt', 'vl-dir');
    fs.mkdirSync(dir, { recursive: true });
    const info = describeManaged(vlNative({ vlBinary: dir }), { home, platform: 'linux', env: {} });
    assert.equal(info.configured, false);
    assert.match(info.reason, /file regolare/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// --- il lancio: stesso binario per verdetto, probe e spawn -------------------

test('lancio: con vlBinary dichiarato e nessun vl nel PATH, la cella PARTE', () => {
  const home = homeSenzaVl();
  try {
    const bin = vlEseguibile(path.join(home, 'opt', 'vl-0.5'));
    const r = resolveManagedEngine({ id: 'vl.native', managed: vlNative({ vlBinary: bin }) },
      { id: 'CellaProva' }, { home, platform: 'linux', env: {}, vlVersionProbe: PROBE('0.5.0') });
    assert.equal(r.ok, true, `motivo: ${r.reason}`);
    assert.equal(r.engine.command, fs.realpathSync(bin), 'lo spawn usa il binario dichiarato');
    assert.equal(r.engine.clientBinary, fs.realpathSync(bin));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('lancio: il probe di versione interroga il binario DICHIARATO', () => {
  const home = homeSenzaVl();
  try {
    const bin = vlEseguibile(path.join(home, 'opt', 'vl-0.5'));
    const interrogati = [];
    const r = resolveManagedEngine({ id: 'vl.native', managed: vlNative({ vlBinary: bin }) },
      { id: 'CellaProva' }, {
        home, platform: 'linux', env: {},
        vlVersionProbe: (b) => { interrogati.push(b); return 'vl 0.5.0\n'; },
      });
    assert.equal(r.ok, true, `motivo: ${r.reason}`);
    assert.ok(interrogati.length > 0, 'il probe e\' stato eseguito');
    for (const b of interrogati) {
      assert.equal(b, fs.realpathSync(bin), 'ogni gate interroga lo stesso binario che verra\' lanciato');
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('lancio: vlBinary rotto blocca il lancio con il motivo dichiarato', () => {
  const home = homeSenzaVl();
  try {
    vlEseguibile(path.join(home, '.local', 'bin', 'vl'));
    const mancante = path.join(home, 'opt', 'vl-che-non-esiste');
    const r = resolveManagedEngine({ id: 'vl.native', managed: vlNative({ vlBinary: mancante }) },
      { id: 'CellaProva' }, { home, platform: 'linux', env: {}, vlVersionProbe: PROBE('0.5.0') });
    assert.equal(r.ok, false, 'la cella non parte con un binario dichiarato rotto');
    assert.match(r.reason, /vlBinary/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// --- il percorso con spazi: legale, risolto, mai quotato ---------------------

test('vlBinary con spazi nel path: risolto e usato (argv separato, niente shell)', () => {
  const home = homeSenzaVl();
  try {
    const bin = vlEseguibile(path.join(home, 'opt', 'vl release 0.5', 'vl'));
    const info = describeManaged(vlNative({ vlBinary: bin }), { home, platform: 'linux', env: {} });
    assert.equal(info.configured, true, `motivo: ${info.reason}`);
    assert.equal(info.binary, fs.realpathSync(bin));
    const r = resolveManagedEngine({ id: 'vl.native', managed: vlNative({ vlBinary: bin }) },
      { id: 'CellaProva' }, { home, platform: 'linux', env: {}, vlVersionProbe: PROBE('0.5.0') });
    assert.equal(r.ok, true, `motivo: ${r.reason}`);
    assert.equal(r.engine.command, fs.realpathSync(bin), 'lo spazio non spezza il comando');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// --- il symlink: risolto in modo COERENTE per probe e lancio -----------------

test('vlBinary che e\' un symlink: risolto una volta sola, probe e spawn coincidono', () => {
  const home = homeSenzaVl();
  try {
    const reale = vlEseguibile(path.join(home, 'opt', 'vl-reale'));
    const link = path.join(home, 'opt', 'vl-link');
    fs.symlinkSync(reale, link);
    const info = describeManaged(vlNative({ vlBinary: link }), { home, platform: 'linux', env: {} });
    assert.equal(info.configured, true, `motivo: ${info.reason}`);
    assert.equal(info.binary, fs.realpathSync(link), 'il symlink si risolve una volta sola');
    const r = resolveManagedEngine({ id: 'vl.native', managed: vlNative({ vlBinary: link }) },
      { id: 'CellaProva' }, { home, platform: 'linux', env: {}, vlVersionProbe: PROBE('0.5.0') });
    assert.equal(r.ok, true, `motivo: ${r.reason}`);
    assert.equal(r.engine.command, fs.realpathSync(reale), 'lo spawn e\' il file reale, come il probe');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// --- l'helper: un solo contratto per tutti ----------------------------------

test('resolveVlBinary: verdetto unico per esistente / inesistente / non eseguibile', () => {
  const home = homeSenzaVl();
  try {
    const ok = vlEseguibile(path.join(home, 'opt', 'vl-ok'));
    const r = resolveVlBinary(ok);
    assert.equal(r.ok, true);
    assert.equal(r.resolved, fs.realpathSync(ok));

    const mancante = resolveVlBinary(path.join(home, 'opt', 'vl-assente'));
    assert.equal(mancante.ok, false);
    assert.match(mancante.reason, /nessun ripiego sul PATH/);

    const nonExec = path.join(home, 'opt', 'vl-noexec');
    fs.writeFileSync(nonExec, 'x\n', { mode: 0o644 });
    fs.chmodSync(nonExec, 0o644);
    const r2 = resolveVlBinary(nonExec);
    assert.equal(r2.ok, false);
    assert.match(r2.reason, /non eseguibile/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
