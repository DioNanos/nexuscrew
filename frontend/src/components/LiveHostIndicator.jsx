import { t } from '../lib/i18n.js';
import { liveHostDotClass, liveHostIndicatorKeys } from '../lib/live-host-view.js';
import './LiveHostIndicator.css';

// The Live host, said in words — for the surfaces that have a line to spare: the
// top of the sidebar and the top of the compact selector. Read-only: the command
// that changes the host is a separate, explicit one.
//
// The phone header gets the same information as a dot instead (see App.jsx):
// that bar must not be widened, and a sentence would widen it.
export default function LiveHostIndicator({ view, className = '' }) {
  const { modeKey, stateKey } = liveHostIndicatorKeys(view || {});
  const hasHost = !!(view && view.cell);
  const text = hasHost
    ? t('live-host-indicator')
      .replace('{cell}', view.cell)
      .replace('{mode}', t(modeKey || 'live-host-mode-unknown'))
      .replace('{state}', t(stateKey))
    : t('live-host-indicator-none');
  return (
    <div className={`nc-live-host${className ? ` ${className}` : ''}`}
      data-testid="live-host-indicator"
      data-state={view && view.state ? view.state : 'none'}
      data-remote={view && view.remote ? 'true' : 'false'}>
      <span className={`nc-live-host-dot ${liveHostDotClass(view || {})}`} aria-hidden="true" />
      <span className="nc-live-host-text">{text}</span>
      {view && view.remote ? <span className="nc-live-host-remote">{t('live-host-remote')}</span> : null}
    </div>
  );
}
