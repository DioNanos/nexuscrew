import { useEffect, useRef, useState } from 'react';
import GridTile from './GridTile.jsx';
import {
  addTile, moveTile, removeTile, sessions, resizeColumn, resizeTile,
  dropForQuadrant, snapFraction, zoomTile, refKey,
} from '../lib/grid-model.js';
import { t } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import './GridView.css';

const MIN_W = 0.2;
const SIDE = 0.28; // fasce laterali left/right (28%)
const transferHas = (transfer, type) => Array.from(transfer?.types || []).includes(type);
const isSessionTransfer = (transfer) => transferHas(transfer, 'text/nc-session');
const isFileTransfer = (transfer) => transferHas(transfer, 'Files') || (transfer?.files?.length || 0) > 0;

// Quadrante dal puntatore vs bounding box: fasce laterali 28%, altrimenti metà top/bottom.
function quadrantOf(x, y, r) {
  const fx = (x - r.left) / (r.width || 1);
  const fy = (y - r.top) / (r.height || 1);
  if (fx < SIDE) return 'left';
  if (fx > 1 - SIDE) return 'right';
  return fy < 0.5 ? 'top' : 'bottom';
}

// Griglia a colonne (flex). width/height dei tile = pesi flex (flex-grow).
// DnD nativo: drop su un tile -> split {col,row}; drop su gap/area vuota ->
// nuova colonna {col}. Divisori pointer ridimensionano i pesi (live).
export default function GridView({
  layout, onLayoutChange, token, readonly = false, sessionsAlive, focusSession, onFocus, onOpenSingle,
  decks = [], currentDeck, onSendToDeck,
}) {
  useLang();                                         // re-render allo switch lingua
  const [drag, setDrag] = useState(null);            // {col} | {col,row,quadrant}
  const gridRef = useRef(null);
  const colRefs = useRef([]);
  const cleanupRef = useRef(null);                   // cleanup del drag-resize attivo

  // F1 audit: i listener globali del resize vanno staccati anche su
  // pointercancel/blur e se il componente smonta a metà drag.
  function trackResize(move, done) {
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      window.removeEventListener('blur', up);
      cleanupRef.current = null;
      if (done) done();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('blur', up);
    cleanupRef.current = up;
  }
  useEffect(() => () => { if (cleanupRef.current) cleanupRef.current(); }, []);

  // F2 audit: drag abortito (esce dalla griglia / dragend senza drop) non
  // deve lasciare l'anteprima appesa.
  useEffect(() => {
    const end = () => setDrag(null);
    window.addEventListener('dragend', end);
    window.addEventListener('drop', end);
    return () => { window.removeEventListener('dragend', end); window.removeEventListener('drop', end); };
  }, []);

  const ncols = layout.columns.length;

  const isNewCol = (ci) => drag && drag.col === ci && drag.row === undefined;
  const isEnd = !!drag && drag.col === ncols;
  const dropClass = (ci, ri) => (drag && drag.col === ci && drag.row === ri && drag.quadrant)
    ? ` drop-${drag.quadrant}` : '';

  function onDrop(e) {
    e.preventDefault();
    if (isFileTransfer(e.dataTransfer)) { setDrag(null); return; }
    const name = e.dataTransfer.getData('text/nc-session');
    const target = drag;
    setDrag(null);
    if (!name || !target) return;
    let drop;
    if (target.quadrant) {
      drop = dropForQuadrant(layout, target.col, target.row, target.quadrant);
      if (!drop) return;
    } else {
      drop = { col: target.col };                    // sfondo/coda -> nuova colonna
    }
    onLayoutChange(sessions(layout).includes(name) ? moveTile(layout, name, drop) : addTile(layout, name, drop));
  }

  // --- resize larghezza colonna (divisore verticale tra col ci e ci+1) ---
  function startColResize(e, ci) {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX;
    const startW = layout.columns[ci].width;
    const total = (gridRef.current && gridRef.current.clientWidth) || 1;
    const nb = layout.columns[ci + 1];               // vicino: binomio ci|ci+1
    const move = (ev) => {
      let w = Math.max(MIN_W, startW + (ev.clientX - startX) / total);
      if (nb) { const f = snapFraction(w / (w + nb.width)); w = (f / (1 - f)) * nb.width; }
      onLayoutChange(resizeColumn(layout, ci, w));
    };
    trackResize(move);
  }

  // --- resize altezza tile (divisore orizzontale sopra il tile ri) ---
  function startRowResize(e, ci, ri) {
    e.preventDefault(); e.stopPropagation();
    const startY = e.clientY;
    const startH = layout.columns[ci].tiles[ri].height;
    const colEl = colRefs.current[ci];
    const total = (colEl && colEl.clientHeight) || 1;
    const nb = layout.columns[ci].tiles[ri + 1];     // vicino: binomio ri|ri+1
    const move = (ev) => {
      let h = Math.max(MIN_W, startH + (ev.clientY - startY) / total);
      if (nb) { const f = snapFraction(h / (h + nb.height)); h = (f / (1 - f)) * nb.height; }
      onLayoutChange(resizeTile(layout, ci, ri, h));
    };
    trackResize(move);
  }

  function closeTile(name) { onLayoutChange(removeTile(layout, name)); }

  return (
    <div
      className="nc-grid"
      ref={gridRef}
      onDragOver={(e) => {
        if (isFileTransfer(e.dataTransfer)) { e.preventDefault(); setDrag(null); return; }
        if (!isSessionTransfer(e.dataTransfer)) return;
        e.preventDefault();
        // area oltre le colonne / griglia vuota -> nuova colonna in coda
        if (!(drag && drag.col === ncols)) setDrag({ col: ncols });
      }}
      onDrop={onDrop}
      onDragLeave={(e) => {
        // reset SOLO se il puntatore esce davvero dalla griglia
        const to = e.relatedTarget;
        if (!to || !(gridRef.current && gridRef.current.contains(to))) setDrag(null);
      }}
    >
      {layout.columns.flatMap((col, ci) => {
        const nodes = [];
        nodes.push(
          <div
            key={`c${ci}`}
            className={`nc-col${isNewCol(ci) ? ' drop-newcol' : ''}`}
            ref={(el) => { colRefs.current[ci] = el; }}
            style={{ flexGrow: col.width, flexBasis: 0 }}
            onDragOver={(e) => {
              if (!isSessionTransfer(e.dataTransfer)) return;
              e.preventDefault(); e.stopPropagation();
              if (!(drag && drag.col === ci && drag.row === undefined)) setDrag({ col: ci });
            }}
          >
            {col.tiles.flatMap((tile, ri) => {
              const tnodes = [];
              const key = refKey(tile);
              tnodes.push(
                <div
                  key={key}
                  className={`nc-tile-slot${dropClass(ci, ri)}`}
                  style={{ flexGrow: tile.height, flexBasis: 0 }}
                  onDragOver={(e) => {
                    if (!isSessionTransfer(e.dataTransfer)) return;
                    e.preventDefault(); e.stopPropagation();
                    const q = quadrantOf(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
                    if (!(drag && drag.col === ci && drag.row === ri && drag.quadrant === q)) setDrag({ col: ci, row: ri, quadrant: q });
                  }}
                >
                  <GridTile
                    session={tile.session} node={tile.node} token={token} readonly={readonly}
                    focused={focusSession === key}
                    onFocus={onFocus} onClose={closeTile} onOpenSingle={onOpenSingle}
                    available={tile.unavailable !== true}
                    alive={tile.unavailable !== true && (!sessionsAlive || sessionsAlive.has(key))}
                    fontSize={tile.fontSize}
                    onZoom={(delta) => onLayoutChange(zoomTile(layout, ci, ri, delta))}
                    decks={decks} currentDeck={currentDeck} onSendToDeck={onSendToDeck}
                  />
                </div>,
              );
              if (ri < col.tiles.length - 1) {
                tnodes.push(
                  <div key={`h${ri}`} className="nc-divider-h" onPointerDown={(e) => startRowResize(e, ci, ri)} />,
                );
              }
              return tnodes;
            })}
          </div>,
        );
        if (ci < ncols - 1) {
          nodes.push(
            <div key={`v${ci}`} className="nc-divider-v" onPointerDown={(e) => startColResize(e, ci)} />,
          );
        }
        return nodes;
      })}

      {isEnd && <div className="nc-drop-line-v nc-drop-line-end" />}

      {ncols === 0 && (
        <div className="nc-grid-empty">{t('grid-empty')}</div>
      )}
    </div>
  );
}
