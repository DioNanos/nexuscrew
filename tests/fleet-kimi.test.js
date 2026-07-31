'use strict';
// Kimi Code CLI nativo (kimi.native) managed client adapter — normalizzazione,
// argv (--yolo solo unsafe, --model, MAI prompt su argv), promptMode send-keys,
// backfill idempotente senza platform gate, coesistenza con claude.kimi-code.
// (NexusCrew 0.8.46)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeManagedSpec, describeManaged, resolveManagedEngine, publicCatalog } = require('../lib/fleet/managed.js');
const { backfillKimiEngine } = require('../lib/fleet/builtin.js');
const { loadDefinitions, atomicWrite } = require('../lib/fleet/definitions.js');

const KIMI = { client: 'kimi', provider: 'native', model: '', permissionPolicy: 'standard' };
const KIMI_UNSAFE = { client: 'kimi', provider: 'native', model: '', permissionPolicy: 'unsafe' };

function homeWithKimi() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nckimi-'));
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const bin = path.join(home, '.local', 'bin', 'kimi');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(bin, 0o755);
  return home;
}

test('kimi: normalizeManagedSpec ammette standard e unsafe; catalogo/publicCatalog includono kimi.native', () => {
  assert.deepEqual(normalizeManagedSpec(KIMI), { client: 'kimi', provider: 'native', model: '', permissionPolicy: 'standard' });
  assert.equal(normalizeManagedSpec(KIMI_UNSAFE).permissionPolicy, 'unsafe');
  assert.equal(normalizeManagedSpec({ client: 'kimi', provider: 'native', permissionPolicy: 'bogus' }), null);
  assert.equal(normalizeManagedSpec({ client: 'kimi', provider: 'kimi-code' }), null, 'provider inesistente per il client kimi');
  const cat = publicCatalog().find((p) => p.id === 'kimi.native');
  assert.ok(cat, 'kimi.native nel catalogo');
  assert.equal(cat.clientLabel, 'Kimi Code CLI');
  assert.equal(cat.supportsUnsafe, true);
  assert.equal(cat.permissionPolicyDefault, 'standard');
  assert.equal(cat.rc, false);
  assert.equal(cat.auth, 'login');
  assert.equal(cat.credentialEnv, false, 'login delegato al CLI, nessuna KEY section');
  assert.equal(cat.notice, 'kimi-native');
});

