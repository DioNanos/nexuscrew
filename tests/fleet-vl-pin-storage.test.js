'use strict';
// Lo storage del pin locale e' parte del confine di fiducia: la directory e il
// file devono essere nostri e privati (0700/0600), il pin si legge per
// descriptor senza seguire link e con identita' coerente, i sottoschemi sono
// chiusi, e la pubblicazione resta atomica anche dove i filesystem Android
// negano i link (fallback esclusivo 0600 + fsync).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const locale = require('../lib/fleet/vl-claim-pin-local.js');
const roots = require('../lib/fleet/vl-roots.js');

const HELPER = roots.MANIFEST.helper.sha256;
function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function prefisso(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pin-storage-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  const node = path.join(bin, 'node');
  const flock = path.join(bin, 'flock');
  fs.writeFileSync(node, '#!/bin/sh\nexit 0\n', { mode: 0o500 });
  fs.writeFileSync(flock, '#!/bin/sh\necho "flock from util-linux 2.39.3"\n', { mode: 0o500 });
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  return { dir, home, node, flock };
}

const deps = (p) => ({ platform: 'android', arch: 'arm64', execPath: p.node, versioneQualificata: () => '2.39.3' });

function provisiona(p, extra = {}) {
  return locale.provisiona({ home: p.home, flock: p.flock, node: p.node, helperHash: HELPER, by: 'prova', deps: deps(p), ...extra });
}

test('R2: una .nexuscrew preesistente non privata non si usa e non si corregge', (t) => {
  const p = prefisso(t);
  const dir = path.join(p.home, '.nexuscrew');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o777);
  const r = provisiona(p);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, 'PIN_DIR');
  assert.equal((fs.lstatSync(dir).mode & 0o777), 0o777, 'directory altrui modificata');
  assert.equal(fs.existsSync(locale.percorso(p.home)), false);
});

test('R2: un pin con modo non privato non si legge', (t) => {
  const p = prefisso(t);
  assert.equal(provisiona(p).ok, true);
  const file = locale.percorso(p.home);
  fs.chmodSync(file, 0o666);
  const v = locale.verifica({ home: p.home, helperHash: HELPER, deps: deps(p) });
  assert.equal(v.ok, false, JSON.stringify(v));
  assert.equal(v.code, 'PIN_REREAD');
  assert.equal(v.motivo, 'modo');
});

test('R2: il pin si legge per descriptor senza seguire link (symlink rifiutato)', (t) => {
  const p = prefisso(t);
  assert.equal(provisiona(p).ok, true);
  const file = locale.percorso(p.home);
  const vero = path.join(p.dir, 'altro.json');
  fs.renameSync(file, vero);
  fs.symlinkSync(vero, file);
  const letto = locale.leggi(p.home);
  assert.equal(letto.stato, 'illeggibile');
  assert.equal(letto.motivo, 'tipo');
});

test('R2: un pin troncato non si interpreta', (t) => {
  const p = prefisso(t);
  assert.equal(provisiona(p).ok, true);
  const file = locale.percorso(p.home);
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, '{"v":1,');
  const letto = locale.leggi(p.home);
  assert.equal(letto.stato, 'illeggibile');
  assert.equal(letto.motivo, 'json');
});

test('R2: i sottoschemi sono chiusi (campo extra dentro un componente rifiutato)', () => {
  const base = {
    v: 1, schema: locale.SCHEMA, provenance: locale.PROVENIENZA,
    platform: { platform: 'android', arch: 'arm64' },
    components: {
      flock: { source: '/x/bin/flock', sha256: 'c'.repeat(64), version: '2.39.3' },
      node: { source: '/x/bin/node', sha256: 'd'.repeat(64) },
    },
    helper: { sha256: 'e'.repeat(64) }, ts: 1, by: 'op',
  };
  assert.equal(locale.validaPin(base).ok, true);
  const conExtra = JSON.parse(JSON.stringify(base));
  conExtra.components.flock.unexpected = 'x';
  assert.equal(locale.validaPin(conExtra).ok, false, 'campo extra nel componente accettato');
  const platformExtra = JSON.parse(JSON.stringify(base));
  platformExtra.platform.extra = 'x';
  assert.equal(locale.validaPin(platformExtra).ok, false);
  const helperExtra = JSON.parse(JSON.stringify(base));
  helperExtra.helper.extra = 'x';
  assert.equal(locale.validaPin(helperExtra).ok, false);
});

