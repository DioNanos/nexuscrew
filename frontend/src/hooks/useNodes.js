// Hook dei gruppi per-nodo (B2, design §5): polla /api/nodes e, per i soli
// nodi col tunnel su, le sessioni remote via proxy /node/<name>/api/sessions.
// Best-effort ovunque: un nodo che non risponde diventa gruppo 'unreachable'
// (design §7, niente spinner infinito); zero nodi configurati -> groups = []
// e la UI resta identica a oggi.
import { useEffect, useRef, useState } from 'react';
import {
  apiFetch, getNodes, getTopology, getNodeAliases, getRouteSessions, fleetStatus, getVlNodes,
} from '../lib/api.js';
import { buildNodeGroups, trackDown } from '../lib/nodes-model.js';
import { vlNodeToPeer, topologyVlOwners, vlSidebarGroups } from '../lib/vl-nodes-model.js';

const POLL_MS = 4000;

export function useNodes(token, enabled = true, refreshKey = 0) {
  const [groups, setGroups] = useState([]);
  const downRef = useRef({});

  useEffect(() => {
    if (!enabled || !token) { setGroups([]); return undefined; }
    let alive = true;

    async function poll() {
      let nodes = []; let topology = []; let aliases = {}; let localInstanceId = '';
      await Promise.all([
        getNodes(token).then((j) => { nodes = Array.isArray(j.nodes) ? j.nodes : []; }).catch(() => {}),
        getTopology(token).then((j) => { topology = Array.isArray(j.nodes) ? j.nodes : []; }).catch(() => {}),
        getNodeAliases(token).then((j) => { aliases = j && typeof j.aliasesByInstanceId === 'object' ? j.aliasesByInstanceId : {}; }).catch(() => {}),
        apiFetch('/api/config', token).then((r) => r.json())
          .then((j) => { localInstanceId = j && typeof j.instanceId === 'string' ? j.instanceId : ''; }).catch(() => {}),
      ]);
      if (!alive) return;
      // Nodi VL nella stessa lista della sidebar (VL_NODES_IN_SIDEBAR):
      // owner locale + owner federati vivi dalla topology gia' pollata —
      // stessa semantica multi-owner di SettingsPanel (readVlDirectory).
      // Best-effort per-owner: un owner che non risponde non blocca gli
      // altri e non blocca i gruppi Fleet.
      // topologyVlOwners legge la RISPOSTA di /api/topology ({nodes:[...]});
      // qui `topology` è già l'array spacchettato — va riavvolto, o gli owner
      // federati risultano SEMPRE vuoti e i nodi VL restano visibili solo a
      // chi è collegato all'owner che li ospita (trovato con il test
      // federato: nodo su un owner, UI su un altro).
      const vlOwners = [
        { instanceId: localInstanceId || null, route: [], label: null },
        ...topologyVlOwners({ nodes: topology }, localInstanceId),
      ];
      const vlPeers = [];
      await Promise.all(vlOwners.map(async (owner) => {
        try {
          const payload = await getVlNodes(token, owner.route);
          for (const raw of payload.nodes || []) {
            const peer = vlNodeToPeer(raw, owner);
            if (peer) vlPeers.push(peer);
          }
        } catch (_) { /* owner senza vl-nodes o irraggiungibile: zero righe, mai un blocco */ }
      }));
      if (!alive) return;
      const remote = {};
      const fleet = {};
      const direct = new Set(nodes.map((n) => n.name));
      const routes = [];
      for (const n of nodes) {
        if (n.tunnel?.status === 'up' && (n.nodeId || n.paired !== false)
          && (n.direction !== 'inbound' || n.shared === true)) routes.push([n.name]);
      }
      for (const n of topology) {
        if (!n.stale && Array.isArray(n.route) && !(n.route.length === 1 && direct.has(n.route[0]))) routes.push(n.route);
      }
      // Per ogni posizione remota up: sessions (tmux) E fleet (celle attive/inattive
      // + capability). Cosi' il client remoto non perde piu' le celle Fleet di un
      // nodo: ogni posizione mostra celle Fleet + tmux unmanaged (inventario Hydra).
      await Promise.all(routes.map(async (route) => {
        const key = route.join('/');
        try {
          remote[key] = await getRouteSessions(token, route);
        } catch (_) {
          remote[key] = { error: 'unreachable' };
        }
        try {
          fleet[key] = await fleetStatus(token, route);
        } catch (_) {
          fleet[key] = { available: false };
        }
      }));
      if (!alive) return;
      const first = buildNodeGroups({ nodes, topology, remote, fleet, aliases, down: downRef.current });
      downRef.current = trackDown(downRef.current, first, Math.floor(Date.now() / 1000));
      setGroups([
        ...buildNodeGroups({ nodes, topology, remote, fleet, aliases, down: downRef.current }),
        ...vlSidebarGroups(vlPeers),
      ]);
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [token, enabled, refreshKey]);

  return groups;
}
