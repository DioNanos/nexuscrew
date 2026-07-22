import { useCallback, useEffect, useState } from 'react';
import {
  COLLAPSE_KEY, isCollapsedOf, loadCollapsed, saveCollapsed, toggleCollapsedIn,
} from '../lib/deckbar-collapse-model.js';

// Preferenza "gruppo owner compresso" della DeckBar, persistita per-client
// (localStorage) e sincronizzata cross-window via storage event. I nuovi owner
// partono compressi (default true nel modello). Nessuna persistenza server,
// nessun leak di topologia: la chiave salvata e' solo {ownerKey: bool}.
//
// L'hook possiede solo lo stato persistente (come useRosterPreferences): la
// markup vive nella shell DeckBar.
export function useDeckBarCollapse() {
  const [collapsed, setCollapsed] = useState(loadCollapsed);

  // sync cross-tab/cross-window: un'altra finestra che comprime/espande lo
  // stesso owner si propaga qui tramite l'evento 'storage'.
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key === COLLAPSE_KEY || event.key === null) setCollapsed(loadCollapsed());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const isCollapsed = useCallback((ownerKey) => isCollapsedOf(collapsed, ownerKey), [collapsed]);

  const toggle = useCallback((ownerKey) => {
    setCollapsed((before) => saveCollapsed(toggleCollapsedIn(before, ownerKey)));
  }, []);

  return { collapsed, isCollapsed, toggle };
}
