'use strict';

// Verifica obbligatoria di terminazione del server tmux dopo kill-server e
// SIGKILL: la chiamata a ps e il verdetto vivono FUORI da ogni catch che
// possa inghiottirli. Un server superstite deve far fallire il test, non
// risultare un errore «operativo» da ignorare; e un ps che non produce
// verdetto (errore di spawn, timeout, uscita inattesa) NON significa
// assenza: senza osservazione non c'e' verifica, e mancare la verifica e'
// essa stessa un fallimento.
//
// `spawn` viene passato dal chiamante — il binding di spawnSync del file di
// test — cosi' la verifica usa esattamente il canale che il test osserva.

function verificaUscitaServer(spawn, serverPid, { timeoutMs = 2000, etichetta = 'server tmux' } = {}) {
  let esitoPs = null;
  let erroreOperativo = null;
  try {
    esitoPs = spawn('ps', ['-p', String(serverPid), '-o', 'pid='], { encoding: 'utf8', timeout: timeoutMs });
  } catch (e) {
    // Solo l'errore operativo del spawn viene catturato, e soltanto qui:
    // ps puo' non partire. Il verdetto resta «non osservato», mai «assente».
    erroreOperativo = e;
  }
  // ps esce con 0 se ha trovato il processo, con 1 se non lo ha trovato:
  // sono gli unici due esiti che costituiscono un verdetto osservabile.
  const conVerdetto = !erroreOperativo && esitoPs && !esitoPs.error && !esitoPs.signal
    && (esitoPs.status === 0 || esitoPs.status === 1);
  if (!conVerdetto) {
    const dettagli = [
      erroreOperativo && erroreOperativo.message,
      esitoPs && esitoPs.error && esitoPs.error.message,
      esitoPs && esitoPs.signal && `segnale ${esitoPs.signal}`,
      esitoPs && typeof esitoPs.status !== 'number' && 'ps senza stato',
      esitoPs && typeof esitoPs.status === 'number' && esitoPs.status > 1 && `stato ${esitoPs.status}`,
    ].filter(Boolean).join(', ');
    throw new Error(`impossibile osservare l'uscita del ${etichetta} ${serverPid}: ps non ha prodotto un verdetto (${dettagli || 'nessuna uscita'})`);
  }
  if (String(esitoPs.stdout || '').trim() !== '') {
    throw new Error(`il ${etichetta} ${serverPid} e' ancora visibile dopo kill-server e SIGKILL`);
  }
  return true;
}

module.exports = { verificaUscitaServer };
