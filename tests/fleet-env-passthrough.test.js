'use strict';

// D3: envPassthrough — passthrough env OPT-IN PER NOME verso il child, mai in
// blocco. Il ramo `vl` di resolveManagedEngine (managed.js) non compone env
// provider (auth 'none'): il runtime VL/Vivling legge le sue variabili da
// config.toml / env proprie, ma il nome di quella da cui legge la chiave NON e'
// fisso nel binario (vivling/src/main.rs). Una patch locale di SysAdmin
// passava un nome hardcoded: si perdeva a ogni npm upgrade. La via generale e'
// che l'operatore dichiari, nello spec managed, l'elenco dei NOMI che la sua
// config vuole vedere nel child. NexusCrew li risolve dalle credentialSources e
// li inietta; un nome dichiarato ma assente da ogni source NON fa partire la
// cella in silenzio — il reason lo nomina, cosi' una cella mal configurata dice
// cosa manca invece di partire muta e rompere dopo.
//
// Vincoli (credenziale) onorati qui sotto e pinanti:
//  - MAI in blocco: solo i nomi elencati, ciascuno un ENV_KEY_RE valido;
//  - un nome non presente nelle source -> ok:false con reason che lo nomina;
//  - nessuna regressione: envPassthrough assente = spec byte-identica a prima.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeManagedSpec, resolveManagedEngine } = require('../lib/fleet/managed.js');

function world() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-envpass-'));
  fs.chmodSync(home, 0o700);
  const vl = path.join(home, '.local', 'bin', 'vl');
  fs.mkdirSync(path.dirname(vl), { recursive: true });
  fs.writeFileSync(vl, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return home;
}

