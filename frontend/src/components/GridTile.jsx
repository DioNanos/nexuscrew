import { useEffect, useRef, useState } from 'react';
import Terminal from './Terminal.jsx';
import ComposerBar from './ComposerBar.jsx';
import FilesPanel from './FilesPanel.jsx';
import CellPanel from './CellPanel.jsx';
import CellPopup from './CellPopup.jsx';
import Icon from './Icon.jsx';
import { t } from '../lib/i18n.js';
import { TILE_FONT_DEF } from '../lib/grid-model.js';
import { advanceTileRuntime, initialTileRuntime, PRESENZA } from '../lib/terminal-lifecycle.js';
import { useInputPreferences } from '../hooks/useInputPreferences.js';
import './GridTile.css';

// Un tile della griglia. Ogni tile ha i PROPRI ref (mai condivisi
// tra tile — altrimenti l'input di uno finirebbe nel PTY di un altro).
// takeSize: false per i tile in griglia (il size-lock sta alla vista singola:
// 3 tile non si contendono la geometria tmux); TRUE per ogni finestra staccata,
// fisso finche' resta staccata. E' un'opzione di attach del PTY: cambiarlo
// riconnette il terminale, quindi non segue MAI il focus (solo stacca/riattacca).
// node (opzionale, B2): il tile porta con se' il nodo remoto — terminale via
// WS proxy, files/composer via HTTP proxy. Identita' del tile = refKey
// "node:session" (drag, focus, close), locale = solo nome (retrocompatibile).
// cellName (Tranche D): titolo visibile risolto dal campo Fleet `cell` (es.
// `Dev`). node/route/tmuxSession restano identita' tecniche e non compaiono
// nel titolo visibile; solo il tooltip porta un identificativo tecnico.
export default function GridTile({ session, node, ownerId, cellName, token, readonly = false, focused, onFocus, onClose, onOpenSingle, onDragTileStart, floating = false, minimized = false, takeSize = false, onDetach, onReattach, onToggleMinimize, onFloatDragStart, alive = true, sessionAlive = alive, available = true, stale = false, presence = null, fontSize = TILE_FONT_DEF, onZoom, decks = [], currentDeck, onSendToDeck, panelUrl = '', panelCellId = '', panelPort = 0 }) {
  const [inputPreferences] = useInputPreferences();
  // Titolo visibile = nome logico Fleet (gestita) o nome sessione (unmanaged).
  // session (tmuxSession reale) resta l'identita' del tile per attach/drag.
  const visibleName = cellName || session;
  const sendRef = useRef(() => {});
  const composerRef = useRef(() => false);
  const actionRef = useRef(() => {});
  const ctrlRef = useRef(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [showComposer, setShowComposer] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  // D8-griglia: il pannello si apre dentro CellPopup (contenitore condiviso
  // con lista/live/vista singola) — non un overlay proprio della tile. Sotto
  // resta tutto montato: griglia, terminale di questa tile, le altre tile.
  // Opt-in totale via panelUrl, stesso contratto della vista singola.
  const [showPanel, setShowPanel] = useState(false);
  const [filesEvent, setFilesEvent] = useState(null);
  const [terminalGeneration, setTerminalGeneration] = useState(0);
  const runtimeRef = useRef(initialTileRuntime());
  const tileKey = node ? `${node}:${session}` : session;
  const deckTargets = decks.filter((deck) => deck.id !== currentDeck && deck.available !== false);

  // `alive` is the node-health indicator. Solo due cose possono creare una
  // nuova generazione xterm/socket: un'assenza VERIFICATA seguita dal ritorno,
  // oppure un cambio di identita' verificato fra due letture autorevoli. Un
  // nodo che ondeggia, una lettura caduta, un owner che sparisce dalla
  // topologia non distruggono il buffer: lo stato lo decide `tileLifecycle`,
  // qui si applica soltanto.
  const presenzaStato = presence ? presence.presenza : (sessionAlive ? PRESENZA.PRESENTE : PRESENZA.ASSENTE);
  const presenzaIdentita = presence ? (presence.identita ?? null) : null;
  useEffect(() => {
    const esito = advanceTileRuntime(runtimeRef.current, {
      presenza: presenzaStato, identita: presenzaIdentita,
    });
    runtimeRef.current = esito.runtime;
    if (esito.generazione) setTerminalGeneration((value) => value + esito.generazione);
  }, [presenzaStato, presenzaIdentita]);

  return (
    <div
      className={`nc-tile${focused ? ' focused' : ''}`}
      onMouseDown={() => onFocus && onFocus(tileKey)}
    >
      {/* L'header è la maniglia di drag: un tile APERTO si sposta nella
          griglia trascinandolo (stesso protocollo delle card sidebar).
          onDragTileStart dice alla griglia CHIE sta spostando: copia che
          segue il mouse e posto di provenienza tratteggiato. */}
      <div
        className={`nc-tile-head${floating ? ' nc-float-head' : ''}`}
        draggable={!floating}
        // I tasti della barra (riattacca, riduci, ×) NON sono maniglia: uno
        // spostamento avviato qui catturerebbe il puntatore e il click non
        // arriverebbe mai al tasto.
        onPointerDown={floating && onFloatDragStart ? (e) => {
          if (e.target && e.target.closest && e.target.closest('.nc-tile-actions')) return;
          onFloatDragStart(e);
        } : undefined}
        onDragStart={(e) => {
          if (floating) return;
          e.dataTransfer.setData('text/nc-session', tileKey);
          e.dataTransfer.effectAllowed = 'move';
          if (onDragTileStart) onDragTileStart(tileKey);
        }}
      >
        <button className="nc-tile-name" onClick={() => onFocus && onFocus(tileKey)} title={node ? `${visibleName} · ${node}` : visibleName}>
          <span className={alive ? 'nc-dot on' : 'nc-dot'} />
          <b>{visibleName}</b>
        </button>
        <span className="nc-tile-actions">
          {floating ? (
            <>
              {onReattach && (
                <button className="nc-tile-float-btn" onClick={() => onReattach(tileKey)} title={t('tile-reattach')} aria-label={t('tile-reattach')}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="3" width="12" height="12" rx="1"></rect><path d="M11 21H3v-8M3 21l9-9"></path></svg>
                </button>
              )}
              {onToggleMinimize && (
                <button onClick={() => onToggleMinimize(tileKey)} title={minimized ? t('tile-restore') : t('tile-minimize')} aria-label={minimized ? t('tile-restore') : t('tile-minimize')}>–</button>
              )}
            </>
          ) : (
            <>
              {onZoom && <button onClick={() => onZoom(-1)} title={t('zoom-out')} aria-label={t('zoom-out')}><Icon name="zoomOut" size={14} /></button>}
          {onZoom && <button onClick={() => onZoom(+1)} title={t('zoom-in')} aria-label={t('zoom-in')}><Icon name="zoomIn" size={14} /></button>}
          {onSendToDeck && deckTargets.length > 0 && (
            <select
              className="nc-tile-deck"
              title={t('send-to-deck')}
              value=""
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(e) => { const d = e.target.value; if (d) onSendToDeck(tileKey, d); e.target.value = ''; }}
            >
              <option value="">{t('send-to-deck')}</option>
              {deckTargets.map((deck) => (
                <option key={deck.id} value={deck.id}>{deck.ownerLabel} · {deck.name}</option>
              ))}
            </select>
          )}
          <button onClick={() => setShowComposer((v) => !v)} title={t('composer')}>⌨</button>
          <button onClick={() => setShowFiles((v) => !v)} title={t('files')}>📁</button>
          {panelUrl && (
            <button onClick={() => setShowPanel((v) => !v)} title={t('panel')} aria-pressed={showPanel}><Icon name="monitor" size={14} /></button>
          )}
          {onOpenSingle && <button onClick={() => onOpenSingle({ session, node, ownerId })} title={t('single-view')}>↗</button>}
            </>
          )}
          {!floating && onDetach && (
            <button className="nc-tile-float-btn" onClick={() => onDetach(tileKey)} title={t('tile-detach')} aria-label={t('tile-detach')}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="9" width="12" height="12" rx="1"></rect><path d="M13 3h8v8M21 3l-9 9"></path></svg>
            </button>
          )}
          {onClose && <button className="nc-tile-close" onClick={() => onClose(tileKey)} title={t('close')} aria-label={t('close')}>✕</button>}
        </span>
      </div>

      <div className="nc-tile-body">
        {/* Il dato è vecchio: lo si DICHIARA e basta. Il terminale non si
            tocca — è proprio quando non si sa più niente della sessione che
            distruggere il buffer sarebbe il danno peggiore. */}
        {presence && presence.oltreIlTetto === true && (
          <div className="nc-tile-unverified" role="status" data-causa={presence.causa || ''}>
            {t('tile-unverified')}
          </div>
        )}
        {/* Il terminale resta SEMPRE montato: la disponibilità dell'owner non
            è un motivo per distruggere il buffer xterm. L'indisponibilità è
            un overlay SOPRA il contenuto, mai un sostituto. */}
        <Terminal
          key={`${tileKey}:${terminalGeneration}`}
          session={session} node={node} token={token} readonly={readonly} takeSize={takeSize} focused={focused}
          sendRef={sendRef} composerRef={composerRef} actionRef={actionRef} ctrlRef={ctrlRef} setCtrlArmed={setCtrlArmed}
          onFiles={setFilesEvent} fontSize={fontSize}
          keyboardGesture={inputPreferences.terminalKeyboardGesture}
        />
        {!available && (
          <div className="nc-tile-unavailable" title={t('deck-owner-unavailable')}>
            {t('deck-owner-reconnecting')}
          </div>
        )}
        {available && stale && (
          <div className="nc-tile-stale" title={t('deck-owner-stale')}>{t('deck-owner-stale')}</div>
        )}
        {available && showFiles && (
          <div className="nc-tile-files" onMouseDown={(e) => e.stopPropagation()}>
            <FilesPanel session={session} node={node} token={token} filesEvent={filesEvent} onClose={() => setShowFiles(false)} />
          </div>
        )}
      </div>

      {available && showComposer && (
        <div className="nc-tile-composer" onMouseDown={(e) => e.stopPropagation()}>
          <ComposerBar submitText={(text) => composerRef.current(text)} token={token} session={session} node={node} ownerId={ownerId} readonly={readonly}
            keepKeyboardClosedOnVoice={inputPreferences.voiceKeepsKeyboardClosed} />
        </div>
      )}

      {/* D8-griglia: CellPopup e' un modale fixed a schermo intero — la griglia
          e il terminale di questa tile restano montati sotto, invariati. */}
      {available && showPanel && panelUrl && panelCellId && (
        <CellPopup title={visibleName} onClose={() => setShowPanel(false)}>
          <CellPanel
            cellId={panelCellId}
            panelUrl={panelUrl}
            route={node ? node.split('/') : []}
            panelPort={panelPort}
            token={token}
            title={visibleName}
          />
        </CellPopup>
      )}
    </div>
  );
}
