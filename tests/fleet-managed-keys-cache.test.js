'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { mock } = require('node:test');
const { credentialSources } = require('../lib/fleet/managed.js');

// Il contratto della cache dei file di chiavi: il burst si deduplica (una
// lettura sola per raffica), il valore resta vero quando il file cambia, e i
// controlli di sicurezza restano per chiamata. Il caso limite e' la
// riscrittura NELLO STESSO millisecondo con la stessa size: l'identita' del
// file (mtime/ctime al ms) non la distingue, quindi la voce non puo' restare
// valida per sempre — al piu' un secondo, poi si rilegge.
function workspace() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-keycache-'));
  const keyFile = path.join(home, '.config', 'keys', 'ai.env');
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, `PROVA_KEY=${'A'.repeat(32)}\n`);
  fs.chmodSync(keyFile, 0o600);
  return { home, keyFile };
}

const leggi = (home, keyFile) => credentialSources(
  { providerKeysPath: keyFile }, home, null, { trackLegacy: false },
).keys.PROVA_KEY;

test('burst: letture ravvicinate dello stesso file leggono il disco una volta sola', async (t) => {
  const { home, keyFile } = workspace();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // Conta e serve: il wrapper passa tutto all'originale catturato prima.
  const originaria = fs.readFileSync;
  const conta = mock.method(fs, 'readFileSync', (...args) => originaria(...args));
  t.after(() => conta.mock.restore());
  const a = leggi(home, keyFile);
  const b = leggi(home, keyFile);
  const c = leggi(home, keyFile);
  assert.equal(a, 'A'.repeat(32));
  assert.equal(b, a);
  assert.equal(c, a);
  const sulFile = conta.mock.calls.filter((call) => String(call.arguments[0]) === keyFile).length;
  assert.equal(sulFile, 1, 'tre letture, una sola dal disco');
});

test('riscrittura nel millisecondo con stessa size: il nuovo valore diventa visibile entro un secondo', async (t) => {
  const { home, keyFile } = workspace();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const a = leggi(home, keyFile);
  assert.equal(a, 'A'.repeat(32));
  // Stessa size, subito dopo: l'identita' al millisecondo non la distingue.
  fs.writeFileSync(keyFile, `PROVA_KEY=${'B'.repeat(32)}\n`);
  await new Promise((r) => setTimeout(r, 1100));
  const b = leggi(home, keyFile);
  assert.equal(b, 'B'.repeat(32), 'la voce cache-ata non vive più di un secondo');
});

test('cap di 1 s con orologio mockato: identita invariata, eta scaduta, si rilegge', async (t) => {
  const { home, keyFile } = workspace();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  // Il caso che solo il cap decide: identita' del file INVARIATA (nessuna
  // riscrittura: niente timing del file system) e voce oltre il secondo di
  // eta'. L'orologio del cap e' mockato: lettura a T0, clock avanti di
  // 1,1 s, rilettura — deve tornare al disco (due letture), perche' una
  // voce vecchia non vale piu' nemmeno a identita' pari. Senza cap la
  // seconda lettura servirebbe la voce (una sola lettura): rosso.
  const originaria = fs.readFileSync;
  const conta = t.mock.method(fs, 'readFileSync', (...args) => originaria(...args));
  let ora = 1_000_000;
  t.mock.method(Date, 'now', () => ora);
  const prima = leggi(home, keyFile);
  ora += 1100;
  const seconda = leggi(home, keyFile);
  assert.equal(prima, 'A'.repeat(32));
  assert.equal(seconda, 'A'.repeat(32));
  const letture = conta.mock.calls.filter((c) => String(c.arguments[0]) === keyFile).length;
  assert.equal(letture, 2, 'eta oltre il cap: la voce non vale, si rilegge dal disco');
});

test('riscrittura oltre il secondo: il nuovo valore diventa visibile subito', async (t) => {
  const { home, keyFile } = workspace();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.equal(leggi(home, keyFile), 'A'.repeat(32));
  await new Promise((r) => setTimeout(r, 1100));
  fs.writeFileSync(keyFile, `PROVA_KEY=${'C'.repeat(32)}\n`);
  assert.equal(leggi(home, keyFile), 'C'.repeat(32));
});

test('i controlli di sicurezza restano per chiamata: permessi allentati subito dopo la lettura', async (t) => {
  const { home, keyFile } = workspace();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.equal(leggi(home, keyFile), 'A'.repeat(32));
  // Lo stesso file, con i permessi allentati, non deve piu' essere creduto:
  // il gate dei permessi corre a OGNI chiamata, cache o no.
  fs.chmodSync(keyFile, 0o644);
  assert.equal(leggi(home, keyFile), undefined);
  fs.chmodSync(keyFile, 0o600);
  assert.equal(leggi(home, keyFile), 'A'.repeat(32));
});
