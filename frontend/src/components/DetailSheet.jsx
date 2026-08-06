import { useEffect, useRef } from 'react';
import { t } from '../lib/i18n.js';
import Icon from './Icon.jsx';
import './DetailSheet.css';

// Contenitore riga → dettaglio, condiviso.
//
// Nasce per il pannello Nodi (NC-I), ma non sa nulla dei nodi: prende
// un'intestazione e dei figli. E' deliberato — il dettaglio di una riga dovra'
// poter ospitare un riquadro che NON e' un terminale (grafici, una pagina web,
// una vista su misura), e un contenitore che conosce il suo contenuto va
// riscritto ogni volta che il contenuto cambia. Qui il contenuto e' `children`.
//
// Una sola gerarchia di navigazione su entrambe le forme: su schermo stretto e'
// un foglio che sale dal basso, su schermo largo un pannello laterale. E'
// sempre lo stesso componente e lo stesso albero — la differenza vive nel CSS,
// quindi non esistono due percorsi da tenere allineati.
//
//   title/subtitle  identita' della riga aperta
//   status          nodo React opzionale a destra del titolo (stato, badge)
//   footer          azioni in fondo, sempre visibili
//   onClose         chiusura: Esc, tocco fuori, bottone
//   plain           corpo senza spaziatura interna, per chi rende un riquadro
//                   proprio invece di sezioni di testo
export default function DetailSheet({ title, subtitle, status, footer, onClose, plain = false, children }) {
  const sheetRef = useRef(null);
  const restoreRef = useRef(null);

  useEffect(() => {
    // Chi aveva il fuoco prima dell'apertura lo riprende alla chiusura: senza,
    // chiudere il foglio da tastiera rimanda il fuoco all'inizio del pannello e
    // si perde il posto nella lista.
    //
    // SOLO AL MONTAGGIO, deliberatamente: questo effetto era armato su
    // [onClose], e i genitori ricreano onClose a ogni giro di polling — il
    // foglio si RUBAVA il fuoco ogni pochi secondi, e su mobile la tastiera
    // si chiudeva sotto le dita mentre si scriveva nel campo prompt. Il fuoco
    // iniziale e il ripristino appartengono all'apertura/chiusura del foglio,
    // non all'identita' di una callback.
    restoreRef.current = document.activeElement;
    if (sheetRef.current) sheetRef.current.focus();
    return () => {
      const previous = restoreRef.current;
      if (previous && typeof previous.focus === 'function' && document.contains(previous)) previous.focus();
    };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose && onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="nc-detail-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose && onClose(); }}>
      <div className="nc-detail-sheet" ref={sheetRef} tabIndex={-1} role="dialog" aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}>
        <div className="nc-detail-head">
          <div className="nc-detail-title">
            <b>{title}</b>
            {subtitle && <small>{subtitle}</small>}
          </div>
          {status}
          <button type="button" className="nc-btn ghost nc-detail-close" onClick={onClose} aria-label={t('close')}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className={`nc-detail-body${plain ? ' plain' : ''}`}>{children}</div>
        {footer && <div className="nc-detail-foot">{footer}</div>}
      </div>
    </div>
  );
}

// Una sezione del corpo. Esiste per dare lo stesso titolo alla stessa cosa in
// tutti i fogli, e perche' una sezione vuota non deve lasciare un titolo
// sospeso su niente.
export function SheetSection({ title, hint, children }) {
  if (children === null || children === undefined || children === false) return null;
  return (
    <section className="nc-detail-section">
      {title && <div className="nc-sheet-label">{title}</div>}
      {hint && <small className="nc-set-hint">{hint}</small>}
      {children}
    </section>
  );
}
