import { t } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import VlNodeEvents from './VlNodeEvents.jsx';
import Icon from './Icon.jsx';
import './VlSessionView.css';

// La sessione del nodo VL nella vista larga — la sua sede
// (VL_NODES_IN_SIDEBAR, 2026-08-06): la scheda del nodo resta per accoppiare
// e comandare, la conversazione si legge qui, dove la larghezza non spezza il
// testo a metà parola. Riusa VlNodeEvents (stesso canale in sola lettura),
// non lo duplica; nessun renderer markdown: prima la sede giusta, poi si
// guarda cosa resta davvero fastidioso.
export default function VlSessionView({ peer, token, onBack }) {
  useLang();
  if (!peer) return null;
  return (
    <section className="nc-vl-session-view">
      <header className="nc-bar nc-bar-single">
        <button onClick={onBack} title={t('back')}>
          <Icon name="chevronLeft" size={18} /><span className="nc-bar-label">{t('back')}</span>
        </button>
        <span className="nc-bar-center">
          <b title={peer.label}>{peer.label}</b>
          {peer.session?.profile && <small className="nc-bar-sub">{peer.session.profile} · {t('vl-events-title')}</small>}
        </span>
        <span className="nc-bar-right" />
      </header>
      <div className="nc-vl-session-body">
        <VlNodeEvents token={token} nodeId={peer.nodeId} route={peer.route || []} />
      </div>
    </section>
  );
}
