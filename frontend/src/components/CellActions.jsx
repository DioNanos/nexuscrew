import { useEffect, useRef } from 'react';
import { t } from '../lib/i18n.js';
import { cellStarView } from '../lib/cell-star.js';
import { hostRouteKey } from '../lib/host-designation.js';
import './CellActions.css';

// Le azioni di UNA cella come UN componente: Assegna/Togli la Live, Fissa/Togli
// in cima (pin), Avvio al boot (interruttore, capability 'boot'), Guarda dal
// vivo (solo cella viva). La LOGICA resta dove sta già: il pin passa da
// cell-star.js, la Live dal comando esplicito live-host-command.js invocato dal
// chiamante, il boot dalla stessa toggleBoot della superficie (Sidebar o
// SessionList). Qui c'è solo il menu e i suoi due gusci: popover desktop e
// foglio dal basso mobile.
//
// Stato derivato in un posto, puro: il chiamante passa la riga com'è, qui si
// decide che pin c'è (via cell-star) e se la cella È l'host Live (hostByRoute).
export function cellActionsState({ item, cellName, route = [], pins = [], hostByRoute = {} } = {}) {
  const star = cellStarView({ item, pins, hostByRoute, route });
  const host = (hostByRoute || {})[hostRouteKey(route)] || {};
  return {
    pinned: star.favorite,
    isLive: !!host.hostCell && host.hostCell === cellName,
  };
}

// La lista delle voci, pura: un'azione tolta (capability assente, cella spenta,
// handler non passato) NON è una voce disabilitata, non c'è — il controllo
// negativo è questo. Ogni voce porta il suo gesto, già legato.
export function cellActionsItems({ isLive, pinned, canBoot, boot, alive, handlers = {} } = {}) {
  const items = [];
  if (typeof handlers.onToggleLive === 'function') {
    items.push({ id: 'live', kind: 'action', on: !!isLive,
      labelKey: isLive ? 'cell-actions-live-remove' : 'cell-actions-live-assign',
      run: handlers.onToggleLive });
  }
  if (typeof handlers.onTogglePin === 'function') {
    items.push({ id: 'pin', kind: 'action', on: !!pinned,
      labelKey: pinned ? 'cell-actions-unpin' : 'cell-actions-pin',
      run: handlers.onTogglePin });
  }
  if (canBoot && typeof handlers.onToggleBoot === 'function') {
    items.push({ id: 'boot', kind: 'switch', on: !!boot,
      labelKey: 'cell-actions-boot',
      run: () => handlers.onToggleBoot(!boot) });
  }
  if (alive && typeof handlers.onWatchLive === 'function') {
    items.push({ id: 'watch', kind: 'action', on: false,
      labelKey: 'cell-actions-watch', run: handlers.onWatchLive });
  }
  return items;
}

// Il contenuto, condiviso dai due gusci. Il busy disabilita TUTTE le voci:
// un comando per volta sulla stessa cella, l'esito arriva dove il chiamante
// ha spazio (stessa regola del comando Live).
export function CellActionsMenu({ items = [], busy = false, onRun }) {
  return (
    <div className="nc-cellactions" role="menu" aria-busy={busy || undefined}>
      {items.map((entry) => {
        // La sottoriga e' OPZIONALE: chi non la passa rende il DOM di prima,
        // parola per parola. `descText` per un testo gia' risolto, `descKey`
        // per una chiave i18n.
        const desc = entry.descKey ? t(entry.descKey) : entry.descText;
        return (
          <button
            key={entry.id}
            type="button"
            role={entry.kind === 'switch' ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={entry.kind === 'switch' ? (entry.on ? 'true' : 'false') : undefined}
            className={`nc-cellactions-voce${entry.on ? ' on' : ''}`}
            disabled={busy}
            data-cellaction={entry.id}
            onClick={(event) => { event.stopPropagation(); onRun ? onRun(entry) : entry.run(); }}
          >
            {entry.kind === 'switch'
              ? <span className={`nc-cellactions-toggle${entry.on ? ' on' : ''}`} aria-hidden="true" />
              : null}
            <span className="nc-cellactions-testo">{t(entry.labelKey)}{desc ? <small className="nc-cellactions-desc">{desc}</small> : null}</span>
          </button>
        );
      })}
    </div>
  );
}

function usaChiusuraGuscio({ aperto, refGuscio, onClose }) {
  useEffect(() => {
    if (!aperto) return undefined;
    const fuori = (event) => {
      if (refGuscio.current && !refGuscio.current.contains(event.target)) onClose();
    };
    const fuga = (event) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', fuori);
    document.addEventListener('keydown', fuga);
    return () => {
      document.removeEventListener('pointerdown', fuori);
      document.removeEventListener('keydown', fuga);
    };
  }, [aperto, refGuscio, onClose]);
}

// Guscio desktop: popover ancorato al trigger (⋯). Il chiamante passa il
// rettangolo del trigger alla vista corrente; il popover non si sposta da solo.
export function CellActionsPopover({ anchorRect, items, busy, onClose }) {
  const refGuscio = useRef(null);
  usaChiusuraGuscio({ aperto: true, refGuscio, onClose });
  const stile = anchorRect ? {
    top: Math.min(anchorRect.bottom + 6, window.innerHeight - 8),
    left: Math.max(8, Math.min(anchorRect.right - 210, window.innerWidth - 218)),
  } : undefined;
  return (
    <div className="nc-cellactions-popover" style={stile} ref={refGuscio}
      data-testid="cell-actions-popover">
      <CellActionsMenu items={items} busy={busy} onRun={(entry) => { entry.run(); onClose(); }} />
    </div>
  );
}

// Guscio mobile: foglio dal basso, bersagli ≥ 44 px, backdrop che chiude.
export function CellActionsSheet({ cellName, items, busy, onClose }) {
  const refGuscio = useRef(null);
  usaChiusuraGuscio({ aperto: true, refGuscio, onClose });
  return (
    <div className="nc-cellactions-velo" data-testid="cell-actions-sheet">
      <div className="nc-cellactions-foglio" role="dialog" aria-modal="true"
        aria-label={t('cell-actions-title').replace('{cell}', cellName || '')} ref={refGuscio}>
        <div className="nc-cellactions-testa">
          <span className="nc-cellactions-titolo">{t('cell-actions-title').replace('{cell}', cellName || '')}</span>
          <button type="button" className="nc-cellactions-chiudi" onClick={onClose}
            title={t('close')} aria-label={t('close')}>✕</button>
        </div>
        <CellActionsMenu items={items} busy={busy} onRun={(entry) => { entry.run(); onClose(); }} />
      </div>
    </div>
  );
}
