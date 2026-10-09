// Hook dei gruppi per-nodo (B2): polla /api/nodes e, per i soli
// nodi col tunnel su, le sessioni remote via proxy /node/<name>/api/sessions.
// Best-effort ovunque: un nodo che non risponde diventa gruppo 'unreachable'
// (niente spinner infinito); zero nodi configurati -> groups = []
// e la UI resta identica a oggi.
//
// Le fonti non fanno barriera fra loro: la discovery si pubblica quando
// arriva, sessions e fleet girano in parallelo per ogni route e pubblicano
// per fonte, il VL e' un arricchimento separato con il suo tetto. Una
// lettura ancora in corso non e' un esito: i gruppi senza esiti sono
// "pending", quelli gia' noti conservano il loro stato marcato "checking".
import { useEffect, useRef, useState } from 'react';
import {
  getRouteConfig, getNodes, getTopology, getNodeAliases, getRouteSessions,
  fleetStatus, getVlNodes, ROSTER_READ_TIMEOUT_MS,
} from '../lib/api.js';
import { buildNodeGroups, trackDown } from '../lib/nodes-model.js';
import { registerRouteIdentities } from '../lib/route-identity.js';
import { loadLastRoster, saveLastRoster } from '../lib/last-roster.js';
import { vlNodeToPeer, topologyVlOwners, vlSidebarGroups } from '../lib/vl-nodes-model.js';
import { fleetReadOutcome } from '../lib/fleet-read-policy.js';
import { createPollGuard } from '../lib/poll-guard.js';
import {
  classifyPeerFailure, recordPeerFailure, recordPeerSuccess, shouldPollPeer,
} from '../lib/peer-backoff.js';

const POLL_MS = 4000;
// Grazia di rimozione per un owner che manca da risposte CONFERMATE: sotto
// questa eta' resta in lista come stale, sopra sparisce. Dieci minuti copre
// un riavvio di servizio (o di nodo) senza tenere in vita i fantasmi.
// Esportata: useDecks la usa come STESSA soglia per sloggiare le deck di un
// owner scaduto (un solo numero, non due grazie divergenti).
export const OWNER_GRACE_MS = 10 * 60 * 1000;
const STICKY_OWNERS_KEY = 'nc-sticky-owners-v1';

function readStickyOwners() {
  try {
    const raw = localStorage.getItem(STICKY_OWNERS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.nodes) || !Array.isArray(parsed.topology)) return null;
    return parsed;
  } catch (_) { return null; }
}
function writeStickyOwners(snapshot) {
  // Best-effort: quota superata o modalita' privata non devono rompere il poll.
  try { localStorage.setItem(STICKY_OWNERS_KEY, JSON.stringify(snapshot)); } catch (_) { /* cache opzionale */ }
}

// Stato sticky degli owner: l'ultimo stato buono sopravvive a un fetch
// fallito, a una risposta vuota e a un'assenza breve. Il merge segna
// `stale` ciò che NON arriva dalla risposta confermata e rimuove solo
// dopo la grazia — la lista non si svuota mai per un blip.
function mergeStickyOwners(map, fetchOk, fresh, keyOf, now) {
  if (!fetchOk) {
    for (const entry of map.values()) entry.data = { ...entry.data, stale: true };
    return map;
  }
  const present = new Map(fresh.map((e) => [keyOf(e), e]));
  for (const [key, entry] of map) {
    if (present.has(key)) {
      entry.data = present.get(key);
      entry.missingSince = null;
      present.delete(key);
    } else {
      entry.missingSince ??= now;
      if (now - entry.missingSince > OWNER_GRACE_MS) map.delete(key);
      else entry.data = { ...entry.data, stale: true };
    }
  }
  for (const [key, freshEntry] of present) map.set(key, { data: freshEntry, missingSince: null });
  return map;
}

