// Logica pura del ciclo della stellina: none -> favorite -> designated thread
// -> none. La designazione e' server-owned (hostCell), il pin e' client-owned
// (pin locale in nc_pins), mentre threadStatus descrive il runtime osservato.
// Nessuna fetch qui: modulo puro e testabile, come pins.js.
//
// IDENTITA': il cellId si legge da item.value.cell (lo stesso campo che il
// server memorizza come hostCell), NON parsando item.key. La chiave del roster
// locale e' il tmuxSession nudo (positionKey([], tmuxSession)), non la forma
// "local:<cella>" che nessuno produce.

export const HOST_NONE = 'none';
export const HOST_FAVORITE = 'favorite';
export const HOST_DESIGNATED = 'designated';
export const HOST_THREAD_PRESENT = 'thread-present';
export const HOST_THREAD_ACTIVE = 'thread-active';
export const HOST_THREAD_UNKNOWN = 'thread-unknown';
const HOST_THREAD_STATES = new Set([
  HOST_DESIGNATED, HOST_THREAD_PRESENT, HOST_THREAD_ACTIVE, HOST_THREAD_UNKNOWN,
]);

export function hostThreadState(threadStatus) {
  if (threadStatus === 'absent') return HOST_DESIGNATED;
  if (threadStatus === 'present') return HOST_THREAD_PRESENT;
  if (threadStatus === 'active') return HOST_THREAD_ACTIVE;
  return HOST_THREAD_UNKNOWN;
}

export function hostThreadTitleKey(renderState) {
  if (!HOST_THREAD_STATES.has(renderState)) return null;
  return `host-thread-${renderState.replace('thread-', '')}`;
}

// Stato di rendering della stellina per un item del roster.
// - designated/thread-present/thread-active/thread-unknown: hostCell ===
//   item.value.cell e threadStatus indica cio' che il nodo ha misurato.
// - favorite: l'item e' nel pin locale (item.key) e non e' designato.
// - none: altrimenti.
// Le sessioni tmux non hanno value.cell: non sono mai host di un nodo, quindi
// ricadono su favorite/none. Le celle REMOTE invece ce l'hanno (stessa forma
// dell'oggetto cella locale, v. roster-view-model.js buildRemoteRoster) — la
// funzione e' identica per locale e remoto: e' il CHIAMANTE che deve passare
// l'hostCell DEL NODO GIUSTO (v. hostRouteKey sotto), mai quello di un altro.
export function hostRenderState({ hostCell, threadStatus, pins = [], item }) {
  const cell = item && item.value && typeof item.value.cell === 'string' ? item.value.cell : null;
  if (cell != null && hostCell === cell) return hostThreadState(threadStatus);
  if (Array.isArray(pins) && item && pins.includes(item.key)) return HOST_FAVORITE;
  return HOST_NONE;
}

// Prossima azione al clic, dato lo stato di rendering corrente:
//   none     -> 'addPin'         (locale: aggiunge pin, diventa favorite)
//   favorite -> 'designate'      (API POST designate: diventa live)
//   live     -> 'clearAndUnpin'  (API POST clear + remove pin: torna none)
export function hostNextAction(renderState) {
  if (HOST_THREAD_STATES.has(renderState)) return 'clearAndUnpin';
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
  if (!HOST_THREAD_STATES.has(renderState)) return null;
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
