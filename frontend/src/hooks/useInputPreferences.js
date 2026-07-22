import { useCallback, useEffect, useState } from 'react';
import {
  INPUT_PREFERENCES_EVENT, INPUT_PREFERENCES_KEY,
  loadInputPreferences, normalizeInputPreferences, saveInputPreferences,
} from '../lib/input-preferences.js';

export function useInputPreferences() {
  const [preferences, setPreferences] = useState(loadInputPreferences);

  useEffect(() => {
    const refresh = (event) => {
      // key === null arriva da un localStorage.clear() di un'altra finestra:
      // va trattato come le altre scritture cross-window (ricarica i default),
      // allineato al modulo gemello useDeckBarCollapse.
      if (event?.type === 'storage' && event.key !== INPUT_PREFERENCES_KEY && event.key !== null) return;
      const next = event?.detail ? normalizeInputPreferences(event.detail) : loadInputPreferences();
      setPreferences(next);
    };
    window.addEventListener(INPUT_PREFERENCES_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(INPUT_PREFERENCES_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const updatePreferences = useCallback((patch) => {
    setPreferences((current) => {
      const next = saveInputPreferences({ ...current, ...(patch || {}) });
      window.dispatchEvent(new CustomEvent(INPUT_PREFERENCES_EVENT, { detail: next }));
      return next;
    });
  }, []);

  return [preferences, updatePreferences];
}

export default useInputPreferences;
