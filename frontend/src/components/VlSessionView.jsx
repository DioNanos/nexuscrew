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
export default function VlSessionView({ peer, token, onBack, nonCorrente = false }) {
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
        {/* Il dato che si sta leggendo non e' aggiornato: la lista che lo
            alimenta non c'e' (mobile senza poll) o e' una fotografia in cache.
            Non si nasconde e non si chiude la vista: si dice. */}
        {nonCorrente && (
          <small className="nc-set-hint nc-vl-session-stale" data-testid="vl-session-stale">
            {t('vl-session-stale')}
          </small>
        )}
        <VlNodeEvents
          token={token}
          nodeId={peer.nodeId}
          route={peer.route || []}
          // Il confine di sessione: profilo dichiarato, attacco e generazione.
          // Cambia uno dei tre, la conversazione riparte da zero — un cursore
          // vecchio mostrerebbe eventi di un'altra sessione.
          sessionKey={`${peer.session?.profile || ''}|${peer.session?.attached === true}|${peer.generation ?? ''}`}
          // Ultimo dato noto: con il peer non corrente il polling si sospende;
          // quando torna corrente riparte, e per una generazione nuova riparte
          // da zero perche' sessionKey e' cambiato.
          sospeso={nonCorrente}
        />
      </div>
    </section>
  );
}
