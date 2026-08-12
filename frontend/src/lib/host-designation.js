// Logica pura del ciclo della stellina: none -> favorite -> live -> none
// (contratto rev6 §2.1). "live" e' server-owned (hostCell); "favorite" e'
// client-owned (pin locale in nc_pins). Nessuna fetch qui: modulo puro e
// testabile, come pins.js.
//
// Precedenza di rendering: live > favorite > none. Una cella live e' rossa
// ANCHE senza pin locale (e' l'host del nodo); altrimenti e' stellina gialla se
// nel pin locale; altrimenti vuota.

export const HOST_NONE = 'none';
export const HOST_FAVORITE = 'favorite';
export const HOST_LIVE = 'live';

// Estrae il cellId locale dalla chiave del roster locale ('local:<cell>').
// Le celle remote / le sessioni tmux non hanno un host: ritorna null (non sono
// mai designabili come host di questo nodo — federazione default-deny).
export function localCellId(item) {
  if (!item || typeof item.key !== 'string') return null;
  if (!item.key.startsWith('local:')) return null;
  const cell = item.key.slice('local:'.length);
  return cell || null;
}

// Stato di rendering della stellina per un item.
export function hostRenderState({ hostCell, pins = [], item }) {
  const cellId = localCellId(item);
  if (cellId != null && hostCell === cellId) return HOST_LIVE;
  if (Array.isArray(pins) && pins.includes(item && item.key)) return HOST_FAVORITE;
  return HOST_NONE;
}

// Prossima azione al clic, dato lo stato di rendering corrente:
//   none     -> 'addPin'         (locale: aggiunge pin, diventa favorite)
//   favorite -> 'designate'      (API POST designate: diventa live)
//   live     -> 'clearAndUnpin'  (API POST clear + rimuove pin: torna none)
export function hostNextAction(renderState) {
  if (renderState === HOST_LIVE) return 'clearAndUnpin';
  if (renderState === HOST_FAVORITE) return 'designate';
  return 'addPin';
}
