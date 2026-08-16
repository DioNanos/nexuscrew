'use strict';
// Il guard sullo stallo del gate, provato con processi veri e un segnale finto.
//
// Quattro domande che deve saper distinguere, e la terza è quella che conta:
//   1. il gate si ferma e non riprende      -> rosso, e causa nominata;
//   2. il gate finisce da solo              -> il verdetto resta dei test;
//   3. il gate è LENTO ma sta avanzando     -> non si tocca;
//   4. una pausa breve, poi riprende        -> non si tocca (il contatore si azzera).
//
// La 3 e la 4 sono il motivo per cui il guard misura l'AVANZAMENTO e non il
// tempo totale: un limite sulla durata ucciderebbe un gate onesto.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { sorvegliaStallo } = require('./stall-watchdog.js');

function raccolta() {
  const righe = [];
  return { righe, write: (s) => { righe.push(String(s)); return true; }, testo: () => righe.join('') };
}

// Un processo vero, così SIGTERM e uscita non sono simulati.
const figlio = (script) => spawn(process.execPath, ['-e', script], { stdio: 'ignore' });

test('il gate si ferma: ROSSO, e la causa è nominata', { timeout: 15_000 }, async () => {
  // Vivo e silenzioso: è il gate appeso. Il segnale non cresce mai.
  const child = figlio('setInterval(() => {}, 1000);');
  const err = raccolta();
  const code = await sorvegliaStallo({
    child, segnale: () => 42, stallMs: 300, tickMs: 50, stderr: err, killAfterMs: 100,
  });
  assert.equal(code, 1, 'un gate appeso deve valere rosso, non attesa infinita');
  assert.match(err.testo(), /nessun avanzamento/, 'dice CHE COSA è successo');
  // Le cause di uno stallo sono DUE e mandano in posti diversi: un file che
  // non rilascia gli handle, oppure un test che aspetta una condizione mai
  // arrivata — cioè una regressione vera nel codice, non nel test. Nominarne
  // una sola manda chi indaga dalla parte sbagliata nella metà dei casi.
  assert.match(err.testo(), /handle aperti/i, 'la prima causa: dove guardare');
  assert.match(err.testo(), /aspetta una condizione/i,
    'la seconda causa: una proprietà rotta si manifesta come stallo, non come assert fallito');
});

test('il gate finisce da solo: il verdetto resta quello dei test', async () => {
  const child = figlio('process.exit(3);');
  const err = raccolta();
  const code = await sorvegliaStallo({
    child, segnale: () => 0, stallMs: 5000, tickMs: 100, stderr: err,
  });
  assert.equal(code, 3, 'il codice dei test passa intatto');
  assert.equal(err.testo(), '', 'e il guard tace: non c\'era niente da nominare');
});

test('un gate LENTO ma che AVANZA non viene toccato', { timeout: 15_000 }, async () => {
  // Il segnale cresce a ogni lettura: sta lavorando. Anche con una soglia
  // ridicola, il guard non deve intervenire — altrimenti sarebbe un limite
  // sulla durata travestito da guardia sugli handle.
  const child = figlio('setTimeout(() => process.exit(0), 900);');
  const err = raccolta();
  let n = 0;
  const inizio = Date.now();
  const code = await sorvegliaStallo({
    child, segnale: () => ++n, stallMs: 100, tickMs: 25, stderr: err,
  });
  assert.equal(code, 0, 'un gate lento arriva in fondo e vale quello che vale');
  assert.equal(err.testo(), '', 'nessuna diagnosi: non c\'era niente di rotto');
  assert.ok(Date.now() - inizio >= 800, 'ed è stato atteso davvero, non ucciso');
});

test('una pausa breve non basta: il contatore si azzera quando l\'output riprende', { timeout: 15_000 }, async () => {
  // Fermo per due terzi della soglia, poi riparte. Se il guard sommasse le
  // pause invece di azzerarle, un gate sano morirebbe a metà.
  const child = figlio('setTimeout(() => process.exit(0), 1200);');
  const err = raccolta();
  let n = 0;
  let letture = 0;
  const code = await sorvegliaStallo({
    child,
    // Ferma per 6 letture (300ms, soglia 500ms), poi riprende a crescere.
    segnale: () => { letture++; if (letture > 6) n++; return n; },
    stallMs: 500, tickMs: 50, stderr: err,
  });
  assert.equal(code, 0, 'la pausa è rientrata: il gate va lasciato finire');
  assert.equal(err.testo(), '', 'nessun falso allarme');
});
