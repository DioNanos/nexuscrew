import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getDecks, createDeck, saveDeck, saveDeckKeepalive, renameDeck, deleteDeck, getRouteConfig, getRouteTopology,
} from '../lib/api.js';
import {
  loadDeckOrders, loadDecks, moveDeckInOrder, orderDeckRecords, readLayoutRaw,
  removeDeckOrderId, replaceDeckOrderId, saveDeckOrders, saveDecks, writeLayoutRaw,
} from '../lib/deck-model.js';
import { addTileSmart, emptyLayout, mergeRemoteWithLocal, normalize, sessions } from '../lib/grid-model.js';
import {
  LOCAL_OWNER, NODE_ID_RE, annotateCanonicalLayout, canonicalizeLayoutForOwner,
  deckId, deckIdForLocalOwner, parseDeckId, refWithOwner, resolveLayoutForViewer,
} from '../lib/deck-federation.js';

const empty = (layout) => sessions(normalize(layout)).length === 0;
const routeKey = (route) => (Array.isArray(route) ? route.join('/') : '');

function cleanOwners(input) {
  const seen = new Set(); const out = [];
  for (const owner of Array.isArray(input) ? input : []) {
    if (!owner || !NODE_ID_RE.test(String(owner.instanceId || '')) || !Array.isArray(owner.route)
      || !owner.route.length || seen.has(owner.instanceId)) continue;
    seen.add(owner.instanceId);
    out.push({
      instanceId: owner.instanceId,
      route: [...owner.route],
      label: String(owner.label || owner.name || owner.route.join(' › ')),
      status: owner.status || 'offline',
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

function ownerForRecord(record) {
  return {
    instanceId: record.ownerId,
    route: record.ownerRoute || [],
    label: record.ownerLabel,
    status: record.available === false ? 'offline' : 'up',
  };
}

function augmentDeck(deck, owner, topology, local = false, available = true) {
  const ownerId = owner.instanceId;
  return {
    ...deck,
    id: deckId(local ? null : ownerId, deck.name),
    ownerId,
    ownerRoute: local ? [] : [...owner.route],
    ownerLabel: local ? 'Local' : owner.label,
    local,
    available,
    ownerTopology: Array.isArray(topology) ? topology : [],
    layout: annotateCanonicalLayout(deck.layout, ownerId, topology),
  };
}

export function useDecks(token, current, layout, setLayout, remoteOwners = []) {
  const [records, setRecords] = useState([]);
  const [ready, setReady] = useState(false);
  const [saveState, setSaveState] = useState('idle');
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const [localNodeId, setLocalNodeId] = useState('');
  const recordsRef = useRef([]);
  const ownersRef = useRef([]);
  const localNodeIdRef = useRef('');
  const currentRef = useRef(current);
  const layoutRef = useRef(layout);
  const dirtyRef = useRef(false);
  const skipRef = useRef(true);
  const bootTokenRef = useRef('');
  const owners = useMemo(() => cleanOwners(remoteOwners), [remoteOwners]);
  const ownersSig = owners.map((o) => `${o.instanceId}:${routeKey(o.route)}:${o.status}:${o.label}`).join('|');
  ownersRef.current = owners;
  layoutRef.current = layout;
  currentRef.current = current;
  recordsRef.current = records;

  const viewLayout = useCallback((record) => resolveLayoutForViewer(
    record.layout, localNodeIdRef.current, ownersRef.current,
  ), []);

  // ONE place that answers "which record is the current deck". The id in the URL
  // can be the owner-qualified form of THIS node while the record carries the
  // local id (deckIdForLocalOwner documents both), and every lookup has to know
  // it — the load effect, the poll, saveNow and the rename/remove paths each had
  // their own `find` and each of them could miss a self-owner deck.
  const resolveCurrentId = useCallback(
    () => deckIdForLocalOwner(currentRef.current, localNodeIdRef.current),
    [],
  );
  const findCurrent = useCallback(
    (records) => (Array.isArray(records) ? records : []).find((d) => d.id === resolveCurrentId()),
    [resolveCurrentId],
  );

  const install = useCallback((next, applyLayout = true, targetId) => {
    const wanted = targetId === undefined ? resolveCurrentId() : deckIdForLocalOwner(targetId, localNodeIdRef.current);
    const ordered = orderDeckRecords(next, loadDeckOrders());
    const previousHadTarget = recordsRef.current.some((d) => d.id === wanted);
    recordsRef.current = ordered; setRecords(ordered);
    const rec = ordered.find((d) => d.id === wanted);
    if (applyLayout && rec) {
      skipRef.current = true;
      const viewed = viewLayout(rec);
      setLayout(viewed);
      if (rec.local) writeLayoutRaw(rec.name, viewed);
    } else if (previousHadTarget && !rec) {
      // Share off / ACL withdrawal: do not leave a previously authorized deck
      // visible in memory after its owner disappears from the topology.
      skipRef.current = true;
      setLayout(emptyLayout());
      setError('deck non più condiviso dal nodo owner');
    }
    saveDecks(ordered.filter((d) => d.local).map((d) => d.name));
  }, [setLayout, viewLayout]);

  const migrateLocal = useCallback(async (nodeId) => {
    let st = await getDecks(token);
    const main = st.decks.find((d) => d.name === 'main');
    if (st.decks.length === 1 && main && main.revision === 0 && empty(main.layout)) {
      const legacyNames = loadDecks();
      const legacyMain = normalize(readLayoutRaw('main') || emptyLayout());
      if (!empty(legacyMain)) {
        const tagged = annotateCanonicalLayout(legacyMain, nodeId, []);
        st.decks[0] = await saveDeck(token, 'main', tagged, 0, []);
      }
      for (const name of legacyNames.filter((n) => n !== 'main')) {
        try {
          let made = await createDeck(token, name, []);
          const old = normalize(readLayoutRaw(name) || emptyLayout());
          if (!empty(old)) made = await saveDeck(token, name, annotateCanonicalLayout(old, nodeId, []), made.revision, []);
        } catch (_) { /* collision/race: il GET successivo converge */ }
      }
      st = await getDecks(token);
    }
    return st;
  }, [token]);

  const loadAll = useCallback(async ({ migrate = false } = {}) => {
    const config = await getRouteConfig(token, []);
    const nodeId = NODE_ID_RE.test(String(config.instanceId || '')) ? config.instanceId : '';
    if (!nodeId) throw new Error('instanceId locale non disponibile');
    localNodeIdRef.current = nodeId; setLocalNodeId(nodeId);
    const [localStore, localTopologyResult] = await Promise.all([
      migrate ? migrateLocal(nodeId) : getDecks(token),
      getRouteTopology(token, []).catch(() => ({ nodes: [] })),
    ]);
    const localOwner = { instanceId: nodeId, route: [], label: 'Local' };
    const next = localStore.decks.map((deck) => augmentDeck(deck, localOwner, localTopologyResult.nodes, true, true));
    const previous = recordsRef.current;
    await Promise.all(ownersRef.current.map(async (owner) => {
      if (owner.status !== 'up') {
        next.push(...previous.filter((d) => !d.local && d.ownerId === owner.instanceId)
          .map((d) => ({ ...d, ownerRoute: [...owner.route], ownerLabel: owner.label, available: false })));
        return;
      }
      try {
        const [remoteStore, remoteTopology] = await Promise.all([
          getDecks(token, owner.route),
          getRouteTopology(token, owner.route).catch(() => ({ nodes: [] })),
        ]);
        next.push(...remoteStore.decks.map((deck) => augmentDeck(deck, owner, remoteTopology.nodes, false, true)));
      } catch (_) {
        next.push(...previous.filter((d) => !d.local && d.ownerId === owner.instanceId)
          .map((d) => ({ ...d, ownerRoute: [...owner.route], ownerLabel: owner.label, available: false })));
      }
    }));
    next.sort((a, b) => (a.local === b.local ? a.ownerLabel.localeCompare(b.ownerLabel) || (a.name === 'main' ? -1 : b.name === 'main' ? 1 : a.name.localeCompare(b.name)) : a.local ? -1 : 1));
    return next;
  }, [token, migrateLocal, ownersSig]);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const firstForToken = bootTokenRef.current !== token;
    bootTokenRef.current = token;
    loadAll({ migrate: firstForToken }).then((next) => {
      if (cancelled) return;
      const here = findCurrent(recordsRef.current);
      const remote = findCurrent(next);
      const changed = remote && (!here || remote.revision > here.revision
        || here.available !== remote.available || routeKey(here.ownerRoute) !== routeKey(remote.ownerRoute));
      install(next, firstForToken || (!!changed && !dirtyRef.current));
      setReady(true);
      if (remote) setError('');
    }).catch((e) => {
      if (!cancelled) { setReady(true); setError(String(e.message || e)); }
    });
    return () => { cancelled = true; };
  }, [install, loadAll, ownersSig, token, findCurrent]);

  const saveNow = useCallback(async (targetId, allowRebase = true) => {
    if (!ready || !dirtyRef.current) return true;
    const wanted = targetId === undefined ? resolveCurrentId() : deckIdForLocalOwner(targetId, localNodeIdRef.current);
    const rec = recordsRef.current.find((d) => d.id === wanted);
    if (!rec) { setError(`deck inesistente: ${wanted}`); return false; }
    if (rec.available === false) { setError(`nodo owner offline: ${rec.ownerLabel}`); return false; }
    setSaveState('saving');
    try {
      const canonical = canonicalizeLayoutForOwner(normalize(layoutRef.current), rec.ownerId, rec.ownerTopology);
      const saved = await saveDeck(token, rec.name, canonical, rec.revision, rec.ownerRoute);
      const augmented = augmentDeck(saved, ownerForRecord(rec), rec.ownerTopology, rec.local, true);
      install(recordsRef.current.map((d) => d.id === wanted ? augmented : d), false);
      dirtyRef.current = false; setSaveState('saved'); setError(''); setConflict(false);
      setTimeout(() => setSaveState('idle'), 1500);
      return true;
    } catch (e) {
      // 409 = un'altra finestra ha salvato prima. Il ramo di recupero
      // era codice morto (confrontava `d.id === targetId`, ma sull'autosave
      // targetId è undefined). Rebase: il record remoto (revisione nuova) diventa
      // la base, il layout LOCALE della finestra resta la modifica dell'utente
      // (vince lei, decisione D2) e si ritenta UNA volta sola.
      if (allowRebase && e.status === 409 && e.data && e.data.current) {
        const conflicted = recordsRef.current.find((d) => d.id === wanted);
        if (conflicted) {
          const rebased = augmentDeck(e.data.current, ownerForRecord(conflicted), conflicted.ownerTopology, conflicted.local, true);
          install(recordsRef.current.map((d) => d.id === wanted ? rebased : d), false);
          dirtyRef.current = true;
          return saveNow(wanted, false);
        }
      }
      setSaveState('error'); setError(String(e.message || e));
      if (e.status === 409) setConflict(true);
      return false;
    }
  }, [ready, token, install]);

  // Azione «ricarica» del conflitto irrisolvibile — riparte dal remoto
  // e scarta la copia locale che non è riuscita a convergere.
  const reloadCurrent = useCallback(async () => {
    try {
      const next = await loadAll();
      dirtyRef.current = false;
      setConflict(false);
      install(next, true);
      setError('');
    } catch (e) {
      setError(String(e.message || e));
    }
  }, [loadAll, install]);

  useEffect(() => {
    if (!ready) return;
    if (skipRef.current) { skipRef.current = false; return; }
    dirtyRef.current = true; setSaveState('saving');
    const id = setTimeout(saveNow, 650);
    return () => clearTimeout(id);
  }, [layout, ready, saveNow]);

  // A chiusura pagina (pagehide/beforeunload) il PUT parte con
  // keepalive se ci sono modifiche non salvate — il debounce di 650 ms può non
  // avere il tempo di scadere. Fire-and-forget: la pagina sta per morire.
  useEffect(() => {
    if (!ready) return undefined;
    const flush = () => {
      if (!dirtyRef.current) return;
      const rec = recordsRef.current.find((d) => d.id === resolveCurrentId());
      if (!rec || rec.available === false) return;
      const canonical = canonicalizeLayoutForOwner(normalize(layoutRef.current), rec.ownerId, rec.ownerTopology);
      saveDeckKeepalive(token, rec.name, canonical, rec.revision, rec.ownerRoute);
    };
    window.addEventListener('pagehide', flush);
    window.addEventListener('beforeunload', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      window.removeEventListener('beforeunload', flush);
    };
  }, [ready, token, resolveCurrentId]);

  useEffect(() => {
    if (!ready) return undefined;
    const id = setInterval(async () => {
      try {
        const next = await loadAll();
        const here = findCurrent(recordsRef.current);
        const remote = findCurrent(next);
        const newer = remote && (!here || remote.revision > here.revision || here.available !== remote.available);
        if (newer && dirtyRef.current && remote) {
          // La finestra è sporca e il remoto è più nuovo — merge
          // remoto ⊕ delta locale invece di restare indietro. Il layout fuso
          // è un cambio di layout: l'autosave lo salva con la revisione nuova.
          const merged = mergeRemoteWithLocal(viewLayout(remote), layoutRef.current);
          install(next, false);
          setLayout(merged);
          return;
        }
        install(next, newer && !dirtyRef.current);
      } catch (_) {}
    }, 5000);
    return () => clearInterval(id);
  }, [ready, loadAll, install, viewLayout, setLayout]);

  const add = async (name, ownerId = null) => {
    const basis = ownerId === LOCAL_OWNER
      ? recordsRef.current.find((d) => d.local)
      : ownerId
      ? recordsRef.current.find((d) => d.ownerId === ownerId)
      : null;
    if (!basis || basis.available === false) throw new Error('nodo owner non disponibile');
    const made = await createDeck(token, name, basis.ownerRoute);
    const record = augmentDeck(made, ownerForRecord(basis), basis.ownerTopology, basis.local, true);
    install([...recordsRef.current, record], false); return record;
  };
  const rename = async (fromId, to) => {
    const deck = recordsRef.current.find((x) => x.id === fromId); if (!deck) throw new Error('deck inesistente');
    if (deckIdForLocalOwner(fromId, localNodeIdRef.current) === resolveCurrentId() && dirtyRef.current) {
      const savedDirty = await saveNow(fromId);
      if (!savedDirty) throw new Error(`salvataggio di "${deck.name}" fallito: rinomina annullata`);
    }
    const fresh = recordsRef.current.find((x) => x.id === fromId); if (!fresh) throw new Error('deck inesistente');
    const saved = await renameDeck(token, fresh.name, to, fresh.revision, fresh.ownerRoute);
    const record = augmentDeck(saved, ownerForRecord(fresh), fresh.ownerTopology, fresh.local, true);
    const ownerKey = fresh.local ? LOCAL_OWNER : fresh.ownerId;
    saveDeckOrders(replaceDeckOrderId(loadDeckOrders(), ownerKey, fromId, record.id));
    install(recordsRef.current.map((x) => x.id === fromId ? record : x), false); return record;
  };
  const remove = async (id) => {
    const deck = recordsRef.current.find((x) => x.id === id); if (!deck) throw new Error('deck inesistente');
    if (deckIdForLocalOwner(id, localNodeIdRef.current) === resolveCurrentId()) dirtyRef.current = false;
    await deleteDeck(token, deck.name, deck.revision, deck.ownerRoute);
    const ownerKey = deck.local ? LOCAL_OWNER : deck.ownerId;
    saveDeckOrders(removeDeckOrderId(loadDeckOrders(), ownerKey, id));
    install(recordsRef.current.filter((x) => x.id !== id), false);
  };
  const reorder = (sourceId, targetId) => {
    const source = recordsRef.current.find((x) => x.id === sourceId);
    const target = recordsRef.current.find((x) => x.id === targetId);
    if (!source || !target) return false;
    const sourceOwner = source.local ? LOCAL_OWNER : source.ownerId;
    const targetOwner = target.local ? LOCAL_OWNER : target.ownerId;
    if (sourceOwner !== targetOwner) return false;
    const available = recordsRef.current
      .filter((record) => (record.local ? LOCAL_OWNER : record.ownerId) === sourceOwner)
      .map((record) => record.id);
    const orders = saveDeckOrders(moveDeckInOrder(loadDeckOrders(), sourceOwner, sourceId, targetId, available));
    install(orderDeckRecords(recordsRef.current, orders), false);
    return true;
  };
  const addTileTo = async (targetId, ref) => {
    const deck = recordsRef.current.find((x) => x.id === targetId); if (!deck) throw new Error('deck inesistente');
    if (deck.available === false) throw new Error(`nodo owner offline: ${deck.ownerLabel}`);
    const ownedRef = refWithOwner(ref, localNodeIdRef.current, ownersRef.current);
    if (!ownedRef) throw new Error('riferimento sessione non valido');
    const targetView = viewLayout(deck);
    const canonical = canonicalizeLayoutForOwner(addTileSmart(targetView, ownedRef), deck.ownerId, deck.ownerTopology);
    const saved = await saveDeck(token, deck.name, canonical, deck.revision, deck.ownerRoute);
    const record = augmentDeck(saved, ownerForRecord(deck), deck.ownerTopology, deck.local, true);
    install(recordsRef.current.map((x) => x.id === targetId ? record : x), false); return record;
  };
  const select = async (id) => {
    if (dirtyRef.current) {
      const saved = await saveNow(resolveCurrentId());
      if (!saved) throw new Error('salvataggio del deck corrente fallito: cambio annullato');
    }
    const target = recordsRef.current.find((d) => d.id === id);
    if (!target) throw new Error(`deck inesistente: ${id}`);
    dirtyRef.current = false; skipRef.current = true;
    return viewLayout(target);
  };

  return {
    decks: records, records, localNodeId, ready, saveState, error, setError, conflict, reloadCurrent,
    saveNow, select, add, rename, remove, reorder, addTileTo,
    localMainId: deckId(null, 'main'), parseDeckId,
  };
}
