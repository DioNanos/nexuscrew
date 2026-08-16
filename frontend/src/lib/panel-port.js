// Quale porta pannello usa il frame di UNA cella (P0 stessa-origin, meta'
// remota). La porta e' per-CELLA attraverso la sua route:
//   - route vuota  -> la porta pannello del nodo che serve la pagina (config);
//   - route remota -> la porta inoltrata (tunnel -L) del primo nodo della
//                     route, dalla mappa nodePanelPorts di /api/config.
// La guardia che non si negozia: una cella remota il cui nodo NON ha porta
// pannello negoziata (peer accoppiato prima di questa funzione) prende 0, mai
// in prestito la porta del nodo locale — sarebbe l'origin del pannello
// sbagliato, non un fallback. Con 0 il frame resta sulla via storica.
export function panelPortForRoute(route, nodePanelPorts, localPanelPort) {
  const prima = (primaPorta) => (Number.isInteger(primaPorta) && primaPorta > 0 && primaPorta < 65536 ? primaPorta : 0);
  // Assente = cella locale (il chiamante senza route); una "route" che non e'
  // un array e' garbage, non una cella locale: non si presta la porta locale
  // a un'origine che non si capisce cosa sia.
  if (route === undefined || route === null) return prima(localPanelPort);
  if (!Array.isArray(route)) return 0;
  if (route.length === 0) return prima(localPanelPort);
  const nome = typeof route[0] === 'string' ? route[0] : null;
  const mappa = nodePanelPorts && typeof nodePanelPorts === 'object' ? nodePanelPorts : {};
  return nome ? prima(mappa[nome]) : 0;
}
