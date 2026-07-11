// Hook dei gruppi per-nodo (B2, design §5): polla /api/nodes e, per i soli
// nodi col tunnel su, le sessioni remote via proxy /node/<name>/api/sessions.
// Best-effort ovunque: un nodo che non risponde diventa gruppo 'unreachable'
// (design §7, niente spinner infinito); zero nodi configurati -> groups = []
// e la UI resta identica a oggi.
import { useEffect, useRef, useState } from 'react';
import { getNodes, getNodeSessions } from '../lib/api.js';
import { buildNodeGroups, trackDown } from '../lib/nodes-model.js';

const POLL_MS = 4000;

export function useNodes(token, enabled = true) {
  const [groups, setGroups] = useState([]);
  const downRef = useRef({}); // name -> epochSec prima osservazione del down

  useEffect(() => {
    if (!enabled || !token) { setGroups([]); return undefined; }
    let alive = true;

    async function poll() {
      let nodes = [];
      try {
        const j = await getNodes(token);
        nodes = Array.isArray(j.nodes) ? j.nodes : [];
      } catch (_) { nodes = []; /* best-effort: API giu' = nessun gruppo */ }
      if (!alive) return;
      downRef.current = trackDown(downRef.current, nodes, Math.floor(Date.now() / 1000));
      const up = nodes.filter((n) => n && n.tunnel && n.tunnel.status === 'up');
      const remote = {};
      await Promise.all(up.map(async (n) => {
        try { remote[n.name] = await getNodeSessions(token, n.name); }
        catch (e) { remote[n.name] = { error: String((e && e.message) || e) }; }
      }));
      if (!alive) return;
      setGroups(buildNodeGroups({ nodes, remote, down: downRef.current }));
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => { alive = false; clearInterval(id); };
  }, [token, enabled]);

  return groups;
}
