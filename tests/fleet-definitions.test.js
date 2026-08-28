'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseDefinitions, validateCommandTrust, resolveCwd,
  loadDefinitions, atomicWrite, CAPS,
} = require('../lib/fleet/definitions.js');

// Fixture valida minimale + estesa. Restituisce copie fresche.
function validDef() {
  return {
    schemaVersion: 1,
    engines: [{
      id: 'claude', label: 'Claude', rc: true,
      command: '/usr/local/bin/claude',
      args: ['--dangerously-skip-permissions'],
      env: { ANTHROPIC_API_KEY: 'sk-x' },
      model: { flag: '--model', value: '' },
      promptMode: 'flag',
      promptFlag: '--append-system-prompt',
    }],
    cells: [{
      id: 'Build', cwd: '/home/user/work', engine: 'claude',
      boot: true, model: 'opus', prompt: 'you are a dev agent',
    }],
  };
}

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nc-def-'));

test('schema valido: accettato (oggetto e stringa JSON) + normalizzazione', () => {
  const obj = parseDefinitions(validDef());
  assert.ok(obj, 'oggetto valido accettato');
  assert.equal(obj.schemaVersion, 1);
  assert.equal(obj.engines[0].id, 'claude');
  assert.equal(obj.engines[0].label, 'Claude');
  assert.deepEqual(obj.engines[0].args, ['--dangerously-skip-permissions']);
  assert.deepEqual(obj.engines[0].env, { ANTHROPIC_API_KEY: 'sk-x' });
  assert.equal(obj.cells[0].tmuxSession, 'cloud-Build', 'tmuxSession derivato da id');
  assert.equal(obj.cells[0].boot, true);

  // stringa JSON round-trip
  assert.ok(parseDefinitions(JSON.stringify(validDef())));

  // engine minimale: solo campi obbligatori -> label=id, rc=false, args=[], env={}
  const min = parseDefinitions({
    schemaVersion: 1,
    engines: [{ id: 'sh', command: '/bin/sh', promptMode: 'send-keys' }],
    cells: [{ id: 'C', cwd: '/tmp', engine: 'sh' }],
  });
  assert.ok(min);
  assert.equal(min.engines[0].label, 'sh');
  assert.equal(min.engines[0].rc, false);
  assert.deepEqual(min.engines[0].args, []);
  assert.deepEqual(min.engines[0].env, {});
  assert.equal(min.cells[0].tmuxSession, 'cloud-C');
  assert.equal(min.cells[0].boot, false);
});

test('managed 0.8.0: Z.AI legacy migra senza spezzare i riferimenti delle celle', () => {
  const parsed = parseDefinitions({
    schemaVersion: 1,
    engines: [{
      id: 'claude.zai-a', label: 'Z.AI A',
      managed: { client: 'claude', provider: 'zai-a', model: 'glm-5.2[1m]' },
    }],
    cells: [{ id: 'Dev', cwd: '/home/user/work', engine: 'claude.zai-a' }],
  });
  assert.ok(parsed);
  assert.deepEqual(parsed.engines[0].managed, {
    client: 'claude', provider: 'zai', credentialProfile: 'a',
    model: 'glm-5.2[1m]', permissionPolicy: 'unsafe',
  });
  assert.equal(parsed.cells[0].engine, 'claude.zai-a');
});

test('schemaVersion sbagliato / engines non-array / cells mancanti -> null', () => {
  const base = validDef();
  assert.equal(parseDefinitions({ ...base, schemaVersion: 2 }), null);
  assert.equal(parseDefinitions({ ...base, schemaVersion: '1' }), null);   // strict number
  assert.equal(parseDefinitions({ ...base, schemaVersion: undefined }), null);
  assert.equal(parseDefinitions({ ...base, engines: 'nope' }), null);
  assert.equal(parseDefinitions({ ...base, engines: null }), null);
  assert.equal(parseDefinitions({ ...base, engines: undefined }), null);
  assert.equal(parseDefinitions({ schemaVersion: 1, engines: [], cells: 'x' }), null);
  assert.equal(parseDefinitions({ schemaVersion: 1, engines: [] }), null);  // cells obbligatorio
  assert.equal(parseDefinitions({ schemaVersion: 1, cells: [] }), null);    // engines obbligatorio
  assert.equal(parseDefinitions('not json {'), null);
  assert.equal(parseDefinitions(null), null);
  assert.equal(parseDefinitions(42), null);
  assert.equal(parseDefinitions([]), null);
});

