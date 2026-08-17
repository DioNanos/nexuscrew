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
import {
  classifyPeerFailure, recordPeerFailure, recordPeerSuccess, shouldPollPeer,
} from '../lib/peer-backoff.js';

const POLL_MS = 4000;

export function useNodes(token, enabled = true, refreshKey = 0) {
  const [groups, setGroups] = useState([]);
  const downRef = useRef({});
  // R21: backoff per-peer (stato) + ultima risposta nota (cache). Il peer
  // morto non si interroga piu' a cadenza fissa: si dirada fino al tetto, e
  // quando torna la cadenza torna normale. La cache mostra l'ultimo stato
  // noto durante i giri saltati — incluso il motivo per cui si salta.
  const backoffRef = useRef({});
  const peerCacheRef = useRef({ remote: {} });

  useEffect(() => {
    if (!enabled || !token) { setGroups([]); return undefined; }
    let alive = true;

    async function poll() {
      const pollStart = Date.now();
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
        // R21: stesso backoff dei peer — un owner morto interrogato ogni 4 s
        // faceva lo stesso rumore indistinto (vl-nodes nel log del pannello).
        const key = `vl:${owner.route.join('/')}`;
        if (!shouldPollPeer(backoffRef.current, key, pollStart)) return; // zero righe, come owner irraggiungibile
        try {
          const payload = await getVlNodes(token, owner.route);
          backoffRef.current = recordPeerSuccess(backoffRef.current, key);
          for (const raw of payload.nodes || []) {
            const peer = vlNodeToPeer(raw, owner);
            if (peer) vlPeers.push(peer);
          }
        } catch (e) {
          backoffRef.current = recordPeerFailure(backoffRef.current, key, classifyPeerFailure(e), pollStart);
        }
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
        // Una route vuota non e' una posizione fleet: e' il VL owner locale
        // (o un gruppo locale riflesso) e interrogarla con fleetStatus/
        // getRouteSessions rifletterebbe il fleet locale sotto un'altra
        // etichetta. Stesso criterio di rosterItemsByPosition/CellSwitcher.
        if (!n.stale && Array.isArray(n.route) && n.route.length > 0
          && !(n.route.length === 1 && direct.has(n.route[0]))) routes.push(n.route);
      }
      // Per ogni posizione remota up: sessions (tmux) E fleet (celle attive/inattive
      // + capability). Cosi' il client remoto non perde piu' le celle Fleet di un
      // nodo: ogni posizione mostra celle Fleet + tmux unmanaged (inventario Hydra).
      await Promise.all(routes.map(async (route) => {
        const key = route.join('/');
        if (!shouldPollPeer(backoffRef.current, key, pollStart)) {
          // R21: il peer in backoff NON si interroga — chi guarda gli ALTRI
          // peer non deve essere intasato dal suo rumore. Resta l'ultimo
          // stato noto, con la causa che l'ha prodotto.
          const cached = peerCacheRef.current.remote[key];
          if (cached) remote[key] = cached;
          return;
        }
        let sessionsOk = false;
        try {
          remote[key] = await getRouteSessions(token, route);
          sessionsOk = true;
          peerCacheRef.current.remote[key] = remote[key];
        } catch (e) {
          // R21: la causa distingue 502 (peer assente), 403 (peer nega),
          // 404 (rotta inesistente): tre azioni diverse per chi guarda.
          remote[key] = { error: 'unreachable', cause: classifyPeerFailure(e) };
          peerCacheRef.current.remote[key] = remote[key];
        }
        try {
          fleet[key] = await fleetStatus(token, route);
        } catch (e) {
          fleet[key] = { available: false, cause: classifyPeerFailure(e) };
        }
        // Il backoff segue sessions, il segnale di vita del peer: se riesce,
        // il peer e' vivo anche se fleet nega o non conosce la rotta —
        // quelle sono cause da MOSTRARE, non motivi per smettere di guardare.
        backoffRef.current = sessionsOk
          ? recordPeerSuccess(backoffRef.current, key)
          : recordPeerFailure(backoffRef.current, key, remote[key].cause, pollStart);
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
