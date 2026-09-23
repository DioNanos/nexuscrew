// Guardia di non-sovrapposizione per i poll del desktop.
//
// Perche' serve: il poll parte ogni 4 s e ogni RICHIESTA ha un tetto di tempo
// (App.jsx). Il tetto limita quanto DURA una richiesta, non il giro intero —
// che ne fa due in sequenza — e non impedisce che due giri coesistano: un tick
// parte comunque ogni 4 s. Senza guardia la risposta piu' VECCHIA puo' atterrare
// dopo la piu' nuova — l'ultima lista nota «torna indietro», e la rail riceve
// due esiti diversi della stessa interrogazione.
//
// Lo stesso rimedio e' gia' in uso in useNodes.js (`inFlightRef`): qui e'
// estratto in una funzione pura perche' e' verificabile senza montare il
// componente, e perche' i due poll di App.jsx (host e sessioni+flotta) devono
// usare la stessa regola invece di due copie.
//
// Due meccanismi, due righe di difesa:
//  - `begin()` ritorna `null` se un giro e' gia' in volo: il tick si SALTA,
//    quindi due giri non coesistono mai.
//  - il token di sequenza dice se l'esito che sta per essere applicato e'
//    ancora quello corrente. Se nel frattempo ne e' partito uno piu' nuovo,
//    l'esito vecchio si SCARTA invece di scrivere: senza questo, togliere la
//    sola attesa non basta, perche' la corsa resta aperta fra la risposta e
//    l'applicazione.
export function createPollGuard() {
  let seq = 0;
  let inFlight = false;
  return {
    /** Apre un giro. `null` se ce n'e' gia' uno in volo: chi lo riceve non deve lavorare. */
    begin() {
      if (inFlight) return null;
      inFlight = true;
      seq += 1;
      return seq;
    },
    /**
     * Chiude il giro aperto da `begin()`.
     *
     * Va chiamato SEMPRE, anche sul percorso d'errore — ma chiude solo se il
     * giro e' ANCORA quello corrente. Se nel frattempo la guardia e' stata
     * invalidata o un giro nuovo e' partito, `inFlight` appartiene a
     * quest'ultimo: azzerarlo qui lascierebbe partire un terzo giro in
     * parallelo al secondo, che e' la sovrapposizione che la guardia evita.
     */
    end(token) {
      if (token === seq) inFlight = false;
    },
    /**
     * Invalida il giro in corso e libera la guardia: chi ha un token vecchio
     * non e' piu' `isCurrent`, e il prossimo `begin()` parte subito invece di
     * essere saltato.
     *
     * Serve al cleanup di un effetto. Senza, cambiando `token` o sotto
     * `StrictMode` (setup→cleanup→setup) il giro vecchio resta in volo, il
     * nuovo `begin()` viene saltato, e la risposta vecchia atterra su una
     * guardia che la considera ancora corrente.
     */
    reset() {
      seq += 1;
      inFlight = false;
    },
    /** L'esito di questo token e' ancora quello da applicare? */
    isCurrent(token) {
      return token !== null && token === seq;
    },
  };
}
