import { useSyncExternalStore } from 'react';
import { t } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import {
  getUpdateState, subscribeUpdate, applyUpdate, reloadWithoutCache, dismissUpdate,
} from '../lib/sw-update.js';
import './UpdatePrompt.css';

// Non-invasive banner (fixed at the bottom) driven by sw-update.js. It is the
// only place where a detection becomes a sentence, so the copy lives here and
// follows the kind: an interface older than the one being served is a diagnosis
// (reload without cache, and restart the node if it persists), a package newer
// than the running interface is an installation waiting for a node restart, and
// a service-worker update is the one case that is really a new version.
//
// The announced version is never the one the browser is running: a banner saying
// "new version X available" while X was already on screen is what made the old
// banner look permanent.
function message(state) {
  if (state.kind === 'install') return t('update-installed-restart').replace('{v}', state.version);
  if (state.kind === 'stale') {
    return t('update-stale').replace('{ui}', state.version).replace('{browser}', state.browserVersion);
  }
  // Service-worker detection: no version string to show, the placeholder is dropped.
  return t('update-available').replace('{v}', state.version).replace('  ', ' ').trim();
}

export default function UpdatePrompt() {
  useLang(); // re-render on language switch
  const state = useSyncExternalStore(subscribeUpdate, getUpdateState, getUpdateState);
  if (!state.needed) return null;

  return (
    <div className="nc-update" role="status" aria-live="polite">
      <span className="nc-update-msg">{message(state)}</span>
      {state.kind === 'stale' && (
        <button className="nc-update-btn" onClick={reloadWithoutCache}>{t('reload-no-cache')}</button>
      )}
      {state.kind === 'reload' && (
        <button className="nc-update-btn" onClick={applyUpdate}>{t('reload')}</button>
      )}
      <button
        className="nc-update-close"
        onClick={dismissUpdate}
        aria-label={t('update-dismiss')}
        title={t('update-dismiss')}
      >×</button>
    </div>
  );
}
