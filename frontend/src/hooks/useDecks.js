import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  getDecks, createDeck, saveDeck, saveDeckKeepalive, renameDeck, deleteDeck, getRouteConfig, getRouteTopology,
} from '../lib/api.js';
import {
  loadDeckOrders, loadDecks, moveDeckInOrder, orderDeckRecords, readLayoutRaw,
  removeDeckOrderId, replaceDeckOrderId, saveDeckOrders, saveDecks, writeLayoutRaw,
} from '../lib/deck-model.js';
import { addTileSmart, emptyLayout, mergeRemoteWithLocal, normalize, sessions } from '../lib/grid-model.js';
// Stessa soglia di useNodes: un owner scaduto e' un fatto, non un blip.
import { OWNER_GRACE_MS } from './useNodes.js';
import {
  LOCAL_OWNER, NODE_ID_RE, annotateCanonicalLayout, canonicalizeLayoutForOwner,
  deckId, deckIdForLocalOwner, parseDeckId, refWithOwner, resolveLayoutForViewer,
} from '../lib/deck-federation.js';

const empty = (layout) => sessions(normalize(layout)).length === 0;
const routeKey = (route) => (Array.isArray(route) ? route.join('/') : '');

// Cache dell'ultima lista deck (locale + remote): al reload della pagina la
// rail riparte piena, non vuota. Best-effort, mai critica. La chiave porta
// l'instanceId LOCALE del nodo: una cache scritta da un altro hub non e' mai
// la nostra lista, e senza il suffisso sarebbe servita a chiunque al reload.
const DECKS_CACHE_PREFIX = 'nc-decks-cache-v1';
const decksCacheKey = (instanceId) => `${DECKS_CACHE_PREFIX}:${instanceId}`;
function readCachedRecords(instanceId) {
  if (!instanceId) return [];
  try {
    const raw = localStorage.getItem(decksCacheKey(instanceId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((d) => d && typeof d.id === 'string' && typeof d.name === 'string')
      ? parsed
      : [];
  } catch (_) { return []; }
}
function writeCachedRecords(instanceId, records) {
  if (!instanceId) return;
  try { localStorage.setItem(decksCacheKey(instanceId), JSON.stringify(records)); } catch (_) { /* quota/private */ }
}

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
      stale: owner.stale === true,
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
  // Da quando un owner manca dalle risposte confermate: passata la grazia le
  // sue deck sloggano (rimozione confermata), sotto restano come blip. Stessa
  // soglia di useNodes, cosi' non esistono due grazie divergenti.
  const ownerMissingRef = useRef(new Map());
  const localNodeIdRef = useRef('');
  const currentRef = useRef(current);
  const layoutRef = useRef(layout);
  const dirtyRef = useRef(false);
  const skipRef = useRef(true);
  const bootTokenRef = useRef('');
  const owners = useMemo(() => cleanOwners(remoteOwners), [remoteOwners]);
  // Firma degli owner per sola identità (instanceId + route): un blip di
  // status/label dalla topologia non deve rilanciare il caricamento completo
  // — i canali legittimi restano la presenza di nuovi owner e il refresh
  // periodico. status/label freschi arrivano comunque via ownersRef a ogni
  // render per il loop di reload dentro loadAll.
  const ownersSig = owners.map((o) => `${o.instanceId}:${routeKey(o.route)}`).join('|');
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
    // Cache dell'ultima lista conosciuta (senza i flag effimeri del refresh
    // fallito): al reload la rail riparte da qui, non dal vuoto. Chiave legata
    // all'instanceId locale: nessun altro hub puo' servirsi di questa lista.
    writeCachedRecords(localNodeIdRef.current, ordered.map((d) => {
      if (!d.refreshFailedAt) return d;
      const cached = { ...d }; delete cached.refreshFailedAt; return cached;
    }));
    const rec = ordered.find((d) => d.id === wanted);
    if (applyLayout && rec) {
      skipRef.current = true;
      const viewed = viewLayout(rec);
      setLayout(viewed);
      // localStorage per i deck locali: SOLO geometria, lo stato effimero di
      // disponibilita' (unavailable/stale) non si persiste mai.
      if (rec.local) writeLayoutRaw(rec.name, normalize(viewed));
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

  // Merge in background di UN owner (mai persistito: install salva solo
  // le locali; nessun reflow — applyLayout false — la deck corrente si aggiorna
  // al prossimo giro di vista).
  //
  // SOSTITUZIONE IN POSIZIONE. L'ordine della rail È l'ordine di questo array
  // (la DeckBar non ordina, e l'utente può riordinarla a mano): appendere in
  // coda le deck appena arrivate farebbe saltare in fondo il gruppo di un
  // owner a ogni risposta, e con più owner che rispondono a tempi diversi la
  // rail si rimescolerebbe di continuo. Qui ogni deck esistente viene
  // rimpiazzata ALLO STESSO INDICE (stesso id), le deck nuove si accodano e
  // quelle che l'owner non elenca più spariscono (revoca confermata).
  // L'ordine relativo degli altri owner non cambia mai.
  const mergeOwner = useCallback((owner, mine) => {
    const replacements = new Map(mine.map((d) => [d.id, d]));
    const placed = new Set();
    const out = [];
    for (const record of recordsRef.current) {
      if (record.local || record.ownerId !== owner.instanceId) { out.push(record); continue; }
      const fresh = replacements.get(record.id);
      if (!fresh) continue; // non più elencata dall'owner: revoca confermata
      out.push(fresh); placed.add(record.id);
    }
    for (const record of mine) if (!placed.has(record.id)) out.push(record); // nuove: in coda
    install(out, false);
  }, [install]);

  const loadOwnerDecks = useCallback(async (owner) => {
    try {
      const [remoteStore, remoteTopology] = await Promise.all([
        getDecks(token, owner.route),
        getRouteTopology(token, owner.route).catch(() => ({ nodes: [] })),
      ]);
      mergeOwner(owner, remoteStore.decks.map((deck) => augmentDeck(deck, owner, remoteTopology.nodes, false, true)));
    } catch (e) {
      // Negazione CONFERMATA (403/404): revoca ACL o rotta dichiarata morta
      // dall'owner — le sue deck sloggano, come una lista senza di loro.
      if (e && (e.status === 403 || e.status === 404)) {
        mergeOwner(owner, []);
        return;
      }
      // Degrado per owner (timeout federato o errore di rete): le sue deck
      // precedenti restano con available:false e l'istante del refresh
      // fallito. Mai un reflow, mai una rimozione.
      const previous = recordsRef.current.filter((d) => !d.local && d.ownerId === owner.instanceId)
        .map((d) => ({
          ...d,
          available: false,
          stale: true,
          refreshFailedAt: Date.now(),
          ownerRoute: [...owner.route],
          ownerLabel: owner.label,
        }));
      mergeOwner(owner, previous);
    }
  }, [token, mergeOwner]);

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
    const localRecords = localStore.decks.map((deck) => augmentDeck(deck, localOwner, localTopologyResult.nodes, true, true));
    // Le deck LOCALI escono subito. Gli owner remoti (up) si caricano in
    // BACKGROUND con il timeout federato di getDecks; chi non risponde degrada
    // a available:false per-owner senza bloccare nessuno. Le deck remote sono
    // STATO STICKY: l'owner assente dalla topologia (blip/purge) NON perde le
    // sue deck — restano come stale/available:false finché l'owner non
    // risponde (lista nuova, anche senza di loro) o nega (403/404).
    const known = new Map(ownersRef.current.map((o) => [o.instanceId, o]));
    // Alla prima load (o dopo un reload) recordsRef e' vuota: la base sono le
    // deck in cache PER QUESTO instanceId, mai quelle di un altro nodo.
    const base = recordsRef.current.length ? recordsRef.current : readCachedRecords(nodeId);
    const missing = ownerMissingRef.current;
    const now = Date.now();
    const previousRemote = base.filter((d) => !d.local).flatMap((d) => {
      const owner = known.get(d.ownerId);
      if (!owner) {
        // L'owner manca da una risposta confermata. Sotto la grazia e' un
        // blip (la deck resta, degradata); oltre, l'assenza e' un fatto: le
        // sue deck sloggano — la rimozione confermata che il blip non deve
        // poter mascherare per sempre.
        const since = missing.get(d.ownerId);
        if (since === undefined) { missing.set(d.ownerId, now); return [{ ...d, available: false, stale: true }]; }
        if (now - since > OWNER_GRACE_MS) return [];
        return [{ ...d, available: false, stale: true }];
      }
      missing.delete(d.ownerId);
      // Owner che verrà ricaricato in background: la disponibilità resta
      // quella già nota finché il reload non la aggiorna — un refresh non
      // deve far lampeggiare offline la rail. Owner non-up (nessun reload
      // in arrivo): degrado esplicito, come prima.
      const reloading = owner.status === 'up';
      return [{
        ...d,
        available: reloading ? d.available !== false : false,
        stale: owner.stale === true,
        ownerRoute: [...owner.route],
        ownerLabel: owner.label,
      }];
    });
    // I reload per owner partono un macrotask DOPO il return: il chiamante
    // installa prima l'elenco (con la disponibilità mantenuta), così il
    // degrado di un owner che rifiuta subito non viene calpestato
    // dall'install dell'elenco fresh.
    setTimeout(() => {
      for (const owner of known.values()) {
        if (owner.status === 'up') loadOwnerDecks(owner);
      }
    }, 0);
    return [...localRecords, ...previousRemote];
  }, [token, migrateLocal, loadOwnerDecks, ownersSig]);

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
    // Lo skip dell'aggiornamento di vista vale solo a finestra PULITA: con un
    // edit utente pendente il debounce si riarma invece di fermarsi, cosi' un
    // flip effimero di disponibilita' non puo' annullare né rinviare per sempre
    // il salvataggio di una modifica vera.
    const skip = skipRef.current && !dirtyRef.current;
    skipRef.current = false;
    if (skip) return;
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
        // Un flip di disponibilita' dell'owner NON e' un cambiamento di layout:
        // non fa partire il merge (che salverebbe) ma solo il refresh della
        // vista. Il merge serve al solo crescita di revisione.
        const newer = Boolean(remote && here && remote.revision > here.revision);
        const refreshed = Boolean(remote && (!here || newer || here.available !== remote.available));
        if (newer && dirtyRef.current && remote) {
          // La finestra è sporca e il remoto è più nuovo — merge
          // remoto ⊕ delta locale invece di restare indietro. Il layout fuso
          // è un cambio di layout: l'autosave lo salva con la revisione nuova.
          const merged = mergeRemoteWithLocal(viewLayout(remote), layoutRef.current);
          install(next, false);
          setLayout(merged);
          return;
        }
        install(next, refreshed && !dirtyRef.current);
      } catch (_) {}
    }, 5000);
    return () => clearInterval(id);
  }, [ready, loadAll, install, viewLayout, setLayout]);

  // Aggiornamento di VISTA (overlay di disponibilita'): cambia il layout in
  // memoria senza marcare la finestra sporca — un flip di disponibilita' non
  // deve mai produrre un PUT. Lo skip si arma solo se l'updater cambia davvero
  // il riferimento, cosi' un layout invariato non lascia skip pendenti.
  const viewUpdate = useCallback((updater) => {
    setLayout((current) => {
      const next = updater(current);
      if (next !== current) skipRef.current = true;
      return next;
    });
  }, []);

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
    saveNow, select, add, rename, remove, reorder, addTileTo, viewUpdate,
    localMainId: deckId(null, 'main'), parseDeckId,
  };
}
