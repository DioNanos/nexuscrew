// Snapshot in memoria per lo switcher mobile. Non persiste dati, non cambia
// il polling esistente: serve solo ad aprire il drawer senza attendere la rete.
let snapshot = { sessions: [], cells: [], nodeGroups: [], localNodeId: '' };

export function readCellSwitcherSnapshot() {
  return snapshot;
}

export function writeCellSwitcherSnapshot(next = {}) {
  snapshot = {
    sessions: Array.isArray(next.sessions) ? next.sessions : [],
    cells: Array.isArray(next.cells) ? next.cells : [],
    nodeGroups: Array.isArray(next.nodeGroups) ? next.nodeGroups : [],
    localNodeId: typeof next.localNodeId === 'string' ? next.localNodeId : '',
  };
  return snapshot;
}
