'use strict';
// Grok (grok.native) managed client adapter — grok-build (xai-org/grok-build),
// Rust TUI, auth delegata al login del CLI (nessuna credenziale letta/copiata).
// Platform gate come Agy (Linux/macOS non-Termux); backfill idempotente pattern
// Agy. argv: --model + prompt come bare posizionale (Usage `grok [OPTIONS]
// [PROMPT]`); unsafe -> --always-approve (flag reale verificato su `grok --help`).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeManagedSpec, describeManaged, resolveManagedEngine, publicCatalog, findBinary } = require('../lib/fleet/managed.js');
const { backfillGrokEngine } = require('../lib/fleet/builtin.js');
const { loadDefinitions, atomicWrite } = require('../lib/fleet/definitions.js');

const GROK = { client: 'grok', provider: 'native', model: '', permissionPolicy: 'standard' };
const GROK_UNSAFE = { client: 'grok', provider: 'native', model: '', permissionPolicy: 'unsafe' };

// Il binario grok vive in ~/.grok/bin/grok (path NON standard): fixture mirata.
function homeWithGrok() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncgrok-'));
  fs.mkdirSync(path.join(home, '.grok', 'bin'), { recursive: true });
  const bin = path.join(home, '.grok', 'bin', 'grok');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(bin, 0o755);
  return home;
}

test('grok: normalizeManagedSpec ammette standard/unsafe; publicCatalog include grok.native', () => {
  assert.deepEqual(normalizeManagedSpec(GROK), { client: 'grok', provider: 'native', model: '', permissionPolicy: 'standard' });
  assert.equal(normalizeManagedSpec(GROK_UNSAFE).permissionPolicy, 'unsafe');
  assert.equal(normalizeManagedSpec({ client: 'grok', provider: 'native', permissionPolicy: 'bogus' }), null);
  const cat = publicCatalog().find((p) => p.id === 'grok.native');
  assert.ok(cat, 'grok.native nel catalogo');
  assert.equal(cat.auth, 'login', 'auth delegata al login del CLI');
  assert.equal(cat.protocol, 'grok_native');
  assert.equal(cat.supportsUnsafe, true);
  assert.equal(cat.permissionPolicyDefault, 'standard');
  assert.equal(cat.rc, false, 'nessun remote-control NexusCrew');
});

