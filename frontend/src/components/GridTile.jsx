import { useRef, useState } from 'react';
import Terminal from './Terminal.jsx';
import ComposerBar from './ComposerBar.jsx';
import FilesPanel from './FilesPanel.jsx';
import Icon from './Icon.jsx';
import { t } from '../lib/i18n.js';
import { TILE_FONT_DEF } from '../lib/grid-model.js';
import './GridTile.css';

// Un tile della griglia. Ogni tile ha i PROPRI ref (audit F6: mai condivisi
// tra tile — altrimenti l'input di uno finirebbe nel PTY di un altro).
// takeSize={false}: il tile non ridimensiona la sessione tmux (lo fa solo la
// vista singola / chi ha preso il size-lock); evita che 3 tile si contendano
// le dimensioni della stessa sessione.
// node (opzionale, B2): il tile porta con se' il nodo remoto — terminale via
// WS proxy, files/composer via HTTP proxy. Identita' del tile = refKey
// "node:session" (drag, focus, close), locale = solo nome (retrocompatibile).
export default function GridTile({ session, node, token, readonly = false, focused, onFocus, onClose, onOpenSingle, alive = true, fontSize = TILE_FONT_DEF, onZoom, decks = [], currentDeck, onSendToDeck }) {
  const sendRef = useRef(() => {});
  const composerRef = useRef(() => false);
  const actionRef = useRef(() => {});
  const ctrlRef = useRef(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [showComposer, setShowComposer] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [filesEvent, setFilesEvent] = useState(null);
  const tileKey = node ? `${node}:${session}` : session;

  return (
    <div
      className={`nc-tile${focused ? ' focused' : ''}`}
      onMouseDown={() => onFocus && onFocus(tileKey)}
    >
      {/* L'header è la maniglia di drag: un tile APERTO si sposta nella
          griglia trascinandolo (stesso protocollo delle card sidebar). */}
      <div
        className="nc-tile-head"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/nc-session', tileKey);
          e.dataTransfer.effectAllowed = 'move';
        }}
      >
        <button className="nc-tile-name" onClick={() => onFocus && onFocus(tileKey)}>
          <span className={alive ? 'nc-dot on' : 'nc-dot'} />
          <b>{session}</b>
          {node && <small className="nc-tile-node">@{node}</small>}
        </button>
        <span className="nc-tile-actions">
          {onZoom && <button onClick={() => onZoom(-1)} title={t('zoom-out')}><Icon name="zoomOut" size={14} /></button>}
          {onZoom && <button onClick={() => onZoom(+1)} title={t('zoom-in')}><Icon name="zoomIn" size={14} /></button>}
          {onSendToDeck && decks.filter((d) => d !== currentDeck).length > 0 && (
            <select
              className="nc-tile-deck"
              title={t('send-to-deck')}
              value=""
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(e) => { const d = e.target.value; if (d) onSendToDeck(tileKey, d); e.target.value = ''; }}
            >
              <option value="">{t('send-to-deck')}</option>
              {decks.filter((d) => d !== currentDeck).map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          )}
          <button onClick={() => setShowComposer((v) => !v)} title="composer">⌨</button>
          <button onClick={() => setShowFiles((v) => !v)} title="file">📁</button>
          {onOpenSingle && <button onClick={() => onOpenSingle({ session, node })} title="vista singola">↗</button>}
          {onClose && <button className="nc-tile-close" onClick={() => onClose(tileKey)} title="chiudi">✕</button>}
        </span>
      </div>

      <div className="nc-tile-body">
        <Terminal
          session={session} node={node} token={token} readonly={readonly} takeSize={false} focused={focused}
          sendRef={sendRef} composerRef={composerRef} actionRef={actionRef} ctrlRef={ctrlRef} setCtrlArmed={setCtrlArmed}
          onFiles={setFilesEvent} fontSize={fontSize}
        />
        {showFiles && (
          <div className="nc-tile-files" onMouseDown={(e) => e.stopPropagation()}>
            <FilesPanel session={session} node={node} token={token} filesEvent={filesEvent} onClose={() => setShowFiles(false)} />
          </div>
        )}
      </div>

      {showComposer && (
        <div className="nc-tile-composer" onMouseDown={(e) => e.stopPropagation()}>
          <ComposerBar submitText={(text) => composerRef.current(text)} token={token} session={session} node={node} />
        </div>
      )}
    </div>
  );
}