function vlEngine(passthrough) {
  return {
    id: 'vl.native', label: 'VL',
    managed: { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard', ...(passthrough ? { envPassthrough: passthrough } : {}) },
  };
}

// --- normalizeManagedSpec: validazione dell'allowlist -----------------------

test('D3 normalize: allowlist valida passa e trimma i nomi', () => {
  const s = normalizeManagedSpec({ client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard', envPassthrough: ['VL_API_KEY', '  VL_ENDPOINT  '] });
  assert.ok(s);
  assert.deepEqual(s.envPassthrough, ['VL_API_KEY', 'VL_ENDPOINT']);
});

test('D3 normalize: assente = no-op, spec identica a prima (no regressione)', () => {
  const s = normalizeManagedSpec({ client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' });
  assert.ok(s);
  assert.equal(Object.prototype.hasOwnProperty.call(s, 'envPassthrough'), false);
  assert.deepEqual(s, { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' });
});

test('D3 normalize: rifiuta non-array, vuoto, non-stringa, nome invalido, duplicato, oltre tetto', () => {
  const base = { client: 'vl', provider: 'native', model: '', permissionPolicy: 'standard' };
  assert.equal(normalizeManagedSpec({ ...base, envPassthrough: 'VL_API_KEY' }), null, 'stringa non array');
  assert.equal(normalizeManagedSpec({ ...base, envPassthrough: [] }), null, 'vuoto');
  assert.equal(normalizeManagedSpec({ ...base, envPassthrough: [42] }), null, 'elemento non-stringa');
  assert.equal(normalizeManagedSpec({ ...base, envPassthrough: ['bad name!'] }), null, 'nome non ENV_KEY_RE');
  assert.equal(normalizeManagedSpec({ ...base, envPassthrough: ['1LEADING_DIGIT'] }), null, 'nome con cifra iniziale');
  assert.equal(normalizeManagedSpec({ ...base, envPassthrough: ['A', 'A'] }), null, 'duplicato');
  assert.equal(normalizeManagedSpec({ ...base, envPassthrough: ['   '] }), null, 'solo whitespace -> nome vuoto dopo trim');
  // 'a ' viene trimmato a 'a' (valido): lo spazio in coda NON e' un errore.
  assert.ok(normalizeManagedSpec({ ...base, envPassthrough: ['a '] }), 'spazio in coda trimmato, nome valido');
  const troppi = Array.from({ length: 33 }, (_, i) => `V${i}`);
  assert.equal(normalizeManagedSpec({ ...base, envPassthrough: troppi }), null, 'oltre il tetto MAX_ENV_PASSTHROUGH');
  // Il tetto e' 32: 32 nomi sono ammessi.
  assert.ok(normalizeManagedSpec({ ...base, envPassthrough: troppi.slice(0, 32) }), '32 nomi ammessi');
});

test('D3 normalize: disponibile per qualunque client, non solo vl', () => {
  // L'allowlist e' uno strumento generale; per claude/codex/pi si aggiunge ai
  // nomi che il ramo provider compone gia'. La validazione non qualifica per client.
  const s = normalizeManagedSpec({ client: 'codex-vl', provider: 'openai-api', model: 'gpt-x', envPassthrough: ['EXTRA_VAR'] });
  assert.ok(s);
  assert.deepEqual(s.envPassthrough, ['EXTRA_VAR']);
});

// --- resolveManagedEngine: risoluzione dalle credentialSources ---------------

test('D3 resolve: nomi presenti nel runtime vengono iniettati; vl non riceve argv', () => {
  const home = world();
  try {
    const r = resolveManagedEngine(vlEngine(['VL_API_KEY', 'VL_ENDPOINT']), { id: 'Dev' }, { home, env: { VL_API_KEY: 'secret-1', VL_ENDPOINT: 'https://host' } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.engine.env, { VL_API_KEY: 'secret-1', VL_ENDPOINT: 'https://host' });
    assert.deepEqual(r.engine.args, [], 'vl non riceve argv (ramo vl vuoto)');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('D3 resolve: ordine di risoluzione runtime -> store -> shell -> keys -> legacy', () => {
  const home = world();
  try {
    // runtime vince su legacy: stesso nome in entrambi, passa il valore runtime.
    const secrets = path.join(home, '.nexuscrew', 'providers.env');
    fs.mkdirSync(path.dirname(secrets), { recursive: true });
    fs.writeFileSync(secrets, 'VL_K=legacy-val\n', { mode: 0o600 });
    const r = resolveManagedEngine(vlEngine(['VL_K']), { id: 'Dev' }, { home, env: { VL_K: 'runtime-val' } });
    assert.equal(r.ok, true);
    assert.equal(r.engine.env.VL_K, 'runtime-val');
    // legacy da solo (runtime vuoto) viene comunque risolto.
    const r2 = resolveManagedEngine(vlEngine(['VL_K']), { id: 'Dev' }, { home, env: {} });
    assert.equal(r2.ok, true);
    assert.equal(r2.engine.env.VL_K, 'legacy-val');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('D3 resolve: nome dichiarato ma assente -> ok:false con reason che NOMINA il nome', () => {
  const home = world();
  try {
    const r = resolveManagedEngine(vlEngine(['VL_API_KEY', 'VL_MISSING']), { id: 'Dev' }, { home, env: { VL_API_KEY: 'x' } });
    assert.equal(r.ok, false);
    assert.match(r.reason, /VL_MISSING/);
    assert.match(r.reason, /credential source/i);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('D3 resolve: senza envPassthrough il ramo vl resta vuoto (no regressione)', () => {
  const home = world();
  try {
    const r = resolveManagedEngine(vlEngine(null), { id: 'Dev' }, { home, env: { UNRELATED: 'x' } });
    assert.equal(r.ok, true);
    assert.deepEqual(r.engine.env, {});
    assert.deepEqual(r.engine.args, []);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('D3 resolve: i valori passano nel child env e mai su argv o info', () => {
  const home = world();
  try {
    const r = resolveManagedEngine(vlEngine(['VL_API_KEY']), { id: 'Dev' }, { home, env: { VL_API_KEY: 'do-not-leak' } });
    assert.equal(r.ok, true);
    assert.equal(r.engine.env.VL_API_KEY, 'do-not-leak');
    assert.equal(r.engine.args.join('\n').includes('do-not-leak'), false, 'mai su argv');
    assert.equal(JSON.stringify(r.info).includes('do-not-leak'), false, 'mai in info');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