test('dangling engine ref -> null', () => {
  const d = validDef();
  d.cells[0].engine = 'inesistente';
  assert.equal(parseDefinitions(d), null);
});

test('cell models: ultimo modello per engine strict e senza dangling key', () => {
  const d = validDef();
  d.cells[0].model = 'opus';
  d.cells[0].models = { claude: 'opus' };
  const parsed = parseDefinitions(d);
  assert.deepEqual(parsed.cells[0].models, { claude: 'opus' });
  d.cells[0].models = { missing: 'x' };
  assert.equal(parseDefinitions(d), null);
  d.cells[0].models = { claude: '' };
  assert.equal(parseDefinitions(d), null);
});

test('cell commands: solo engine Shell, stringa opaca bounded e policy standard', () => {
  const shell = { id: 'shell.local', managed: { client: 'shell', provider: 'local', model: '', permissionPolicy: 'standard' } };
  const base = {
    schemaVersion: 1,
    engines: [shell, validDef().engines[0]],
    cells: [{ id: 'Ops', cwd: '/home/user/work', engine: 'shell.local', commands: { 'shell.local': "printf '$HOME' | sed s/x/y/" } }],
  };
  assert.deepEqual(parseDefinitions(base).cells[0].commands, base.cells[0].commands);
  assert.equal(parseDefinitions({ ...base, cells: [{ ...base.cells[0], commands: { claude: 'echo no' } }] }), null);
  assert.equal(parseDefinitions({ ...base, cells: [{ ...base.cells[0], commands: { missing: 'echo no' } }] }), null);
  assert.equal(parseDefinitions({ ...base, cells: [{ ...base.cells[0], commands: { 'shell.local': 'x\n' } }] }), null);
  assert.equal(parseDefinitions({ ...base, cells: [{ ...base.cells[0], commands: { 'shell.local': 'x'.repeat(CAPS.MAX_CELL_COMMAND_LEN + 1) } }] }), null);
  assert.equal(parseDefinitions({ ...base, cells: [{ ...base.cells[0], permissionPolicies: { 'shell.local': 'unsafe' } }] }), null);
});

test('id duplicati (engine e cell) -> null', () => {
  const d = validDef();
  d.engines.push({ ...d.engines[0] }); // stesso id 'claude'
  assert.equal(parseDefinitions(d), null, 'engine id dup');

  const d2 = validDef();
  d2.cells.push({ id: 'Build', cwd: '/x', engine: 'claude' }); // stesso id cell
  assert.equal(parseDefinitions(d2), null, 'cell id dup');
});

test('tmuxSession duplicato (override espliciti) -> null', () => {
  const d = validDef();
  d.cells[0].tmuxSession = 'room';                 // esplicito non-cloud
  d.cells.push({ id: 'Other', cwd: '/x', engine: 'claude', tmuxSession: 'room' });
  assert.equal(parseDefinitions(d), null, 'tmuxSession non univoco');
});

test('cella con tmuxSession cloud-* (override esplicito) -> null; derivato/canonico cloud-<id> ok', () => {
  const d = validDef();
  d.cells[0].tmuxSession = 'cloud-Foo';
  assert.equal(parseDefinitions(d), null, 'alias cloud-* verso altro rifiutato');
  // il derivato (nessun campo) cloud-Build e' accettato (forma canonica del fleet)
  const ok = parseDefinitions(validDef());
  assert.equal(ok.cells[0].tmuxSession, 'cloud-Build');
  // il canonico cloud-<id> scritto esplicitamente e' ammesso (round-trip su disco)
  const canon = validDef();
  canon.cells[0].tmuxSession = 'cloud-Build';
  const cok = parseDefinitions(canon);
  assert.ok(cok);
  assert.equal(cok.cells[0].tmuxSession, 'cloud-Build');
});

