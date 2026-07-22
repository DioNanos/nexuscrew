'use strict';
// Agy (agy.native) managed client adapter — normalizzazione, platform gate,
// argv (prompt ultimo), backfill platform-aware. (NexusCrew 0.8.31 §4.2)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeManagedSpec, describeManaged, resolveManagedEngine, publicCatalog } = require('../lib/fleet/managed.js');
const { backfillAgyEngine } = require('../lib/fleet/builtin.js');
const { loadDefinitions, atomicWrite } = require('../lib/fleet/definitions.js');

const AGY = { client: 'agy', provider: 'native', model: '', permissionPolicy: 'standard' };
const AGY_UNSAFE = { client: 'agy', provider: 'native', model: '', permissionPolicy: 'unsafe' };

function homeWithAgy() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncagy-'));
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const bin = path.join(home, '.local', 'bin', 'agy');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(bin, 0o755);
  return home;
}

test('agy: normalizeManagedSpec ammette standard e unsafe; catalogo/publicCatalog includono agy.native', () => {
  assert.deepEqual(normalizeManagedSpec(AGY), { client: 'agy', provider: 'native', model: '', permissionPolicy: 'standard' });
  assert.equal(normalizeManagedSpec(AGY_UNSAFE).permissionPolicy, 'unsafe');
  assert.equal(normalizeManagedSpec({ client: 'agy', provider: 'native', permissionPolicy: 'bogus' }), null);
  const cat = publicCatalog().find((p) => p.id === 'agy.native');
  assert.ok(cat, 'agy.native nel catalogo');
  assert.equal(cat.supportsUnsafe, true);
  assert.equal(cat.permissionPolicyDefault, 'standard');
  assert.equal(cat.rc, false);
});

test('agy platform gate: configurato solo su linux/darwin non-Termux; rifiutato su Termux/Windows', () => {
  const home = homeWithAgy();
  try {
    // Termux mascherato da linux (PREFIX com.termux) -> unsupported
    const termux = describeManaged(AGY, { home, platform: 'linux', env: { PREFIX: '/data/data/com.termux/files/usr' } });
    assert.equal(termux.configured, false);
    assert.match(termux.reason, /non supportato su questa piattaforma/);
    // android esplicito -> unsupported
    assert.equal(describeManaged(AGY, { home, platform: 'android' }).configured, false);
    // win32 -> unsupported
    assert.equal(describeManaged(AGY, { home, platform: 'win32' }).configured, false);
    // linux non-Termux con binary presente -> configured
    assert.equal(describeManaged(AGY, { home, platform: 'linux', env: {} }).configured, true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('agy argv: standard=nessun flag; unsafe=--dangerously-skip-permissions; --model poi --prompt-interactive ULTIMO', () => {
  const home = homeWithAgy();
  try {
    const eng = (pp) => ({ id: 'agy.native', managed: { client: 'agy', provider: 'native', model: '', permissionPolicy: pp } });
    // standard, no model, no prompt -> TUI interattivo (nessun arg)
    const r0 = resolveManagedEngine(eng('standard'), { id: 'agy.native' }, { home, platform: 'linux', env: {} });
    assert.equal(r0.ok, true);
    assert.deepEqual(r0.engine.args, []);
    // unsafe + model + prompt -> ordine esatto: skip-perm, --model, --prompt-interactive, <prompt>
    const r1 = resolveManagedEngine(eng('unsafe'), { id: 'agy.native', model: 'opus', prompt: 'you are dev' }, { home, platform: 'linux', env: {} });
    assert.equal(r1.ok, true);
    assert.deepEqual(r1.engine.args, ['--dangerously-skip-permissions', '--model', 'opus', '--prompt-interactive', 'you are dev']);
    // standard + model, nessun prompt -> nessun --prompt-interactive
    const r2 = resolveManagedEngine(eng('standard'), { id: 'agy.native', model: 'sonnet' }, { home, platform: 'linux', env: {} });
    assert.deepEqual(r2.engine.args, ['--model', 'sonnet']);
    // prompt e' SEMPRE l'ultimo argomento (mai flag dopo)
    const r3 = resolveManagedEngine(eng('standard'), { id: 'agy.native', prompt: 'p1' }, { home, platform: 'linux', env: {} });
    assert.equal(r3.engine.args[r3.engine.args.length - 1], 'p1');
    assert.equal(r3.engine.args[r3.engine.args.length - 2], '--prompt-interactive');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('agy backfill: idempotente, platform-aware, non distruttivo su collisione id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ncagybf-'));
  try {
    const dp = (engines) => {
      const p = path.join(root, `f-${Math.random().toString(36).slice(2)}.json`);
      atomicWrite(p, { schemaVersion: 1, engines, cells: [] });
      return p;
    };
    const base = [{ id: 'claude.native', label: 'Claude', rc: true, managed: { client: 'claude', provider: 'native', permissionPolicy: 'unsafe' } }];
    // linux -> aggiunge agy.native
    const p1 = dp(base);
    const a1 = backfillAgyEngine(p1, loadDefinitions(p1), { platform: 'linux' });
    assert.ok(a1.engines.some((e) => e.id === 'agy.native'));
    // idempotente
    const a1b = backfillAgyEngine(p1, a1, { platform: 'linux' });
    assert.equal(a1b.engines.filter((e) => e.id === 'agy.native').length, 1);
    // android -> no-op
    const p2 = dp(base);
    const a2 = backfillAgyEngine(p2, loadDefinitions(p2), { platform: 'android' });
    assert.equal(a2.engines.some((e) => e.id === 'agy.native'), false);
    // darwin -> aggiunge
    const p3 = dp(base);
    assert.ok(backfillAgyEngine(p3, loadDefinitions(p3), { platform: 'darwin' }).engines.some((e) => e.id === 'agy.native'));
    // collisione id: engine custom con id agy.native ma client diverso -> preservato
    const p4 = dp([{ id: 'agy.native', label: 'Custom', rc: false, command: '/bin/x', args: [], env: {}, promptMode: 'flag', promptFlag: '-p' }]);
    const a4 = backfillAgyEngine(p4, loadDefinitions(p4), { platform: 'linux' });
    assert.equal(a4.engines.length, 1);
    assert.equal(a4.engines[0].command, '/bin/x', 'collisione: custom agy.native preservato');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
