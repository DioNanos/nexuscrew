'use strict';
// Il guard sull'uscita del gate, provato con processi VERI e piccoli.
//
// Ogni caso qui sotto è la risposta a una domanda che il guard deve saper
// distinguere, e sono tre domande diverse:
//   1. i test sono finiti e il processo NON esce  -> rosso, e nominato;
//   2. i test sono finiti e il processo esce      -> il verdetto è dei test;
//   3. il processo è LENTO e non ha ancora finito -> non si tocca.
//
// Il terzo è quello che conta di più: un guard che uccide un gate lento sarebbe
// peggio del difetto che cura.

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const { sorvegliaUscita } = require('./exit-watchdog.js');

// Raccoglie ciò che il guard scrive, invece di sporcare l'output della suite.
function raccolta() {
  const righe = [];
  return { righe, write: (s) => { righe.push(String(s)); return true; }, testo: () => righe.join('') };
}

function figlio(script) {
  return spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
}

// La scadenza non è decorativa: se il guard smettesse di funzionare, questo
// test si APPENDEREBBE invece di fallire — cioè si ammalerebbe esattamente del
// difetto che sta curando, e il gate perderebbe il rosso proprio dove serve.
test('handle non chiuso: i test finiscono, il processo resta — verdetto ROSSO e causa NOMINATA', { timeout: 15_000 }, async () => {
  // Stampa il sommario e poi tiene vivo il loop con un handle, esattamente come
  // farebbe un server mai chiuso. Senza il guard, questa promise non si
  // risolverebbe mai: è il gate appeso.
  const child = figlio('console.log("ℹ duration_ms 12.3"); setInterval(() => {}, 1000);');
  const out = raccolta();
  const err = raccolta();
  const code = await sorvegliaUscita({ child, graceMs: 300, stdout: out, stderr: err, killAfterMs: 200 });

  assert.equal(code, 1, 'un leak deve valere un gate rosso, non un successo lento');
  assert.match(err.testo(), /non è uscito entro/, 'il gate dice CHE COSA è successo');
  assert.match(err.testo(), /handle non chiuso/, 'e dice dove guardare');
  assert.match(out.testo(), /duration_ms/, 'lo stdout del figlio arriva comunque a chi guarda');
});

test('nessun leak: il verdetto resta quello dei test, non del guard', async () => {
  // Sommario e uscita immediata, con codice 3: il guard non deve inventarsi
  // nulla, né trasformare un verde in rosso, né un rosso in un altro numero.
  const child = figlio('console.log("ℹ duration_ms 4"); process.exit(3);');
  const err = raccolta();
  const code = await sorvegliaUscita({ child, graceMs: 5000, stdout: raccolta(), stderr: err });

  assert.equal(code, 3, 'il codice di uscita dei test passa intatto');
  assert.equal(err.testo(), '', 'e il guard tace: non è successo niente da nominare');
});

test('un gate LENTO non viene toccato: la grazia parte dal sommario, non dall\'avvio', { timeout: 15_000 }, async () => {
  // Nessun sommario: il processo sta ancora lavorando. Anche con una grazia
  // ridicolmente breve il guard non deve intervenire — se lo facesse, sarebbe
  // un timeout sui test travestito da guard sugli handle.
  const child = figlio('setTimeout(() => { console.log("ℹ duration_ms 9"); process.exit(0); }, 900);');
  const err = raccolta();
  const inizio = Date.now();
  const code = await sorvegliaUscita({ child, graceMs: 50, stdout: raccolta(), stderr: err });

  assert.equal(code, 0, 'un gate lento arriva in fondo e vale quello che vale');
  assert.equal(err.testo(), '', 'nessuna diagnosi: non c\'era niente di rotto');
  assert.ok(Date.now() - inizio >= 800, 'ed è stato atteso davvero, non ucciso');
});

test('il figlio muore da solo: il guard non lascia la promise appesa', async () => {
  // Un processo che non stampa nulla e cade subito. Senza il ramo 'exit' il
  // runner resterebbe in attesa di un sommario che non arriverà mai.
  const child = figlio('process.exit(7);');
  const code = await sorvegliaUscita({ child, graceMs: 5000, stdout: raccolta(), stderr: raccolta() });
  assert.equal(code, 7);
});