test('cap engines/cells/args/env superati -> null', () => {
  const eng = (id) => ({ id, command: '/bin/x', promptMode: 'send-keys' });

  // engines
  const tooManyEng = { schemaVersion: 1, engines: [], cells: [] };
  for (let i = 0; i <= CAPS.MAX_ENGINES; i += 1) tooManyEng.engines.push(eng(`e${i}`));
  assert.equal(parseDefinitions(tooManyEng), null, 'troppi engine');

  // cells (una engine condivisa)
  const tooManyCells = { schemaVersion: 1, engines: [eng('e0')], cells: [] };
  for (let i = 0; i <= CAPS.MAX_CELLS; i += 1) tooManyCells.cells.push({ id: `c${i}`, cwd: '/x', engine: 'e0' });
  assert.equal(parseDefinitions(tooManyCells), null, 'troppe cell');

  // args count + len
  const argsCount = { schemaVersion: 1, engines: [{ ...eng('e0'), args: [] }], cells: [] };
  for (let i = 0; i <= CAPS.MAX_ARGS; i += 1) argsCount.engines[0].args.push('-x');
  assert.equal(parseDefinitions(argsCount), null, 'troppi arg');
  const argsLen = { schemaVersion: 1, engines: [{ ...eng('e0'), args: ['x'.repeat(CAPS.MAX_ARG_LEN + 1)] }], cells: [] };
  assert.equal(parseDefinitions(argsLen), null, 'arg troppo lungo');

  // env count + key len + val len
  const envCount = { schemaVersion: 1, engines: [{ ...eng('e0'), env: {} }], cells: [] };
  for (let i = 0; i <= CAPS.MAX_ENV_KEYS; i += 1) envCount.engines[0].env[`K${i}`] = 'v';
  assert.equal(parseDefinitions(envCount), null, 'troppe env key');
  const longKey = 'K' + 'a'.repeat(CAPS.MAX_ENV_KEY_LEN);
  assert.equal(parseDefinitions({ schemaVersion: 1, engines: [{ ...eng('e0'), env: { [longKey]: 'v' } }], cells: [] }), null, 'env key troppo lunga');
  assert.equal(parseDefinitions({ schemaVersion: 1, engines: [{ ...eng('e0'), env: { K: 'v'.repeat(CAPS.MAX_ENV_VAL_LEN + 1) } }], cells: [] }), null, 'env value troppo lungo');
  assert.equal(parseDefinitions({ schemaVersion: 1, engines: [{ ...eng('e0'), env: { '1bad': 'v' } }], cells: [] }), null, 'env key non identificatore');
  assert.equal(parseDefinitions({ schemaVersion: 1, engines: [{ ...eng('e0'), env: { K: 123 } }], cells: [] }), null, 'env value non stringa');
});

test('cap engine: 100 definizioni passano, 101 viene rifiutata', () => {
  const eng = (id) => ({ id, command: '/bin/x', promptMode: 'send-keys' });
  const defs = { schemaVersion: 1, engines: [], cells: [] };
  for (let i = 0; i < 100; i += 1) defs.engines.push(eng(`e${i}`));
  assert.equal(CAPS.MAX_ENGINES, 100, 'il cap dichiarato deve essere 100');
  assert.ok(parseDefinitions(defs), '100 engine devono essere accettati');
  defs.engines.push(eng('e100'));
  assert.equal(parseDefinitions(defs), null, '101 engine devono essere rifiutati');
});

