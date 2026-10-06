'use strict';

// Coalescing della risposta di /api/sessions (finestra di 2 s, decisione
// operativa: latenza percepita al piu' pari alla finestra in cambio di spawn
// dimezzati — anzi, di UNO spawn per finestra condiviso fra client).
//
// Tre comportamenti, tutti voluti:
//  - letture entro la finestra servono la risposta gia' pronta: zero spawn;
//  - letture che arrivano mentre il giro e' in volo aspettano QUELLO giro
//    (mai due serie di spawn contemporanee per lo stesso endpoint);
//  - un errore non si cache-a: il giro fallito non lascia nulla e la
//    prossima lettura riparte da zero.
//
// La finestra e' breve PERCHE' la cache non deve nascondere i cambi di tmux:
// kill, avvio e cambio finestra diventano visibili al piu' tardi al primo
// giro dopo la finestra. Il test di freschezza custodisce esattamente questo.

// Finestra di coalescing in millisecondi. Il valore e' un contratto
// operativo (decisione approvata): al piu' 2 s di latenza aggiuntiva sulla
// vista sessioni, in cambio di una serie sola di spawn per finestra.
const TMUX_READS_WINDOW_MS = 2000;

function createTmuxReadWindow(loader, windowMs = TMUX_READS_WINDOW_MS) {
  let cached = null;
  let inFlight = null;
  return {
    async read() {
      if (cached && Date.now() - cached.at < windowMs) return cached.value;
      if (inFlight) return inFlight;
      inFlight = (async () => {
        try {
          const value = await loader();
          cached = { at: Date.now(), value };
          return value;
        } finally {
          inFlight = null;
        }
      })();
      return inFlight;
    },
  };
}

module.exports = { TMUX_READS_WINDOW_MS, createTmuxReadWindow };