test('grok findBinary: risolve ~/.grok/bin/grok (path non standard)', () => {
  const home = homeWithGrok();
  try {
    const bin = findBinary('grok', home);
    assert.ok(bin, 'grok risolto da ~/.grok/bin');
    assert.equal(bin, fs.realpathSync(path.join(home, '.grok', 'bin', 'grok')));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('grok platform gate: configurato solo su linux/darwin non-Termux; rifiutato altrove', () => {
  const home = homeWithGrok();
  try {
    const termux = describeManaged(GROK, { home, platform: 'linux', env: { PREFIX: '/data/data/com.termux/files/usr' } });
    assert.equal(termux.configured, false);
    assert.match(termux.reason, /non supportato su questa piattaforma/);
    assert.equal(describeManaged(GROK, { home, platform: 'android' }).configured, false);
    assert.equal(describeManaged(GROK, { home, platform: 'win32' }).configured, false);
    assert.equal(describeManaged(GROK, { home, platform: 'linux', env: {} }).configured, true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('grok argv: standard=nessun flag; unsafe=--always-approve; --model poi prompt bare posizionale ULTIMO; niente token', () => {
  const home = homeWithGrok();
  try {
    const eng = (pp) => ({ id: 'grok.native', managed: { client: 'grok', provider: 'native', model: '', permissionPolicy: pp } });
    // standard, no model, no prompt -> TUI interattivo (nessun arg), niente env/token
    const r0 = resolveManagedEngine(eng('standard'), { id: 'grok.native' }, { home, platform: 'linux', env: {} });
    assert.equal(r0.ok, true);
    assert.deepEqual(r0.engine.args, []);
    assert.deepEqual(r0.engine.env, {}, 'auth login: nessun token/credenziale su env');
    // unsafe + model + prompt -> --always-approve, --model, <prompt bare posizionale>
    const r1 = resolveManagedEngine(eng('unsafe'), { id: 'grok.native', model: 'grok-4', prompt: 'you are dev' }, { home, platform: 'linux', env: {} });
    assert.equal(r1.ok, true);
    assert.deepEqual(r1.engine.args, ['--always-approve', '--model', 'grok-4', 'you are dev']);
    assert.deepEqual(r1.engine.env, {});
    assert.equal(JSON.stringify(r1.engine).toLowerCase().includes('token'), false, 'nessun token in argv/env');
    assert.equal(JSON.stringify(r1.engine.args).includes('sk-'), false);
    // standard + model, no prompt -> solo --model
    const r2 = resolveManagedEngine(eng('standard'), { id: 'grok.native', model: 'grok-4' }, { home, platform: 'linux', env: {} });
    assert.deepEqual(r2.engine.args, ['--model', 'grok-4']);
    // prompt e' SEMPRE l'ultimo argomento (bare posizionale, mai flag dopo)
    const r3 = resolveManagedEngine(eng('standard'), { id: 'grok.native', prompt: 'p1' }, { home, platform: 'linux', env: {} });
    assert.equal(r3.engine.args[r3.engine.args.length - 1], 'p1');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('grok describeManaged: binario assente -> non configurato', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncgrokna-'));
  try {
    const info = describeManaged(GROK, { home, platform: 'linux', env: {} });
    assert.equal(info.configured, false);
    assert.match(info.reason, /client grok not found/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('grok backfill: idempotente, platform-aware, non distruttivo su collisione id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncgrokbf-'));
  try {
    const dp = (engines) => {
      const p = path.join(root, `f-${Math.random().toString(36).slice(2)}.json`);
      atomicWrite(p, { schemaVersion: 1, engines, cells: [] });
      return p;
    };
    const base = [{ id: 'claude.native', label: 'Claude', rc: true, managed: { client: 'claude', provider: 'native', permissionPolicy: 'unsafe' } }];
    // linux -> aggiunge grok.native
    const p1 = dp(base);
    const g1 = backfillGrokEngine(p1, loadDefinitions(p1), { platform: 'linux' });
    assert.ok(g1.engines.some((e) => e.id === 'grok.native'));
    // idempotente (non duplica)
    const g1b = backfillGrokEngine(p1, g1, { platform: 'linux' });
    assert.equal(g1b.engines.filter((e) => e.id === 'grok.native').length, 1);
    // android -> no-op
    const p2 = dp(base);
    const g2 = backfillGrokEngine(p2, loadDefinitions(p2), { platform: 'android' });
    assert.equal(g2.engines.some((e) => e.id === 'grok.native'), false);
    // darwin -> aggiunge
    const p3 = dp(base);
    assert.ok(backfillGrokEngine(p3, loadDefinitions(p3), { platform: 'darwin' }).engines.some((e) => e.id === 'grok.native'));
    // collisione id: engine custom con id grok.native ma command proprio -> preservato
    const p4 = dp([{ id: 'grok.native', label: 'Custom', rc: false, command: '/bin/x', args: [], env: {}, promptMode: 'flag', promptFlag: '-p' }]);
    const g4 = backfillGrokEngine(p4, loadDefinitions(p4), { platform: 'linux' });
    assert.equal(g4.engines.length, 1);
    assert.equal(g4.engines[0].command, '/bin/x', 'collisione: custom grok.native preservato, mai sovrascritto');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Path PER-CELL: l'override permissionPolicies e' l'unico modo in cui grok
// riceve 'unsafe' dentro resolveManagedEngine (lo spec engine di default e'
// standard). grok NON e' clampato (non in lista pi|shell|vl): unsafe deve
// mettere --always-approve; standard non deve. Ancora il NON-clamp di grok.
test('grok policy per-cell: override unsafe mette --always-approve (NON clampato); standard -> assente', () => {
  const home = homeWithGrok();
  try {
    const engine = (pp) => ({ id: 'grok.native', managed: { client: 'grok', provider: 'native', model: '', permissionPolicy: pp } });
    // default engine standard -> nessun flag
    const def = resolveManagedEngine(engine('standard'), { id: 'Dev' }, { home, platform: 'linux', env: {} });
    assert.equal(def.info.permissionPolicy, 'standard');
    assert.equal(def.engine.args.includes('--always-approve'), false);
    // override PER-CELL unsafe -> grok NON clampato, --always-approve presente, policy effettiva unsafe
    const uns = resolveManagedEngine(engine('standard'), { id: 'Dev', permissionPolicies: { 'grok.native': 'unsafe' } }, { home, platform: 'linux', env: {} });
    assert.equal(uns.ok, true);
    assert.equal(uns.info.permissionPolicy, 'unsafe', 'grok: override PER-CELL unsafe non clampato (NON in lista pi|shell|vl)');
    assert.equal(uns.engine.args.includes('--always-approve'), true, 'override unsafe -> --always-approve in argv');
    // override PER-CELL standard su engine default unsafe -> flag assente
    const std = resolveManagedEngine(engine('unsafe'), { id: 'Dev', permissionPolicies: { 'grok.native': 'standard' } }, { home, platform: 'linux', env: {} });
    assert.equal(std.info.permissionPolicy, 'standard');
    assert.equal(std.engine.args.includes('--always-approve'), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
