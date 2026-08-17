import { useCallback, useEffect, useRef } from 'react';
import { t } from '../lib/i18n.js';
import './CellPopup.css';

// Il contenitore che apre SOPRA invece di portare via. Una sola implementazione
// per tre usi — anteprima di una cella, flusso live, pannello del desktop —
// perche' sono la stessa esigenza: guardare una cosa senza perdere il posto in
// cui si sta.
//
// Non sa nulla di cio' che mostra: riceve un figlio e lo monta. Chi lo apre
// decide la sorgente. Se sapesse anche cosa mostrare, il terzo uso
// richiederebbe di modificarlo — ed e' cosi' che un contenitore diventa tre
// contenitori.
//
// Cio' che sta sotto NON viene smontato: ne' la griglia, ne' il terminale, ne'
// la cella corrente. Aprire questo popup non cambia dove sei.
export default function CellPopup({ title, subtitle, onClose, children }) {
  const boxRef = useRef(null);
  const primaRef = useRef(null);

  const chiudi = useCallback(() => { if (onClose) onClose(); }, [onClose]);

  useEffect(() => {
    // Esc chiude: e' il gesto che chi apre un popup si aspetta, e senza di
    // esso su desktop resta solo il bersaglio piccolo della X.
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); chiudi(); } };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [chiudi]);

  useEffect(() => {
    // Il fuoco entra nel popup all'apertura: senza, i tasti continuerebbero ad
    // andare al terminale sottostante, che e' ancora vivo e in ascolto.
    const el = primaRef.current;
    if (el && typeof el.focus === 'function') el.focus();
  }, []);

  return (
    <div
      className="nc-popup-velo"
      // Il clic FUORI chiude; quello dentro no. Senza il confronto sul target,
      // un clic partito nel corpo e finito sul velo chiuderebbe il popup —
      // succede selezionando testo, ed e' il modo piu' rapido di far perdere
      // quello che si stava leggendo.
      onMouseDown={(e) => { if (e.target === e.currentTarget) chiudi(); }}
      role="presentation"
    >
      <div className="nc-popup" ref={boxRef} role="dialog" aria-modal="true" aria-label={title || t('panel')}>
        <header className="nc-popup-testa">
          <span className="nc-popup-titolo">
            {title}
            {subtitle ? <small className="nc-popup-sub">{subtitle}</small> : null}
          </span>
          <button type="button" ref={primaRef} className="nc-popup-chiudi" onClick={chiudi} title={t('close')} aria-label={t('close')}>✕</button>
        </header>
        <div className="nc-popup-corpo">{children}</div>
      </div>
    </div>
  );
}
