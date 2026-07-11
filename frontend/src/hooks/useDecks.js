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
  const layoutRef = useRef(layout);
  const dirtyRef = useRef(false);
  const skipRef = useRef(true);
  layoutRef.current = layout;
  recordsRef.current = records;

  const install = useCallback((next, applyLayout = true) => {
    recordsRef.current = next; setRecords(next);
    const rec = next.find((d) => d.name === current);
    if (applyLayout && rec) {
      skipRef.current = true;
      setLayout(normalize(rec.layout));
      writeLayoutRaw(current, rec.layout); // cache/migrazione backward-compatible
    }
    saveDecks(next.map((d) => d.name));
  }, [current, setLayout]);

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

  const saveNow = useCallback(async () => {
    if (!ready) return;
    const rec = recordsRef.current.find((d) => d.name === current);
    if (!rec) return setError(`deck inesistente: ${current}`);
    setSaveState('saving');
    try {
      const saved = await saveDeck(token, current, normalize(layoutRef.current), rec.revision);
      install(recordsRef.current.map((d) => d.name === current ? saved : d), false);
      dirtyRef.current = false; setSaveState('saved'); setError('');
      setTimeout(() => setSaveState('idle'), 1500);
    } catch (e) {
      setSaveState('error'); setError(String(e.message || e));
      if (e.status === 409 && e.data && e.data.current) install(recordsRef.current.map((d) => d.name === current ? e.data.current : d), false);
    }
  }, [ready, current, token, install]);

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
    const saved = await renameDeck(token, from, to, d.revision);
    install(recordsRef.current.map((x) => x.name === from ? saved : x), false); return saved;
  };
  const remove = async (name) => {
    const d = recordsRef.current.find((x) => x.name === name); if (!d) throw new Error('deck inesistente');
    await deleteDeck(token, name, d.revision); install(recordsRef.current.filter((x) => x.name !== name), false);
  };
  const addTileTo = async (name, ref) => {
    const d = recordsRef.current.find((x) => x.name === name); if (!d) throw new Error('deck inesistente');
    const saved = await saveDeck(token, name, addTileSmart(normalize(d.layout), ref), d.revision);
    install(recordsRef.current.map((x) => x.name === name ? saved : x), false); return saved;
  };
  return { decks: records.map((d) => d.name), records, ready, saveState, error, setError, saveNow, add, rename, remove, addTileTo };
}
