'use strict';
// La seconda riga del file di generazione non deve essere FRAINTESA da un
// lettore vecchio.
//
// Il formato nuovo di `activity.gen` e':
//
//     <generazione>
//     exit:1
//
// La 0.9.41 legge quel file con un `trim()` del contenuto INTERO e lo confronta
// con la generazione che l'evento dichiara. Con due righe il confronto non
// torna: gli eventi vengono scartati e la cella risulta «non verificato».
// **Degrada, e non crede a uno stato vecchio** — che e' la direzione giusta — e
// questo test lo prova col lettore VERO di quella versione, non con una sua
// imitazione.
//
// Perche' conta: durante un aggiornamento, le celle gia' in esecuzione hanno un
// file scritto dal supervisore vecchio (una riga, senza segno) e il lettore
// nuovo le tratta come «uscita non garantita»; nella direzione opposta un
// lettore vecchio che incontrasse un file nuovo non deve leggere come fresco uno
// stato che non e' piu' verificabile.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { scriviGenerazione, scriviStato } = require('../lib/files/activity.js');

const REV_0941 = '55f8a9a'; // il punto di rilascio della 0.9.41 sulla linea di lavoro
const SESSIONE = 'cloud-Dev';

// Il modulo della 0.9.41, preso da git e caricato davvero. Non e' una copia
// scritta a mano: se il lettore vecchio cambiasse, cambierebbe questo test.
function lettoreVecchio(t) {
  const sorgente = execFileSync('git', ['show', `${REV_0941}:lib/files/activity.js`],
    { cwd: path.join(__dirname, '..'), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-0941-reader-'));
  const file = path.join(dir, 'activity-0941.js');
  fs.writeFileSync(file, sorgente);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return require(file);
}

function cella(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-genfile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dir: path.join(root, SESSIONE) };
}

test('il file di generazione NUOVO non viene frainteso dal lettore della 0.9.41', (t) => {
  const vecchio = lettoreVecchio(t);
  const { root, dir } = cella(t);
  assert.equal(vecchio.leggiAttivita(root, SESSIONE), null, 'niente su disco: null');

  // File NUOVO (due righe) + uno stato legittimo del lancio.
  const gen = 'a'.repeat(16);
  assert.equal(scriviGenerazione(dir, gen, { uscitaGarantita: true }), true);
  assert.equal(fs.readFileSync(path.join(dir, 'activity.gen'), 'utf8'), `${gen}\nexit:1`);
  assert.equal(scriviStato(dir, { evento: 'Stop', generazione: gen, ora: Date.now() }), true);

  // Il lettore VECCHIO calcola `'<gen>\nexit:1'` e non lo trova uguale alla
  // generazione dell'evento: scarta. Non legge «ferma» per sbaglio.
  assert.equal(vecchio.leggiAttivita(root, SESSIONE, Date.now()), null,
    'il lettore della 0.9.41 deve degradare a null, non credere allo stato');
  // e nemmeno un istante dopo: non e' una questione di finestra.
  assert.equal(vecchio.leggiAttivita(root, SESSIONE, Date.now() + 60 * 60 * 1000), null);
});

test('il formato STORICO (una riga) resta leggibile dal lettore della 0.9.41', (t) => {
  // La controprova: la differenza fra i due formati e' SOLO la seconda riga, e
  // un lancio senza il segno dell'uscita resta compatibile con la 0.9.41.
  const vecchio = lettoreVecchio(t);
  const { root, dir } = cella(t);
  const gen = 'b'.repeat(16);
  assert.equal(scriviGenerazione(dir, gen), true, 'senza `uscitaGarantita`: una riga');
  assert.equal(fs.readFileSync(path.join(dir, 'activity.gen'), 'utf8'), gen);
  assert.equal(scriviStato(dir, { evento: 'Stop', generazione: gen, ora: Date.now() }), true);
  const letto = vecchio.leggiAttivita(root, SESSIONE, Date.now());
  assert.ok(letto && letto.stato === 'ferma', `il lettore vecchio legge il formato storico: ${JSON.stringify(letto)}`);
});
