import { useCallback, useEffect, useState } from 'react';
import { currentDeviceId, resolveConflict, syncPrefs } from '../lib/prefs-sync.js';

// Stato condiviso (modulo) dell'ultimo giro di sync: lo legge il pannello in Impostazioni.
const IDLE = { status: 'idle' };
let shared = IDLE; const listeners = new Set();
const publish = (next) => { shared = next; listeners.forEach((fn) => fn(next)); };
// Lo stato appartiene al login (token) che l'ha prodotto: se il token cambia o sparisce (nuovo login, 401, logout) lo
// stato e il conflitto pendente si azzerano e i risultati ancora in volo del login precedente vengono scartati.
let owner = null; let epoch = 0;
const adopt = (token) => {
  const next = token || null;
  if (owner === next) return;
  owner = next; epoch += 1;
  if (shared !== IDLE) publish(IDLE);
};
export const resetPrefsSyncState = () => { owner = null; epoch += 1; publish(IDLE); };
export const usePrefsSyncState = () => {
  const [state, setState] = useState(shared);
  useEffect(() => { listeners.add(setState); setState(shared); return () => { listeners.delete(setState); }; }, []);
  return state;
};

// Applica la scelta dell'utente sul conflitto aperto (usabile anche fuori da un componente con l'hook).
// Il conflitto e' legato al login e al dispositivo che l'hanno prodotto: con un altro token, o con un id dispositivo
// diverso da quello del conflitto, la scelta non parte (userebbe credenziali e id che non si appartengono).
export async function resolveSharedConflict(token, choice) {
  if (shared.status !== 'conflict') return;
  const mine = epoch;
  if (owner !== (token || null) || shared.conflict?.deviceId !== currentDeviceId()) {
    publish(IDLE);
    try { window.dispatchEvent(new Event('nexuscrew-roster-preferences')); } catch (_) { /* fuori dal browser */ }
    return;
  }
  const result = await resolveConflict(choice, shared.conflict, { token });
  if (mine === epoch) publish({ ...result, at: Date.now() });
}

const FIRST_DELAY_MS = 1500; const DEBOUNCE_MS = 3000;
const CHANGE_EVENT = 'nexuscrew-roster-preferences';

// Sync delle preferenze col nodo: un giro poco dopo l'avvio, poi un giro dopo ogni pausa nelle modifiche.
// Con un conflitto aperto non si carica nulla: decide l'utente (resolve).
export function usePrefsSync(token) {
  useEffect(() => {
    adopt(token);
    if (!token) return undefined;
    let timer = null; let alive = true;
    const run = async () => {
      if (!alive || shared.status === 'conflict') return;
      const mine = epoch;
      const result = await syncPrefs({ token });
      if (alive && mine === epoch) publish({ ...result, at: Date.now() });
    };
    const later = (ms) => { clearTimeout(timer); timer = setTimeout(run, ms); };
    const onChange = () => { if (shared.status !== 'conflict') later(DEBOUNCE_MS); };
    later(FIRST_DELAY_MS);
    window.addEventListener(CHANGE_EVENT, onChange); window.addEventListener('storage', onChange);
    return () => { alive = false; clearTimeout(timer); window.removeEventListener(CHANGE_EVENT, onChange); window.removeEventListener('storage', onChange); };
  }, [token]);

  const resolve = useCallback((choice) => resolveSharedConflict(token, choice), [token]);
  return { state: usePrefsSyncState(), resolve };
}