test('kimi: describeManaged configura con binario; auth delegata al login del CLI', () => {
  const home = homeWithKimi();
  try {
    const ok = describeManaged(KIMI, { home, env: {} });
    assert.equal(ok.configured, true);
    assert.equal(ok.authConfigured, true, 'auth login delegata al CLI, sempre configurata');
    assert.equal(ok.auth, 'login');
    assert.equal(ok.reason, 'ready');
    assert.equal(ok.binary, path.join(home, '.local', 'bin', 'kimi'), 'preferisce il binario in ~/.local/bin');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('kimi argv: standard=nessun flag; unsafe=--yolo (MAI --auto); --model opzionale; env vuoto', () => {
  const home = homeWithKimi();
  try {
    const eng = (pp) => ({ id: 'kimi.native', managed: { client: 'kimi', provider: 'native', model: '', permissionPolicy: pp } });
    // standard, no model, no prompt -> TUI interattivo (nessun arg)
    const r0 = resolveManagedEngine(eng('standard'), { id: 'kimi.native' }, { home, env: {} });
    assert.equal(r0.ok, true);
    assert.deepEqual(r0.engine.args, []);
    assert.deepEqual(r0.engine.env, {}, 'nessun env provider o credenziale');
    // unsafe -> --yolo; --auto NON mappato (fully autonomous fuori contratto)
    const r1 = resolveManagedEngine(eng('unsafe'), { id: 'kimi.native' }, { home, env: {} });
    assert.deepEqual(r1.engine.args, ['--yolo']);
    assert.equal(r1.engine.args.includes('--auto'), false);
    // unsafe + model -> ordine esatto: --yolo, --model
    const r2 = resolveManagedEngine(eng('unsafe'), { id: 'kimi.native', model: 'k3' }, { home, env: {} });
    assert.deepEqual(r2.engine.args, ['--yolo', '--model', 'k3']);
    // standard + model
    const r3 = resolveManagedEngine(eng('standard'), { id: 'kimi.native', model: 'k3' }, { home, env: {} });
    assert.deepEqual(r3.engine.args, ['--model', 'k3']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('kimi prompt: MAI su argv (kimi -p e non-interattivo); promptMode send-keys con bracketed paste', () => {
  const home = homeWithKimi();
  try {
    const eng = { id: 'kimi.native', managed: { client: 'kimi', provider: 'native', model: '', permissionPolicy: 'standard' } };
    const r = resolveManagedEngine(eng, { id: 'kimi.native', prompt: 'you are dev' }, { home, env: {} });
    assert.equal(r.ok, true);
    assert.equal(r.engine.promptMode, 'send-keys');
    assert.deepEqual(r.engine.args, [], 'prompt assente da argv');
    assert.equal(r.engine.args.includes('you are dev'), false);
    // gli altri client managed conservano managed-argv
    const claude = resolveManagedEngine(
      { id: 'claude.native', managed: { client: 'claude', provider: 'native', model: '', permissionPolicy: 'standard' } },
      { id: 'claude.native', prompt: 'p' }, { home, env: {} },
    );
    if (claude.ok) assert.equal(claude.engine.promptMode, 'managed-argv');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('kimi backfill: idempotente, senza platform gate, non distruttivo su collisione id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nckimibf-'));
  try {
    const dp = (engines) => {
      const p = path.join(root, `f-${Math.random().toString(36).slice(2)}.json`);
      atomicWrite(p, { schemaVersion: 1, engines, cells: [] });
      return p;
    };
    const base = [{ id: 'claude.native', label: 'Claude', rc: true, managed: { client: 'claude', provider: 'native', permissionPolicy: 'unsafe' } }];
    // aggiunge kimi.native
    const p1 = dp(base);
    const a1 = backfillKimiEngine(p1, loadDefinitions(p1));
    assert.ok(a1.engines.some((e) => e.id === 'kimi.native'));
    const kimi = a1.engines.find((e) => e.id === 'kimi.native');
    assert.equal(kimi.label, 'Kimi Code CLI');
    assert.deepEqual(kimi.managed, { client: 'kimi', provider: 'native', model: '', permissionPolicy: 'standard' });
    // idempotente
    const a1b = backfillKimiEngine(p1, a1);
    assert.equal(a1b.engines.filter((e) => e.id === 'kimi.native').length, 1);
    // client kimi gia' presente con altro id -> skip
    const p2 = dp([{ id: 'kimi.custom-id', label: 'K', rc: false, managed: { client: 'kimi', provider: 'native', model: '', permissionPolicy: 'standard' } }]);
    assert.equal(backfillKimiEngine(p2, loadDefinitions(p2)).engines.length, 1);
    // collisione id: engine custom con id kimi.native ma non managed -> preservato
    const p3 = dp([{ id: 'kimi.native', label: 'Custom', rc: false, command: '/bin/x', args: [], env: {}, promptMode: 'flag', promptFlag: '-p' }]);
    const a3 = backfillKimiEngine(p3, loadDefinitions(p3));
    assert.equal(a3.engines.length, 1);
    assert.equal(a3.engines[0].command, '/bin/x', 'collisione: custom kimi.native preservato');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('kimi native e claude.kimi-code restano due percorsi distinti', () => {
  const kimi = publicCatalog().find((p) => p.id === 'kimi.native');
  const claudeKimi = publicCatalog().find((p) => p.id === 'claude.kimi-code');
  assert.ok(kimi && claudeKimi, 'entrambi i percorsi nel catalogo');
  assert.notEqual(kimi.client, claudeKimi.client);
  assert.equal(claudeKimi.credentialEnv, 'KIMI_API_KEY', 'claude.kimi-code conserva la chiave gestita');
  assert.deepEqual(claudeKimi.models, ['k3', 'k3[1m]', 'kimi-for-coding', 'kimi-for-coding-highspeed'], 'K3 1M preservato');
  assert.equal(kimi.credentialEnv, false, 'kimi nativo non espone chiavi gestite');
  // normalize: stessi provider id non si confondono tra client
  assert.equal(normalizeManagedSpec({ client: 'kimi', provider: 'kimi-code' }), null);
  assert.ok(normalizeManagedSpec({ client: 'claude', provider: 'kimi-code', model: 'k3[1m]' }));
});
