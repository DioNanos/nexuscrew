// frontend/src/lib/vl-nodes-model.js — traduce un nodo VL (`/api/vl-nodes`)
// nella forma "peer" che `node-summary.js`/`node-detail.js`/`NodeSheet.jsx`
// già sanno rendere, cosi' la UI puo' fondere le due liste SOLO lato
// presentazione (design NC_UI_NODI_VL, 2026-08-05): il contratto di
// `/api/nodes`/`/api/peers` non cambia, e questo file non tocca il backend.
//
// Mappatura misurata nel brief — solo `nodeId`/`label`/`health` sono davvero
// condivisi con un peer NexusCrew:
//   nome         -> `label` (poi `cell`, poi `nodeId`: mai una riga senza nome)
//   accoppiato   -> derivato da `pairedAt` (booleano, non il timestamp)
//   salute       -> `health`, stessa forma, passata attraverso invariata
//   collegamento -> non c'e' un tunnel: `online`/`lastSeen` (stato del poll)
//   avvio auto   -> non esposto oggi dal backend: OMESSO, mai inventato
//   condivisione -> non applicabile (i nodi VL non si federano): nessun
//                   campo `shared`/`visibility` viene scritto
//   azioni       -> `capabilities` passate attraverso (le legge il
//                   componente, non questo modulo — regola del brief: mai
//                   una lista fissa lato frontend)
export function vlNodeToPeer(node) {
  if (!node || typeof node !== 'object') return null;
  const nodeId = typeof node.nodeId === 'string' ? node.nodeId : '';
  if (!nodeId) return null;
  const label = (typeof node.label === 'string' && node.label.trim())
    || (typeof node.cell === 'string' && node.cell.trim())
    || nodeId;
  return {
    kind: 'vl',
    nodeId,
    name: nodeId,
    label,
    cell: node.cell ?? null,
    paired: !!node.pairedAt,
    online: !!node.online,
    lastSeen: node.lastSeen ?? null,
    generation: node.generation ?? null,
    version: node.version ?? null,
    health: node.health ?? null,
    capabilities: Array.isArray(node.capabilities) ? node.capabilities : [],
    inflight: node.inflight ?? null,
    lastAck: node.lastAck ?? null,
    canManage: !!node.canManage,
  };
}
