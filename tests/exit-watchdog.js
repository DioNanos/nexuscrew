'use strict';
// tests/exit-watchdog.js — il guard che dà COLORE a un handle non chiuso.
//
// IL FENOMENO. Un file di test che lascia handle aperti (server non chiusi,
// socket vivi, timer senza unref) non produce un rosso: i test passano TUTTI e
// il processo semplicemente non esce. Il gate resta appeso, e dal di fuori
// sembra lento invece che rotto — il modo peggiore di fallire, perché nessuno
// va a cercare un difetto in qualcosa che sta ancora lavorando. Misurato due
// volte: `cell-lease-proof` con cinque socket e `ws-preauth` con tre server
// (`server.close()` non libera l'handle finché ci sono connessioni aperte). Il
// secondo ha tenuto appeso un gate per quasi due ore e un altro per dieci.
//
// PERCHÉ SULL'USCITA E NON PER FILE. Il runner lancia UN SOLO processo
// `node --test` con tutti i file: un limite per file, qui, non è esprimibile.
// Ma il fenomeno ha un istante preciso in cui si manifesta — il sommario è
// stampato, i test sono finiti, e da lì in poi l'unica cosa che resta da fare
// è uscire. Da quel momento parte una grazia; se scade, il gate fallisce
// NOMINANDO la causa.
//
// COSA NON È: un timeout sui test. Un gate lento non viene toccato, perché il
// contatore parte solo dopo il sommario. È scritto in un test.
//
// Il modulo non finisce in `*.test.js` di proposito: il runner esegue quelli, e
// questo è ciò che il runner USA.

// Riconosce la riga di durata del reporter default (`ℹ duration_ms 1234.5`),
// che chiude il sommario. Dopo di essa il reporter stampa al più l'elenco dei
// falliti, che costa millisecondi. Il prefisso non è ancorato al simbolo: i
// reporter lo cambiano, il nome del campo no.
const FINE_SOMMARIO = /(^|\s)duration_ms\s/m;

const SPIEGAZIONE = [
  'Non è lentezza: è un handle non chiuso (server, socket, timer) che tiene vivo il loop.',
  'Trovalo con process._getActiveHandles() nel file sospetto — e ricorda che server.close()',
  'NON libera l\'handle finché ci sono connessioni aperte: servono closeAllConnections() e',
  'closeIdleConnections(). La grazia si regola con NEXUSCREW_TEST_EXIT_GRACE_MS.',
].join('\n');

// sorvegliaUscita(): inoltra lo stdout del figlio e ne sorveglia l'uscita.
// Risolve con il codice di uscita da usare come verdetto del gate.
//
//   child     processo con stdout in pipe
//   graceMs   quanto tempo concedere DOPO il sommario
//   stdout    dove rilanciare l'output (iniettabile per i test)
//   stderr    dove scrivere la diagnosi
//   killAfterMs  quanto attendere fra SIGTERM e SIGKILL
function sorvegliaUscita({
  child,
  graceMs = 60_000,
  stdout = process.stdout,
  stderr = process.stderr,
  killAfterMs = 5_000,
} = {}) {
  let watchdog = null;
  let appeso = false;
  const disarma = () => { if (watchdog) { clearTimeout(watchdog); watchdog = null; } };

  return new Promise((resolve) => {
    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdout.write(chunk);
        if (watchdog || !FINE_SOMMARIO.test(chunk)) return;
        watchdog = setTimeout(() => {
          appeso = true;
          stderr.write(
            `\nNexusCrew: i test sono finiti ma il processo non è uscito entro ${Math.round(graceMs / 1000)}s.\n${SPIEGAZIONE}\n`,
          );
          try { child.kill('SIGTERM'); } catch (_) { /* già morto */ }
          const colpoDiGrazia = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (_) { /* già morto */ }
          }, killAfterMs);
          if (colpoDiGrazia.unref) colpoDiGrazia.unref();
        }, graceMs);
        // Il watchdog non deve tenere vivo IL RUNNER: sarebbe lo stesso difetto
        // che sta cercando.
        if (watchdog.unref) watchdog.unref();
      });
    }
    child.once('error', () => { disarma(); resolve(1); });
    child.once('exit', (value) => {
      disarma();
      // Un processo ucciso dal guard non ha un esito da riportare: il verdetto è
      // del guard, e resta ROSSO anche se i test erano tutti verdi. È il punto
      // di tutto: senza, un leak resterebbe un successo lento.
      resolve(appeso ? 1 : (Number.isInteger(value) ? value : 1));
    });
  });
}

module.exports = { sorvegliaUscita, FINE_SOMMARIO };
