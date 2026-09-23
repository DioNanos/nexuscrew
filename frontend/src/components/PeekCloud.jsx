import { useEffect } from 'react';
import { CellPeekBody } from './CellPeek.jsx';
import { t } from '../lib/i18n.js';
import './PeekCloud.css';

// La NUVOLA: la sbirciata che si appende al pallino di stato al passaggio
// (~300 ms, il tempo lo decide chi la apre). Stesso corpo di CellPeek
// (CellPeekBody: Anteprima/Live/Pannello), guscio diverso: piccola, fissa,
// ancorata al pallino che l'ha chiamata, SENZA velo — la pagina resta viva
// sotto. La puntina la trasforma nella CellPopup libera (stessa cella, stessa
// sorgente): una sola sbirciata alla volta è una regola del chiamante, qui
// c'è solo il gesto.
//
// Default sorgente: LIVE. Il senso della nuvola, per chi la chiede, è vedere
// COSA STA FACENDO la cella adesso; l'anteprima statica resta una tab.
const NUVOLA_W = 460;
const NUVOLA_H = 320;

export default function PeekCloud({
  row, token, panelPort = 0, anchorRect,
  liveHost = null, onLiveHostApplied,
  source, onSourceChange,
  onExpand, onClose, onMouseEnter, onMouseLeave,
}) {
  useEffect(() => {
    const fuga = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', fuga);
    return () => document.removeEventListener('keydown', fuga);
  }, [onClose]);

  // Ancorata alla DEstra del pallino (la sidebar sta a sinistra), clampata al
  // riquadro: mai sotto lo schermo, mai fuori.
  const left = anchorRect
    ? Math.max(8, Math.min(anchorRect.right + 10, window.innerWidth - NUVOLA_W - 8))
    : undefined;
  const top = anchorRect
    ? Math.max(8, Math.min(anchorRect.top - 6, window.innerHeight - NUVOLA_H - 8))
    : undefined;

  return (
    <div className="nc-peekcloud" style={{ left, top, width: NUVOLA_W }}
      data-testid="peek-cloud"
      onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      <div className="nc-peekcloud-testa">
        <b className="nc-peekcloud-nome">{row.cellName}</b>
        {[row.nodeLabel, row.subtitle].filter(Boolean).length > 0 && (
          <span className="nc-peekcloud-sub">{[row.nodeLabel, row.subtitle].filter(Boolean).join(' · ')}</span>
        )}
        <button type="button" className="nc-peekcloud-espandi" title={t('cell-peek-expand')}
          aria-label={`${t('cell-peek-expand')}: ${row.cellName}`}
          onClick={() => onExpand(source)}>⤢</button>
      </div>
      <CellPeekBody
        row={row} token={token} panelPort={panelPort}
        liveHost={liveHost} onLiveHostApplied={onLiveHostApplied}
        source={source} onSourceChange={onSourceChange}
      />
    </div>
  );
}
