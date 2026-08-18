// frontend/src/lib/fleet-read-policy.js — R27: cosa fare della lista celle
// quando la lettura della flotta risponde o fallisce. La decisione vive qui,
// pura, perche' vale per DUE consumatori (SessionList mobile e poll desktop
// di App.jsx) che prima duplicavano lo stesso difetto: un fleet che non
// risponde svuotava la lista in silenzio, e la home sembrava «tutto offline».
//
// Regola: una lista vuota e' un DATO soltanto quando la lettura e' riuscita.
// Un fallimento (rete, 401, 5xx) o un `available:false` non dicono «zero
// celle definite» — dicono «non ho potuto leggere»: resta l'ULTIMA lista
// nota e la UI lo dichiara con l'indicatore stale. Stesso principio gia'
// documentato per hostByRoute in App.jsx: una route irraggiungibile non
// cancella lo stato delle altre («resta lo stato precedente»).

// Ritorna { kind: 'data', cells, capabilities } quando la risposta e' un
// dato (i consumatori aggiornano la lista — anche verso lista vuota vera),
// { kind: 'stale' } quando non si e' potuto leggere (i consumatori NON
// toccano la lista corrente e accendono l'indicatore).
export function fleetReadOutcome({ fs = null, error = null } = {}) {
  if (error) return { kind: 'stale' };
  if (!fs || fs.available !== true) return { kind: 'stale' };
  return { kind: 'data', cells: fs.cells || [], capabilities: fs.capabilities || [] };
}
