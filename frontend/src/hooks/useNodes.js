// Hook dei gruppi per-nodo (B2, design §5): polla /api/nodes e, per i soli
// nodi col tunnel su, le sessioni remote via proxy /node/<name>/api/sessions.
// Best-effort ovunque: un nodo che non risponde diventa gruppo 'unreachable'
// (design §7, niente spinner infinito); zero nodi configurati -> groups = []
// e la UI resta identica a oggi.
import { useEffect, useRef, useState } from 'react';
import { getNodes, getTopology, getRouteSessions } from '../lib/api.js';
import { buildNodeGroups, trackDown } from '../lib/nodes-model.js';

const POLL_MS = 4000;

export function useNodes(token, enabled = true) {
  const [groups, setGroups] = useState([]);
  const downRef = useRef({});

  useEffect(() => {
    if (!enabled || !token) { setGroups([]); return undefined; }
    let alive = true;

    async function poll() {
      let nodes = []; let topology = [];
      await Promise.all([
        getNodes(token).then((j) => { nodes = Array.isArray(j.nodes) ? j.nodes : []; }).catch(() => {}),
        getTopology(token).then((j) => { topology = Array.isArray(j.nodes) ? j.nodes : []; }).catch(() => {}),
      ]);
      if (!alive) return;
      const remote = {};
      const direct = new Set(nodes.map((n) => n.name));
      const routes = [];
      for (const n of nodes) {
        if (n.tunnel?.status === 'up' && (n.nodeId || n.paired !== false)) routes.push([n.name]);
      }
      for (const n of topology) {
        if (!n.stale && Array.isArray(n.route) && !(n.route.length === 1 && direct.has(n.route[0]))) routes.push(n.route);
      }
      await Promise.all(routes.map(async (route) => {
        const key = route.join('/');
        try {
          remote[key] = await getRouteSessions(token, route);
        } catch (_) {
          remote[key] = { error: 'unreachable' };
        }
      }));
      if (!alive) return;
      const first = buildNodeGroups({ nodes, topology, remote, down: downRef.current });
      downRef.current = trackDown(downRef.current, first, Math.floor(Date.now() / 1000));
      setGroups(buildNodeGroups({ nodes, topology, remote, down: downRef.current }));
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [token, enabled]);

  return groups;
}
