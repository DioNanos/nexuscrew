// frontend/src/lib/fleet-read-policy.js — R27: cosa fare della lista celle
// quando la lettura della flotta risponde o fallisce. La decisione vive qui,
// pura, perche' vale per DUE consumatori (SessionList mobile e poll desktop
// di App.jsx).
//
// rev3 (audit r27lista): available:false NON e' un fallimento di lettura —
// e' il server che parla, e dice PERCHE' nel campo `reason` (la route /status
// lo propaga sempre: lib/fleet/routes.js). Tre esiti:
//
//  - kind 'data'    — available:true: la risposta e' un dato. La lista si
//    aggiorna, anche verso lista vuota («zero celle definite» e' vero).
//  - kind 'stale'   — non si e' potuto leggere (reject: rete/401/5xx) OPPURE
//    la config del fleet e' illeggibile (reason «fleet.json …»: mancante,
//    invalido, non verificabile — transitorio ai fini dell'elenco). Resta
//    l'ULTIMA lista nota e la UI lo dichiara (principio hostByRoute).
//  - kind 'disabled' — il fleet e' spento PER SCELTA (reason di configurazione
//    esplicita: «(fleetEnabled=false)», «(builtinEnabled=false)» — provider.js
//    li scrive cosi') o, in fail-safe, available:false con reason non
//    riconosciuto: la risposta e' comunque RIUSCITA, quindi zero celle e' la
//    verita' — lista vuota con indicatore distinto, MAI le celle fantasma
//    dell'ultima lista nota (il caso peggiore secondo l'audit).

// Le classi di reason come le scrive il provider: «spento per scelta» porta il
// nome della config tra parentesi (fleetEnabled=false / builtinEnabled=false);
// «non ho potuto leggere» parla del file (fleet.json mancante / invalido /
// non verificabile). Quelle stringhe sono l'interfaccia che /status espone.
const OFF_UNREADABLE = /fleet\.json/;

// Ritorna { kind: 'data', cells, capabilities } | { kind: 'stale' } |
// { kind: 'disabled', reason: string | null }.
export function fleetReadOutcome({ fs = null, error = null } = {}) {
  if (error) return { kind: 'stale' };
  if (!fs) return { kind: 'stale' };
  if (fs.available === true) {
    return { kind: 'data', cells: fs.cells || [], capabilities: fs.capabilities || [] };
  }
  const reason = typeof fs.reason === 'string' ? fs.reason : '';
  if (OFF_UNREADABLE.test(reason)) return { kind: 'stale' };
  return { kind: 'disabled', reason: reason || null };
}
