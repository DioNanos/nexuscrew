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
export default function GridTile({ session, token, focused, onFocus, onClose, onOpenSingle, alive = true, fontSize = TILE_FONT_DEF, onZoom }) {
  const sendRef = useRef(() => {});
  const actionRef = useRef(() => {});
  const ctrlRef = useRef(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  const [showComposer, setShowComposer] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [filesEvent, setFilesEvent] = useState(null);

  return (
    <div
      className={`nc-tile${focused ? ' focused' : ''}`}
      onMouseDown={() => onFocus && onFocus(session)}
    >
      {/* L'header è la maniglia di drag: un tile APERTO si sposta nella
          griglia trascinandolo (stesso protocollo delle card sidebar). */}
      <div
        className="nc-tile-head"
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('text/nc-session', session);
          e.dataTransfer.effectAllowed = 'move';
        }}
      >
        <button className="nc-tile-name" onClick={() => onFocus && onFocus(session)}>
          <span className={alive ? 'nc-dot on' : 'nc-dot'} />
          <b>{session}</b>
        </button>
        <span className="nc-tile-actions">
          {onZoom && <button onClick={() => onZoom(-1)} title={t('zoom-out')}><Icon name="zoomOut" size={14} /></button>}
          {onZoom && <button onClick={() => onZoom(+1)} title={t('zoom-in')}><Icon name="zoomIn" size={14} /></button>}
          <button onClick={() => setShowComposer((v) => !v)} title="composer">⌨</button>
          <button onClick={() => setShowFiles((v) => !v)} title="file">📁</button>
          {onOpenSingle && <button onClick={() => onOpenSingle(session)} title="vista singola">↗</button>}
          {onClose && <button className="nc-tile-close" onClick={() => onClose(session)} title="chiudi">✕</button>}
        </span>
      </div>

      <div className="nc-tile-body">
        <Terminal
          session={session} token={token} readonly={false} takeSize={false}
          sendRef={sendRef} actionRef={actionRef} ctrlRef={ctrlRef} setCtrlArmed={setCtrlArmed}
          onFiles={setFilesEvent} fontSize={fontSize}
        />
        {showFiles && (
          <div className="nc-tile-files" onMouseDown={(e) => e.stopPropagation()}>
            <FilesPanel session={session} token={token} filesEvent={filesEvent} onClose={() => setShowFiles(false)} />
          </div>
        )}
      </div>

      {showComposer && (
        <div className="nc-tile-composer" onMouseDown={(e) => e.stopPropagation()}>
          <ComposerBar send={(seq) => sendRef.current(seq)} token={token} session={session} />
        </div>
      )}
    </div>
  );
}
