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
// `owner` — {instanceId, route, label} — identifica DA CHI viene questo
// nodo (step 3, NC_UI_NODI_VL_REMOTI): il locale di default (route vuota),
// o un owner federato quando il chiamante lo fonde da piu' owner
// (`topologyVlOwners`). Portato sul peer perche' due nodi con la stessa
// label su owner diversi sono distinguibili SOLO cosi' (brief, invariante
// 2), ed e' anche cio' che decide a quale route va instradato un comando
// (invariante 3) — sbagliare owner qui manda il comando al device sbagliato.
export function vlNodeToPeer(node, owner = {}) {
  if (!node || typeof node !== 'object') return null;
  const nodeId = typeof node.nodeId === 'string' ? node.nodeId : '';
  if (!nodeId) return null;
  const label = (typeof node.label === 'string' && node.label.trim())
    || (typeof node.cell === 'string' && node.cell.trim())
    || nodeId;
  const route = Array.isArray(owner.route) ? [...owner.route] : [];
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
    route,
    isLocal: route.length === 0,
    ownerInstanceId: typeof owner.instanceId === 'string' ? owner.instanceId : null,
    ownerLabel: typeof owner.label === 'string' && owner.label ? owner.label : null,
  };
}

// Porta la semantica di `topologyOwners()` (lib/mcp/cells.js, server MCP)
// nel frontend: dalla stessa `/api/topology` che `useNodes.js` gia' polla,
// gli owner VIVI (non stale) e diversi dal locale, deduplicati per
// instanceId (prima occorrenza vince). Un owner stale non e' un bersaglio
// raggiungibile per un comando, quindi non entra nella lista.
export function topologyVlOwners(topology, localInstanceId) {
  const nodes = topology && Array.isArray(topology.nodes) ? topology.nodes : [];
  const seen = new Set([localInstanceId]);
  const out = [];
  for (const node of nodes) {
    const instanceId = node && typeof node.instanceId === 'string' ? node.instanceId : '';
    if (!instanceId || seen.has(instanceId)) continue;
    if (node.stale === true) continue;
    if (!Array.isArray(node.route) || node.route.length === 0) continue;
    seen.add(instanceId);
    const label = (typeof node.label === 'string' && node.label)
      || (typeof node.name === 'string' && node.name)
      || node.route.join(' › ');
    out.push({ instanceId, route: [...node.route], label });
  }
  return out;
}
