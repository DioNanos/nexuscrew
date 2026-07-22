import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DOT_NEUTRAL, DOT_WARN, PRESENCE_HEARTBEAT_MS, PRESENCE_KEY,
  dotStatesForPresence, loadPresence, removePresence, savePresence, upsertPresence,
} from '../lib/deck-presence-model.js';

// Refresh dei dot a meta' heartbeat: rileva quando il deck di un'altra finestra
// diventa stale senza aspettare il prossimo battito.
const REFRESH_MS = Math.min(PRESENCE_HEARTBEAT_MS, 5000);

// Identity del top-level browser runtime. Non usare sessionStorage: una pagina
// aperta con window.open puo' ereditarne una copia dall'opener e collidere con
// la finestra sorgente. Ogni realm JS riceve invece un ID nuovo; un reload ne
// crea uno nuovo e il vecchio heartbeat viene eliminato dal TTL.
export function createWindowRuntimeId() {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return `w${uuid.replaceAll('-', '')}`;
  } catch (_) { /* fallback non crittografico: serve unicita', non segretezza */ }
  return `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 14)}`;
}
const WINDOW_RUNTIME_ID = createWindowRuntimeId();

function focusState() {
  const focused = (typeof document !== 'undefined' && typeof document.hasFocus === 'function')
    ? document.hasFocus()
    : true;
  const visible = (typeof document !== 'undefined' && typeof document.visibilityState === 'string')
    ? document.visibilityState !== 'hidden'
    : true;
  return { focus: focused, visible };
}

// Presence client-side del deck owner-qualified attualmente aperto in questa
// finestra. Heartbeat bounded, focus/visibility, prune stale, cleanup best
// effort e sync cross-window. Nessun backend globale: la presence e' locale
// al browser (le sue finestre); l'owner offline si legge dal modello deck.
//
// currentDeckId: l'id owner-qualified del deck mostrato in questa finestra.
// enabled: falso durante il bootstrap o in contesti senza window (no-op).
export function useDeckPresence(currentDeckId, enabled = true) {
  const windowIdRef = useRef(WINDOW_RUNTIME_ID);
  const windowId = windowIdRef.current;

  const currentRef = useRef(currentDeckId);
  currentRef.current = currentDeckId;

  const [snapshot, setSnapshot] = useState(() => ({ map: {}, now: Date.now() }));
  const refresh = useCallback(() => {
    setSnapshot({ map: loadPresence(), now: Date.now() });
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;

    const write = () => {
      const now = Date.now();
      const next = upsertPresence(loadPresence(), windowId, {
        deckId: currentRef.current, ts: now, ...focusState(),
      }, now);
      savePresence(next);
      return { map: next, now };
    };
    const writeAndRefresh = () => setSnapshot(write());

    writeAndRefresh();
    const beat = setInterval(write, PRESENCE_HEARTBEAT_MS);
    const refreshTimer = setInterval(refresh, REFRESH_MS);

    const onActivity = writeAndRefresh;
    const onStorage = (event) => { if (event.key === PRESENCE_KEY || event.key === null) refresh(); };

    window.addEventListener('focus', onActivity);
    window.addEventListener('blur', onActivity);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onActivity);
    window.addEventListener('storage', onStorage);

    return () => {
      clearInterval(beat);
      clearInterval(refreshTimer);
      window.removeEventListener('focus', onActivity);
      window.removeEventListener('blur', onActivity);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onActivity);
      window.removeEventListener('storage', onStorage);
      // cleanup best-effort: togli questa finestra dalla presence map.
      try { savePresence(removePresence(loadPresence(), windowId)); } catch (_) {}
    };
  }, [enabled, windowId, refresh]);

  // Quando il deck corrente cambia (navigazione tra deck della stessa finestra),
  // aggiorna subito la presenza di questa finestra: il dot passa al nuovo deck
  // senza aspettare il prossimo heartbeat (che altrimenti lascerebbe fino a
  // PRESENCE_HEARTBEAT_MS il vecchio deckId per questa finestra).
  useEffect(() => {
    if (!enabled) return;
    const now = Date.now();
    const next = upsertPresence(loadPresence(), windowId, {
      deckId: currentDeckId, ts: now, ...focusState(),
    }, now);
    savePresence(next);
    setSnapshot({ map: next, now });
  }, [currentDeckId, enabled, windowId]);

  const dotStates = useMemo(
    () => (enabled ? dotStatesForPresence(snapshot.map, snapshot.now) : {}),
    [enabled, snapshot],
  );

  const dotFor = useCallback((deckId, ownerOffline = false) => {
    if (!enabled) return null;
    if (ownerOffline) return DOT_WARN;
    return dotStates[deckId] || DOT_NEUTRAL;
  }, [dotStates, enabled]);

  return { dotFor, windowId };
}
