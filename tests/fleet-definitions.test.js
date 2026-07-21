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
