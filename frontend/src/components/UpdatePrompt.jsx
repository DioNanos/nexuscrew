import { useSyncExternalStore } from 'react';
import { t } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import { getUpdateState, subscribeUpdate, applyUpdate } from '../lib/sw-update.js';
import './UpdatePrompt.css';

// Banner non invasivo (fisso in basso): il Service Worker ha rilevato una nuova
// versione. Complementare al banner API-version di App.jsx (desktop-only, in alto):
// questo lavora su ogni vista e si basa sul ciclo di vita del SW.
export default function UpdatePrompt() {
  useLang(); // re-render allo switch lingua
  const state = useSyncExternalStore(subscribeUpdate, getUpdateState, getUpdateState);
  if (!state.needed) return null;

  // Nel flusso SW non abbiamo una versione semantica: puliamo il placeholder {v}.
  // La chiave resta con {v} per l'uso API-version in App.jsx.
  const msg = state.kind === 'install'
    ? t('install-version-mismatch').replace('{v}', state.version)
    : t('update-available').replace('{v}', state.version).replace('  ', ' ').trim();

  return (
    <div className="nc-update" role="status" aria-live="polite">
      <span className="nc-update-msg">{msg}</span>
      {state.kind === 'reload' && <button className="nc-update-btn" onClick={applyUpdate}>{t('reload')}</button>}
    </div>
  );
}
