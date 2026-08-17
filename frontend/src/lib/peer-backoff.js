// R21 — backoff sui peer irraggiungibili + tre cause distinte.
//
// Il difetto: con tre peer spenti la PWA li interrogava A CADENZA FISSA
// finché la scheda restava aperta — 502 su sessions, fleet/status, vl-nodes,
// migliaia di righe in console, e alla fine il service worker cedeva con
// «Failed to fetch». Un peer morto intasava la vista di chi stava guardando
// GLI ALTRI peer.
//
// La cura, in due parti:
//  1. BACKOFF: un peer che non risponde si interroga sempre più di rado, con
//     un tetto. Quando torna a rispondere la cadenza torna normale — e questo
//     va testato, altrimenti il backoff diventa una condanna.
//  2. TRE CAUSE CON NOME: tre esiti diversi producono tre azioni diverse per
//     chi guarda, e oggi sono lo stesso rumore indistinto:
//        502 — il peer non c'è (il proxy risponde onestamente su un peer
//              assente)            → azione: aspettare;
//        403 — il peer c'è e NEGA (permesso non concesso SUL NODO REMOTO)
//                                   → azione: concedere il permesso;
//        404 — il peer c'è ma quella rotta non esiste
//                                   → azione: aggiornare il nodo.
//
// Modello puro: niente React, niente fetch. Lo stato è una mappa
// { [key]: { failures, cause, nextAtMs } } che il chiamante conserva fra un
// giro e l'altro; il tempo (nowMs) e la schedulazione sono iniettati, così i
// test non dipendono dall'orologio.

export const BACKOFF_DEFAULTS = { baseMs: 4000, capMs: 60000 };

// Tre cause con nome — DATI, non testo: le frasi si compongono al confine
// UI (roster-view-model), mai qui dove non si sa abbastanza per scriverle.
export const CAUSE_PEER_ASENTE = 'peer-assente';
export const CAUSE_PEER_NEGA = 'peer-nega';
export const CAUSE_ROTTA_INESISTENTE = 'rotta-inesistente';

// Classifica l'esito di una chiamata fallita a un peer. Gli status sono
// quelli del proxy federato; qualunque altro fallimento (rete giu', service
// worker che cede, 5xx) finisce nella causa «aspetta»: per chi guarda l'azione
// è la stessa del 502. Lo status grezzo resta disponibile per chi lo vuole
// mostrare, ma la causa e' una delle tre.
export function classifyPeerFailure(err) {
  const status = err && err.status;
  if (status === 403) return CAUSE_PEER_NEGA;
  if (status === 404) return CAUSE_ROTTA_INESISTENTE;
  return CAUSE_PEER_ASENTE;
}

// Ritardo prima del prossimo tentativo dopo `failures` fallimenti consecutivi.
// failures=0 -> 0 (nessun backoff); 1 -> baseMs (un solo fallimento non
// rallenta il recupero: il prossimo giro prova comunque); poi raddoppia fino
// al tetto. Il tetto esiste perche' «sempre piu' di rado» senza limite
// diventerebbe «mai piu'».
export function backoffDelayMs(failures, { baseMs, capMs } = BACKOFF_DEFAULTS) {
  if (!Number.isFinite(failures) || failures < 1) return 0;
  return Math.min(baseMs * 2 ** (failures - 1), capMs);
}

// Si puo' interrogare questo peer adesso? Un peer mai fallito si interroga
// sempre; uno fallito solo quando nowMs ha raggiunto il suo nextAtMs.
export function shouldPollPeer(states, key, nowMs) {
  const s = states && states[key];
  if (!s || !(s.failures >= 1)) return true;
  return nowMs >= s.nextAtMs;
}

// Registra un fallimento: incrementa il conteggio, fissa la causa corrente e
// sposta in avanti il prossimo tentativo. Ritorna la mappa NUOVA (immutabile:
// chi chiama sostituisce la ref, niente mutazioni in posto che i test non
// vedrebbero).
export function recordPeerFailure(states, key, cause, nowMs, sched = BACKOFF_DEFAULTS) {
  const prev = (states && states[key]) || { failures: 0 };
  const failures = prev.failures + 1;
  return {
    ...states,
    [key]: { failures, cause, nextAtMs: nowMs + backoffDelayMs(failures, sched) },
  };
}

// Registra un successo: il peer è tornato, la cadenza torna NORMALE. Se non
// c'era stato registrato, ritorna la mappa intatta (niente oggetti nuovi per
// rumore).
export function recordPeerSuccess(states, key) {
  if (!states || !(key in states)) return states;
  const out = { ...states };
  delete out[key];
  return out;
}
