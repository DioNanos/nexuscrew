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
const { scriviGenerazione, scriviStato } = require('../lib/files/activity.js');

const REV_0941 = '55f8a9a'; // il punto di rilascio della 0.9.41 sulla linea di lavoro
const SESSIONE = 'cloud-Dev';

// Il modulo della 0.9.41, caricato davvero: la copia ESATTA di quello che la
// 0.9.41 ha pubblicato, in `tests/fixtures/activity-0941.js` (l'intestazione del
// fixture dice da quale revisione viene).
//
// PERCHE' NON DA GIT: la storia del repository pubblico e' schiacciata a un
// commit per release, quindi `55f8a9a` la' non esiste e il test moriva con
// «Command failed: git show» — la CI della 0.9.42 e' diventata rossa per questo,
// non per il codice. Un guardiano deve poter girare anche dove la storia non
// c'e'.
function lettoreVecchio() {
  return require('./fixtures/activity-0941.js');
}

test('il fixture dichiara da quale revisione viene (la sua provenienza e\' verificabile)', () => {
  // Il valore di quel file e' che sia la copia ESATTA del lettore pubblicato
  // nella 0.9.41: se la provenienza non e' scritta, nessuno puo' ricontrollarla.
  const testa = fs.readFileSync(path.join(__dirname, 'fixtures', 'activity-0941.js'), 'utf8')
    .split('\n').slice(0, 16).join('\n');
  assert.match(testa, new RegExp(REV_0941), 'la revisione di provenienza sta nel fixture');
  assert.match(testa, /git show 55f8a9a:lib\/files\/activity\.js/, 'con il comando per ricontrollarla');
});

function cella(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-genfile-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dir: path.join(root, SESSIONE) };
}

test('il file di generazione NUOVO non viene frainteso dal lettore della 0.9.41', (t) => {
  const vecchio = lettoreVecchio();
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
  const vecchio = lettoreVecchio();
  const { root, dir } = cella(t);
  const gen = 'b'.repeat(16);
  assert.equal(scriviGenerazione(dir, gen), true, 'senza `uscitaGarantita`: una riga');
  assert.equal(fs.readFileSync(path.join(dir, 'activity.gen'), 'utf8'), gen);
  assert.equal(scriviStato(dir, { evento: 'Stop', generazione: gen, ora: Date.now() }), true);
  const letto = vecchio.leggiAttivita(root, SESSIONE, Date.now());
  assert.ok(letto && letto.stato === 'ferma', `il lettore vecchio legge il formato storico: ${JSON.stringify(letto)}`);
});
