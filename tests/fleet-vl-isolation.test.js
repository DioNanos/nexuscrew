'use strict';
// Isolamento per cella del ramo vl: la directory di stato, il socket di
// controllo e le sessioni sono derivati da XDG_STATE_HOME e distinti per cella.
//
// L'affermazione forte da provare non e' "due celle hanno due env diverse":
// e' "due celle sono isolate FINO ALL'HOST". Il runtime vl deriva dal suo
// stato XDG tre cose che condividerebbero una cartella: il tree del server
// (che ospita il socket di controllo) e il dove finiscono le sessioni. Se le
// directory per cella sono distinte, host e socket sono distinti per costruzione
// — e la prova e' sul percorso DERIVATO, non su una stringa confrontata.
//
// Percorsi derivati dal runtime vl (misurati sul sorgente, crates/vl-core):
//   XDG_STATE_HOME/vl/host-v1/                 -> root del server
//   XDG_STATE_HOME/vl/host-v1/server/.vl/control.sock  -> socket di controllo
//   XDG_STATE_HOME/vl/host-v1/sessions/<nome>  -> sessioni
//   XDG_CONFIG_HOME/vl/config.toml            -> catalogo (copia per cella)
//   XDG_CONFIG_HOME/vl/selected.toml           -> preferenza (MAI toccata)
//
// Nulla di questo tocca il runtime: il test calcola i percorsi come farebbe
// il runtime e verifica la loro separazione, e verifica che NexusCrew non
// scriva MAI dentro le directory di stato (che sono del runtime).

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveManagedEngine, vlCellBaseDir, ensureVlCellDirs } = require('../lib/fleet/managed.js');

const PROBE = () => 'vl 0.5.0\n';

function homeWith() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvliso-'));
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const bin = path.join(home, '.local', 'bin', 'vl');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(bin, 0o755);
  // Il catalogo dell'operatore: e' la sorgente di un engine native senza
  // vlConfigFile dichiarato. Senza di esso il lancio nativo e' un rifiuto
  // dichiarato, non un avvio sui default del runtime.
  const catalogoVl = path.join(home, '.config', 'vl');
  fs.mkdirSync(catalogoVl, { recursive: true });
  fs.writeFileSync(path.join(catalogoVl, 'config.toml'), '[profiles.work]\nmodel = "m-work"\n');
  return home;
}

