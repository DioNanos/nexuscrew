// Hook dei gruppi per-nodo (B2, design §5): polla /api/nodes e, per i soli
// nodi col tunnel su, le sessioni remote via proxy /node/<name>/api/sessions.
// Best-effort ovunque: un nodo che non risponde diventa gruppo 'unreachable'
// (design §7, niente spinner infinito); zero nodi configurati -> groups = []
// e la UI resta identica a oggi.
import { useEffect, useRef, useState } from 'react';
import { getTopology, getRouteSessions } from '../lib/api.js';

const POLL_MS = 4000;

export function useNodes(token, enabled = true) {
  const [groups, setGroups] = useState([]);
  const downRef = useRef({});

  useEffect(() => {
    if (!enabled || !token) { setGroups([]); return undefined; }
    let alive = true;

    async function poll() {
      let topology = [];
      try {
        const j = await getTopology(token);
        topology = Array.isArray(j.nodes) ? j.nodes : [];
      } catch (_) { topology = []; }
      if (!alive) return;
      const groups = [];
      await Promise.all(topology.map(async (n) => {
        const key = n.route.join('/');
        try {
          const remote = await getRouteSessions(token, n.route);
          delete downRef.current[key];
          groups.push({
            name: n.name, label: n.route.join(' › '), route: n.route, status: 'up',
            sessions: (remote.sessions || []).map((s) => ({ ...s, node: key, route: n.route, key: `${key}:${s.name}` })),
          });
        } catch (_) {
          downRef.current[key] ||= Math.floor(Date.now() / 1000);
          groups.push({ name: n.name, label: n.route.join(' › '), route: n.route, status: 'unreachable', sessions: [], downSince: downRef.current[key] });
        }
      }));
      if (!alive) return;
      setGroups(groups.sort((a, b) => a.label.localeCompare(b.label)));
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [token, enabled]);

  return groups;
}
