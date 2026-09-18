'use strict';
// La cella protetta (codex-vl) riceve CODEX_APP_SERVER_IDENTITY_REQUIRED='1'
// SOLO in authority mode con authority costruibile. Fuori di quello il flag non
// viene esportato e il canale identita' (fd 3:4 + NEXUSCREW_IDENTITY_FD) NON
// viene creato: la decisione sul canale nasce dalla STESSA risoluzione che
// decide il flag, cosi' i due non possono divergere. Gli override espliciti
// (engine.env, cfg.env) vincono sempre; forzare '1' fuori dall'authority mode
// produce UNA riga di warning strutturato.
//
// Authority configurata ma non costruibile (credenziali assenti, identiche o con
// permessi sbagliati): il lancio e' RIFIUTATO dal launcher col codice
// IDENTITY_AUTHORITY_UNAVAILABLE — non degradato a standalone in silenzio.
// Prima si esportava '0' con una riga di log.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveManagedEngine } = require('../lib/fleet/managed.js');
const { validPayload } = require('../lib/fleet/cell-exec.js');

const KEY = 'CODEX_APP_SERVER_IDENTITY_REQUIRED';
const ENGINE = { id: 'codex-vl.native', label: 'Codex-VL', managed: { client: 'codex-vl', provider: 'native', model: '' } };

function mondo() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-idreq-'));
  const bin = path.join(home, '.local', 'bin', 'codex-vl');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.chmodSync(bin, 0o755);
  const lines = [];
  const log = (m) => lines.push(String(m));
  return { home, lines, log };
}

function resolve(mondo, cfgExtra = {}, engine = ENGINE) {
  return resolveManagedEngine(engine, { id: 'Dev', prompt: 'bootstrap' }, { home: mondo.home, env: {}, log: mondo.log, ...cfgExtra });
}

test('identity required: default legacy -> 0 e nessun canale', () => {
  const m = mondo();
  const r = resolve(m);
  assert.equal(r.ok, true);
  assert.equal(r.engine.env[KEY], '0');
  assert.equal(r.engine.identityChannel, false);
  assert.equal(r.engine.identityAuthorityUnavailable, undefined);
  assert.ok(m.lines.some((l) => l.includes('identity mode') && l.includes('legacy') && l.includes(KEY)), m.lines);
});

test('identity required: authority mode senza credenziali -> lancio rifiutato, non 0 silenzioso', () => {
  const m = mondo();
  const r = resolve(m, { fleetIdentityMode: 'authority' });
  assert.equal(r.ok, true);
  assert.equal(r.engine.env[KEY], undefined, "nessun '0' esportato: il lancio e' rifiutato");
  assert.equal(r.engine.identityChannel, false);
  assert.match(r.engine.identityAuthorityUnavailable, /authority credentials missing/);
  assert.ok(m.lines.some((l) => l.includes('launch refused') && l.includes('authority credentials missing')), m.lines);
});

test('identity required: authority mode con credenziali -> 1 e canale, senza log di degradazione', () => {
  const m = mondo();
  const r = resolve(m, {
    fleetIdentityMode: 'authority',
    identityDaemonCredential: 'd'.repeat(32),
    identityLauncherCredential: 'l'.repeat(32),
  });
  assert.equal(r.ok, true);
  assert.equal(r.engine.env[KEY], '1');
  assert.equal(r.engine.identityChannel, true);
  assert.equal(r.engine.identityAuthorityUnavailable, undefined);
  assert.equal(m.lines.filter((l) => l.includes(KEY)).length, 0);
});

test('identity required: authority gia costruita (cfg.identityAuthority) -> 1 e canale', () => {
  const m = mondo();
  const r = resolve(m, { fleetIdentityMode: 'authority', identityAuthority: { fake: true } });
  assert.equal(r.ok, true);
  assert.equal(r.engine.env[KEY], '1');
  assert.equal(r.engine.identityChannel, true);
});

test('identity required: override definition esplicito rispettato anche fuori authority', () => {
  const m = mondo();
  const engine = { ...ENGINE, env: { [KEY]: '1' } };
  const r = resolve(m, {}, engine);
  assert.equal(r.ok, true);
  assert.equal(r.engine.env[KEY], '1');
  // Override esplicito a 1 fuori authority: il canale si apre come prima
  // (comportamento invariato) e resta la riga di warning.
  assert.equal(r.engine.identityChannel, true);
  assert.equal(r.engine.identityAuthorityUnavailable, undefined);
  assert.ok(m.lines.some((l) => l.includes('override definition') && l.includes(KEY)), m.lines);
});

test('identity required: override runtime cfg.env esplicito rispettato', () => {
  const m = mondo();
  const r = resolve(m, { env: { [KEY]: '0' } });
  assert.equal(r.ok, true);
  assert.equal(r.engine.env[KEY], '0');
  assert.equal(r.engine.identityChannel, false);
  // '0' esplicito in legacy: standalone deliberato, nessun warning
  assert.equal(m.lines.filter((l) => l.includes('override')).length, 0);
});

