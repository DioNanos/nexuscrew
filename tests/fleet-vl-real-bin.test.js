'use strict';
// Integrazione con il binario VL reale congelato (auditor, prova minima 5).
//
// Usa /home/dag/.local/bin/vl-0.4-bin con il probe di versione REALE (nessun
// seam iniettato): resolveManagedEngine lancia spawnSync <binario> --version,
// che esce subito. Il TUI non parte MAI in questi test: si verifica la
// composizione di argv/env, il gate del prompt, la copia del catalogo, la
// neutralizzazione profilo e l'isolamento fino all'host — tutto cio' che si
// decide PRIMA dello spawn, eseguito contro la versione vera del binario.
//
// Effort: il binario reale e' 0.4.0 (< 0.5.0, VL_EFFORT_MIN), cosi' il gate
// effort che legge la versione REALE rifiuta dichiarato — prova che il gate
// interroga il binario scelto e non un valore cablato. Il caso effort ammesso
// (0.5.0) si prova con un binario finto, come da mandato (lo strato 2 di VL
// non e' ancora rilasciato).
//
// Skip graceful se il binario reale non e' presente (macchina di CI diversa).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  resolveManagedEngine, vlEffortGate, vlSystemAppendGate, vlEffortMinVersion,
} = require('../lib/fleet/managed.js');

const REAL_BIN = '/home/dag/.local/bin/vl-0.4-bin';
const haveRealBin = fs.existsSync(REAL_BIN) && fs.statSync(REAL_BIN).isFile();

