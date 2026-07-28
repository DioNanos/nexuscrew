// Snapshot in memoria per lo switcher mobile. Non persiste dati, non cambia
// il polling esistente: serve solo ad aprire il drawer senza attendere la rete.
let snapshot = {
  sessions: [], cells: [], nodeGroups: [], localNodeId: '',
  localFresh: false, refreshedAt: 0,
};

export function readCellSwitcherSnapshot() {
  return snapshot;
}

export function writeCellSwitcherSnapshot(next = {}) {
  snapshot = {
    sessions: Array.isArray(next.sessions) ? next.sessions : [],
    cells: Array.isArray(next.cells) ? next.cells : [],
    nodeGroups: Array.isArray(next.nodeGroups) ? next.nodeGroups : [],
    localNodeId: typeof next.localNodeId === 'string' ? next.localNodeId : '',
    // Il drawer mobile puo' usare la cache solo come punto di partenza visivo.
    // Questi flag indicano se il suo poll ha verificato la posizione: una riga
    // cache-only non diventa mai selezionabile per errore.
    localFresh: next.localFresh === true,
    refreshedAt: Number.isFinite(next.refreshedAt) ? next.refreshedAt : 0,
  };
  return snapshot;
}
