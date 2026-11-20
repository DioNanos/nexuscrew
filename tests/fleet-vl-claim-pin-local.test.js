'use strict';
// Pin LOCALE della toolchain per le piattaforme che il manifest di build non
// copre (Termux/Android): si registra solo con un'azione esplicita, dichiara la
// provenienza e la piattaforma del runtime, localizza solo flock e node (mai
// l'helper della sezione critica), pubblica in modo atomico e non si crea MAI
// da solo: assente, sostituito o aggiornato = rifiuto.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const locale = require('../lib/fleet/vl-claim-pin-local.js');
const radici = require('../lib/fleet/vl-roots.js');

const HELPER = 'a'.repeat(64);

function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// Prefisso finto: <dir>/bin/node e <dir>/bin/flock, con flock che stampa una
// versione util-linux. Niente esecuzione di candidati non approvati: qui il
// test fornisce la versione via seam.
function prefissoFinto(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-pin-local-'));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  const node = path.join(bin, 'node');
  const flock = path.join(bin, 'flock');
  // Il finto runtime risponde `--version` con la versione del runner: la
  // probe della fotografia qualificata deve tornare proprio quella.
  fs.writeFileSync(node, `#!/bin/sh\ncase "$1" in --version) echo "v${process.versions.node}";; esac\n`, { mode: 0o500 });
  fs.writeFileSync(flock, '#!/bin/sh\necho "flock from util-linux 2.39.3"\n', { mode: 0o500 });
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {} });
  return { dir, home, node, flock };
}

const depsAndroid = (p, extra = {}) => ({
  platform: 'android', arch: 'arm64', execPath: p.node,
  versioneQualificata: () => '2.39.3', ...extra,
});

function provisiona(p, extra = {}) {
  return locale.provisiona({
    home: p.home, flock: p.flock, helperHash: HELPER, by: 'prova', ...extra,
  });
}

