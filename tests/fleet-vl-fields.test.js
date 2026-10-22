'use strict';
// Matrice argv/env del ramo vl (campi vlBinary/vlConfigFile/vlProfile/effort
// + varianti + neutralizzazione) e launcher finto che REGISTRA argv/env
// redatti attraverso lo spawn REALE del supervisore (cell-exec).
//
// La matrice copre: native/custom/anthropic ×
// con/senza profilo/modello/effort, env ambientali ostili, envPassthrough che
// reintroduce nomi VL_*, path binario con spazi, binario inesistente/non
// eseguibile/vecchio, profilo mancante, effort non dichiarato/non supportato.
// Nessun valore segreto e' mai atteso su argv; i valori di test marcati
// segreti (sk-...) devono risultare REDATTI nel registro del launcher finto.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  normalizeManagedSpec, resolveManagedEngine, vlCellBaseDir, ensureVlCellDirs,
  resolveVlBinary, vlEffortGate, vlEffortMinVersion, writeVlCellCatalog, vlCatalogProfiles,
} = require('../lib/fleet/managed.js');
const { main } = require('../lib/fleet/cell-exec.js');

const PROBE = (v) => () => `vl ${v}\n`;

function homeWith(opts = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlfld-'));
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const bin = path.join(home, '.local', 'bin', 'vl');
  fs.writeFileSync(bin, '#!/bin/sh\nif [ "$1" = "--version" ]; then printf "vl 0.5.0\\n"; fi\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(bin, 0o755);
  // Il catalogo dell'operatore: e' la sorgente di un engine native senza
  // vlConfigFile dichiarato. Senza di esso il lancio nativo e' un rifiuto
  // dichiarato, non un avvio sui default del runtime.
  if (!opts.senzaCatalogo) {
    const catalogoVl = path.join(home, '.config', 'vl');
    fs.mkdirSync(catalogoVl, { recursive: true });
    fs.writeFileSync(path.join(catalogoVl, 'config.toml'), '[profiles.work]\nmodel = "m-work"\n');
  }
  return home;
}

function catalogWith(home, profiles) {
  const dir = path.join(home, 'cataloghi');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.toml');
  const corpo = profiles.map((n) => `[profiles.${n}]\nmodel = "m-${n}"\n`).join('\n');
  fs.writeFileSync(file, `# catalogo di prova\n${corpo}`);
  return file;
}

function resolve(home, managed, cell = { id: 'CellaProva' }, cfgExtra = {}, engineId = 'vl.native') {
  const engine = { id: engineId, managed };
  return resolveManagedEngine(engine, cell, { home, platform: 'linux', env: {}, ...cfgExtra });
}

function vlNative(extra = {}) {
  return { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard', ...extra };
}

// --- matrice normalize: campi vl -------------------------------------------

test('normalize: vlBinary/vlConfigFile assoluti e puliti passano; relativi/control rifiutati nominali', () => {
  const base = vlNative({ vlBinary: '/opt/vl/bin/vl', vlConfigFile: '/opt/vl/config.toml' });
  const ok = normalizeManagedSpec(base);
  assert.equal(ok.vlBinary, '/opt/vl/bin/vl');
  assert.equal(ok.vlConfigFile, '/opt/vl/config.toml');
  const conSpazi = normalizeManagedSpec(vlNative({ vlBinary: '/opt/vl dir/bin vl' }));
  assert.equal(conSpazi.vlBinary, '/opt/vl dir/bin vl', 'gli spazi sono leciti: argv separato, nessuna shell');
  let issue = null;
  assert.equal(normalizeManagedSpec(vlNative({ vlBinary: 'vl' })), null, 'relativo rifiutato');
  assert.equal(normalizeManagedSpec(vlNative({ vlBinary: '/x/y' })), null, 'byte di controllo rifiutato');
  // vlProfile senza vlConfigFile: normalize ammette il CAMPO (l'esistenza nel
  // catalogo si verifica sul nodo esecutore, al lancio); il rifiuto esplicito
  // e' provato sotto nel test del lancio
  assert.equal(normalizeManagedSpec(vlNative({ vlProfile: 'work' })).vlProfile, 'work');
  assert.equal(normalizeManagedSpec(vlNative({ vlProfile: 'work', vlConfigFile: '/x/config.toml' })).vlProfile, 'work');
  assert.equal(normalizeManagedSpec(vlNative({ vlProfile: '../evil' })), null, 'token profilo non valido rifiutato');
  normalizeManagedSpec(vlNative({ vlProfile: 'a b' }), { onIssue: (i) => { issue = i; } });
  assert.ok(issue && issue.field === 'vlProfile');
  // campi vl su ALTRO client: errore di configurazione dichiarato, mai no-op
  let crossClient = null;
  normalizeManagedSpec({ client: 'claude', provider: 'native', vlBinary: '/x' }, { onIssue: (i) => { crossClient = i; } });
  assert.ok(crossClient && /solo sul client vl/.test(crossClient.rule), 'campo vl su client non-vl rifiutato');
});

test('normalize: vlProfile rifiutato sulle varianti che compongono provider/base (custom, anthropic)', () => {
  let i1 = null; let i2 = null;
  normalizeManagedSpec({
    client: 'vl', provider: 'custom', displayName: 'X', baseUrl: 'https://x/', protocol: 'openai-compat', model: 'm',
    envKey: '', vlProfile: 'work', vlConfigFile: '/x/config.toml',
  }, { onIssue: (i) => { i1 = i; } });
  assert.ok(i1 && /si escludono/.test(i1.rule), 'custom + profilo: rifiuto esplicito');
  normalizeManagedSpec({ client: 'vl', provider: 'anthropic', vlProfile: 'work', vlConfigFile: '/x/config.toml' },
    { onIssue: (i) => { i2 = i; } });
  assert.ok(i2 && /si escludono/.test(i2.rule), 'anthropic + profilo: rifiuto esplicito');
});

test('normalize: effort solo fra i livelli dichiarati per il modello', () => {
  const extraModels = new Map([['vl.native', new Map([['gemma4', { id: 'gemma4', engine: 'vl.native', effortLevels: ['low', 'high'] }]])]]);
  const ctx = { extraModels, engineId: 'vl.native' };
  assert.equal(normalizeManagedSpec(vlNative({ model: 'gemma4', effort: 'high' }), ctx).effort, 'high');
  assert.equal(normalizeManagedSpec(vlNative({ model: 'gemma4', effort: 'medium' }), ctx), null, 'livello non dichiarato: rifiutato');
  let senza = null;
  normalizeManagedSpec(vlNative({ model: 'gemma4', effort: 'low', vlConfigFile: '/x' }), { extraModels: new Map([['vl.native', new Map([['gemma4', { id: 'gemma4', engine: 'vl.native' }]])]]), onIssue: (i) => { senza = i; } });
  assert.ok(senza && /effortLevels/.test(senza.rule), 'modello senza effortLevels: nessun effort inventato');
});

test('normalize: envPassthrough non porta i nomi VL_* delle scelte engine (precedenza esplicita NC > profilo)', () => {
  let issue = null;
  normalizeManagedSpec(vlNative({ vlConfigFile: '/x', vlProfile: 'w', envPassthrough: ['VL_API_KEY', 'VL_MODEL'] }),
    { onIssue: (i) => { issue = i; } });
  assert.ok(issue && issue.field === 'envPassthrough' && issue.value === 'VL_MODEL',
    'il passthrough che reintroduce la scelta engine si rifiuta alla sorgente');
  assert.equal(normalizeManagedSpec(vlNative()).envPassthrough, undefined,
    'vl.native non dichiara default: senza dichiarazione operatore niente passthrough');
  assert.deepEqual(normalizeManagedSpec(vlNative({ envPassthrough: ['VL_API_KEY'] })).envPassthrough, ['VL_API_KEY'],
    'dichiarazione esplicita senza conflitto: tenuta');
  assert.deepEqual(normalizeManagedSpec({ client: 'vl', provider: 'anthropic' }).envPassthrough, ['VL_API_KEY'],
    'il default VL_API_KEY del profilo anthropic resta legittimo');
});

// --- matrice resolve: argv/env per variante --------------------------------

test('matrice native: nessun campo -> argv vuoto, solo trio XDG; +catalogo -> copia atomica, selected.toml MAI creato', () => {
  const home = homeWith();
  try {
    const r0 = resolve(home, vlNative(), { id: 'CellaProva' }, { vlVersionProbe: PROBE('0.5.0') });
    assert.equal(r0.ok, true);
    assert.deepEqual(r0.engine.args, []);
    assert.equal(r0.engine.env.VL_PROVIDER, undefined);
    assert.equal(r0.engine.env.VL_BASE_URL, undefined);
    const { XDG_STATE_HOME, XDG_DATA_HOME, XDG_CONFIG_HOME } = r0.engine.env;
    assert.ok(XDG_STATE_HOME && XDG_DATA_HOME && XDG_CONFIG_HOME);
    assert.equal(r0.engine.env.VL_SYSTEM_APPEND_FILE, path.join(home, '.nexuscrew', 'vl-prompts', 'CellaProva.md'));

    const cat = catalogWith(home, ['work', 'fast']);
    const r1 = resolve(home, vlNative({ vlConfigFile: cat }), { id: 'CellaProva' }, { vlVersionProbe: PROBE('0.5.0') });
    assert.equal(r1.ok, true);
    const copia = path.join(XDG_CONFIG_HOME, 'vl', 'config.toml');
    assert.equal(fs.readFileSync(copia, 'utf8'), fs.readFileSync(cat, 'utf8'), 'copia identica al catalogo dichiarato');
    assert.equal((fs.statSync(copia).mode & 0o777), 0o600, 'copia 0600');
    assert.ok(!fs.existsSync(path.join(XDG_CONFIG_HOME, 'vl', 'selected.toml')), 'selected.toml non esiste: preferenza di cella mai toccata');
    assert.ok(!fs.existsSync(path.join(XDG_CONFIG_HOME, 'vl', 'secrets.env')), 'nessun segreto copiato');
    // rilancio: la copia si aggiorna al catalogo CORRENTE (politica: a ogni lancio)
    fs.writeFileSync(cat, '# nuovo\n[profiles.solo]\n');
    resolve(home, vlNative({ vlConfigFile: cat }), { id: 'CellaProva' }, { vlVersionProbe: PROBE('0.5.0') });
    assert.match(fs.readFileSync(copia, 'utf8'), /profiles\.solo/, 'il catalogo della cella segue l\'engine');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('matrice native+profilo: -p <nome>, provider/base/model/effort NEUTRALIZZATI (anche via passthrough, anche ostili)', () => {
  const home = homeWith();
  try {
    const cat = catalogWith(home, ['work']);
    const spec = vlNative({ vlConfigFile: cat, vlProfile: 'work' });
    // envPassthrough con nomi leciti + ambient ostile: VL_PROVIDER presente
    // nell'ambiente del processo NON entra nel child (il passthrough lo
    // reintrodurrebbe, ma e' gia' rifiutato in normalize; qui si prova la
    // difesa in profondita' del loop con uno spec costruito a mano)
    const r = resolve(home, spec, { id: 'CellaProva' }, { vlVersionProbe: PROBE('0.5.0') });
    assert.equal(r.ok, true);
    assert.deepEqual(r.engine.args, ['-p', 'work'], 'profilo come argomento unico -p');
    for (const name of ['VL_PROVIDER', 'VL_BASE_URL', 'VL_MODEL', 'VL_EFFORT']) {
      assert.equal(r.engine.env[name], undefined, `${name}: il profilo decide, l'env composta non lo porta`);
    }
    // difesa in profondita': passthrough che reintroduce VL_PROVIDER su spec bypass
    const hostile = { ...spec, envPassthrough: ['VL_API_KEY'] };
    const r2 = resolve(home, hostile, { id: 'CellaProva' }, { vlVersionProbe: PROBE('0.5.0'), env: { VL_API_KEY: 'sk-test', VL_PROVIDER: 'evil' } });
    assert.equal(r2.ok, true);
    assert.equal(r2.engine.env.VL_PROVIDER, undefined, 'il provider ostile dell\'ambiente NON arriva al child');
    assert.equal(r2.engine.env.VL_API_KEY, 'sk-test', 'la chiave viaggia per NOME: solo quella passa');
    // modello esplicito NC > profilo
    const r3 = resolve(home, vlNative({ vlConfigFile: cat, vlProfile: 'work', model: 'scelto-da-ui' }), { id: 'CellaProva' }, { vlVersionProbe: PROBE('0.5.0') });
    assert.equal(r3.engine.env.VL_MODEL, 'scelto-da-ui', 'scelta esplicita NC vince sul profilo');
    assert.equal(r3.engine.args[2], undefined, 'il modello NON va su argv in modalita\' profilo');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('matrice anthropic/custom: la variante e\' la scelta -> coppia SEMPRE composta; mai insieme al profilo', () => {
  const home = homeWith();
  try {
    const rA = resolve(home, { client: 'vl', provider: 'anthropic', model: '' }, { id: 'CellaProva' },
      { vlVersionProbe: PROBE('0.5.0'), env: { VL_API_KEY: 'sk-a' } });
    assert.equal(rA.ok, true);
    assert.equal(rA.engine.env.VL_PROVIDER, 'anthropic');
    assert.equal(rA.engine.env.VL_BASE_URL, 'https://api.anthropic.com');
    assert.deepEqual(rA.engine.args, [], 'varianti remote: nessun -p');
    const rC = resolve(home, {
      client: 'vl', provider: 'custom', displayName: 'GW', baseUrl: 'https://gw/x',
      protocol: 'anthropic-bearer', model: 'kimi-k2.7', envKey: '',
    }, { id: 'CellaProva' }, { vlVersionProbe: PROBE('0.5.0') });
    assert.equal(rC.engine.env.VL_PROVIDER, 'anthropic-bearer', 'il protocollo custom E\' il provider wire');
    assert.equal(rC.engine.env.VL_BASE_URL, 'https://gw/x');
    assert.equal(rC.engine.env.VL_MODEL, 'kimi-k2.7');
    // la variante NON combatte con l'ambiente: passthrough ostile rifiutato in
    // normalize; quello che arriva e' solo cio\' che la variante ha composto
    const hostile = resolve(home, {
      ...vlNative(), vlConfigFile: catalogWith(home, ['w']), vlProfile: 'w',
    }, { id: 'CellaProva' }, { vlVersionProbe: PROBE('0.5.0'), env: { VL_BASE_URL: 'http://evil', VL_API_KEY: 'sk-b' } });
    assert.equal(hostile.engine.env.VL_BASE_URL, undefined, 'env ostile neutralizzata in modalita\' profilo');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// --- vlBinary: stesso binario per probe e spawn, spazi compresi ------------

test('vlBinary: valido (con spazi) -> realpath per probe E spawn; invalido -> rifiuto, MAI ripiego PATH', () => {
  const home = homeWith();
  try {
    const dirWithSpaces = path.join(home, 'vl tools', 'bin 0.4');
    fs.mkdirSync(dirWithSpaces, { recursive: true });
    const bin = path.join(dirWithSpaces, 'vl-Runner');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.chmodSync(bin, 0o755);
    const r = resolve(home, vlNative({ vlBinary: bin }), { id: 'CellaProva' }, { vlVersionProbe: PROBE('0.5.0') });
    assert.equal(r.ok, true);
    assert.equal(r.info.binary, fs.realpathSync(bin), 'probe e spawn usano il binario RISOLTO (realpath)');
    assert.equal(r.engine.command, fs.realpathSync(bin), 'il comando di lancio e\' lo stesso file');
    assert.ok(r.engine.command.includes(' '), 'percorso con spazi conservato INTEGER (argv separato, nessuna shell)');
    // inesistente
    const rMissing = resolve(home, vlNative({ vlBinary: path.join(home, 'non-esiste') }), { id: 'CellaProva' }, { vlVersionProbe: PROBE('0.5.0') });
    assert.equal(rMissing.ok, false);
    assert.match(rMissing.reason, /nessun ripiego sul PATH/);
    // non eseguibile
    const noExec = path.join(home, 'vl-noexec');
    fs.writeFileSync(noExec, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    const rNoExec = resolve(home, vlNative({ vlBinary: noExec }), { id: 'CellaProva' }, { vlVersionProbe: PROBE('0.5.0') });
    assert.equal(rNoExec.ok, false);
    assert.match(rNoExec.reason, /non eseguibile/);
    // directory (non file regolare)
    const rDir = resolve(home, vlNative({ vlBinary: path.join(home, '.local', 'bin') }), { id: 'CellaProva' }, { vlVersionProbe: PROBE('0.5.0') });
    assert.equal(rDir.ok, false);
    assert.match(rDir.reason, /non e' un file regolare/);
    // assente -> PATH, come prima
    const rPath = resolve(home, vlNative(), { id: 'CellaProva' }, { vlVersionProbe: PROBE('0.5.0') });
    assert.equal(rPath.info.binary, fs.realpathSync(path.join(home, '.local', 'bin', 'vl')));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('catalogo: sorgente mancante o illeggibile -> avvio RIFIUTATO dichiarato; profilo inesistente -> rifiuto nominato', () => {
  const home = homeWith();
  try {
    const rMissing = resolve(home, vlNative({ vlConfigFile: path.join(home, 'manca.toml') }), { id: 'CellaProva' }, { vlVersionProbe: PROBE('0.5.0') });
    assert.equal(rMissing.ok, false);
    assert.match(rMissing.reason, /non leggibile/);
    assert.match(rMissing.reason, /avvio rifiutato/, 'mai partire senza catalogo');
    const cat = catalogWith(home, ['work']);
    const rProfile = resolve(home, vlNative({ vlConfigFile: cat, vlProfile: 'ghost' }), { id: 'CellaProva' }, { vlVersionProbe: PROBE('0.5.0') });
    assert.equal(rProfile.ok, false);
    assert.match(rProfile.reason, /ghost/);
    assert.match(rProfile.reason, /profilo inesistente rifiutato esplicitamente/);
    // vlProfile senza vlConfigFile dichiarato: la sorgente diventa il
    // catalogo dell'operatore, e il profilo ci deve stare davvero.
    const rOperatore = resolve(home, vlNative({ vlProfile: 'work' }), { id: 'CellaProva' }, { vlVersionProbe: PROBE('0.5.0') });
    assert.equal(rOperatore.ok, true, rOperatore.reason);
    assert.deepEqual(rOperatore.engine.args, ['-p', 'work'], 'il profilo viene dal catalogo dell\'operatore');
    // Senza NESSUNA sorgente il rifiuto e' dichiarato: mai un profilo
    // inventato, mai un catalogo di scarto.
    const homeSenza = homeWith({ senzaCatalogo: true });
    try {
      const rNoCat = resolve(homeSenza, vlNative({ vlProfile: 'work' }), { id: 'CellaProva' }, { vlVersionProbe: PROBE('0.5.0') });
      assert.equal(rNoCat.ok, false);
      assert.match(rNoCat.reason, /senza catalogo/);
    } finally { fs.rmSync(homeSenza, { recursive: true, force: true }); }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// --- effort: gate di versione del binario scelto ---------------------------

test('effort: gate versione sul binario SCELTO (0.4.0 rifiuta, 0.5.0 passa); costante min allineata', () => {
  const home = homeWith();
  try {
    assert.deepEqual(vlEffortMinVersion(), [0, 5, 0]);
    const extraModels = new Map([['vl.native', new Map([['gemma4', { id: 'gemma4', engine: 'vl.native', effortLevels: ['high'] }]])]]);
    const spec = vlNative({ model: 'gemma4', effort: 'high' });
    const rVecchio = resolve(home, spec, { id: 'CellaProva' }, { vlVersionProbe: PROBE('0.4.0'), extraModels });
    assert.equal(rVecchio.ok, false, 'binario che non legge VL_EFFORT: rifiuto dichiarato, non ignorato');
    assert.match(rVecchio.reason, /0\.4\.0/);
    assert.match(rVecchio.reason, /0\.5\.0/);
    const rNuovo = resolve(home, spec, { id: 'CellaProva' }, { vlVersionProbe: PROBE('0.5.0'), extraModels });
    assert.equal(rNuovo.ok, true);
    assert.equal(rNuovo.engine.env.VL_EFFORT, 'high', 'VL_EFFORT composta solo se promettibile');
    // probe muto: rifiuto fail-closed
    const rMuto = resolve(home, spec, { id: 'CellaProva' }, { vlVersionProbe: () => null, extraModels });
    assert.equal(rMuto.ok, false);
    assert.match(rMuto.reason, /non determinabile/);
    // il gate riceve lo stesso binario dello spawn
    const bin = path.join(home, 'altro-vl');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const rBin = resolve(home, vlNative({ vlBinary: bin, model: 'gemma4', effort: 'high' }), { id: 'CellaProva' },
      { vlVersionProbe: PROBE('0.5.0'), extraModels });
    assert.equal(rBin.info.binary, fs.realpathSync(bin));
    assert.equal(vlEffortGate(fs.realpathSync(bin), { vlVersionProbe: PROBE('0.5.0') }).ok, true);
    assert.equal(vlEffortGate(fs.realpathSync(bin), { vlVersionProbe: PROBE('0.4.0') }).ok, false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// --- identità per cella: owner+cellId, stabile, senza collisioni -----------

test('identita vl: owner+cellId -> directory stabile e distinte; collisioni slug impossibili', () => {
  const home = homeWith();
  try {
    const a1 = vlCellBaseDir(home, 'owner-A', 'CellaProva');
    const a2 = vlCellBaseDir(home, 'owner-A', 'CellaProva');
    const b = vlCellBaseDir(home, 'owner-B', 'CellaProva');
    assert.equal(a1, a2, 'stessa cella stesso owner: percorso STABILE ai restart');
    assert.notEqual(a1, b, 'stessa cellId, owner diversi: percorsi DIVERSI');
    // due id che slugano uguale restano distinti per costruzione (hash)
    const s1 = vlCellBaseDir(home, 'owner-A', 'CellaProva Cell');
    const s2 = vlCellBaseDir(home, 'owner-A', 'dev-cell');
    assert.notEqual(s1, s2, 'slug equivalente: l\'hash distingue');
    // il trio si crea con permessi privati e si riusa
    const d1 = ensureVlCellDirs(home, 'owner-A', 'CellaProva');
    const d2 = ensureVlCellDirs(home, 'owner-A', 'CellaProva');
    assert.equal(d1.base, d2.base);
    assert.ok(fs.statSync(d1.base).isDirectory());
    assert.equal((fs.statSync(d1.base).mode & 0o777), 0o700, 'base 0700');
    for (const p of [d1.env.XDG_STATE_HOME, d1.env.XDG_DATA_HOME, d1.env.XDG_CONFIG_HOME]) {
      assert.equal((fs.statSync(p).mode & 0o777), 0o700, 'trio XDG 0700');
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('due celle stesso engine: trii XDG distinti fino all\'host; la preferenza di A non tocca B', () => {
  const home = homeWith();
  try {
    const r1 = resolve(home, vlNative(), { id: 'Alpha' }, { vlVersionProbe: PROBE('0.5.0'), vlOwnerInstanceId: 'node-1' });
    const r2 = resolve(home, vlNative(), { id: 'Beta' }, { vlVersionProbe: PROBE('0.5.0'), vlOwnerInstanceId: 'node-1' });
    assert.notEqual(r1.engine.env.XDG_STATE_HOME, r2.engine.env.XDG_STATE_HOME, 'stato per cella: host distinti');
    assert.notEqual(r1.engine.env.XDG_CONFIG_HOME, r2.engine.env.XDG_CONFIG_HOME);
    assert.notEqual(r1.engine.env.VL_SYSTEM_APPEND_FILE, r2.engine.env.VL_SYSTEM_APPEND_FILE, 'prompt per cella');
    // la cella B puo' scriversi la sua preferenza: NC non la tocca
    const selectedB = path.join(r2.engine.env.XDG_CONFIG_HOME, 'vl', 'selected.toml');
    fs.mkdirSync(path.dirname(selectedB), { recursive: true });
    fs.writeFileSync(selectedB, 'model = "preferita-di-beta"\n');
    resolve(home, vlNative(), { id: 'Alpha' }, { vlVersionProbe: PROBE('0.5.0'), vlOwnerInstanceId: 'node-1' });
    assert.equal(fs.readFileSync(selectedB, 'utf8'), 'model = "preferita-di-beta"\n', 'un lancio di A non riscrive selected.toml di B');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// --- launcher finto: argv/env REDATTI attraverso lo spawn vero del supervisore

// Il launcher registra argv COMPLETO (i path sono di test, non segreti) e
// dell'env i SOLI NOMI piu' i valori whitelistati non-segreti; tutto cio' che
// sembra un segrente (sk-, secret, token-like) e' redatto con <redacted>.
const REDACT_RE = /^(sk-|secret|token|bearer |key-)/i;
function redactEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) {
    out[k] = REDACT_RE.test(String(v)) ? '<redacted>' : String(v);
  }
  return out;
}

function fakeChildExit() {
  const ee = new EventEmitter();
  ee.kill = () => {};
  queueMicrotask(() => ee.emit('exit', 0, null));
  return ee;
}

test('launcher finto: argv separato con path spaziato, env con nomi+valori redatti, nessun segreto su argv', async () => {
  const home = homeWith();
  try {
    // launcher con SPAZI nel percorso: lo spawn del supervisore deve passarlo
    // INTERO come argv[0], nessuna interpolazione shell
    const launcherDir = path.join(home, 'fake launchers');
    fs.mkdirSync(launcherDir, { recursive: true });
    const launcher = path.join(launcherDir, 'vl fake');
    fs.writeFileSync(launcher, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.chmodSync(launcher, 0o755);

    const registrati = [];
    let clock = 1000;
    const payload = {
      command: fs.realpathSync(launcher),
      args: ['-p', 'work'],
      env: {
        VL_API_KEY: 'sk-test-secret',
        VL_MODEL: 'gemma4',
        XDG_STATE_HOME: '/tmp/stato-di-test',
      },
      supervise: {
        enabled: true, initialReadyMs: 50, restartDelayMs: 10, maxRestartDelayMs: 10,
        resetAfterMs: 1000000, rapidWindowMs: 60000, maxRapidRestarts: 1,
      },
    };
    await main(['--socket', '/tmp/nc-nope', '--nonce', 'a'.repeat(64)], {
      receivePayload: async () => payload,
      spawn: (command, args, opts) => {
        registrati.push({ argv0: command, args: [...args], env: redactEnv(opts && opts.env) });
        clock += 100;
        return fakeChildExit();
      },
      now: () => clock,
      sleep: async () => { clock += 1000; },
      stderrWrite: () => {},
    });
    assert.ok(registrati.length >= 1);
    const row = registrati[0];
    assert.equal(row.argv0, payload.command, 'argv[0] INTERO: il path con spazi non viene spezzato né shell-izzato');
    assert.deepEqual(row.args, ['-p', 'work'], 'argv separato: profilo come token proprio');
    assert.equal(JSON.stringify(row.args).includes('sk-test-secret'), false, 'MAI segreti su argv');
    assert.equal(row.env.VL_API_KEY, '<redacted>', 'il valore segreto e\' REDATTO nel registro');
    assert.equal(row.env.VL_MODEL, 'gemma4', 'i valori non-segreti restano leggibili');
    assert.ok('XDG_STATE_HOME' in row.env, 'i nomi env arrivano tutti');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// --- confini (P9/P10): nessun guardiano dell'Invio, niente sessioni toccate

test('confini: il ramo vl non porta send-keys né guardiano; il prompt viaggia SOLO su VL_SYSTEM_APPEND_FILE', () => {
  const home = homeWith();
  try {
    const r = resolve(home, vlNative(), { id: 'CellaProva', prompt: 'prompt di cella' }, { vlVersionProbe: PROBE('0.5.0') });
    assert.equal(r.engine.promptMode, 'managed-argv', 'vl: nessuna consegna send-keys (niente pressione di Invio)');
    assert.equal(r.engine.restartPrompt, undefined, 'niente reinjection: nessun guardiano dell\'Invio');
    assert.deepEqual(r.engine.args, [], 'il prompt NON sta su argv');
    assert.ok(r.engine.env.VL_SYSTEM_APPEND_FILE, 'l\'unico canale del prompt e\' il file per cella');
    // NC non legge/riscrive sessioni vl: lo stato per cella contiene SOLO
    // directory create da NC; nessun file di sessione aperto o toccato
    const stateDir = r.engine.env.XDG_STATE_HOME;
    assert.deepEqual(fs.readdirSync(stateDir), [], 'NexusCrew non scrive nulla nello stato vl: le sessioni sono del runtime');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('confini: diagnostica senza segreti (vlRuntime) e versione probe condivisa con il gate prompt', () => {
  const home = homeWith();
  try {
    const bin = path.join(home, 'vl-sonda');
    fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    fs.chmodSync(bin, 0o755);
    const cat = catalogWith(home, ['work']);
    const r = resolve(home, vlNative({ vlBinary: bin, vlConfigFile: cat, vlProfile: 'work' }),
      { id: 'CellaProva' }, { vlVersionProbe: PROBE('0.5.0') });
    assert.equal(r.ok, true);
    assert.ok(r.info.vlRuntime, 'diagnostica presente');
    assert.equal(r.info.vlRuntime.binary, fs.realpathSync(bin), 'dice QUALE binario girera\'');
    assert.equal(r.info.vlRuntime.profile, 'work');
    assert.equal(r.info.vlRuntime.stateDir.includes('.nexuscrew'), true);
    const dump = JSON.stringify(r.info);
    assert.equal(dump.toLowerCase().includes('sk-'), false, 'niente valori segreti nella diagnostica');
    // il catalogo copiato non contiene segreti per costruzione (il sorgente e'
    // il file dichiarato: qui si verifica che non nasca un secrets.env)
    assert.ok(!fs.existsSync(path.join(r.info.vlRuntime.stateDir, 'config', 'vl', 'secrets.env')));
    // vlCatalogProfiles legge le tabelle del catalogo
    assert.deepEqual([...vlCatalogProfiles('[profiles.a]\n[profiles.b-c]\n[x]\n')].sort(), ['a', 'b-c']);
    // writeVlCellCatalog e' atomico: il target e' sempre un file REGOLARE
    // (il chiamante di produzione crea l'albero con ensureVlCellDirs; qui il
    // parent si prepara a mano perche' il test non passa dal ramo vl)
    fs.mkdirSync(path.join(home, 'cfg', 'vl'), { recursive: true, mode: 0o700 });
    const target = writeVlCellCatalog(path.join(home, 'cfg', 'vl'), cat);
    assert.ok(fs.statSync(target.target).isFile());
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