function realVersion() {
  if (!haveRealBin) return null;
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(REAL_BIN, ['--version'], { encoding: 'utf8', timeout: 3000 });
  if (r.status !== 0 || r.error) return null;
  const m = String(r.stdout || '').match(/\bvl\s+(\d+)\.(\d+)\.(\d+)/i);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function homeWith() {
  // Come fleet-vl-fields.test.js: un vl nel PATH rende il verdetto `configured`
  // vero (il gate di configured guarda findBinary); vlBinary dichiarato fa
  // poi l'override di info.binary per probe E spawn, cosi' il binario reale e'
  // quello interrogato. Il vl finto non viene mai lanciato.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlreal-'));
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const bin = path.join(home, '.local', 'bin', 'vl');
  fs.writeFileSync(bin, '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "vl 0.4.0\\n"; fi\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(bin, 0o755);
  return home;
}

function catalogWith(home, profiles) {
  const dir = path.join(home, 'cataloghi');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.toml');
  const corpo = profiles.map((n) => `[profiles.${n}]\nmodel = "m-${n}"\n`).join('\n');
  fs.writeFileSync(file, `# catalogo di prova reale\n${corpo}`);
  return file;
}

function vlNative(extra = {}) {
  return { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard', ...extra };
}

function resolve(home, managed, cell = { id: 'Dev' }, cfgExtra = {}, engineId = 'vl.native') {
  return resolveManagedEngine({ id: engineId, managed }, cell, { home, platform: 'linux', env: {}, ...cfgExtra });
}

// --- presenza --------------------------------------------------------------

test('binario reale: presente e probe --version risponde (altrimenti skip)', () => {
  if (!haveRealBin) {
    assert.ok(true, 'binario reale assente su questo nodo: test di integrazione saltati');
    return;
  }
  const v = realVersion();
  assert.ok(v, 'il binario reale risponde a --version');
  assert.deepEqual(v, [0, 4, 0], `versione attesa 0.4.0, avuta ${v ? v.join('.') : 'null'}`);
});

// --- probe reale attraverso resolveManagedEngine ----------------------------

test('real probe: resolve con vlBinary reale usa il REALPATH per probe E spawn; nessun seam', () => {
  if (!haveRealBin) return;
  const home = homeWith();
  try {
    // NESSUN vlVersionProbe iniettato: il gate lancia spawnSync sul binario vero.
    const r = resolve(home, vlNative({ vlBinary: REAL_BIN }), { id: 'Dev' }, { vlOwnerInstanceId: 'node-1' });
    assert.equal(r.ok, true, 'resolve ammesso con il binario reale');
    assert.equal(r.info.binary, fs.realpathSync(REAL_BIN), 'info.binary e il realpath del binario reale');
    assert.equal(r.engine.command, fs.realpathSync(REAL_BIN), 'il comando di lancio e lo stesso file');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// --- gate prompt: 0.4.0 >= 0.3.1 -> prompt consegnato ----------------------

test('real gate prompt: 0.4.0 >= 0.3.1 -> VL_SYSTEM_APPEND_FILE composta e file scritto', () => {
  if (!haveRealBin) return;
  const home = homeWith();
  try {
    const r = resolve(home, vlNative({ vlBinary: REAL_BIN }), { id: 'Dev', prompt: 'prompt di cella reale' },
      { vlOwnerInstanceId: 'node-1' });
    assert.equal(r.ok, true);
    assert.ok(r.engine.env.VL_SYSTEM_APPEND_FILE, 'il prompt viaggia sul file per cella');
    assert.ok(fs.existsSync(r.engine.env.VL_SYSTEM_APPEND_FILE), 'il file del prompt e stato scritto');
    // il gate diretto contro il binario reale: ok
    const gate = vlSystemAppendGate(fs.realpathSync(REAL_BIN), {});
    assert.equal(gate.ok, true, 'vlSystemAppendGate: 0.4.0 ammette VL_SYSTEM_APPEND_FILE');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// --- profile mode con binario reale: catalogo copiato, -p, env neutralizzato -

test('real profile: catalogo copiato 0600, -p <nome>, provider/base/model neutralizzati', () => {
  if (!haveRealBin) return;
  const home = homeWith();
  try {
    const cat = catalogWith(home, ['work']);
    const r = resolve(home, vlNative({ vlBinary: REAL_BIN, vlConfigFile: cat, vlProfile: 'work' }),
      { id: 'Dev' }, { vlOwnerInstanceId: 'node-1' });
    assert.equal(r.ok, true);
    assert.deepEqual(r.engine.args, ['-p', 'work'], 'profilo come argomento unico');
    for (const name of ['VL_PROVIDER', 'VL_BASE_URL', 'VL_MODEL', 'VL_EFFORT']) {
      assert.equal(r.engine.env[name], undefined, `${name} neutralizzato in modalita profilo`);
    }
    // la copia del catalogo nella cella e identica al sorgente, 0600
    const copia = path.join(r.engine.env.XDG_CONFIG_HOME, 'vl', 'config.toml');
    assert.equal(fs.readFileSync(copia, 'utf8'), fs.readFileSync(cat, 'utf8'));
    assert.equal((fs.statSync(copia).mode & 0o777), 0o600);
    assert.ok(!fs.existsSync(path.join(r.engine.env.XDG_CONFIG_HOME, 'vl', 'secrets.env')), 'nessun segreto copiato');
    // diagnostica con il binario reale risolto
    assert.equal(r.info.vlRuntime.binary, fs.realpathSync(REAL_BIN));
    assert.equal(r.info.vlRuntime.profile, 'work');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// --- isolamento: due celle, binario reale, trii XDG e cataloghi distinti ----

test('real isolation: due celle stesso engine -> trii XDG, prompt e cataloghi distinti', () => {
  if (!haveRealBin) return;
  const home = homeWith();
  try {
    const cat = catalogWith(home, ['work']);
    const r1 = resolve(home, vlNative({ vlBinary: REAL_BIN, vlConfigFile: cat, vlProfile: 'work' }),
      { id: 'Alpha' }, { vlOwnerInstanceId: 'node-1' });
    const r2 = resolve(home, vlNative({ vlBinary: REAL_BIN, vlConfigFile: cat, vlProfile: 'work' }),
      { id: 'Beta' }, { vlOwnerInstanceId: 'node-1' });
    assert.equal(r1.ok && r2.ok, true);
    assert.notEqual(r1.engine.env.XDG_STATE_HOME, r2.engine.env.XDG_STATE_HOME, 'stato per cella distinto');
    assert.notEqual(r1.engine.env.XDG_CONFIG_HOME, r2.engine.env.XDG_CONFIG_HOME);
    assert.notEqual(r1.engine.env.VL_SYSTEM_APPEND_FILE, r2.engine.env.VL_SYSTEM_APPEND_FILE, 'prompt file per cella');
    // il catalogo di A e B e in directory config distinte (ciascuno la sua copia)
    assert.notEqual(path.join(r1.engine.env.XDG_CONFIG_HOME, 'vl', 'config.toml'),
      path.join(r2.engine.env.XDG_CONFIG_HOME, 'vl', 'config.toml'));
    // la preferenza scritta da B non e' toccata da un rilancio di A
    const selectedB = path.join(r2.engine.env.XDG_CONFIG_HOME, 'vl', 'selected.toml');
    fs.mkdirSync(path.dirname(selectedB), { recursive: true });
    fs.writeFileSync(selectedB, 'model = "preferita-beta"\n');
    resolve(home, vlNative({ vlBinary: REAL_BIN, vlConfigFile: cat, vlProfile: 'work' }),
      { id: 'Alpha' }, { vlOwnerInstanceId: 'node-1' });
    assert.equal(fs.readFileSync(selectedB, 'utf8'), 'model = "preferita-beta"\n', 'A non riscrive selected.toml di B');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// --- effort gate contro la versione REALE: 0.4.0 rifiuta (< 0.5.0) ----------

test('real effort gate: il binario reale 0.4.0 < VL_EFFORT_MIN -> effort RIFIUTATO dal gate reale', () => {
  if (!haveRealBin) return;
  const v = realVersion();
  assert.deepEqual(vlEffortMinVersion(), [0, 5, 0]);
  // il gate diretto legge la versione REALE del binario scelto
  const gate = vlEffortGate(fs.realpathSync(REAL_BIN), {});
  assert.equal(gate.ok, false, '0.4.0 non legge VL_EFFORT: il gate rifiuta invece di ignorare');
  assert.match(gate.reason, /0\.4\.0/);
  assert.match(gate.reason, /0\.5\.0/);
  // e lo rifiuta anche nel resolve (con modello che dichiara effortLevels):
  // la cella NON parte con un effort che il runtime ignorerebbe in silenzio
  const home = homeWith();
  try {
    const extraModels = new Map([['vl.native', new Map([['gemma4', { id: 'gemma4', engine: 'vl.native', effortLevels: ['high'] }]])]]);
    const r = resolve(home, vlNative({ vlBinary: REAL_BIN, model: 'gemma4', effort: 'high' }),
      { id: 'Dev' }, { vlOwnerInstanceId: 'node-1', extraModels });
    assert.equal(r.ok, false, 'resolve: effort non promettibile dal binario reale -> avvio rifiutato');
    assert.match(r.reason, /VL_EFFORT/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// --- effort ammesso: binario finto 0.5.0 (strato 2 non rilasciato) -----------

test('effort ammesso: binario finto 0.5.0 (>= VL_EFFORT_MIN) -> VL_EFFORT composta', () => {
  // Lo strato 2 di VL (lettura di VL_EFFORT) non e' ancora rilasciato: il
  // binario reale e' 0.4.0. Il caso ammesso si prova con un binario finto
  // 0.5.0, come da mandato: il gate e' lo stesso, cambia solo la versione.
  const home = homeWith();
  try {
    const fake = path.join(home, 'vl-fake-050');
    fs.writeFileSync(fake, '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "vl 0.5.0\\n"; fi\nexit 0\n', { mode: 0o755 });
    fs.chmodSync(fake, 0o755);
    const extraModels = new Map([['vl.native', new Map([['gemma4', { id: 'gemma4', engine: 'vl.native', effortLevels: ['high'] }]])]]);
    const r = resolve(home, vlNative({ vlBinary: fake, model: 'gemma4', effort: 'high' }),
      { id: 'Dev' }, { vlOwnerInstanceId: 'node-1', extraModels });
    assert.equal(r.ok, true, 'binario 0.5.0: effort promettibile -> avvio ammesso');
    assert.equal(r.engine.env.VL_EFFORT, 'high', 'VL_EFFORT composta solo se promettibile');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// --- probe e spawn usano lo STESSO binario reale (req 3) --------------------

test('real same-binary: probe e spawn puntano lo stesso realpath (nessun ripiego PATH)', () => {
  if (!haveRealBin) return;
  const home = homeWith();
  try {
    const r = resolve(home, vlNative({ vlBinary: REAL_BIN }), { id: 'Dev' }, { vlOwnerInstanceId: 'node-1' });
    assert.equal(r.info.binary, r.engine.command, 'il binario provato e quello lanciato sono lo stesso file');
    assert.equal(r.info.binary, fs.realpathSync(REAL_BIN));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});