export function useNodesState(token, enabled = true, refreshKey = 0) {
  const [groups, setGroups] = useState([]);
  const [loadedToken, setLoadedToken] = useState(null);
  const groupsRef = useRef([]);
  const downRef = useRef({});
  // R21: backoff per-peer (stato) + ultima risposta nota (cache). Il peer
  // morto non si interroga piu' a cadenza fissa: si dirada fino al tetto, e
  // quando torna la cadenza torna normale. La cache mostra l'ultimo stato
  // noto durante i giri saltati — incluso il motivo per cui si salta.
  const backoffRef = useRef({});
  const peerCacheRef = useRef({ remote: {}, fleet: {} });
  // Il token con cui la cache e' stata riempita, e la guardia generazionale
  // del giro in volo.
  const cacheTokenRef = useRef(null);
  const cacheInstanceRef = useRef(null);
  const cacheOwnersRef = useRef(new Map());
  // Last known VL peers per owner (`vl:<route>`): the sidebar keeps showing
  // a vl node while its owner read is in flight, failing or backed off.
  // `at` is the moment of the last CONFIRMED read (failures and skips never
  // renew it); past OWNER_GRACE_MS the entry is dropped. `round` marks the
  // poll that filled it, so anything published from an older round is
  // flagged stale, never presented as freshly verified.
  const vlCacheRef = useRef(new Map());
  // Routes present in the fresh topology whose owner is not identifiable
  // (no usable instanceId): cached vl entries for those routes stay
  // published but cannot be verified.
  const vlUnknownRoutesRef = useRef(new Set());
  const guardRef = useRef(createPollGuard());
  const abortRef = useRef(null);

  useEffect(() => {
    if (!enabled || !token) { setGroups([]); setLoadedToken(null); return undefined; }
    let alive = true;
    // Cache e backoff sono legati al TOKEN che li ha riempiti: un token
    // diverso e' un'altra sessione, e i suoi dati non sono i nostri. Senza
    // questo, dopo un cambio di token la UI mostrerebbe l'elenco dell'utente
    // precedente come se fosse una lettura corrente.
    const tokenChanged = cacheTokenRef.current !== null && cacheTokenRef.current !== token;
    if (cacheTokenRef.current !== token) {
      cacheTokenRef.current = token;
      backoffRef.current = {};
      peerCacheRef.current = { remote: {}, fleet: {} };
      cacheOwnersRef.current.clear();
      vlCacheRef.current.clear();
      vlUnknownRoutesRef.current.clear();
      downRef.current = {};
      groupsRef.current = [];
      setGroups([]);
    }
    // Owner sticky, ripristinati dal localStorage per ripartire pieni al
    // reload della pagina invece che con la lista vuota.
    const sticky = { instanceId: '', nodes: new Map(), topology: new Map() };
    const persisted = tokenChanged ? null : readStickyOwners();
    if (persisted) {
      sticky.instanceId = persisted.instanceId || '';
      for (const n of persisted.nodes) sticky.nodes.set(n.name, { data: n, missingSince: null });
      for (const t of persisted.topology) sticky.topology.set(t.route.join('/'), { data: t, missingSince: null });
    }

    // Il giro: guardia generazionale, abort proprio e pubblicazioni per
    // fonte. Ogni giro porta il PROPRIO token: una risposta tardiva di un
    // giro scartato non scrive piu' nulla (gruppi, cache, backoff, storage).
    async function poll() {
      const guard = guardRef.current;
      const pollStart = Date.now();
      const round = guard.begin();
      if (round === null) return;
      const controller = new AbortController();
      abortRef.current = controller;
      const opts = { timeoutMs: ROSTER_READ_TIMEOUT_MS, signal: controller.signal };
      const current = () => alive && guard.isCurrent(round);
      let nodes = []; let topology = []; let aliases = {}; let localInstanceId = '';
      let nodesOk = false; let topologyOk = false;
      let nodesState = 'pending'; let topologyState = 'pending';
      const remote = {}; const fleet = {};
      // Letture in corso, per route e per fonte: chiave nuda o `key#sessions` /
      // `key#fleet`. Non sono esiti: la proiezione li distingue dai dati.
      const pendingReads = new Set();
      const routesStarted = new Set();
      const vlStarted = new Set();
      let ownerOf = new Map();
      const readTasks = [];

      const computeOwnerOf = () => {
        ownerOf = new Map([
          ...topology.filter((n) => Array.isArray(n.route)).map((n) => [n.route.join('/'), n.instanceId]),
          ...nodes.map((n) => [n.name, n.nodeId]),
        ].filter(([, id]) => typeof id === 'string' && id));
      };
      const restoredFleet = (key) => {
        const id = ownerOf.get(key);
        const cells = id ? loadLastRoster(`id:${id}`) : [];
        return cells.length ? { available: false, cells, fleetState: 'stale' } : null;
      };

      const publish = () => {
        if (!current() || !localInstanceId) return false;
        // VL peers come from the per-owner cache, so intermediate publishes
        // (discovery, sessions, fleet...) keep the node in the sidebar while
        // its own read is still in flight, failed or backed off. Entries past
        // the owner grace are dropped here; entries filled by an older round
        // are published flagged stale, never as freshly verified.
        const vlPeers = [];
        const nowMs = Date.now();
        for (const [key, entry] of vlCacheRef.current) {
          if (nowMs - entry.at > OWNER_GRACE_MS) { vlCacheRef.current.delete(key); continue; }
          // An entry filled by an owner that no longer holds the route is
          // neither published nor kept: the current owner's confirmed
          // answer is the only data that counts for that route.
          const routePath = key.slice('vl:'.length);
          const routeOwner = cacheOwnersRef.current.get(routePath);
          if (entry.ownerInstanceId != null && routeOwner !== undefined
            && routeOwner !== entry.ownerInstanceId) {
            vlCacheRef.current.delete(key);
            continue;
          }
          const unknownRoute = vlUnknownRoutesRef.current.has(key.slice('vl:'.length));
          const stale = entry.round !== round || entry.identityUnknown === true || unknownRoute;
          for (const peer of entry.peers) vlPeers.push({ ...peer, stale });
        }
        const previousGroups = groupsRef.current;
        const first = buildNodeGroups({
          nodes, topology, remote, fleet, aliases, down: downRef.current,
          pendingReads, previousGroups,
        });
        downRef.current = trackDown(downRef.current, first, Math.floor(Date.now() / 1000));
        const nextGroups = [
          ...buildNodeGroups({
            nodes, topology, remote, fleet, aliases, down: downRef.current,
            pendingReads, previousGroups: groupsRef.current,
          }),
          ...vlSidebarGroups(vlPeers),
        ];
        // Prima dei componenti: le preferenze per nome si allineano all'identita' (instanceId) del nodo.
        registerRouteIdentities(nextGroups);
        groupsRef.current = nextGroups;
        setLoadedToken(token);
        setGroups(nextGroups);
        return true;
      };

      // La singola fonte di discovery aggiorna il proprio snapshot (sticky
      // compreso) e ripubblica: l'assenza da una richiesta in corso o fallita
      // non e' una rimozione confermata.
      let nodesFresh = []; let topologyFresh = [];
      // Ogni fonte risolta aggiorna il proprio esito e la proiezione viene
      // RICONCILIATA: merge sticky per fonte (solo con esito confermato),
      // conservazione cache dei nodi non raggiungibili, avvio delle letture
      // pronte, pubblicazione. L'identita' locale (config) precede il merge:
      // una cache di un'altra istanza viene svuotata PRIMA, non dopo.
      const reconcile = () => {
        if (!current()) return;
        if (!localInstanceId) return;
        // Un esito confermato aggiorna; un FETCH FALLITO non azzera: marca
        // gli owner noti come stale (stessa semantica del merge sticky).
        if (nodesOk) {
          mergeStickyOwners(sticky.nodes, true, nodesFresh, (n) => n && n.name, pollStart);
        } else if (nodesState === 'error') {
          mergeStickyOwners(sticky.nodes, false, nodesFresh, (n) => n && n.name, pollStart);
        }
        if (topologyOk) {
          mergeStickyOwners(sticky.topology, true, topologyFresh, (t) => (Array.isArray(t && t.route) ? t.route.join('/') : ''), pollStart);
        } else if (topologyState === 'error') {
          mergeStickyOwners(sticky.topology, false, topologyFresh, (t) => (Array.isArray(t && t.route) ? t.route.join('/') : ''), pollStart);
        }
        nodes = [...sticky.nodes.values()].map((e) => e.data);
        topology = [...sticky.topology.values()].map((e) => e.data);
        computeOwnerOf();
        for (const [key, id] of ownerOf) {
          const previousId = cacheOwnersRef.current.get(key);
          if (previousId && previousId !== id) {
            delete peerCacheRef.current.remote[key]; delete peerCacheRef.current.fleet[key];
            delete backoffRef.current[key]; delete backoffRef.current[`vl:${key}`]; delete downRef.current[key];
            // A different owner on the same route is different data: the
            // cached vl entry belongs to the old one and must not survive.
            vlCacheRef.current.delete(`vl:${key}`);
          }
          cacheOwnersRef.current.set(key, id);
        }
        // Owners whose identity is no longer resolvable from the fresh
        // topology (route gone, or present without a usable instanceId)
        // keep their cached vl entries, but those entries are no longer
        // verifiable: flagged until a confirmed read for a known owner
        // replaces them.
        for (const key of cacheOwnersRef.current.keys()) {
          if (!ownerOf.has(key)) {
            const staleVlEntry = vlCacheRef.current.get(`vl:${key}`);
            if (staleVlEntry) staleVlEntry.identityUnknown = true;
          }
        }
        // Routes still present in the topology but without a usable owner
        // identity: their cached vl entries cannot be verified.
        vlUnknownRoutesRef.current = new Set(
          topology
            .filter((n) => !n.stale && Array.isArray(n.route) && n.route.length > 0 && !ownerOf.has(n.route.join('/')))
            .map((n) => n.route.join('/')),
        );
        // Nodi NON raggiungibili o stale: la lettura fleet non e' VERIFICABILE,
        // non assente — l'ultimo elenco noto resta come elenco fermo (stale)
        // finche' il nodo non torna su.
        for (const n of nodes) {
          if (n.tunnel?.status === 'up') continue;
          const cachedFleet = peerCacheRef.current.fleet[n.name];
          if (cachedFleet && !fleet[n.name]) {
            fleet[n.name] = { ...cachedFleet, available: false, fleetState: 'stale' };
          }
        }
        for (const n of topology) {
          if (!n.stale || !Array.isArray(n.route) || !n.route.length) continue;
          const key = n.route.join('/');
          const cachedFleet = peerCacheRef.current.fleet[key];
          if (cachedFleet && !fleet[key]) {
            fleet[key] = { ...cachedFleet, available: false, fleetState: 'stale' };
          }
        }
        if (nodesOk || topologyOk) {
          writeStickyOwners({
            instanceId: sticky.instanceId,
            savedAt: pollStart,
            nodes: [...sticky.nodes.values()].map((e) => e.data),
            topology: [...sticky.topology.values()].map((e) => e.data),
          });
        }
        maybeStartReads();
        publish();
      };
      const applyNodes = (ok, list) => {
        if (!current()) return;
        nodesState = ok ? 'success' : 'error';
        nodesOk = ok;
        nodesFresh = ok ? list : [];
        reconcile();
      };
      const applyTopology = (ok, list) => {
        if (!current()) return;
        topologyState = ok ? 'success' : 'error';
        topologyOk = ok;
        topologyFresh = ok ? list : [];
        reconcile();
      };
      const applyConfig = (j) => {
        if (!current()) return;
        localInstanceId = j && typeof j.instanceId === 'string' ? j.instanceId : '';
        if (localInstanceId && (sticky.instanceId !== localInstanceId || cacheInstanceRef.current !== localInstanceId)) {
          // localStorage di un ALTRO nodo locale: la cache non e' nostra. E lo
          // stesso vale per le risposte dei peer, che sono indicizzate per
          // ROTTA: un'altra istanza puo' riusare la stessa rotta, e in quel caso
          // l'elenco di prima e' il residuo di un nodo diverso.
          if (sticky.instanceId !== localInstanceId) {
            sticky.nodes.clear(); sticky.topology.clear();
          }
          groupsRef.current = []; downRef.current = {};
          backoffRef.current = {};
          peerCacheRef.current = { remote: {}, fleet: {} };
          cacheOwnersRef.current.clear();
          vlCacheRef.current.clear();
          vlUnknownRoutesRef.current.clear();
        } else if (localInstanceId) {
          sticky.instanceId = localInstanceId;
        }
        cacheInstanceRef.current = localInstanceId || null;
        sticky.instanceId = localInstanceId;
        reconcile();
      };

      // Un owner VL e' un arricchimento separato: parte con la discovery, non
      // blocca nessuna lettura principale e pubblica per owner.
      function startVlReads() {
        const vlOwners = [
          { instanceId: localInstanceId || null, route: [], label: null },
          ...topologyVlOwners({ nodes: topology }, localInstanceId),
        ];
        for (const owner of vlOwners) {
          const identity = `${owner.instanceId}:${owner.route.join('/')}`;
          if (vlStarted.has(identity)) continue;
          vlStarted.add(identity);
          const key = `vl:${owner.route.join('/')}`;
          readTasks.push((async () => {
            if (!shouldPollPeer(backoffRef.current, key, pollStart)) return;
            try {
              const payload = await getVlNodes(token, owner.route, { signal: controller.signal });
              if (!current()) return;
              // Only the CURRENT owner of the route may touch the shared
              // backoff and fill the cache: a reply from a superseded owner
              // (its read started from the sticky snapshot before the fresh
              // topology reassigned the route) must neither reset the new
              // owner's backoff nor fill the cache.
              const routeOwner = cacheOwnersRef.current.get(owner.route.join('/'));
              if ((routeOwner !== undefined && routeOwner !== owner.instanceId)
                || vlUnknownRoutesRef.current.has(owner.route.join('/'))) {
                return;
              }
              backoffRef.current = recordPeerSuccess(backoffRef.current, key);
              const peers = [];
              for (const raw of payload.nodes || []) {
                const peer = vlNodeToPeer(raw, owner);
                if (peer) peers.push(peer);
              }
              // A confirmed read — even an empty one — replaces ONLY this
              // owner's entry: an authoritative empty answer is a removal.
              vlCacheRef.current.set(key, {
                peers,
                ownerInstanceId: owner.instanceId ?? null,
                at: pollStart,
                round,
              });
              publish();
            } catch (e) {
              if (!current()) return;
              // Same identity rule on failures: a superseded owner's
              // failure must not pile up on the current owner's backoff
              // (the current owner would inherit the failures and skip its
              // own retry).
              const catchRouteOwner = cacheOwnersRef.current.get(owner.route.join('/'));
              if ((catchRouteOwner !== undefined && catchRouteOwner !== owner.instanceId)
                || vlUnknownRoutesRef.current.has(owner.route.join('/'))) {
                return;
              }
              backoffRef.current = recordPeerFailure(backoffRef.current, key, classifyPeerFailure(e), pollStart);
            }
          })());
        }
      }

      // Per ogni posizione remota up: sessions E fleet in parallelo e per
      // fonte. Il peer sano non aspetta il peer lento, il fleet sano non
      // aspetta sessions lento e viceversa; l'attesa complessiva serve solo a
      // sapere quando liberare la guardia.
      async function startRouteReads(route) {
        const key = route.join('/');
        const cachedRemote = peerCacheRef.current.remote[key] || null;
        if (!shouldPollPeer(backoffRef.current, key, pollStart)) {
          pendingReads.delete(`${key}#sessions`);
          pendingReads.delete(`${key}#fleet`);
          // R21: il peer in backoff NON si interroga — chi guarda gli ALTRI
          // peer non deve essere intasato dal suo rumore. E non interrogarlo
          // significa che la sua lista NON e' verificata, non che sia vuota:
          // l'ultimo dato buono resta come elenco fermo, con l'istante in cui
          // e' stato letto DAVVERO.
          const stato = backoffRef.current[key];
          remote[key] = {
            error: 'unreachable',
            cause: (stato && stato.cause) || null,
            lastGoodAt: cachedRemote ? cachedRemote.at : null,
          };
          // Il backoff rende la lettura Fleet NON VERIFICABILE, non vuota.
          const cachedFleet = peerCacheRef.current.fleet[key] || restoredFleet(key);
          if (cachedFleet) fleet[key] = { ...cachedFleet, available: false, fleetState: 'stale' };
          return;
        }
        // Letture in corso: la proiezione distingue il pendere da un esito.
        pendingReads.add(`${key}#sessions`);
        pendingReads.add(`${key}#fleet`);

        const sessionsTask = (async () => {
              let sessionsOk = false;
          try {
            const payload = await getRouteSessions(token, route, opts);
            if (!current()) return;
            sessionsOk = true;
            // L'istante viaggia col payload: e' l'ora della LETTURA, non del
            // render, e serve al tetto del «non verificato» quando piu' tardi
            // questa risposta sara' l'ultima buona rimasta.
            remote[key] = { ...payload, at: pollStart };
            peerCacheRef.current.remote[key] = { payload, at: pollStart };
          } catch (e) {
            if (!current()) return;
            // R21: la causa distingue 502 (peer assente), 403 (peer nega),
            // 404 (rotta inesistente): tre azioni diverse per chi guarda.
            remote[key] = {
              error: 'unreachable',
              cause: classifyPeerFailure(e),
              lastGoodAt: cachedRemote ? cachedRemote.at : null,
            };
          } finally {
            pendingReads.delete(`${key}#sessions`);
          }
          // Il backoff segue sessions, il segnale di vita del peer, una volta
          // sola per esito e indipendentemente dal ritardo fleet/VL.
          backoffRef.current = sessionsOk
            ? recordPeerSuccess(backoffRef.current, key)
            : recordPeerFailure(backoffRef.current, key, remote[key].cause, pollStart);
          publish();
        })();

        const fleetTask = (async () => {
          const previousFleet = peerCacheRef.current.fleet[key] || restoredFleet(key);
          try {
            const response = await fleetStatus(token, route, opts);
            if (!current()) return;
            const outcome = fleetReadOutcome({ fs: response });
            if (outcome.kind === 'data') {
              fleet[key] = {
                ...response,
                available: true,
                cells: outcome.cells,
                fleetState: 'available',
              };
              if (ownerOf.get(key)) saveLastRoster(`id:${ownerOf.get(key)}`, outcome.cells);
            } else if (outcome.kind === 'disabled') {
              // available:false con ragione di configurazione e' un dato reale:
              // zero celle, senza conservare celle fantasma.
              fleet[key] = { ...response, available: false, cells: [], fleetState: 'disabled' };
              if (ownerOf.get(key)) saveLastRoster(`id:${ownerOf.get(key)}`, []);
            } else {
              // La risposta e' arrivata, ma la lettura non e' verificabile
              // (per esempio fleet.json illeggibile): elenco fermo, non vuoto.
              fleet[key] = {
                ...(previousFleet || {}),
                available: false,
                cells: Array.isArray(previousFleet?.cells) ? previousFleet.cells : [],
                fleetState: 'stale',
                ...(response?.reason ? { reason: response.reason } : {}),
              };
            }
            peerCacheRef.current.fleet[key] = fleet[key];
          } catch (e) {
            if (!current()) return;
            // Un errore di trasporto non prova che il nodo abbia zero celle.
            fleet[key] = {
              ...(previousFleet || {}),
              available: false,
              cells: Array.isArray(previousFleet?.cells) ? previousFleet.cells : [],
              fleetState: 'stale',
              cause: classifyPeerFailure(e),
            };
            peerCacheRef.current.fleet[key] = fleet[key];
          }
          pendingReads.delete(`${key}#fleet`);
          publish();
        })();

        await Promise.allSettled([sessionsTask, fleetTask]);
      }

      // Le letture principali partono una volta sola, quando la discovery
      // della propria fonte e la config sono valide. L'alias non e' un
      // prerequisito.
      function maybeStartReads() {
        if (!current() || !localInstanceId) return;
        startVlReads();
        const direct = new Set(nodes.map((n) => n.name));
        const add = (route) => {
          const key = route.join('/');
          if (routesStarted.has(key)) return;
          routesStarted.add(key);
          readTasks.push(startRouteReads(route));
        };
        for (const n of nodes) {
          if (nodesOk && !n.stale && n.tunnel?.status === 'up' && (n.nodeId || n.paired !== false)
            && (n.direction !== 'inbound' || n.shared === true)) add([n.name]);
          else if (nodesState === 'pending' && !n.stale && n.tunnel?.status === 'up') {
            pendingReads.add(`${n.name}#sessions`); pendingReads.add(`${n.name}#fleet`);
          }
        }
        for (const n of topology) {
          if (!n.stale && Array.isArray(n.route) && n.route.length > 0
            && !(n.route.length === 1 && direct.has(n.route[0]))) {
            const key = n.route.join('/');
            if (topologyOk) add(n.route);
            else if (topologyState === 'pending') {
              pendingReads.add(`${key}#sessions`); pendingReads.add(`${key}#fleet`);
            }
          }
        }
      }

      const taskNodes = getNodes(token, opts).then(
        (j) => { applyNodes(true, Array.isArray(j.nodes) ? j.nodes : []); },
        () => { applyNodes(false, []); },
      );
      const taskTopology = getTopology(token, opts).then(
        (j) => { applyTopology(true, Array.isArray(j.nodes) ? j.nodes : []); },
        () => { applyTopology(false, []); },
      );
      const taskAliases = getNodeAliases(token, opts).then(
        (j) => { if (!current()) return; aliases = j && typeof j.aliasesByInstanceId === 'object' ? j.aliasesByInstanceId : {}; publish(); },
        () => {},
      );
      const taskConfig = getRouteConfig(token, [], opts).then(
        (j) => { applyConfig(j); },
        () => {},
      );

      // L'attesa complessiva serve solo a sapere quando liberare la guardia:
      // le singole pubblicazioni sono gia' avvenute per fonte. La discovery
      // prima: e' lei che avvia le letture per route (raccolte in readTasks);
      // la guardia si libera solo quando ANCHE quelle sono concluse.
      try {
        await Promise.allSettled([taskNodes, taskTopology, taskAliases, taskConfig]);
        await Promise.allSettled(readTasks);
      } finally {
        if (guard.isCurrent(round)) guard.end(round);
      }
    }

    poll();
    const id = setInterval(poll, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
      // Cleanup: la guardia si invalida (il finally del giro vecchio non
      // libera il nuovo) e le letture del giro in volo vengono abortite.
      guardRef.current.reset();
      if (abortRef.current) abortRef.current.abort();
    };
  }, [token, enabled, refreshKey]);

  return { groups, hasLoaded: enabled && !!token && loadedToken === token };
}

// Existing consumers keep the array API; the drawer also needs to distinguish
// the initial empty state from an empty model that has already published.
export function useNodes(token, enabled = true, refreshKey = 0) {
  return useNodesState(token, enabled, refreshKey).groups;
}
