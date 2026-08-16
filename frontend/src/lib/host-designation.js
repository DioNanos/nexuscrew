// Logica pura del ciclo della stellina: none -> favorite -> live -> none
// (contratto rev6 §2.1). "live" e' server-owned (hostCell); "favorite" e'
// client-owned (pin locale in nc_pins). Nessuna fetch qui: modulo puro e
// testabile, come pins.js.
//
// Precedenza di rendering: live > favorite > none. Una cella live e' rossa
// ANCHE senza pin locale (e' l'host del nodo).
//
// IDENTITA': il cellId si legge da item.value.cell (lo stesso campo che il
// server memorizza come hostCell), NON parsando item.key. La chiave del roster
// locale e' il tmuxSession nudo (positionKey([], tmuxSession)), non la forma
// "local:<cella>" che nessuno produce.

export const HOST_NONE = 'none';
export const HOST_FAVORITE = 'favorite';
export const HOST_LIVE = 'live';

// Stato di rendering della stellina per un item del roster.
// - live: hostCell === item.value.cell (la cella e' l'host del nodo).
// - favorite: l'item e' nel pin locale (item.key) e non e' live.
// - none: altrimenti.
// Le sessioni tmux non hanno value.cell: non sono mai host di un nodo, quindi
// ricadono su favorite/none. Le celle REMOTE invece ce l'hanno (stessa forma
// dell'oggetto cella locale, v. roster-view-model.js buildRemoteRoster) — la
// funzione e' identica per locale e remoto: e' il CHIAMANTE che deve passare
// l'hostCell DEL NODO GIUSTO (v. hostRouteKey sotto), mai quello di un altro.
export function hostRenderState({ hostCell, pins = [], item }) {
  const cell = item && item.value && typeof item.value.cell === 'string' ? item.value.cell : null;
  if (cell != null && hostCell === cell) return HOST_LIVE;
  if (Array.isArray(pins) && item && pins.includes(item.key)) return HOST_FAVORITE;
  return HOST_NONE;
}

// Prossima azione al clic, dato lo stato di rendering corrente:
//   none     -> 'addPin'         (locale: aggiunge pin, diventa favorite)
//   favorite -> 'designate'      (API POST designate: diventa live)
//   live     -> 'clearAndUnpin'  (API POST clear + remove pin: torna none)
export function hostNextAction(renderState) {
  if (renderState === HOST_LIVE) return 'clearAndUnpin';
  if (renderState === HOST_FAVORITE) return 'designate';
  return 'addPin';
}

// Seam lease↔designazione (2026-08-15): lo stato lease dell'host designato,
// distintamente. I cinque stati del backend (live|grace|expired|none|
// unavailable) non collassano: chi legge distingue «non idonea perche' morta»
// da «non idonea perche' in recupero». Ogni stato ha la propria chiave i18n
// (guardia tests/i18n.test.js: parita' it/en/es, mai vuote).
// - Solo il LIVE HOST mostra lo stato lease: fuori dal live non c'e' soggetto.
// - Stato assente (server vecchio che non espone host.lease) o sconosciuto:
//   NESSUNA etichetta — mai una bugia per riempire lo spazio.
const HOST_LEASE_STATES = Object.freeze(['live', 'grace', 'expired', 'none', 'unavailable']);

export function hostLeaseTitleKey(renderState, hostLease) {
  if (renderState !== HOST_LIVE) return null;
  if (!HOST_LEASE_STATES.includes(hostLease)) return null;
  return `host-lease-${hostLease}`;
}

// --- Per-nodo (0.9.1 seconda meta') ------------------------------------------
// hostByRoute e' una mappa {chiave -> {hostCell, hostLease, hostRevision}}, una
// voce per nodo. La chiave e' la stessa forma gia' in uso altrove per lo stesso
// scopo (bootCellKey in Sidebar/SessionList, nodeRoute): la route joinata, o
// 'local' quando vuota/assente. Una singola funzione condivisa evita che le due
// shell (desktop/mobile) divergano su com'e' fatta la chiave.
export const HOST_LOCAL_KEY = 'local';
export function hostRouteKey(route) {
  return Array.isArray(route) && route.length ? route.join('/') : HOST_LOCAL_KEY;
}

// Quale causa mostrare quando designate/clear falliscono. Il gate federato
// (lib/proxy/federation.js) risponde 403 con reason 'live-host-not-granted' —
// jsonFetch (frontend/src/lib/api.js) lo propaga come err.data.reason. Ogni
// altro fallimento (rete, 500, nodo irraggiungibile) ha comunque una chiave:
// il difetto che questo chiude e' il silenzio, non la precisione della causa.
export function hostDesignationFailureMessage(error) {
  const reason = error && error.data && typeof error.data === 'object' ? error.data.reason : null;
  return reason === 'live-host-not-granted' ? 'live-host-not-granted' : 'live-host-error';
}