test('pin locale: piattaforma non autorizzata -> PIN_UNCOVERED, nessun file', (t) => {
  const p = prefissoFinto(t);
  // Una piattaforma davvero esclusa: linux e' autorizzata dal ripiego dopo un
  // aggiornamento di sistema, darwin arrivera' con un altro schema.
  const r = locale.provisiona({ home: p.home, flock: p.flock, node: p.node, helperHash: HELPER, by: 'x', deps: { platform: 'sunos', arch: 'x64', execPath: p.node, versioneQualificata: () => '2.39.3' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PIN_UNCOVERED');
  assert.equal(fs.existsSync(locale.percorso(p.home)), false);
});

test('pin locale: registrazione valida, file 0600 e provenienza dichiarata', (t) => {
  const p = prefissoFinto(t);
  const r = provisiona(p, { deps: depsAndroid(p) });
  assert.equal(r.ok, true, JSON.stringify(r));
  const file = locale.percorso(p.home);
  assert.equal(fs.existsSync(file), true);
  assert.equal((fs.lstatSync(file).mode & 0o777), 0o600);
  assert.equal((fs.lstatSync(path.dirname(file)).mode & 0o777), 0o700);
  const letto = locale.leggi(p.home);
  assert.equal(letto.stato, 'presente');
  assert.equal(letto.pin.provenance, 'operator-provisioned');
  assert.equal(`${letto.pin.platform.platform}-${letto.pin.platform.arch}`, 'android-arm64');
  assert.equal(letto.pin.components.flock.version, '2.39.3');
  assert.equal(letto.pin.helper.sha256, HELPER);
  assert.equal(letto.pin.by, 'prova');
});

test('pin locale: seconda registrazione rifiutata senza again, sostituita con again', (t) => {
  const p = prefissoFinto(t);
  assert.equal(provisiona(p, { deps: depsAndroid(p) }).ok, true);
  const prima = locale.leggi(p.home).pin;
  const seconda = provisiona(p, { deps: depsAndroid(p) });
  assert.equal(seconda.ok, false);
  assert.equal(seconda.code, 'PIN_EXISTS');
  assert.equal(locale.leggi(p.home).pin.ts, prima.ts, 'pin riscritto senza consenso');
  const terza = provisiona(p, { deps: depsAndroid(p), again: true, ts: prima.ts + 10 });
  assert.equal(terza.ok, true, JSON.stringify(terza));
  assert.equal(locale.leggi(p.home).pin.ts, prima.ts + 10);
});

test('pin locale: flock fuori prefisso -> PIN_PREFIX (il node non e\' piu\' un componente)', (t) => {
  const p = prefissoFinto(t);
  const fuori = path.join(p.dir, 'flock');
  fs.writeFileSync(fuori, 'x', { mode: 0o500 });
  const r2 = locale.provisiona({ home: p.home, flock: fuori, helperHash: HELPER, by: 'x', deps: depsAndroid(p) });
  assert.equal(r2.code, 'PIN_PREFIX');
  assert.equal(r2.detail, 'flock');
});

test('pin locale: Android, il prefisso decide prima di helper, attestatore e versione', (t) => {
  const p = prefissoFinto(t);
  const fuori = path.join(p.dir, 'flock');
  fs.writeFileSync(fuori, 'x', { mode: 0o500 });
  // Tre casi combinati: sorgente assoluta fuori prefisso E un secondo dato
  // invalido. La diagnosi deve restare quella del prefisso.
  const combinati = [
    ['helper invalido', { helperHash: 'zz', by: 'x' }, depsAndroid(p)],
    ['attestatore invalido', { helperHash: HELPER, by: '' }, depsAndroid(p)],
    ['versione non disponibile', { helperHash: HELPER, by: 'x' }, depsAndroid(p, { versioneQualificata: undefined })],
  ];
  for (const [nome, extra, deps] of combinati) {
    const r = locale.provisiona({ home: p.home, flock: fuori, helperHash: extra.helperHash, by: extra.by, deps });
    assert.equal(r.ok, false, `${nome}: deve rifiutare`);
    assert.equal(r.code, 'PIN_PREFIX', `${nome}: il prefisso precede ogni altro rifiuto`);
    assert.equal(fs.existsSync(locale.percorso(p.home)), false, `${nome}: nessun pin scritto`);
  }
  // Ordinario negativo: solo fuori prefisso, tutto il resto valido.
  const solo = locale.provisiona({ home: p.home, flock: fuori, helperHash: HELPER, by: 'x', deps: depsAndroid(p) });
  assert.equal(solo.ok, false);
  assert.equal(solo.code, 'PIN_PREFIX');
  assert.equal(solo.detail, 'flock');
  assert.equal(fs.existsSync(locale.percorso(p.home)), false);
  // Ordinario positivo: dentro il prefisso, tutto valido.
  const dentro = locale.provisiona({ home: p.home, flock: p.flock, helperHash: HELPER, by: 'x', deps: depsAndroid(p) });
  assert.equal(dentro.ok, true, JSON.stringify(dentro));
  assert.equal(fs.existsSync(locale.percorso(p.home)), true);
});

test('pin locale: helper fuori release, hash non valido e versione assente sono rifiuti', (t) => {
  const p = prefissoFinto(t);
  assert.equal(locale.provisiona({ home: p.home, flock: p.flock, node: p.node, helperHash: 'b'.repeat(64), by: 'x', deps: depsAndroid(p) }).ok, true);
  // l'helper del pin e' quello passato: la verifica lo confronta con la release
  const v = locale.verifica({ home: p.home, helperHash: HELPER, deps: depsAndroid(p) });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'PIN_MISMATCH');
  assert.equal(v.component, 'helper');
});

test('pin locale: versione non leggibile sull\'oggetto qualificato -> PIN_VERSION', (t) => {
  const p = prefissoFinto(t);
  const r = provisiona(p, { deps: depsAndroid(p, { versioneQualificata: () => '' }) });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PIN_VERSION');
  assert.equal(fs.existsSync(locale.percorso(p.home)), false);
});

test('pin locale: assente non si crea da solo, nemmeno dopo un tentativo', (t) => {
  const p = prefissoFinto(t);
  const v1 = locale.verifica({ home: p.home, helperHash: HELPER, deps: depsAndroid(p) });
  assert.equal(v1.ok, false);
  assert.equal(v1.code, 'PIN_UNCOVERED');
  assert.equal(v1.motivo, 'assente');
  const v2 = locale.verifica({ home: p.home, helperHash: HELPER, deps: depsAndroid(p) });
  assert.equal(v2.ok, false);
  assert.equal(fs.existsSync(locale.percorso(p.home)), false, 'pin creato da un tentativo di verifica');
});

test('pin locale: byte cambiati dopo la registrazione -> PIN_MISMATCH del componente', (t) => {
  const p = prefissoFinto(t);
  assert.equal(provisiona(p, { deps: depsAndroid(p) }).ok, true);
  assert.equal(locale.verifica({ home: p.home, helperHash: HELPER, deps: depsAndroid(p) }).ok, true);
  fs.chmodSync(p.flock, 0o700);
  fs.writeFileSync(p.flock, '#!/bin/sh\necho altra cosa\n');
  fs.chmodSync(p.flock, 0o500);
  const v = locale.verifica({ home: p.home, helperHash: HELPER, deps: depsAndroid(p) });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'PIN_MISMATCH');
  assert.equal(v.component, 'flock');
});

test('pin locale: flock fuori prefisso dopo la registrazione -> rifiuto', (t) => {
  const p = prefissoFinto(t);
  assert.equal(provisiona(p, { deps: depsAndroid(p) }).ok, true);
  const file = locale.percorso(p.home);
  const pin = JSON.parse(fs.readFileSync(file, 'utf8'));
  const altro = path.join(p.dir, 'flock-altro');
  fs.writeFileSync(altro, 'x', { mode: 0o500 });
  pin.components.flock.source = altro;
  pin.components.flock.sha256 = sha(fs.readFileSync(altro));
  fs.writeFileSync(file, JSON.stringify(pin), { mode: 0o600 });
  const v = locale.verifica({ home: p.home, helperHash: HELPER, deps: depsAndroid(p) });
  assert.equal(v.ok, false);
  assert.equal(v.code, 'PIN_UNCOVERED');
  assert.equal(v.motivo, 'prefisso');
  assert.equal(v.component, 'flock');
});

test('pin locale: un link al posto del file non e\' un pin leggibile', (t) => {
  const p = prefissoFinto(t);
  assert.equal(provisiona(p, { deps: depsAndroid(p) }).ok, true);
  const file = locale.percorso(p.home);
  const vero = path.join(p.dir, 'pin-vero.json');
  fs.renameSync(file, vero);
  fs.symlinkSync(vero, file);
  const letto = locale.leggi(p.home);
  assert.equal(letto.stato, 'illeggibile');
  assert.equal(letto.motivo, 'tipo');
  const v = locale.verifica({ home: p.home, helperHash: HELPER, deps: depsAndroid(p) });
  assert.equal(v.code, 'PIN_REREAD');
});

test('pin locale: schema chiuso (campo in piu\' o provenienza diversa) rifiutato', () => {
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
  assert.equal(locale.validaPin({ ...base, extra: 1 }).ok, false);
  assert.equal(locale.validaPin({ ...base, provenance: 'local-first-run' }).ok, false);
  assert.equal(locale.validaPin({ ...base, components: { ...base.components, altro: {} } }).ok, false);
});

test('integrazione: preparaPin usa il pin locale su una piattaforma autorizzata', (t) => {
  const p = prefissoFinto(t);
  assert.equal(provisiona(p, { deps: depsAndroid(p), helperHash: radici.MANIFEST.helper.sha256 }).ok, true);
  const r = radici.preparaPin(p.home, radici.MANIFEST, 'android-arm64', { execPath: p.node });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.ok(fs.existsSync(r.flock) && fs.existsSync(r.node) && fs.existsSync(r.helper));
  // L'helper resta quello della release, non un hash del disco.
  assert.equal(sha(fs.readFileSync(r.helper)), radici.MANIFEST.helper.sha256);
});

test('integrazione: senza pin locale preparaPin rifiuta con PIN_UNCOVERED', (t) => {
  const p = prefissoFinto(t);
  const r = radici.preparaPin(p.home, radici.MANIFEST, 'android-arm64', { execPath: p.node });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'PIN_UNCOVERED');
  assert.equal(r.motivo, 'assente');
});
