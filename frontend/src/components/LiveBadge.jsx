import { t } from '../lib/i18n.js';
import { liveBadgeMode } from '../lib/live-host-view.js';
import './LiveBadge.css';

// "Live" as a thing of its own: shown only while there is a Live to name, and
// without the host cell's name. Read-only; the designation stays elsewhere.
export default function LiveBadge({ view }) {
  const mode = liveBadgeMode(view);
  if (!mode) return null;
  return (
    <span className="nc-live-badge" data-testid="live-badge" data-mode={mode}
      title={t(`live-badge-${mode}`)}>{t('live-badge')}</span>
  );
}
