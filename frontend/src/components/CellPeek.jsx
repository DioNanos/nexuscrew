import { useRef, useState } from 'react';
import CellPopup from './CellPopup.jsx';
import Terminal from './Terminal.jsx';
import CellPanel from './CellPanel.jsx';
import { t } from '../lib/i18n.js';
import './CellPeek.css';

// La sbirciata di una cella, UNA volta sola: contenitore CellPopup, tre
// sorgenti (anteprima, flusso, pannello) dietro le stesse tab. Nata dentro
// CellSwitcher e portata fuori quando la Sidebar ha avuto lo stesso bisogno:
// la terza copia non sarebbe stata una terza funzione, sarebbe stato il
// ritorno del posto dove le differenze nascono.
//
// Il VERSO della telemetria è scritto nel testo di OGNI numero (contesto
// LIBERO, tier USATI) e l'etichetta sta appiccicata al numero: chi legge
// vede solo questa riga.

const ATTIVITÀ_MASSIMA_MS = 30 * 60 * 1000;

export function formattaAttività(tt, epoch, oraMs = Date.now()) {
  const ms = Number(epoch);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const età = oraMs - ms;
  if (età < 0 || età > ATTIVITÀ_MASSIMA_MS) return '';
  // L'etichetta c'è sempre: un «2m» nudo accanto alla telemetria non dice
  // cosa stia misurando, e una riga che non si spiega viene letta male.
  if (età < 60 * 1000) return `${tt('cell-activity')} ${tt('cell-activity-now')}`;
  const minuti = Math.floor(età / 60000);
  if (minuti < 60) return `${tt('cell-activity')} ${minuti}m`;
  return `${tt('cell-activity')} ${Math.floor(minuti / 60)}h`;
}

export function formattaTelemetria(tt, tele) {
  if (!tele || typeof tele !== 'object') return '';
  const parti = [];
  if (Number.isInteger(tele.contextFreePct)) {
    parti.push(`${tt('cell-tele-ctx')} ${tele.contextFreePct}% ${tt('cell-tele-free')}`);
  }
  if (Number.isInteger(tele.tier5hUsedPct)) parti.push(`${tt('cell-tele-5h')} ${tele.tier5hUsedPct}%`);
  if (Number.isInteger(tele.tier7dUsedPct)) parti.push(`${tt('cell-tele-7d')} ${tele.tier7dUsedPct}%`);
  return parti.join(' · ');
}

// La riga che il popup mostra, RI-risolta per CHIAVE a ogni render dal padre:
// mai un oggetto riga salvato (il fotogramma morto del difetto trovato in R4).
// Campi: key, cellName, subtitle, nodeLabel, node (route qualificata o ''),
// session, route[], panelUrl, telemetry, preview, activity.
export default function CellPeek({ row, token, initialSource = 'preview', panelPort = 0, onClose }) {
  const [source, setSource] = useState(initialSource === 'panel' && !row.panelUrl ? 'preview' : initialSource);
  // Ref del terminale: il contratto della tile, così Terminal non dipende da
  // chi lo monta. takeSize={false} sotto: il popup non ruba il size-lock
  // della sessione a chi sta sotto.
  const sendRef = useRef(() => {});
  const composerRef = useRef(() => false);
  const actionRef = useRef(() => {});
  const ctrlRef = useRef(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const tabs = [
    ['preview', t('cell-peek-preview')],
    ['stream', t('cell-peek-stream')],
    ...(row.panelUrl ? [['panel', t('cell-peek-panel')]] : []),
  ];
  return (
    <CellPopup
      title={row.cellName}
      subtitle={[row.nodeLabel, row.subtitle].filter(Boolean).join(' · ')}
      onClose={onClose}
    >
      {/* Le tre sorgenti in un contenitore solo: chi apre decide COSA
          guardare, il contenitore decide COME si chiude. */}
      <div className="nc-peek-sorgenti" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={source === id}
            className={`nc-peek-sorgente${source === id ? ' attiva' : ''}`}
            onClick={() => setSource(id)}>{label}</button>
        ))}
      </div>
      {source === 'stream' ? (
        <div className="nc-peek-stream">
          <Terminal
            key={`peek:${row.key}`}
            session={row.session} node={row.node || undefined} token={token}
            readonly={false} takeSize={false} focused
            sendRef={sendRef} composerRef={composerRef} actionRef={actionRef}
            ctrlRef={ctrlRef} setCtrlArmed={setCtrlArmed}
          />
        </div>
      ) : source === 'panel' ? (
        <CellPanel
          cellId={row.cellName}
          panelUrl={row.panelUrl}
          route={row.route || []}
          panelPort={panelPort}
          token={token}
          title={row.cellName}
        />
      ) : (
        <>
          <pre className="nc-peek-testo">{row.preview || t('cell-peek-vuoto')}</pre>
          {[formattaAttività(t, row.activity), formattaTelemetria(t, row.telemetry)].filter(Boolean).join(' · ')
            && <small className="nc-cell-switcher-telemetry">{[formattaAttività(t, row.activity), formattaTelemetria(t, row.telemetry)].filter(Boolean).join(' · ')}</small>}
        </>
      )}
    </CellPopup>
  );
}