test('loadDefinitions: il cap engine rifiutato lascia una diagnosi parlante', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'fleet.json');
    const engines = Array.from({ length: CAPS.MAX_ENGINES + 1 }, (_, i) => ({
      id: `e${i}`, command: '/bin/x', promptMode: 'send-keys',
    }));
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, engines, cells: [] }));
    const out = {};
    assert.equal(loadDefinitions(file, out), null);
    assert.match(out.parseReason, new RegExp(`\\b${CAPS.MAX_ENGINES + 1}\\b`));
    assert.match(out.parseReason, new RegExp(`\\b${CAPS.MAX_ENGINES}\\b`));
    assert.match(out.parseReason, /riduci|cap/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('env denylist loader/runtime (PATH, LD_PRELOAD, NODE_OPTIONS, NPM_CONFIG_*, DYLD_*) -> null', () => {
  const eng = (env) => ({ schemaVersion: 1, engines: [{ id: 'e0', command: '/bin/x', promptMode: 'send-keys', env }], cells: [] });
  for (const k of ['PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'DYLD_INSERT_LIBRARIES', 'NODE_OPTIONS', 'NPM_CONFIG_PREFIX', 'SHELL', 'HOME']) {
    assert.equal(parseDefinitions(eng({ [k]: 'x' })), null, `denylist ${k}`);
  }
  // env pulito con identificatori validi -> ok
  assert.ok(parseDefinitions(eng({ FOO: '1', BAR_BAZ: '2' })));
});

test('model.flag / promptFlag con spazio (o non argv singolo) -> null', () => {
  // model.flag con spazio
  const m1 = validDef();
  m1.engines[0].model = { flag: '--m odel', value: '' };
  assert.equal(parseDefinitions(m1), null, 'model.flag con spazio');
  // model.flag vuoto
  const m2 = validDef();
  m2.engines[0].model = { flag: '', value: '' };
  assert.equal(parseDefinitions(m2), null, 'model.flag vuoto');
  // promptFlag con spazio
  const m3 = validDef();
  m3.engines[0].promptFlag = '--append system';
  assert.equal(parseDefinitions(m3), null, 'promptFlag con spazio');
  // promptMode flag senza promptFlag
  const m4 = validDef();
  delete m4.engines[0].promptFlag;
  assert.equal(parseDefinitions(m4), null, 'flag mode senza promptFlag');
  // promptMode invalido
  const m5 = validDef();
  m5.engines[0].promptMode = 'telepathy';
  assert.equal(parseDefinitions(m5), null, 'promptMode invalido');
  // flag con tab/newline -> null
  const m6 = validDef();
  m6.engines[0].promptFlag = '--x\t--y';
  assert.equal(parseDefinitions(m6), null, 'promptFlag con tab');
});

test('label con control char -> null', () => {
  const d = validDef();
  d.engines[0].label = 'Claude\n';
  assert.equal(parseDefinitions(d), null);
});

test('validateCommandTrust: relativo / world-writable / symlink / non-exec / assente -> ok=false', () => {
  const dir = tmpDir();
  try {
    // relativo
    assert.equal(validateCommandTrust('./bin').ok, false);
    assert.equal(validateCommandTrust('claude').ok, false);
    assert.equal(validateCommandTrust('').ok, false);

    // assoluto regolare eseguibile non-ww -> ok
    const good = path.join(dir, 'good');
    fs.writeFileSync(good, '#!/bin/sh\necho hi\n');
    fs.chmodSync(good, 0o755);
    assert.equal(validateCommandTrust(good).ok, true, 'regolare eseguibile trusted');

    // world-writable
    const ww = path.join(dir, 'ww');
    fs.writeFileSync(ww, 'x');
    fs.chmodSync(ww, 0o777);
    assert.equal(validateCommandTrust(ww).ok, false, 'world-writable rifiutato');

    // symlink (anche a buon fine) -> lstat non segue
    const link = path.join(dir, 'link');
    fs.symlinkSync(good, link);
    assert.equal(validateCommandTrust(link).ok, false, 'symlink rifiutato');

    // non eseguibile
    const ne = path.join(dir, 'ne');
    fs.writeFileSync(ne, 'x');
    fs.chmodSync(ne, 0o644);
    assert.equal(validateCommandTrust(ne).ok, false, 'non eseguibile rifiutato');

    // inesistente
    assert.equal(validateCommandTrust(path.join(dir, 'nope')).ok, false, 'inesistente rifiutato');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveCwd: dentro home ok, fuori home null, file non-dir null', () => {
  const home = tmpDir();
  const inside = fs.mkdtempSync(path.join(home, 'sub-'));
  const outside = tmpDir(); // sibling sotto os.tmpdir(), NON sotto home
  try {
    assert.ok(resolveCwd(inside, home), 'dentro home accettato');
    assert.equal(resolveCwd(outside, home), null, 'fuori home rifiutato');
    // un file (non directory) -> null
    const file = path.join(home, 'f.txt');
    fs.writeFileSync(file, 'x');
    assert.equal(resolveCwd(file, home), null, 'file non-dir rifiutato');
    // inesistente -> null
    assert.equal(resolveCwd(path.join(home, 'nope'), home), null);
    // home stessa -> ok
    assert.equal(resolveCwd(home, home), home);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('atomicWrite: file 0600 + rileggibile con loadDefinitions; backup predecessore', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'fleet.json');
    const parsed = atomicWrite(file, validDef());
    assert.ok(parsed);
    const mode = fs.statSync(file).mode & 0o777;
    assert.equal(mode, 0o600, 'file scritto 0600');

    const loaded = loadDefinitions(file);
    assert.ok(loaded, 'rileggibile');
    assert.equal(loaded.engines[0].id, 'claude');
    assert.equal(loaded.cells[0].tmuxSession, 'cloud-Build');

    // dati invalidi -> throw + backup del predecessore + file originale intatto
    assert.throws(() => atomicWrite(file, { schemaVersion: 1, engines: 'bad', cells: [] }), /validazione/i);
    assert.ok(fs.existsSync(`${file}.bak`), 'backup predecessore creato');
    const stillValid = loadDefinitions(file);
    assert.ok(stillValid, 'file originale non sovrascritto con dati invalidi');

    // accetta anche stringa JSON
    const f2 = path.join(dir, 'f2.json');
    atomicWrite(f2, JSON.stringify(validDef()));
    assert.ok(loadDefinitions(f2));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('loadDefinitions / atomicWrite: rifiutano i symlink', () => {
  const dir = tmpDir();
  try {
    const real = path.join(dir, 'fleet.json');
    atomicWrite(real, validDef());
    const link = path.join(dir, 'fleet-link.json');
    fs.symlinkSync(real, link);
    assert.equal(loadDefinitions(link), null, 'loadDefinitions rifiuta symlink');
    assert.throws(() => atomicWrite(link, validDef()), /symlink/i, 'atomicWrite rifiuta symlink');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validateCommandTrust: owner check — proprio utente o root ok, altro owner rifiutato', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nctrust-'));
  const own = path.join(dir, 'own-cmd');
  fs.writeFileSync(own, '#!/bin/sh\n', { mode: 0o755 });
  try {
    assert.equal(validateCommandTrust(own).ok, true, 'file di proprieta propria: trusted');
    // root-owned (es. /usr/bin/env) deve passare
    assert.equal(validateCommandTrust('/usr/bin/env').ok, true, 'root-owned: trusted');
    // caso negativo: stub di process.getuid — il file "own" risulta di un ALTRO utente
    const orig = process.getuid;
    process.getuid = () => 99999;
    try {
      const r = validateCommandTrust(own);
      assert.equal(r.ok, false, 'owner diverso da service-user e root: rifiutato');
      assert.match(r.reason, /owner/i);
    } finally { process.getuid = orig; }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// --- NC-D: la cella ha un nome leggibile distinto dall'id -------------------
// Senza questa distinzione l'id fa anche da nome: un nodo che battezza la
// propria cella come il motore la espone cosi' a tutta la rete, e chi la riceve
// non ha modo di sapere che ruolo occupa.

test('label di cella: accettata, distinta dall id e non usata per indirizzare', () => {
  const def = validDef();
  def.cells[0].label = 'SysAdmin del portatile';
  const parsed = parseDefinitions(def);
  assert.ok(parsed);
  assert.equal(parsed.cells[0].label, 'SysAdmin del portatile');
  // L'id e la sessione tmux NON cambiano: la label e' solo cio' che si legge.
  assert.equal(parsed.cells[0].id, 'Build');
  assert.equal(parsed.cells[0].tmuxSession, 'cloud-Build');
});

test('label di cella: assente resta assente, senza inventare un default', () => {
  const parsed = parseDefinitions(validDef());
  assert.ok(parsed);
  assert.equal(parsed.cells[0].label, undefined,
    'chi legge decide il fallback sull id, il parser non lo impone');
});

test('label di cella: spazi ai bordi normalizzati', () => {
  const def = validDef();
  def.cells[0].label = '  Ricerca  ';
  assert.equal(parseDefinitions(def).cells[0].label, 'Ricerca');
});

test('label di cella: forme non valide rifiutano la definizione', () => {
  const tooLong = 'x'.repeat(65);
  const withNewline = ['riga', 'spezzata'].join(String.fromCharCode(10));
  const withControl = `tab${String.fromCharCode(9)}dentro`;
  for (const bad of ['', '   ', tooLong, withNewline, withControl, 42, {}]) {
    const def = validDef();
    def.cells[0].label = bad;
    assert.equal(parseDefinitions(def), null, `atteso rifiuto per ${JSON.stringify(bad)}`);
  }
});

test('label di cella: sopravvive al round-trip su disco', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'fleet.json');
  const def = validDef();
  def.cells[0].label = 'Cella di Ricerca';
  atomicWrite(file, parseDefinitions(def));
  const reloaded = loadDefinitions(file);
  assert.equal(reloaded.cells[0].label, 'Cella di Ricerca');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ===========================================================================
// Punto 4 — loadDefinitions: lstat con ENOENT o EACCES -> null -> "fleet
// unavailable" senza dire perché. Il discriminante e' CHI ha fallito: ENOENT e'
// legittimo "missing"; EACCES/ELOOP e' "non ho potuto guardare". Verdetto (null
// -> fail-closed) invariato; out.lstatBlocked porta il perché.
// ===========================================================================

test('loadDefinitions: fleet.json presente ma illeggibile (EACCES sul lstat) -> stesso null, ma out.lstatBlocked traccia EACCES, non "missing"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ld-blocked-'));
  try {
    const defs = path.join(dir, 'fleet.json');
    fs.writeFileSync(defs, JSON.stringify({ schemaVersion: 1, engines: [], cells: [] }), { mode: 0o600 });
    fs.chmodSync(dir, 0o600); // directory senza execute: lstatSync(defs) -> EACCES
    try {
      const out = {};
      const r = loadDefinitions(defs, out);
      assert.equal(r, null, 'verdetto invariato: fail-closed, nessuna definizione caricata');
      assert.ok(out.lstatBlocked && /EACCES/.test(out.lstatBlocked),
        'il file presente ma illeggibile va tracciato, non collassato in "missing"');
    } finally { fs.chmodSync(dir, 0o700); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('loadDefinitions: fleet.json ASSENTE (ENOENT) -> null, out.lstatBlocked vuoto (caso legittimo invariato)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-ld-legit-'));
  try {
    const out = {};
    const r = loadDefinitions(path.join(dir, 'nope.json'), out);
    assert.equal(r, null);
    assert.equal(out.lstatBlocked, undefined, 'ENOENT e" legittimo "missing", non "non ho potuto guardare"');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ===========================================================================
// Punto 5 (pezzo di valore) — resolveCwd: catch (_) -> null collassava ENOENT
// (cwd non esiste, legittimo 'invalid-cwd') con EACCES/ELOOP (cwd esiste ma non
// verificabile). resolveCellCwd riportava 'invalid-cwd' e unportableCwdError
// "non esiste sotto la home" anche per una cwd presente ma illeggibile. Stesso
// verdetto (cwd rifiutata, fail-closed di sicurezza); il messaggio distingue.
// ===========================================================================

test('resolveCwd: cwd presente ma padre illeggibile (EACCES) -> stesso null, ma out.unverifiable traccia EACCES, non "non esiste"', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cwd-blocked-'));
  try {
    const locked = path.join(home, 'locked'); fs.mkdirSync(locked);
    const cwd = path.join(locked, 'Dev'); fs.mkdirSync(cwd);
    fs.chmodSync(locked, 0o600); // padre senza execute: realpathSync(cwd) -> EACCES
    try {
      const out = {};
      const r = resolveCwd(cwd, home, out);
      assert.equal(r, null, 'verdetto invariato: non possiamo confermare la cwd');
      assert.ok(out.unverifiable && /EACCES/.test(out.unverifiable),
        'la cwd esiste ma non verificabile va tracciata (EACCES), non collassata in "non esiste"');
    } finally { fs.chmodSync(locked, 0o700); }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('resolveCwd: cwd davvero ASSENTE (ENOENT) -> null, out.unverifiable vuoto (caso legittimo invariato)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-cwd-legit-'));
  try {
    const out = {};
    const r = resolveCwd(path.join(home, 'nope'), home, out);
    assert.equal(r, null);
    assert.equal(out.unverifiable, undefined, 'ENOENT e" legittimo "non c\'e", non "non ho potuto guardare"');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// --- panelUrl (D8 backend) ---------------------------------------------------
// Opt-in per-cella/per-engine: http(s) + solo host loopback (127.0.0.1,
// localhost, ::1) + cap di lunghezza. Un valore malformato fa fallire l'INTERA
// definizione (return null), MAI un collasso silenzioso "cella valida senza
// pannello": sono due esiti opposti che si assomigliano.

test('panelUrl assente: cella si comporta esattamente come oggi (pin percorso PTY)', () => {
  const def = validDef();
  const parsed = parseDefinitions(def);
  assert.ok(parsed, 'definizione senza panelUrl resta valida');
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.cells[0], 'panelUrl'), false,
    'nessun campo panelUrl inventato quando assente');
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.engines[0], 'panelUrl'), false,
    'nessun campo panelUrl inventato sull\'engine quando assente');
});

test('panelUrl valido (loopback): accettato su cella ed engine, valore preservato', () => {
  for (const url of ['https://127.0.0.1:6901', 'https://localhost:6901', 'https://[::1]:6901']) {
    const def = validDef();
    def.cells[0].panelUrl = url;
    const parsed = parseDefinitions(def);
    assert.ok(parsed, `atteso accettato per ${url}`);
    assert.equal(parsed.cells[0].panelUrl, url);
  }
  const def = { schemaVersion: 1, engines: [{ id: 'sh', command: '/bin/sh', promptMode: 'send-keys', panelUrl: 'https://127.0.0.1:6901' }], cells: [] };
  const parsed = parseDefinitions(def);
  assert.ok(parsed, 'engine con panelUrl valido accettato');
  assert.equal(parsed.engines[0].panelUrl, 'https://127.0.0.1:6901');
});

test('panelUrl non-loopback: rifiutato, e il rifiuto e\' distinguibile dall\'assenza', () => {
  for (const url of ['https://example.com:6901', 'http://192.168.1.5:6901']) {
    const def = validDef();
    def.cells[0].panelUrl = url;
    assert.equal(parseDefinitions(def), null, `atteso rifiuto per host non-loopback ${url}`);
  }
  // il rifiuto e' della definizione INTERA, non un collasso silenzioso a "assente":
  // una definizione altrimenti valida con panelUrl malformato non produce una
  // cella valida priva di pannello, produce null.
  const bad = validDef();
  bad.cells[0].panelUrl = 'https://evil.example/panel';
  assert.equal(parseDefinitions(bad), null);
  const absent = validDef();
  assert.ok(parseDefinitions(absent), 'assenza resta valida: i due esiti sono distinti');
});

test('panelUrl con scheme non ammesso: rifiutato', () => {
  for (const url of ['ftp://127.0.0.1:6901', 'javascript:alert(1)', 'file:///etc/passwd']) {
    const def = validDef();
    def.cells[0].panelUrl = url;
    assert.equal(parseDefinitions(def), null, `atteso rifiuto per scheme in ${url}`);
  }
});

test('panelUrl oltre il cap di lunghezza: rifiutato', () => {
  const def = validDef();
  def.cells[0].panelUrl = `https://127.0.0.1/${'x'.repeat(CAPS.MAX_PANELURL_LEN)}`;
  assert.equal(parseDefinitions(def), null, 'oltre il cap rifiutato');
});

test('panelUrl: forme non-stringa o vuote rifiutate', () => {
  for (const bad of ['', 42, {}, ['https://127.0.0.1:6901'], null]) {
    const def = validDef();
    def.cells[0].panelUrl = bad;
    assert.equal(parseDefinitions(def), null, `atteso rifiuto per ${JSON.stringify(bad)}`);
  }
});

// --- panelUrl su engine MANAGED (rilievo 1 dell'audit D8) -------------------
// Il validatore è UNO: anche il ramo managed valida e conserva panelUrl con
// lo stesso validPanelUrl del ramo custom. Prima del fix il ramo managed
// tornava PRIMA della validazione: un valore valido spariva in silenzio e uno
// invalido veniva accettato (fail-open) — due percorsi divergenti sullo
// stesso campo, quello che l'audit ha bloccato.

test('panelUrl su engine managed valido: validato e CONSERVATO, non scartato', () => {
  const def = {
    schemaVersion: 1,
    engines: [{
      id: 'x.managed', label: 'X', rc: true,
      managed: { client: 'claude', provider: 'native', permissionPolicy: 'unsafe' },
      panelUrl: 'https://127.0.0.1:6901',
    }],
    cells: [],
  };
  const parsed = parseDefinitions(def);
  assert.ok(parsed, 'engine managed con panelUrl valido accettato');
  assert.equal(parsed.engines[0].panelUrl, 'https://127.0.0.1:6901',
    'il campo sopravvive al parse, come nel ramo custom');
});

test('panelUrl su engine managed INVALIDO: definizione rifiutata (fail-closed, come custom)', () => {
  // Riproduce il caso dell'auditor: "not a url" sul managed veniva ACCETTATO
  // col campo scartato in silenzio; sul custom dava null. Ora uguali.
  for (const url of ['not a url', 'https://example.com:6901', 'ftp://127.0.0.1:6901', '']) {
    const def = {
      schemaVersion: 1,
      engines: [{
        id: 'x.managed', rc: true,
        managed: { client: 'claude', provider: 'native', permissionPolicy: 'unsafe' },
        panelUrl: url,
      }],
      cells: [],
    };
    assert.equal(parseDefinitions(def), null, `atteso rifiuto per ${JSON.stringify(url)}`);
  }
  // e un managed SENZA panelUrl resta valido: il campo è opzionale su entrambi i rami
  const clean = {
    schemaVersion: 1,
    engines: [{ id: 'x.managed', rc: true, managed: { client: 'claude', provider: 'native', permissionPolicy: 'unsafe' } }],
    cells: [],
  };
  const parsed = parseDefinitions(clean);
  assert.ok(parsed, 'managed senza panelUrl resta valido');
  assert.equal(Object.prototype.hasOwnProperty.call(parsed.engines[0], 'panelUrl'), false);
});

test('validatore unico presidiato: backend (validPanelUrl) e backup (validBackupPanelUrl) stesso verdetto', async () => {
  const { validPanelUrl } = require('../lib/fleet/definitions.js');
  const backup = await import('../frontend/src/lib/fleet-backup.js');
  const cases = [
    'https://127.0.0.1:6901', 'https://localhost:6901', 'https://[::1]:6901', 'http://127.0.0.1:1',
    'not a url', '', 'https://example.com:6901', 'http://192.168.1.5:6901', 'ftp://127.0.0.1:6901',
    'javascript:alert(1)', 'file:///etc/passwd', 'https://127.0.0.1:6901/panel?x=1',
    'https://127.0.0.1.:6901', 'https://user@127.0.0.1:6901', 'https://127.0.0.1:6901/a b',
    42, null, {}, ['https://127.0.0.1:6901'],
  ];
  for (const c of cases) {
    assert.equal(backup.validBackupPanelUrl(c), validPanelUrl(c),
      `divergenza fra validatore backend e backup su ${JSON.stringify(c)}`);
  }
});

test('cellStatus: panelUrl dell\'engine MANAGED raggiunge la cella (fallback engine->cella vale per entrambi)', async () => {
  const { createBuiltinRuntime } = require('../lib/fleet/runtime.js');
  const dir = tmpDir();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-d8-home-'));
  const defsPath = path.join(dir, 'fleet.json');
  atomicWrite(defsPath, {
    schemaVersion: 1,
    engines: [{
      id: 'x.managed', label: 'X', rc: true,
      managed: { client: 'claude', provider: 'native', permissionPolicy: 'unsafe' },
      panelUrl: 'https://127.0.0.1:6901',
    }],
    cells: [{ id: 'A', cwd: home, engine: 'x.managed', boot: false }],
  });
  try {
    // tmuxBin che fallisce: refreshSessions torna un set vuoto (nessuna cella
    // attiva) — per il fallback panelUrl non serve alcuna sessione viva.
    const runtime = createBuiltinRuntime({
      cfg: {}, home, defsPath, tmuxBin: '/bin/false',
      readonly: () => false, launchBroker: null, boot: loadDefinitions(defsPath),
    });
    const st = await runtime.cellStatus();
    const cellA = st.cells.find((c) => c.cell === 'A');
    assert.ok(cellA, 'cella nello status');
    assert.equal(cellA.panelUrl, 'https://127.0.0.1:6901',
      'il panelUrl precompilato dall\'engine MANAGED arriva alla cella via fallback');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
