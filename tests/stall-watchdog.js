'use strict';
// tests/stall-watchdog.js — il gate non deve MAI restare appeso in silenzio.
//
// IL FENOMENO, misurato tre volte in due giorni. Un file di test che lascia
// handle aperti (server non chiusi, socket vivi) non produce un rosso: il suo
// sotto-processo non esce, `node --test` continua ad aspettarlo, e il gate resta
// fermo per sempre. Dal di fuori sembra lento invece che rotto — il modo peggiore
// di fallire, perché nessuno va a cercare un difetto in qualcosa che sta ancora
// lavorando. Due runner sono rimasti così per DIECI ORE, un terzo per due.
//
// LA PRIMA VERSIONE DI QUESTA GUARDIA GUARDAVA IL POSTO SBAGLIATO. Contava il
// tempo a partire dal sommario finale, cioè copriva il caso «i test sono
// finiti e il processo non esce». Ma il caso reale — tutte e tre le volte — è
// «un file non finisce»: il sommario non viene MAI stampato, e una guardia che
// parte da lì non si arma nemmeno. È servito vederla fallire su un gate appeso
// da 27 minuti per accorgersene.
//
// IL SEGNALE GIUSTO È L'INATTIVITÀ. Finché il runner ha file da eseguire,
// l'output scorre; quando resta solo quello appeso, si ferma di colpo e non
// riprende. Nessuna riga per N minuti significa appeso, e copre entrambi i casi
// senza doverli distinguere. Un gate LENTO non viene toccato: se sta lavorando,
// sta anche stampando.
//
// PERCHÉ NON SI LEGGE LO STDOUT. Prenderlo in pipe per osservarlo obbligherebbe
// il runner a rilanciare ogni riga: costo di CPU e contropressione proprio sui
// test che misurano tempi, su una macchina che è già satura. Il segnale arriva
// invece da un SECONDO reporter, scritto su un file che nessuno legge: al
// runner basta guardare se quel file cresce. Lo stdout resta ereditato — stesso
// aspetto, stessi colori, zero costo.

const DEFAULT_STALL_MS = 5 * 60 * 1000;   // il gate intero dura 8-25 minuti
const DEFAULT_TICK_MS = 15 * 1000;

const SPIEGAZIONE = [
  'Nessun output per il tempo indicato: il gate è APPESO, non lento.',
  '',
  'Le cause sono due, e mandano in posti diversi:',
  '',
  '1. Un file che lascia HANDLE APERTI: il suo processo non esce e il runner lo',
  '   aspetta per sempre. Trovalo con process._getActiveHandles() nel file che',
  '   stava girando, e ricorda che server.close() NON libera l\'handle finché ci',
  '   sono connessioni aperte: servono closeAllConnections() e',
  '   closeIdleConnections().',
  '',
  '2. Un test che ASPETTA UNA CONDIZIONE che non arriverà mai. Diversi test',
  '   attendono un fatto osservabile (stato su disco, pidfile, evento) senza',
  '   budget di tempo, apposta: un budget misurerebbe la velocità della macchina',
  '   e sotto carico aprirebbe falsi rossi. Il prezzo è che una proprietà ROTTA',
  '   si manifesta qui, come stallo, invece che come assert fallito. Se il file',
  '   che stava girando è fra quelli, sospetta una regressione VERA nel codice',
  '   che doveva produrre quella condizione — non il test.',
  '',
  'La soglia si regola con NEXUSCREW_TEST_STALL_MS.',
].join('\n');

// sorvegliaStallo(): risolve con il codice di uscita da usare come verdetto.
//
//   child        il processo del runner
//   segnale()    un numero che CRESCE quando c'è attività (tipicamente la
//                dimensione del file di report). Iniettabile: è ciò che rende
//                questa funzione provabile senza una suite vera.
//   stallMs      quanta inattività si tollera
//   tickMs       ogni quanto si guarda
//   stderr       dove va la diagnosi
function sorvegliaStallo({
  child,
  segnale,
  stallMs = DEFAULT_STALL_MS,
  tickMs = DEFAULT_TICK_MS,
  stderr = process.stderr,
  killAfterMs = 5_000,
} = {}) {
  return new Promise((resolve) => {
    let ultimo = -1;
    let fermoDa = 0;
    let appeso = false;

    const battito = setInterval(() => {
      let corrente;
      try { corrente = segnale(); } catch (_) { corrente = ultimo; }
      if (corrente !== ultimo) { ultimo = corrente; fermoDa = 0; return; }
      fermoDa += tickMs;
      if (fermoDa < stallMs) return;

      appeso = true;
      clearInterval(battito);
      stderr.write(
        `\nNexusCrew: nessun avanzamento del gate da ${Math.round(stallMs / 1000)}s.\n${SPIEGAZIONE}\n`,
      );
      try { child.kill('SIGTERM'); } catch (_) { /* già morto */ }
      const colpoDiGrazia = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (_) { /* già morto */ }
      }, killAfterMs);
      if (colpoDiGrazia.unref) colpoDiGrazia.unref();
    }, tickMs);
    // Il guard non deve tenere vivo il runner: sarebbe lo stesso difetto che cerca.
    if (battito.unref) battito.unref();

    const chiudi = (code) => { clearInterval(battito); resolve(code); };
    child.once('error', () => chiudi(1));
    // Un processo ucciso dal guard non ha un esito da riportare: il verdetto è
    // del guard e resta ROSSO, anche se i test fino a lì erano tutti verdi.
    child.once('exit', (value) => chiudi(appeso ? 1 : (Number.isInteger(value) ? value : 1)));
  });
}

module.exports = { sorvegliaStallo, DEFAULT_STALL_MS, DEFAULT_TICK_MS };