test('identity required: override definition vince su cfg.env', () => {
  const m = mondo();
  const engine = { ...ENGINE, env: { [KEY]: '0' } };
  const r = resolve(m, { env: { [KEY]: '1' } }, engine);
  assert.equal(r.ok, true);
  assert.equal(r.engine.env[KEY], '0');
  assert.equal(r.engine.identityChannel, false);
});

test('identity required: override esplicito 0 in authority mode -> standalone deliberato, nessun rifiuto', () => {
  const m = mondo();
  const r = resolve(m, { fleetIdentityMode: 'authority', env: { [KEY]: '0' } });
  assert.equal(r.ok, true);
  assert.equal(r.engine.env[KEY], '0');
  assert.equal(r.engine.identityChannel, false);
  assert.equal(r.engine.identityAuthorityUnavailable, undefined);
});

test('identity required: credenziali identiche nei file -> lancio rifiutato col fault', () => {
  const m = mondo();
  const dir = path.join(m.home, '.nexuscrew', 'identity-authority');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'daemon.credential'), 'uguale\n', { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'launcher.credential'), 'uguale\n', { mode: 0o600 });
  // Come in produzione: il runtime passa il cfg di loadConfig, che ha letto i
  // file e registrato il fault.
  const cfg = require('../lib/config.js').loadConfig({ home: m.home });
  const r = resolve(m, { ...cfg, fleetIdentityMode: 'authority' });
  assert.equal(r.ok, true);
  assert.equal(r.engine.env[KEY], undefined);
  assert.equal(r.engine.identityChannel, false);
  assert.ok((cfg.identityAuthorityFault || '').includes('identical'), cfg.identityAuthorityFault);
  assert.match(r.engine.identityAuthorityUnavailable, /identical/);
  assert.ok(m.lines.some((l) => l.includes('identical')), m.lines);
});

test('identity required: cfg con credenziali esplicite identiche -> lancio rifiutato col fault', () => {
  const m = mondo();
  const r = resolve(m, {
    fleetIdentityMode: 'authority',
    identityDaemonCredential: 'stesso',
    identityLauncherCredential: 'stesso',
  });
  assert.equal(r.ok, true);
  assert.equal(r.engine.env[KEY], undefined);
  assert.equal(r.engine.identityChannel, false);
  assert.match(r.engine.identityAuthorityUnavailable, /identical/);
  assert.ok(m.lines.some((l) => l.includes('identical')), m.lines);
});

// : il buco era che NESSUN test alimentava `validPayload()` col payload
// REALE prodotto dal launcher. `managed.js` (:2233) aggiunge `identityChannel`
// e `runtime.js` (:289-296) lo mette nel payload del broker, ma la whitelist
// di `cell-exec.js` (:114) elencava solo command/args/env/supervise/
// restartPrompt/lease/identity: chiave ignota -> payload rifiutato ->
// `invalid launch payload` -> CLIENT_EARLY_EXIT, la cella non nasceva.
// Qui il payload nasce dalla STESSA risoluzione che decide il flag (managed.js)
// e viene composto come lo compone runtime.js, poi passa al validatore vero.
function payloadDalLauncher(engine, extra = {}) {
  return {
    command: '/bin/true',
    args: [],
    env: { PATH: '/bin' },
    supervise: { enabled: false },
    ...(typeof engine.identityChannel === 'boolean' ? { identityChannel: engine.identityChannel } : {}),
    ...extra,
  };
}

test(': payload legacy prodotto dal launcher -> validPayload true', () => {
  const r = resolve(mondo());
  assert.equal(r.ok, true);
  assert.equal(r.engine.identityChannel, false);
  const payload = payloadDalLauncher(r.engine);
  assert.equal(payload.identityChannel, false, 'il launcher mette la chiave in legacy');
  assert.equal(validPayload(payload), true, 'il payload reale in legacy deve essere accettato');
});

test(': payload authority prodotto dal launcher -> validPayload true', () => {
  const r = resolve(mondo(), {
    fleetIdentityMode: 'authority',
    identityDaemonCredential: 'd'.repeat(32),
    identityLauncherCredential: 'l'.repeat(32),
  });
  assert.equal(r.ok, true);
  assert.equal(r.engine.identityChannel, true);
  assert.equal(validPayload(payloadDalLauncher(r.engine)), true);
});

test(': identityChannel non booleano -> payload invalido', () => {
  const base = { command: '/bin/true', args: [], env: { PATH: '/bin' }, supervise: { enabled: false } };
  assert.equal(validPayload({ ...base, identityChannel: false }), true);
  assert.equal(validPayload({ ...base, identityChannel: true }), true);
  assert.equal(validPayload({ ...base, identityChannel: 'no' }), false, 'stringa: rifiutata');
  assert.equal(validPayload({ ...base, identityChannel: 0 }), false, '0 non e un booleano');
  assert.equal(validPayload({ ...base, identityChannel: null }), false);
});

test(': chiamante precedente senza la chiave -> ancora accettato', () => {
  const base = { command: '/bin/true', args: [], env: { PATH: '/bin' }, supervise: { enabled: false } };
  assert.equal(validPayload(base), true);
});
