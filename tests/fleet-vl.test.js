'use strict';
// VL (vl.native) — runtime TUI Vivling (~/Dev/20_ai-labs/vl), binario `vl`.
// Runtime locale: auth propria del runtime (auth 'none', nessuna credenziale
// NexusCrew). Backfill idempotente pattern Kimi (NESSUN platform gate: musl-
// friendly ovunque). vl non ha flag prompt, --model, ne' di approvazione: lancia
// la TUI senza argomenti; e' standard-only (nessun flag unsafe da cablare).
// Verifica TUI: `vl --help` -> Usage `vl [OPTIONS]` (nessun argomento richiesto;
// absent config OK, fallback built-in local Ollama).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeManagedSpec, describeManaged, resolveManagedEngine, publicCatalog, findBinary } = require('../lib/fleet/managed.js');
const { backfillVlEngine } = require('../lib/fleet/builtin.js');
const { loadDefinitions, atomicWrite } = require('../lib/fleet/definitions.js');

const VL = { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' };

function homeWithVl() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvl-'));
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const bin = path.join(home, '.local', 'bin', 'vl');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(bin, 0o755);
  return home;
}

test('vl: normalizeManagedSpec ammette solo standard; publicCatalog include vl.native', () => {
  assert.deepEqual(normalizeManagedSpec(VL), { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' });
  // vl e' standard-only: il CLI non ha flag di approvazione -> unsafe rifiutato (fail-closed)
  assert.equal(normalizeManagedSpec({ client: 'vl', provider: 'native', permissionPolicy: 'unsafe' }), null);
  assert.equal(normalizeManagedSpec({ client: 'vl', provider: 'native', permissionPolicy: 'bogus' }), null);
  const cat = publicCatalog().find((p) => p.id === 'vl.native');
  assert.ok(cat, 'vl.native nel catalogo');
  assert.equal(cat.auth, 'none', 'runtime locale: niente credenziali NexusCrew');
  assert.equal(cat.protocol, 'vl_native');
  assert.equal(cat.supportsUnsafe, false, 'vl non ha flag di approvazione');
  assert.equal(cat.permissionPolicyDefault, 'standard');
  assert.equal(cat.rc, false, 'nessun remote-control NexusCrew');
});

test('vl findBinary: risolve ~/.local/bin/vl (path standard)', () => {
  const home = homeWithVl();
  try {
    const bin = findBinary('vl', home);
    assert.ok(bin, 'vl risolto da ~/.local/bin');
    assert.equal(bin, fs.realpathSync(path.join(home, '.local', 'bin', 'vl')));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('vl argv: lancia la TUI senza argomenti; nessun prompt su argv; niente token', () => {
  const home = homeWithVl();
  try {
    const eng = () => ({ id: 'vl.native', managed: { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' } });
    // TUI: nessun argomento, niente env/token
    const r0 = resolveManagedEngine(eng(), { id: 'vl.native' }, { home, platform: 'linux', env: {} });
    assert.equal(r0.ok, true);
    assert.deepEqual(r0.engine.args, [], 'vl lancia la TUI senza argomenti');
    assert.deepEqual(r0.engine.env, {}, 'runtime locale: nessun token/credenziale');
    // anche con un prompt di cella, vl NON lo riceve su argv (TUI senza superficie prompt)
    const r1 = resolveManagedEngine(eng(), { id: 'vl.native', prompt: 'you are dev' }, { home, platform: 'linux', env: {} });
    assert.deepEqual(r1.engine.args, [], 'vl non accetta prompt su argv (TUI senza superficie prompt)');
    assert.equal(JSON.stringify(r1.engine).toLowerCase().includes('token'), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('vl describeManaged: binario assente -> non configurato (NESSUN gate di piattaforma)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlna-'));
  try {
    // nessun gate: su ogni piattaforma, binario assente -> non configurato (non "unsupported")
    for (const platform of ['linux', 'darwin', 'android', 'win32']) {
      const info = describeManaged(VL, { home, platform, env: {} });
      assert.equal(info.configured, false, `${platform}: binario assente -> non configurato`);
      assert.match(info.reason, /client vl not found/);
    }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('vl backfill: idempotente, NESSUN platform gate, non distruttivo su collisione id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncvlbf-'));
  try {
    const dp = (engines) => {
      const p = path.join(root, `f-${Math.random().toString(36).slice(2)}.json`);
      atomicWrite(p, { schemaVersion: 1, engines, cells: [] });
      return p;
    };
    const base = [{ id: 'claude.native', label: 'Claude', rc: true, managed: { client: 'claude', provider: 'native', permissionPolicy: 'unsafe' } }];
    // NESSUN platform gate: aggiunge vl.native su tutte le piattaforme
    for (const platform of ['linux', 'darwin', 'android', 'win32']) {
      const p = dp(base);
      const v = backfillVlEngine(p, loadDefinitions(p), { platform });
      assert.ok(v.engines.some((e) => e.id === 'vl.native'), `${platform}: backfill aggiunge vl.native`);
    }
    // idempotente (non duplica)
    const p1 = dp(base);
    const v1 = backfillVlEngine(p1, loadDefinitions(p1), { platform: 'linux' });
    const v1b = backfillVlEngine(p1, v1, { platform: 'linux' });
    assert.equal(v1b.engines.filter((e) => e.id === 'vl.native').length, 1);
    // collisione id: engine custom con id vl.native ma command proprio -> preservato
    const p4 = dp([{ id: 'vl.native', label: 'Custom', rc: false, command: '/bin/x', args: [], env: {}, promptMode: 'flag', promptFlag: '-p' }]);
    const v4 = backfillVlEngine(p4, loadDefinitions(p4), { platform: 'linux' });
    assert.equal(v4.engines.length, 1);
    assert.equal(v4.engines[0].command, '/bin/x', 'collisione: custom vl.native preservato, mai sovrascritto');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Il clamp standard-only di vl vive in DUE copie: normalizeManagedSpec (sopra,
// unsafe->null) e resolveManagedEngine (override PER-CELL -> standard). Questa
// e' la copia resolveManagedEngine: l'unico modo in cui 'unsafe' raggiunge
// resolve e' via cell.permissionPolicies, e quel path va ancorato ai test.
test('vl policy per-cell: override unsafe viene clampato a standard (nessun flag, NESSUN bypass)', () => {
  const home = homeWithVl();
  try {
    const engine = { id: 'vl.native', managed: { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' } };
    // override PER-CELL unsafe -> vl e' standard-only, clamp a standard, nessun flag
    const r = resolveManagedEngine(engine, { id: 'Dev', permissionPolicies: { 'vl.native': 'unsafe' } }, { home, platform: 'linux', env: {} });
    assert.equal(r.ok, true);
    assert.equal(r.info.permissionPolicy, 'standard', "vl: l'override PER-CELL unsafe e' clampato a standard");
    assert.equal(r.engine.args.includes('--always-approve'), false, 'nessun --always-approve');
    assert.equal(r.engine.args.includes('--dangerously-skip-permissions'), false);
    assert.equal(r.engine.args.includes('--yolo'), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
