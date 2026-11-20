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
// Un pid in stato Z dopo SIGKILL e' un corpo gia' terminato in attesa del
// reaper: si attende per un tetto esplicito la sua sparizione. Ogni altro
// stato resta un server vivo e fallisce subito; uno zombie non raccolto nel
// tetto fallisce con un errore distinto.

function osservaPs(spawn, serverPid, timeoutMs, etichetta) {
  let esitoPs = null;
  let erroreOperativo = null;
  try {
    esitoPs = spawn('ps', ['-p', String(serverPid), '-o', 'pid=,state='], { encoding: 'utf8', timeout: timeoutMs });
  } catch (e) {
    erroreOperativo = e;
  }
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
  const riga = String(esitoPs.stdout || '').trim();
  if (esitoPs.status === 1 || riga === '') return { gone: true };
  const campi = riga.split(/\s+/);
  if (campi.length < 2 || campi[0] !== String(serverPid)) {
    throw new Error(`ps non ha prodotto un verdetto leggibile per il ${etichetta} ${serverPid}: ${JSON.stringify(riga)}`);
  }
  return { gone: false, state: campi.slice(1).join(' ') };
}

function attendiRaccolta(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function verificaUscitaServer(spawn, serverPid, {
  timeoutMs = 2000,
  etichetta = 'server tmux',
  raccoltaTimeoutMs = 1000,
  pollMs = 10,
} = {}) {
  let osservazione = osservaPs(spawn, serverPid, timeoutMs, etichetta);
  if (osservazione.gone) return true;
  if (!/^Z/.test(osservazione.state)) {
    throw new Error(`il ${etichetta} ${serverPid} e' ancora vivo dopo kill-server e SIGKILL (state ${osservazione.state})`);
  }
  const fine = Date.now() + raccoltaTimeoutMs;
  while (Date.now() < fine) {
    attendiRaccolta(pollMs);
    osservazione = osservaPs(spawn, serverPid, timeoutMs, etichetta);
    if (osservazione.gone) return true;
    if (!/^Z/.test(osservazione.state)) {
      throw new Error(`il ${etichetta} ${serverPid} e' tornato vivo durante la raccolta (state ${osservazione.state})`);
    }
  }
  throw new Error(`il ${etichetta} ${serverPid} e' ancora uno zombie dopo kill-server, SIGKILL e ${raccoltaTimeoutMs} ms di raccolta (state ${osservazione.state})`);
}

module.exports = { verificaUscitaServer };
