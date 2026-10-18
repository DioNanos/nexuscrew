'use strict';
// OpenCode client nativo (opencode.native) managed adapter — catalogo, argv
// (-m provider/model col prefisso gateway, --prompt, --auto solo unsafe),
// env vuoto di default, envPassthrough OPENCODE_CONFIG opt-in per nome.
// Tutto MISURATO su opencode 1.18.33: --standalone non
// esiste, ogni invocazione ha il proprio server; il posizionale e' il PATH di
// progetto, quindi il prompt di cella viaggia su --prompt.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  normalizeManagedSpec, describeManaged, resolveManagedEngine, publicCatalog,
  CLIENT_ORDER, isStandardClient, engineClient,
} = require('../lib/fleet/managed.js');

const OC = { client: 'opencode', provider: 'native', model: '', permissionPolicy: 'standard' };
const OC_UNSAFE = { client: 'opencode', provider: 'native', model: '', permissionPolicy: 'unsafe' };

function homeWithOpencode() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ncoc-'));
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  const bin = path.join(home, '.local', 'bin', 'opencode');
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(bin, 0o755);
  return home;
}

function eng(managed) {
  return { id: 'opencode.native', managed: managed || { ...OC } };
}

test('opencode: normalizeManagedSpec ammette standard e unsafe; publicCatalog include opencode.native', () => {
  assert.deepEqual(normalizeManagedSpec(OC), { client: 'opencode', provider: 'native', model: '', permissionPolicy: 'standard' });
  assert.equal(normalizeManagedSpec(OC_UNSAFE).permissionPolicy, 'unsafe');
  assert.equal(normalizeManagedSpec({ client: 'opencode', provider: 'native', permissionPolicy: 'bogus' }), null);
  assert.equal(normalizeManagedSpec({ client: 'opencode', provider: 'zai' }), null, 'provider inesistente per il client opencode');
  // nessun passthrough obbligatorio sul profilo: la cella di default parte
  // anche senza OPENCODE_CONFIG (config globale/di progetto del client).
  assert.equal(normalizeManagedSpec(OC).envPassthrough, undefined);
  const cat = publicCatalog().find((p) => p.id === 'opencode.native');
  assert.ok(cat, 'opencode.native nel catalogo');
  assert.equal(cat.clientLabel, 'opencode');
  assert.equal(cat.auth, 'login');
  assert.equal(cat.credentialEnv, false, 'login delegato al client, nessuna KEY section');
  assert.equal(cat.notice, 'opencode-native');
  assert.equal(cat.supportsUnsafe, true);
  assert.equal(cat.permissionPolicyDefault, 'standard');
  assert.equal(cat.mcpManaged, false, 'MCP nel file di config di opencode, non gestito da NexusCrew');
  assert.deepEqual(cat.models, [], 'nessun elenco statico: il gateway ruota i modelli');
  assert.equal(cat.requiresModel, false, 'modello libero, gateway free anche senza login');
});