test('R2: dove i link sono negati la pubblicazione resta atomica e privata', (t) => {
  const p = prefisso(t);
  const link = fs.linkSync;
  let negato = 0;
  fs.linkSync = function (a, b) {
    negato += 1;
    const e = new Error('link negato'); e.code = 'EPERM'; throw e;
  };
  let r;
  try { r = provisiona(p); } finally { fs.linkSync = link; }
  assert.ok(negato >= 1, 'fallback non esercitato');
  assert.equal(r.ok, true, JSON.stringify(r));
  const file = locale.percorso(p.home);
  assert.equal((fs.lstatSync(file).mode & 0o777), 0o600);
  const letto = locale.leggi(p.home);
  assert.equal(letto.stato, 'presente');
});

test('R2: un errore di pubblicazione non lascia un pin valido', (t) => {
  const p = prefisso(t);
  const link = fs.linkSync;
  fs.linkSync = function () { const e = new Error('io'); e.code = 'EIO'; throw e; };
  let r;
  try { r = provisiona(p); } finally { fs.linkSync = link; }
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PIN_WRITE');
  assert.equal(fs.existsSync(locale.percorso(p.home)), false);
  assert.deepEqual(fs.readdirSync(path.join(p.home, '.nexuscrew')).filter((n) => n.includes('vl-claim-pin')), []);
});

test('R2: la sostituzione dei byte fra registrazione e lettura e\' rifiutata', (t) => {
  const p = prefisso(t);
  assert.equal(provisiona(p).ok, true);
  fs.chmodSync(p.flock, 0o700);
  fs.writeFileSync(p.flock, '#!/bin/sh\necho "flock from util-linux 9.9.9"\n');
  fs.chmodSync(p.flock, 0o500);
  const v = locale.verifica({ home: p.home, helperHash: HELPER, deps: deps(p) });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'PIN_MISMATCH');
  assert.equal(v.component, 'flock');
});

// R2 giro 2 — la qualifica vale ANCHE in lettura: autorizzare l'uso del pin
// dopo la registrazione e' una verifica, e deve rifiutare una catena che non e'
// piu' quella qualificata al provision. Nessun chmod e nessun mkdir: la
// verifica resta read-only.
test('R2/R2b: una .nexuscrew resa non privata dopo il provision non si legge piu\'', (t) => {
  const p = prefisso(t);
  assert.equal(provisiona(p).ok, true);
  const dir = path.join(p.home, '.nexuscrew');
  fs.chmodSync(dir, 0o777);
  const v = locale.verifica({ home: p.home, helperHash: HELPER, deps: deps(p) });
  assert.equal(v.ok, false, JSON.stringify(v));
  assert.equal(v.code, 'PIN_REREAD');
  assert.equal(v.motivo, 'catena-modo');
  assert.equal((fs.lstatSync(dir).mode & 0o777), 0o777, 'la lettura non corregge i permessi');
  assert.equal(locale.leggi(p.home).stato, 'illeggibile');
});

test('R2/R2b: un .nexuscrew sostituito da symlink non si segue', (t) => {
  const p = prefisso(t);
  assert.equal(provisiona(p).ok, true);
  const dir = path.join(p.home, '.nexuscrew');
  const vero = path.join(p.home, '.nexuscrew-vero');
  fs.renameSync(dir, vero);
  fs.symlinkSync(vero, dir);
  const v = locale.verifica({ home: p.home, helperHash: HELPER, deps: deps(p) });
  assert.equal(v.ok, false, JSON.stringify(v));
  assert.equal(v.code, 'PIN_REREAD');
  assert.equal(v.motivo, 'catena');
  assert.equal(fs.lstatSync(dir).isSymbolicLink(), true, 'la lettura non tocca il link');
});
