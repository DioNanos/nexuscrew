import { useRef, useState } from 'react';
import GridTile from './GridTile.jsx';
import {
  addTile, moveTile, removeTile, sessions, resizeColumn, resizeTile,
} from '../lib/grid-model.js';
import './GridView.css';

const MIN_W = 0.2;

// Griglia a colonne (flex). width/height dei tile = pesi flex (flex-grow).
// DnD nativo: drop su un tile -> split {col,row}; drop su gap/area vuota ->
// nuova colonna {col}. Divisori pointer ridimensionano i pesi (live).
export default function GridView({
  layout, onLayoutChange, token, sessionsAlive, focusSession, onFocus, onOpenSingle,
}) {
  const [drag, setDrag] = useState(null);            // {col} | {col,row}
  const gridRef = useRef(null);
  const colRefs = useRef([]);

  const ncols = layout.columns.length;

  const isSplit = (ci, ri) => drag && drag.col === ci && drag.row === ri;
  const isNewCol = (ci) => drag && drag.col === ci && drag.row === undefined;
  const isEnd = !!drag && drag.col === ncols;

  function onDrop(e) {
    e.preventDefault();
    const name = e.dataTransfer.getData('text/nc-session');
    const target = drag;
    setDrag(null);
    if (!name || !target) return;
    const drop = target.row !== undefined ? { col: target.col, row: target.row } : { col: target.col };
    onLayoutChange(sessions(layout).includes(name) ? moveTile(layout, name, drop) : addTile(layout, name, drop));
  }

  // --- resize larghezza colonna (divisore verticale tra col ci e ci+1) ---
  function startColResize(e, ci) {
    e.preventDefault(); e.stopPropagation();
    const startX = e.clientX;
    const startW = layout.columns[ci].width;
    const total = (gridRef.current && gridRef.current.clientWidth) || 1;
    const move = (ev) => {
      const w = Math.max(MIN_W, startW + (ev.clientX - startX) / total);
      onLayoutChange(resizeColumn(layout, ci, w));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // --- resize altezza tile (divisore orizzontale sopra il tile ri) ---
  function startRowResize(e, ci, ri) {
    e.preventDefault(); e.stopPropagation();
    const startY = e.clientY;
    const startH = layout.columns[ci].tiles[ri].height;
    const colEl = colRefs.current[ci];
    const total = (colEl && colEl.clientHeight) || 1;
    const move = (ev) => {
      const h = Math.max(MIN_W, startH + (ev.clientY - startY) / total);
      onLayoutChange(resizeTile(layout, ci, ri, h));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function closeTile(name) { onLayoutChange(removeTile(layout, name)); }

  return (
    <div
      className="nc-grid"
      ref={gridRef}
      onDragOver={(e) => {
        e.preventDefault();
        // area oltre le colonne / griglia vuota -> nuova colonna in coda
        if (!(drag && drag.col === ncols)) setDrag({ col: ncols });
      }}
      onDrop={onDrop}
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
              e.preventDefault(); e.stopPropagation();
              if (!(drag && drag.col === ci && drag.row === undefined)) setDrag({ col: ci });
            }}
          >
            {col.tiles.flatMap((tile, ri) => {
              const tnodes = [];
              tnodes.push(
                <div
                  key={tile.session}
                  className={`nc-tile-slot${isSplit(ci, ri) ? ' drop-split' : ''}`}
                  style={{ flexGrow: tile.height, flexBasis: 0 }}
                  onDragOver={(e) => {
                    e.preventDefault(); e.stopPropagation();
                    if (!(drag && drag.col === ci && drag.row === ri)) setDrag({ col: ci, row: ri });
                  }}
                >
                  <GridTile
                    session={tile.session} token={token}
                    focused={focusSession === tile.session}
                    onFocus={onFocus} onClose={closeTile} onOpenSingle={onOpenSingle}
                    alive={!sessionsAlive || sessionsAlive.has(tile.session)}
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
        <div className="nc-grid-empty">
          trascina qui una sessione dalla sidebar, o doppio-clic per la vista singola
        </div>
      )}
    </div>
  );
}
