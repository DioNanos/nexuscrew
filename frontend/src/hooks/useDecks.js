import { useCallback, useEffect, useRef, useState } from 'react';
import { getDecks, createDeck, saveDeck, renameDeck, deleteDeck } from '../lib/api.js';
import { loadDecks, readLayoutRaw, saveDecks, writeLayoutRaw } from '../lib/deck-model.js';
import { addTileSmart, emptyLayout, normalize, sessions } from '../lib/grid-model.js';

const empty = (l) => sessions(normalize(l)).length === 0;

export function useDecks(token, current, layout, setLayout) {
  const [records, setRecords] = useState([]);
  const [ready, setReady] = useState(false);
  const [saveState, setSaveState] = useState('idle');
  const [error, setError] = useState('');
  const recordsRef = useRef([]);
  const currentRef = useRef(current);
  const layoutRef = useRef(layout);
  const dirtyRef = useRef(false);
  const skipRef = useRef(true);
  layoutRef.current = layout;
  currentRef.current = current;
  recordsRef.current = records;

  const install = useCallback((next, applyLayout = true, deckName = currentRef.current) => {
    recordsRef.current = next; setRecords(next);
    const rec = next.find((d) => d.name === deckName);
    if (applyLayout && rec) {
      skipRef.current = true;
      setLayout(normalize(rec.layout));
      writeLayoutRaw(deckName, rec.layout); // cache/migrazione backward-compatible
    }
    saveDecks(next.map((d) => d.name));
  }, [setLayout]);

  const bootstrap = useCallback(async () => {
    let st = await getDecks(token);
    // Migrazione one-shot: solo se lo store server e' ancora vuoto.
    const main = st.decks.find((d) => d.name === 'main');
    if (st.decks.length === 1 && main && main.revision === 0 && empty(main.layout)) {
      const legacyNames = loadDecks();
      const legacyMain = normalize(readLayoutRaw('main') || emptyLayout());
      if (!empty(legacyMain)) {
        const saved = await saveDeck(token, 'main', legacyMain, 0);
        st.decks[0] = saved;
      }
      for (const name of legacyNames.filter((n) => n !== 'main')) {
        try {
          let made = await createDeck(token, name);
          const old = normalize(readLayoutRaw(name) || emptyLayout());
          if (!empty(old)) made = await saveDeck(token, name, old, made.revision);
          st.decks.push(made);
        } catch (_) { /* collision/race: il prossimo GET converge */ }
      }
      st = await getDecks(token);
    }
    install(st.decks, true); setReady(true); setError('');
  }, [token, install]);

  useEffect(() => { if (token) bootstrap().catch((e) => setError(String(e.message || e))); }, [bootstrap, token]);

  const saveNow = useCallback(async (deckName = currentRef.current) => {
    if (!ready || !dirtyRef.current) return true;
    const rec = recordsRef.current.find((d) => d.name === deckName);
    if (!rec) { setError(`deck inesistente: ${deckName}`); return false; }
    setSaveState('saving');
    try {
      const saved = await saveDeck(token, deckName, normalize(layoutRef.current), rec.revision);
      install(recordsRef.current.map((d) => d.name === deckName ? saved : d), false);
      dirtyRef.current = false; setSaveState('saved'); setError('');
      setTimeout(() => setSaveState('idle'), 1500);
      return true;
    } catch (e) {
      setSaveState('error'); setError(String(e.message || e));
      if (e.status === 409 && e.data && e.data.current) install(recordsRef.current.map((d) => d.name === deckName ? e.data.current : d), false);
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

  // Convergenza tra finestre; non sovrascrive un layout locale ancora dirty.
  useEffect(() => {
    if (!ready) return;
    const id = setInterval(async () => {
      try {
        const st = await getDecks(token);
        const here = recordsRef.current.find((d) => d.name === current);
        const remote = st.decks.find((d) => d.name === current);
        const newer = remote && (!here || remote.revision > here.revision);
        install(st.decks, newer && !dirtyRef.current);
      } catch (_) {}
    }, 5000);
    return () => clearInterval(id);
  }, [ready, token, current, install]);

  const add = async (name) => { const d = await createDeck(token, name); install([...recordsRef.current, d], false); return d; };
  const rename = async (from, to) => {
    const d = recordsRef.current.find((x) => x.name === from); if (!d) throw new Error('deck inesistente');
    if (from === currentRef.current && dirtyRef.current) {
      const savedDirty = await saveNow(from);
      if (!savedDirty) throw new Error(`salvataggio di "${from}" fallito: rinomina annullata`);
    }
    const fresh = recordsRef.current.find((x) => x.name === from); if (!fresh) throw new Error('deck inesistente');
    const saved = await renameDeck(token, from, to, fresh.revision);
    install(recordsRef.current.map((x) => x.name === from ? saved : x), false); return saved;
  };
  const remove = async (name) => {
    const d = recordsRef.current.find((x) => x.name === name); if (!d) throw new Error('deck inesistente');
    if (name === currentRef.current) dirtyRef.current = false; // delete confirmation intentionally discards pending layout
    await deleteDeck(token, name, d.revision); install(recordsRef.current.filter((x) => x.name !== name), false);
  };
  const addTileTo = async (name, ref) => {
    const d = recordsRef.current.find((x) => x.name === name); if (!d) throw new Error('deck inesistente');
    const saved = await saveDeck(token, name, addTileSmart(normalize(d.layout), ref), d.revision);
    install(recordsRef.current.map((x) => x.name === name ? saved : x), false); return saved;
  };
  // Cambio deck nella stessa finestra: salva prima l'eventuale layout dirty,
  // poi restituisce il layout target e arma skipRef per evitare che React salvi
  // per errore il layout del deck precedente sotto il nuovo nome.
  const select = async (name) => {
    if (dirtyRef.current) {
      const saved = await saveNow(currentRef.current);
      if (!saved) throw new Error(`salvataggio di "${currentRef.current}" fallito: cambio deck annullato`);
    }
    const target = recordsRef.current.find((d) => d.name === name);
    if (!target) throw new Error(`deck inesistente: ${name}`);
    dirtyRef.current = false; skipRef.current = true;
    return normalize(target.layout);
  };
  return { decks: records.map((d) => d.name), records, ready, saveState, error, setError, saveNow, select, add, rename, remove, addTileTo };
}
