// Chi risolve il peer di una vista VL aperta, e quando la vista si chiude.
//
// La vista tiene l'IDENTITÀ (nodo + owner + route) e il peer si risolve a ogni
// render dalla lista viva. Le regole sono quelle decise per lo strato:
//
//   1. un peer in lista, anche `stale`, si mostra: è «l'ultimo dato noto», e la
//      vista lo dichiara (non si chiude a ogni publish intermedio);
//   2. il polling verso un peer non corrente si sospende (lo decide la vista);
//   3. la vista si chiude SOLO quando la lista viva c'è e il peer non c'è più,
//      nemmeno come stale;
//   4. se una lista viva in questa shell non esiste (mobile: hook spento) o è
//      ancora vuota, non si chiude e non si finge: si resta sull'ultimo dato
//      noto dichiarandolo.
//
// Funzione pura: la stessa regola vale per la vista e per i test.

function peerMinimo(sessione) {
  return {
    kind: 'vl',
    nodeId: sessione.nodeId,
    name: sessione.nodeId,
    label: sessione.label || sessione.nodeId,
    route: Array.isArray(sessione.route) ? sessione.route : [],
    online: false,
    lastSeen: null,
    generation: null,
    session: null,
    health: null,
  };
}

// `live` e' la fonte dedicata delle shell senza lista di gruppi (mobile):
//   { trovato: true, peer }  il nodo c'e'    -> corrente (o stale, se lo dice)
//   { trovato: false }       il nodo non c'e' -> e' sparito, la vista si chiude
//   null / assente           la fonte non ha risposto -> «non lo so»
export function risolviVlSession(sessione, gruppi, { isDesktop = true, live = null } = {}) {
  if (!sessione || typeof sessione !== 'object' || !sessione.nodeId) return null;
  const lista = Array.isArray(gruppi) ? gruppi : [];
  for (const gruppo of lista) {
    const p = gruppo && gruppo.peer;
    if (!p || p.nodeId !== sessione.nodeId) continue;
    if ((p.ownerInstanceId || null) !== (sessione.ownerInstanceId || null)) continue;
    return { peer: p, nonCorrente: p.stale === true || gruppo.fleetState === 'stale' };
  }
  // La fonte dedicata ha risposto: dice presenza o assenza, e vale come la lista.
  if (live && live.trovato === true && live.peer) {
    return { peer: live.peer, nonCorrente: live.peer.stale === true };
  }
  if (live && live.trovato === false) return null;
  // La lista c'è e non lo contiene: il nodo non esiste più.
  if (isDesktop && lista.length > 0) return null;
  // Nessuna fonte ha risposto (o la lista è ancora vuota): «non lo so».
  return { peer: peerMinimo(sessione), nonCorrente: true };
}