test('opencode: describeManaged configura con binario; auth delegata al login del client', () => {
  const home = homeWithOpencode();
  try {
    const ok = describeManaged(OC, { home, env: {} });
    assert.equal(ok.configured, true);
    assert.equal(ok.authConfigured, true, 'auth login delegata, sempre configurata');
    assert.equal(ok.auth, 'login');
    assert.equal(ok.reason, 'ready');
    assert.equal(ok.binary, path.join(home, '.local', 'bin', 'opencode'));
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('opencode argv: standard=nessun flag; unsafe=--auto; -m prefissa il gateway solo senza slash; env vuoto', () => {
  const home = homeWithOpencode();
  try {
    // standard, no model -> TUI interattivo (nessun arg)
    const r0 = resolveManagedEngine(eng(), { id: 'opencode.native' }, { home, env: {} });
    assert.equal(r0.ok, true);
    assert.deepEqual(r0.engine.args, []);
    assert.deepEqual(r0.engine.env, {}, 'nessun env provider o credenziale');
    // unsafe -> --auto (flag reale 1.18.33, auto-approve permissions)
    const r1 = resolveManagedEngine(eng({ ...OC_UNSAFE }), { id: 'opencode.native' }, { home, env: {} });
    assert.deepEqual(r1.engine.args, ['--auto']);
    // modello gateway senza slash -> prefisso opencode/
    const r2 = resolveManagedEngine(eng({ ...OC, model: 'nemotron-3.5-lightning-free' }), { id: 'opencode.native' }, { home, env: {} });
    assert.deepEqual(r2.engine.args, ['-m', 'opencode/nemotron-3.5-lightning-free']);
    // unsafe + modello -> ordine esatto: --auto, -m
    const r3 = resolveManagedEngine(eng({ ...OC_UNSAFE, model: 'kimi-k2.5-free' }), { id: 'opencode.native' }, { home, env: {} });
    assert.deepEqual(r3.engine.args, ['--auto', '-m', 'opencode/kimi-k2.5-free']);
    // id gia' prefissato (provider esplicito) passa tale e quale
    const r4 = resolveManagedEngine(eng({ ...OC, model: 'envtest/ministral-3:3b-cloud' }), { id: 'opencode.native' }, { home, env: {} });
    assert.deepEqual(r4.engine.args, ['-m', 'envtest/ministral-3:3b-cloud']);
    // il posizionale resta libero: e' il PATH di progetto, mai testo
    for (const r of [r0, r1, r2, r3, r4]) assert.equal(r.engine.args.includes('you are dev'), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('opencode prompt: --prompt + testo in coda (managed-argv), mai il testo nudo su argv', () => {
  const home = homeWithOpencode();
  try {
    const r = resolveManagedEngine(eng(), { id: 'opencode.native', prompt: 'you are dev' }, { home, env: {} });
    assert.equal(r.ok, true);
    assert.deepEqual(r.engine.args, ['--prompt', 'you are dev'], 'flag --prompt col valore subito dopo');
    assert.equal(r.engine.promptMode, 'managed-argv', 'consegna via argv: il classifier send-keys non copre opencode');
    // con modello: -m prima, --prompt dopo
    const r2 = resolveManagedEngine(eng({ ...OC, model: 'nemotron-3.5-lightning-free' }), { id: 'opencode.native', prompt: 'you are dev' }, { home, env: {} });
    assert.deepEqual(r2.engine.args, ['-m', 'opencode/nemotron-3.5-lightning-free', '--prompt', 'you are dev']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('opencode envPassthrough: OPENCODE_CONFIG opt-in per nome, fail-closed col nome assente', () => {
  const home = homeWithOpencode();
  try {
    const withPass = { ...OC, envPassthrough: ['OPENCODE_CONFIG'] };
    const cfgOk = { home, env: { OPENCODE_CONFIG: '/cells/research/opencode.jsonc' } };
    const r = resolveManagedEngine(eng(withPass), { id: 'opencode.native' }, cfgOk);
    assert.equal(r.ok, true);
    assert.equal(r.engine.env.OPENCODE_CONFIG, '/cells/research/opencode.jsonc', 'per-cell config consegnata alla cella');
    assert.deepEqual(r.engine.args, [], 'il passthrough non tocca argv');
    // dichiarato ma assente ovunque -> blocco con il NOME, non silenzio
    const rMissing = resolveManagedEngine(eng(withPass), { id: 'opencode.native' }, { home, env: {} });
    assert.equal(rMissing.ok, false);
    assert.match(rMissing.reason, /OPENCODE_CONFIG.*not set/, 'il motivo nomina la variabile');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('opencode e\' standard: in CLIENT_ORDER tra pi e agy; engineClient derivato dal primo segmento', () => {
  assert.equal(isStandardClient('opencode'), true);
  assert.ok(CLIENT_ORDER.includes('pi') && CLIENT_ORDER.includes('agy'));
  assert.ok(CLIENT_ORDER.indexOf('pi') < CLIENT_ORDER.indexOf('opencode'), 'dopo pi');
  assert.ok(CLIENT_ORDER.indexOf('opencode') < CLIENT_ORDER.indexOf('agy'), 'prima di agy');
  assert.equal(engineClient({ id: 'opencode.native', managed: { client: 'opencode', provider: 'native' } }), 'opencode');
  assert.equal(engineClient({ id: 'opencode.native' }), 'opencode', 'senza managed: primo segmento dell\'id');
});