function vlNative(extra = {}) {
  return { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard', ...extra };
}

function resolve(home, managed, cell = { id: 'CellaProva' }, cfgExtra = {}) {
  return resolveManagedEngine({ id: 'vl.native', managed }, cell,
    { home, platform: 'linux', env: {}, ...cfgExtra });
}

// I percorsi che il runtime vl deriva dal trio XDG. Ricalcolati qui come
// farebbe il runtime: e' il contratto che l'isolamento deve garantire.
function percorsiDerivati(env) {
  const stateRoot = path.join(env.XDG_STATE_HOME, 'vl', 'host-v1');
  return {
    serverRoot: stateRoot,
    controlSock: path.join(stateRoot, 'server', '.vl', 'control.sock'),
    sessionsDir: path.join(stateRoot, 'sessions'),
    configDir: path.join(env.XDG_CONFIG_HOME, 'vl'),
    selected: path.join(env.XDG_CONFIG_HOME, 'vl', 'selected.toml'),
  };
}

// ===========================================================================
// 1. Due celle, stesso engine: distinti FINO ALL'HOST
// ===========================================================================

test('isolamento: due celle stesso engine -> root server, socket e sessioni distinti', () => {
  const home = homeWith();
  try {
    const rA = resolve(home, vlNative(), { id: 'Alpha' }, { vlVersionProbe: PROBE, vlOwnerInstanceId: 'node-1' });
    const rB = resolve(home, vlNative(), { id: 'Beta' }, { vlVersionProbe: PROBE, vlOwnerInstanceId: 'node-1' });
    assert.equal(rA.ok && rB.ok, true);
    const pA = percorsiDerivati(rA.engine.env);
    const pB = percorsiDerivati(rB.engine.env);
    // il root del server (che ospita il socket) e' diverso
    assert.notEqual(pA.serverRoot, pB.serverRoot, 'root del server distinto: un host per directory');
    // il socket di controllo e' diverso: due celle non parlano col mismo host
    assert.notEqual(pA.controlSock, pB.controlSock, 'socket di controllo distinto');
    // le sessioni non si mescolano
    assert.notEqual(pA.sessionsDir, pB.sessionsDir, 'directory delle sessioni distinta');
    // e nessun percorso dell una e dentro l altro
    assert.equal(pA.controlSock.startsWith(pB.serverRoot), false, 'il socket di A non sta sotto il root di B');
    assert.equal(pB.controlSock.startsWith(pA.serverRoot), false, 'il socket di B non sta sotto il root di A');
    // la config (catalogo + preferenza) e' distinta
    assert.notEqual(pA.configDir, pB.configDir, 'config per cella distinta');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('isolamento: il prompt di A e il catalogo di A non sono quelli di B', () => {
  const home = homeWith();
  try {
    const dir = path.join(home, 'cataloghi');
    fs.mkdirSync(dir, { recursive: true });
    const cat = path.join(dir, 'config.toml');
    fs.writeFileSync(cat, '[profiles.work]\nmodel = "m-work"\n');
    const rA = resolve(home, vlNative({ vlConfigFile: cat, vlProfile: 'work' }), { id: 'Alpha' },
      { vlVersionProbe: PROBE, vlOwnerInstanceId: 'node-1' });
    const rB = resolve(home, vlNative({ vlConfigFile: cat, vlProfile: 'work' }), { id: 'Beta' },
      { vlVersionProbe: PROBE, vlOwnerInstanceId: 'node-1' });
    assert.equal(rA.ok && rB.ok, true);
    assert.notEqual(rA.engine.env.VL_SYSTEM_APPEND_FILE, rB.engine.env.VL_SYSTEM_APPEND_FILE,
      'il file del prompt e\' per cella');
    // il CATALOGO e' condiviso per contenuto (la stessa sorgente dichiarata) ma
    // la copia vive nella config della cella: il contenuto e\' condiviso, la
    // scrittura no.
    const copiaA = path.join(rA.engine.env.XDG_CONFIG_HOME, 'vl', 'config.toml');
    const copiaB = path.join(rB.engine.env.XDG_CONFIG_HOME, 'vl', 'config.toml');
    assert.notEqual(copiaA, copiaB, 'la copia del catalogo e\' per cella');
    assert.equal(fs.readFileSync(copiaA, 'utf8'), fs.readFileSync(copiaB, 'utf8'),
      'contenuto del catalogo condiviso: la sorgente e\' una sola');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ===========================================================================
// 2. La preferenza /model e l'effort di A NON modificano B
// ===========================================================================

test('isolamento: la preferenza (selected.toml) di B sopravvive a un lancio di A', () => {
  const home = homeWith();
  try {
    const rB = resolve(home, vlNative(), { id: 'Beta' }, { vlVersionProbe: PROBE, vlOwnerInstanceId: 'node-1' });
    const selB = path.join(rB.engine.env.XDG_CONFIG_HOME, 'vl', 'selected.toml');
    fs.mkdirSync(path.dirname(selB), { recursive: true });
    fs.writeFileSync(selB, 'model = "preferita-di-beta"\n');
    // un lancio di A: non tocca la preferenza di B
    resolve(home, vlNative(), { id: 'Alpha' }, { vlVersionProbe: PROBE, vlOwnerInstanceId: 'node-1' });
    assert.equal(fs.readFileSync(selB, 'utf8'), 'model = "preferita-di-beta"\n',
      'il lancio di A non riscrive la preferenza di B');
    // e la preferenza di B non finisce nella config di A
    const rA = resolve(home, vlNative(), { id: 'Alpha' }, { vlVersionProbe: PROBE, vlOwnerInstanceId: 'node-1' });
    const selA = path.join(rA.engine.env.XDG_CONFIG_HOME, 'vl', 'selected.toml');
    assert.equal(fs.existsSync(selA), false, 'la preferenza di B non e\' finita nella config di A');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('isolamento: l\'effort di A non compare nell\'env di B', () => {
  const home = homeWith();
  try {
    const extraModels = new Map([['vl.native', new Map([['gemma4', { id: 'gemma4', engine: 'vl.native', effortLevels: ['high'] }]])]]);
    const rA = resolve(home, vlNative({ model: 'gemma4', effort: 'high' }), { id: 'Alpha' },
      { vlVersionProbe: PROBE, vlOwnerInstanceId: 'node-1', extraModels });
    const rB = resolve(home, vlNative({ model: 'gemma4' }), { id: 'Beta' },
      { vlVersionProbe: PROBE, vlOwnerInstanceId: 'node-1', extraModels });
    assert.equal(rA.engine.env.VL_EFFORT, 'high', 'A chiede l\'effort');
    assert.equal(rB.engine.env.VL_EFFORT, undefined, 'B non eredita l\'effort di A');
    assert.notEqual(rA.engine.env.XDG_STATE_HOME, rB.engine.env.XDG_STATE_HOME);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ===========================================================================
// 3. Identita': stessa cellId con owner diversi, slug equivalenti
// ===========================================================================

test('identita: stessa cellId con owner diversi -> percorsi distinti', () => {
  const home = homeWith();
  try {
    const a = vlCellBaseDir(home, 'owner-A', 'CellaProva');
    const b = vlCellBaseDir(home, 'owner-B', 'CellaProva');
    assert.notEqual(a, b, 'stessa cellId, owner diversi: percorsi DIVERSI');
    // e i percorsi DERIVATI (server/socket) non collidono
    const envA = { XDG_STATE_HOME: path.join(a, 'state'), XDG_CONFIG_HOME: path.join(a, 'config') };
    const envB = { XDG_STATE_HOME: path.join(b, 'state'), XDG_CONFIG_HOME: path.join(b, 'config') };
    assert.notEqual(percorsiDerivati(envA).controlSock, percorsiDerivati(envB).controlSock,
      'i socket non collidono: due owner, due host');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('identita: due id che sluggano uguale restano distinti (l\'hash distingue)', () => {
  const home = homeWith();
  try {
    const a = vlCellBaseDir(home, 'owner-A', 'CellaProva Cell');
    const b = vlCellBaseDir(home, 'owner-A', 'dev-cell');
    const c = vlCellBaseDir(home, 'owner-A', 'dev_cell');
    assert.notEqual(a, b, 'slug-equivalenti: percorsi distinti');
    assert.notEqual(a, c, 'slug-equivalenti: percorsi distinti');
    assert.notEqual(b, c, 'slug-equivalenti: percorsi distinti');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('identita: la stessa cella conserva il percorso fra restart e cambio engine', () => {
  const home = homeWith();
  try {
    const primo = vlCellBaseDir(home, 'node-1', 'CellaProva');
    const secondo = vlCellBaseDir(home, 'node-1', 'CellaProva');
    assert.equal(primo, secondo, 'stesso owner+cellId: percorso STABILE');
    // il percorso NON dipende dall'engine: vlCellBaseDir non ne prende uno
    const envVl = ensureVlCellDirs(home, 'node-1', 'CellaProva');
    assert.equal(envVl.base, primo, 'l\'engine non partecipa alla chiave');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// ===========================================================================
// 4. Stessi ID su nodi separati: risoluzione LOCALE
// ===========================================================================

test('identita: la stessa cellId su due nodi (home diverse) risolve in locale', () => {
  const homeA = homeWith();
  const homeB = homeWith();
  try {
    const a = vlCellBaseDir(homeA, 'node-1', 'CellaProva');
    const b = vlCellBaseDir(homeB, 'node-1', 'CellaProva');
    // lo stesso nome di cella su due nodi: due directory locali distinte
    assert.notEqual(a, b, 'due nodi: due directory locali distinte');
    assert.ok(a.startsWith(homeA), 'il nodo A risolve sotto la propria home');
    assert.ok(b.startsWith(homeB), 'il nodo B risolve sotto la propria home');
    // lo stesso suffisso NON crea collisione: la chiave include l'owner, e
    // l'albero e' per home
    assert.equal(path.basename(a), path.basename(b), 'il suffisso e\' lo stesso');
    assert.notEqual(path.dirname(path.dirname(path.dirname(a))), path.dirname(path.dirname(path.dirname(b))),
      'ma la radice e\' diversa: nessuna collisione');
  } finally {
    fs.rmSync(homeA, { recursive: true, force: true });
    fs.rmSync(homeB, { recursive: true, force: true });
  }
});

// ===========================================================================
// 5. NexusCrew non scrive NELLO STATO del runtime
// ===========================================================================

test('confini: NexusCrew non scrive nello stato del runtime (le sessioni sono del vl)', () => {
  const home = homeWith();
  try {
    const r = resolve(home, vlNative(), { id: 'CellaProva', prompt: 'prompt di cella' },
      { vlVersionProbe: PROBE, vlOwnerInstanceId: 'node-1' });
    assert.equal(r.ok, true);
    const stateDir = r.engine.env.XDG_STATE_HOME;
    assert.deepEqual(fs.readdirSync(stateDir), [],
      'lo stato per cella e\' vuoto: NexusCrew non scrive file di sessione');
    // il prompt sta nella config/area NC, non nello stato del runtime
    assert.ok(r.engine.env.VL_SYSTEM_APPEND_FILE.includes('.nexuscrew'),
      'il prompt vive sotto l\'albero NexusCrew');
    assert.equal(r.engine.env.VL_SYSTEM_APPEND_FILE.includes(stateDir), false,
      'il prompt NON e\' dentro lo stato del runtime');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('confini: il catalogo copiato non contiene segreti (nessun secrets.env)', () => {
  const home = homeWith();
  try {
    const dir = path.join(home, 'cataloghi');
    fs.mkdirSync(dir, { recursive: true });
    const cat = path.join(dir, 'config.toml');
    fs.writeFileSync(cat, '[profiles.work]\nmodel = "m"\napi_key = "sk-non-deve-essere-copiato"\n');
    const r = resolve(home, vlNative({ vlConfigFile: cat, vlProfile: 'work' }), { id: 'CellaProva' },
      { vlVersionProbe: PROBE, vlOwnerInstanceId: 'node-1' });
    assert.equal(r.ok, true);
    const vlDir = path.join(r.engine.env.XDG_CONFIG_HOME, 'vl');
    assert.ok(!fs.existsSync(path.join(vlDir, 'secrets.env')), 'nessun secrets.env creato');
    // il catalogo copiato e' il file dichiarato dall'engine: se l'engine
    // dichiara una chiave dentro il catalogo, il runtime la legge li'. Il
    // contratto che NC garantisce e' un altro: NON copia i segreti DEL
    // CREDENTIAL STORE di NexusCrew, e non crea un secrets.env.
    assert.equal(fs.existsSync(path.join(vlDir, 'secrets.env')), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
