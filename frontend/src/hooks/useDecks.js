import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getDecks, createDeck, saveDeck, renameDeck, deleteDeck, getRouteConfig, getRouteTopology,
} from '../lib/api.js';
import { loadDecks, readLayoutRaw, saveDecks, writeLayoutRaw } from '../lib/deck-model.js';
import { addTileSmart, emptyLayout, normalize, sessions } from '../lib/grid-model.js';
import {
  LOCAL_OWNER, NODE_ID_RE, annotateCanonicalLayout, canonicalizeLayoutForOwner,
  deckId, parseDeckId, refWithOwner, resolveLayoutForViewer,
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

  const install = useCallback((next, applyLayout = true, targetId = currentRef.current) => {
    const previousHadTarget = recordsRef.current.some((d) => d.id === targetId);
    recordsRef.current = next; setRecords(next);
    const rec = next.find((d) => d.id === targetId);
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
    saveDecks(next.filter((d) => d.local).map((d) => d.name));
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
      const here = recordsRef.current.find((d) => d.id === currentRef.current);
      const remote = next.find((d) => d.id === currentRef.current);
      const changed = remote && (!here || remote.revision > here.revision
        || here.available !== remote.available || routeKey(here.ownerRoute) !== routeKey(remote.ownerRoute));
      install(next, firstForToken || (!!changed && !dirtyRef.current));
      setReady(true);
      if (remote) setError('');
    }).catch((e) => {
      if (!cancelled) { setReady(true); setError(String(e.message || e)); }
    });
    return () => { cancelled = true; };
  }, [install, loadAll, ownersSig, token]);

  const saveNow = useCallback(async (targetId = currentRef.current) => {
    if (!ready || !dirtyRef.current) return true;
    const rec = recordsRef.current.find((d) => d.id === targetId);
    if (!rec) { setError(`deck inesistente: ${targetId}`); return false; }
    if (rec.available === false) { setError(`nodo owner offline: ${rec.ownerLabel}`); return false; }
    setSaveState('saving');
    try {
      const canonical = canonicalizeLayoutForOwner(normalize(layoutRef.current), rec.ownerId, rec.ownerTopology);
      const saved = await saveDeck(token, rec.name, canonical, rec.revision, rec.ownerRoute);
      const augmented = augmentDeck(saved, ownerForRecord(rec), rec.ownerTopology, rec.local, true);
      install(recordsRef.current.map((d) => d.id === targetId ? augmented : d), false);
      dirtyRef.current = false; setSaveState('saved'); setError('');
      setTimeout(() => setSaveState('idle'), 1500);
      return true;
    } catch (e) {
      setSaveState('error'); setError(String(e.message || e));
      if (e.status === 409 && e.data && e.data.current) {
        const currentDeck = recordsRef.current.find((d) => d.id === targetId);
        const replacement = augmentDeck(e.data.current, ownerForRecord(currentDeck), currentDeck.ownerTopology, currentDeck.local, true);
        install(recordsRef.current.map((d) => d.id === targetId ? replacement : d), false);
      }
      return false;
    }
  }, [ready, token, install]);

  useEffect(() => {
    if (!ready) return;
    if (skipRef.current) { skipRef.current = false; return; }
    dirtyRef.current = true; setSaveState('saving');
    const id = setTimeout(saveNow, 650);
    return () => clearTimeout(id);
  }, [layout, ready, saveNow]);

  useEffect(() => {
    if (!ready) return undefined;
    const id = setInterval(async () => {
      try {
        const next = await loadAll();
        const here = recordsRef.current.find((d) => d.id === currentRef.current);
        const remote = next.find((d) => d.id === currentRef.current);
        const newer = remote && (!here || remote.revision > here.revision || here.available !== remote.available);
        install(next, newer && !dirtyRef.current);
      } catch (_) {}
    }, 5000);
    return () => clearInterval(id);
  }, [ready, loadAll, install]);

  const add = async (name, ownerId = null) => {
    const basis = ownerId
      ? recordsRef.current.find((d) => d.ownerId === ownerId)
      : recordsRef.current.find((d) => d.id === currentRef.current) || recordsRef.current.find((d) => d.local);
    if (!basis || basis.available === false) throw new Error('nodo owner non disponibile');
    const made = await createDeck(token, name, basis.ownerRoute);
    const record = augmentDeck(made, ownerForRecord(basis), basis.ownerTopology, basis.local, true);
    install([...recordsRef.current, record], false); return record;
  };
  const rename = async (fromId, to) => {
    const deck = recordsRef.current.find((x) => x.id === fromId); if (!deck) throw new Error('deck inesistente');
    if (fromId === currentRef.current && dirtyRef.current) {
      const savedDirty = await saveNow(fromId);
      if (!savedDirty) throw new Error(`salvataggio di "${deck.name}" fallito: rinomina annullata`);
    }
    const fresh = recordsRef.current.find((x) => x.id === fromId); if (!fresh) throw new Error('deck inesistente');
    const saved = await renameDeck(token, fresh.name, to, fresh.revision, fresh.ownerRoute);
    const record = augmentDeck(saved, ownerForRecord(fresh), fresh.ownerTopology, fresh.local, true);
    install(recordsRef.current.map((x) => x.id === fromId ? record : x), false); return record;
  };
  const remove = async (id) => {
    const deck = recordsRef.current.find((x) => x.id === id); if (!deck) throw new Error('deck inesistente');
    if (id === currentRef.current) dirtyRef.current = false;
    await deleteDeck(token, deck.name, deck.revision, deck.ownerRoute);
    install(recordsRef.current.filter((x) => x.id !== id), false);
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
      const saved = await saveNow(currentRef.current);
      if (!saved) throw new Error('salvataggio del deck corrente fallito: cambio annullato');
    }
    const target = recordsRef.current.find((d) => d.id === id);
    if (!target) throw new Error(`deck inesistente: ${id}`);
    dirtyRef.current = false; skipRef.current = true;
    return viewLayout(target);
  };

  return {
    decks: records, records, localNodeId, ready, saveState, error, setError,
    saveNow, select, add, rename, remove, addTileTo,
    localMainId: deckId(null, 'main'), parseDeckId,
  };
}
