// Guardia di non-sovrapposizione per i poll del desktop.
//
// Perche' serve: il poll parte ogni 4 s, ma una lettura federata puo' durare
// fino al timeout di rete (8 s, api.js). Senza guardia due giri stanno in volo
// insieme, e la risposta piu' VECCHIA puo' atterrare dopo la piu' nuova:
// l'ultima lista nota «torna indietro», e la rail lampeggia perche' riceve due
// esiti diversi della stessa interrogazione.
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
    /** Chiude il giro. Va chiamato SEMPRE, anche sul percorso d'errore. */
    end() {
      inFlight = false;
    },
    /** L'esito di questo token e' ancora quello da applicare? */
    isCurrent(token) {
      return token !== null && token === seq;
    },
  };
}
