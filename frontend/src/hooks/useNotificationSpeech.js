import { useCallback, useEffect, useState } from 'react';
import {
  NOTIFICATION_SPEECH_EVENT, NOTIFICATION_SPEECH_KEY,
  loadNotificationSpeech, normalizeNotificationSpeech, saveNotificationSpeech,
} from '../lib/notification-speech.js';

export function useNotificationSpeech() {
  const [preference, setPreference] = useState(loadNotificationSpeech);

  useEffect(() => {
    const refresh = (event) => {
      if (event?.type === 'storage'
        && event.key !== NOTIFICATION_SPEECH_KEY
        && event.key !== null) return;
      const next = event?.type === NOTIFICATION_SPEECH_EVENT
        ? normalizeNotificationSpeech(event.detail)
        : loadNotificationSpeech();
      setPreference(next);
    };
    window.addEventListener(NOTIFICATION_SPEECH_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(NOTIFICATION_SPEECH_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);

  const setEnabled = useCallback((enabled) => {
    const next = saveNotificationSpeech({ enabled: enabled === true });
    setPreference(next);
    window.dispatchEvent(new CustomEvent(NOTIFICATION_SPEECH_EVENT, { detail: next }));
    return next.enabled;
  }, []);

  return [preference.enabled, setEnabled];
}

export default useNotificationSpeech;
