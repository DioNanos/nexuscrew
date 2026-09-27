import { useEffect, useRef, useState } from 'react';
import GridTile from './GridTile.jsx';
import {
  addTile, moveTile, removeTile, sessions, resizeColumnCouple, resizeTileCouple, swapTiles,
  dropForQuadrant, zoomTile, refKey, MIN_COL_PX, MIN_ROW_PX, SNAP_POINTS, SNAP_PX,
} from '../lib/grid-model.js';
import { cellDisplayName, findManagedCell } from '../lib/cell-display.js';
import { panelPortForRoute } from '../lib/panel-port.js';
import { tileLifecycle } from '../lib/terminal-lifecycle.js';
import { t } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import './GridView.css';

const SIDE = 0.28; // fasce laterali left/right (28%)
const CENTER_Y = 0.3; // banda verticale del «centro = scambia» (30%..70%)
const transferHas = (transfer, type) => Array.from(transfer?.types || []).includes(type);
const isSessionTransfer = (transfer) => transferHas(transfer, 'text/nc-session');
const isFileTransfer = (transfer) => transferHas(transfer, 'Files') || (transfer?.files?.length || 0) > 0;

function nodeGroupForTile(node, groups) {
  return node && Array.isArray(groups)
    ? groups.find((group) => Array.isArray(group?.route) && group.route.join('/') === node)
    : null;
}

// Zone di spostamento: fasce laterali 28%, poi la zona centrale (28%..72% x
// 30%..70%) è «SCAMBIA», il resto metà top/bottom.
function quadrantOf(x, y, r) {
  const fx = (x - r.left) / (r.width || 1);
  const fy = (y - r.top) / (r.height || 1);
  if (fx < SIDE) return 'left';
  if (fx > 1 - SIDE) return 'right';
  if (fy >= CENTER_Y && fy <= 1 - CENTER_Y) return 'center';
  return fy < 0.5 ? 'top' : 'bottom';
}

// Griglia a colonne (flex). width/height dei tile = pesi flex (flex-grow).
// DnD nativo: drop su un tile -> split {col,row}; drop su gap/area vuota ->
// nuova colonna {col}. Divisori pointer ridimensionano i pesi (live).
export default function GridView({
  layout, onLayoutChange, token, readonly = false, sessionsAlive, focusSession, onFocus, onOpenSingle,
  // Il nodo LOCALE non ha un gruppo in nodeGroups: la sua autorevolezza e il
  // suo istante di lettura viaggiano come props, con la stessa semantica dei
  // gruppi remoti (verifiedAt). localIdentities: refKey -> `created`.
  localVerified = true, localIdentities = null, localVerifiedAt = null,
  decks = [], currentDeck, onSendToDeck,
  // Fine gesto di resize (pointerup/pointercancel/blur) — la griglia
  // chiede un salvataggio immediato invece di affidarsi al debounce.
  onResizeEnd,
  // Roster Fleet gia' caricato (Tranche D): usato per risolvere il titolo
  // visibile di ogni tile dal campo `cell`, senza fetch per-tile.
  cells = [], nodeGroups = [],
  // D8-griglia: stessa fonte della vista singola (App) per il pannello
  // per-cella — nessuna fetch propria, nessuna seconda fonte.
  panelPort = 0, nodePanelPorts = {},
}) {
  useLang();                                         // re-render allo switch lingua
  // Un solo orologio per l'intero render: il tetto del «non verificato» si
  // misura in secondi, e la griglia si ridisegna a ogni giro di poll (4 s),
  // quindi un istante letto qui e' fresco abbastanza da farlo scattare.
  const nowMs = Date.now();
  const [drag, setDrag] = useState(null);            // {col} | {col,row,quadrant} (+ from/ghost durante lo spostamento)
  const [gesture, setGesture] = useState(null);      // resize a coppia: anteprima live, applicata UNA volta al rilascio
  const gestureRef = useRef(null); gestureRef.current = gesture; // il done del gesto legge il live aggiornato
  const gridRef = useRef(null);
  const colRefs = useRef([]);
  const cleanupRef = useRef(null);                   // cleanup del drag-resize attivo

  // F1 audit: i listener globali del resize vanno staccati anche su
  // pointercancel/blur e se il componente smonta a metà drag. Col resize a
  // coppia il layout si applica SOLO a pointerup: cancel e blur ANNULLANO
  // (nessun onLayoutChange, nessun onResizeEnd), mai a metà gesto.
  function trackResize(move, done, cancel) {
    const off = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', stop);
      window.removeEventListener('blur', stop);
    };
    const up = () => { off(); cleanupRef.current = null; if (done) done(); };
    const stop = () => { off(); cleanupRef.current = null; if (cancel) cancel(); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('blur', stop);
    cleanupRef.current = stop;
  }
  useEffect(() => () => { if (cleanupRef.current) cleanupRef.current(); }, []);

  // Esc durante lo spostamento: l'anteprima sparisce e un eventuale drop
  // tardivo non fa nulla (drag null -> onDrop ritorna subito).
  useEffect(() => {
    if (!drag) return undefined;
    const esc = (e) => { if (e.key === 'Escape') setDrag(null); };
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('keydown', esc); };
  }, [drag]);

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
    // «centro = SCAMBIA»: le due finestre si scambiano di posto, geometria intatta.
    if (target.quadrant === 'center') {
      const destKey = refKey(layout.columns[target.col]?.tiles[target.row] || {});
      if (destKey && destKey !== name) onLayoutChange(swapTiles(layout, name, destKey));
      return;
    }
    let drop;
    if (target.quadrant) {
      drop = dropForQuadrant(layout, target.col, target.row, target.quadrant);
      if (!drop) return;
    } else {
      drop = { col: target.col };                    // sfondo/coda -> nuova colonna
    }
    onLayoutChange(sessions(layout).includes(name) ? moveTile(layout, name, drop) : addTile(layout, name, drop));
  }

  // --- resize a COPPIA in pixel (divisore verticale tra col ci e ci+1) ----
  // Il bordo segue il mouse 1:1; durante il gesto si mostra solo l'anteprima
  // (linea guida + badge), il layout — e il resize dei terminali — arriva
  // UNA volta al rilascio. Aggancio a 1/3 1/2 2/3 della coppia, Alt lo spegne.
  function startColResize(e, ci) {
    e.preventDefault(); e.stopPropagation();
    try { if (e.currentTarget.setPointerCapture && e.pointerId != null) e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* best-effort */ }
    const gridPx = (gridRef.current && gridRef.current.clientWidth) || 0;
    const ra = colRefs.current[ci] ? colRefs.current[ci].getBoundingClientRect() : null;
    const rb = colRefs.current[ci + 1] ? colRefs.current[ci + 1].getBoundingClientRect() : null;
    const coupleLeft = ra && rb && rb.right > ra.left ? ra.left : 0; // jsdom: rect piatti -> coppia da 0
    const startX = Number.isFinite(e.clientX) ? e.clientX : 0;
    const sumW = layout.columns[ci].width + (layout.columns[ci + 1]?.width || 0);
    const sumTot = layout.columns.reduce((s, c) => s + c.width, 0);
    const couplePx = (ra && rb && rb.right > ra.left) ? (rb.right - ra.left) : gridPx * (sumW / (sumTot || 1));
    const minPx = Math.min(MIN_COL_PX, couplePx / 2);
    const liveOf = (ev) => {
      const x = Number.isFinite(ev.clientX) ? ev.clientX : startX;
      let border = Math.max(minPx, Math.min(couplePx - minPx, x - coupleLeft));
      let snapped = false;
      if (!ev.altKey) {
        for (const s of SNAP_POINTS) {
          if (Math.abs(border - s * couplePx) <= SNAP_PX) { border = s * couplePx; snapped = true; break; }
        }
      }
      return { border, snapped, alt: ev.altKey === true };
    };
    setGesture({ kind: 'col', ci, coupleLeft, couplePx, live: liveOf(e) });
    trackResize(
      (ev) => setGesture((g) => (g ? { ...g, live: liveOf(ev) } : g)),
      () => { // pointerup: applica UNA volta sola, con l'ultimo live visto
        const g = gestureRef.current;
        const finale = g?.live?.border ?? couplePx / 2;
        setGesture(null);
        onLayoutChange(resizeColumnCouple(layout, ci, gridPx, finale, { snap: !(g?.live?.alt) }));
        if (onResizeEnd) onResizeEnd();
      },
      () => setGesture(null),                        // cancel/blur: annulla
    );
  }

  // Doppio clic sul divisore: la coppia torna a metà (50/50), un salvataggio.
  function doubleColResize(ci) {
    const gridPx = (gridRef.current && gridRef.current.clientWidth) || 0;
    onLayoutChange(resizeColumnCouple(layout, ci, gridPx, Number.NaN, { snap: true, half: true }));
    if (onResizeEnd) onResizeEnd();
  }

  // --- resize a coppia delle RIGHE (divisore orizzontale sopra il tile ri) --
  function startRowResize(e, ci, ri) {
    e.preventDefault(); e.stopPropagation();
    try { if (e.currentTarget.setPointerCapture && e.pointerId != null) e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* best-effort */ }
    const colEl = colRefs.current[ci];
    const gridPx = (colEl && colEl.clientHeight) || (gridRef.current && gridRef.current.clientHeight) || 0;
    const rr = colEl ? colEl.getBoundingClientRect() : null;
    const coupleTop = rr && rr.height > 0 ? rr.top : 0;
    const startY = Number.isFinite(e.clientY) ? e.clientY : 0;
    const tiles = layout.columns[ci].tiles;
    const sumH = tiles[ri].height + (tiles[ri + 1]?.height || 0);
    const sumTot = tiles.reduce((s, t) => s + t.height, 0);
    const couplePx = rr && rr.height > 0 ? gridPx * (sumH / (sumTot || 1)) : gridPx * (sumH / (sumTot || 1));
    const minPx = Math.min(MIN_ROW_PX, couplePx / 2);
    const liveOf = (ev) => {
      const y = Number.isFinite(ev.clientY) ? ev.clientY : startY;
      let border = Math.max(minPx, Math.min(couplePx - minPx, y - coupleTop));
      let snapped = false;
      if (!ev.altKey) {
        for (const s of SNAP_POINTS) {
          if (Math.abs(border - s * couplePx) <= SNAP_PX) { border = s * couplePx; snapped = true; break; }
        }
      }
      return { border, snapped, alt: ev.altKey === true };
    };
    setGesture({ kind: 'row', ci, ri, coupleTop, couplePx, live: liveOf(e) });
    trackResize(
      (ev) => setGesture((g) => (g ? { ...g, live: liveOf(ev) } : g)),
      () => {
        const g = gestureRef.current;
        const finale = g?.live?.border ?? couplePx / 2;
        setGesture(null);
        onLayoutChange(resizeTileCouple(layout, ci, ri, gridPx, finale, { snap: !(g?.live?.alt) }));
        if (onResizeEnd) onResizeEnd();
      },
      () => setGesture(null),
    );
  }

  function doubleRowResize(ci, ri) {
    const colEl = colRefs.current[ci];
    const gridPx = (colEl && colEl.clientHeight) || (gridRef.current && gridRef.current.clientHeight) || 0;
    onLayoutChange(resizeTileCouple(layout, ci, ri, gridPx, Number.NaN, { snap: true, half: true }));
    if (onResizeEnd) onResizeEnd();
  }

  function closeTile(name) { onLayoutChange(removeTile(layout, name)); }

  return (
    <div
      className={`nc-grid${gesture ? ' gesturing' : ''}`}
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
              const nodeGroup = nodeGroupForTile(tile.node, nodeGroups);
              // Un solo calcolo di stato per tile, da cui derivano sia il
              // pallino di testa sia la decisione sulla generazione: due
              // letture divergenti della stessa cosa erano il difetto.
              const presenza = tileLifecycle({
                tileKey: key, node: tile.node, nodeGroups, sessionsAlive,
                localVerified, localIdentita: localIdentities ? localIdentities.get(key) : null,
                lastVerifiedAt: tile.node ? (nodeGroup?.verifiedAt ?? null) : localVerifiedAt,
                nowMs,
              });
              const nodeOnline = tile.unavailable !== true && (
                tile.node ? nodeGroup?.status === 'up' : presenza.owner === 'ok'
              );
              const sessionAlive = tile.unavailable !== true
                && presenza.presenza !== 'assente-verificata';
              // Cella Fleet gestita per questo tile (route + ownerId + tmuxSession),
              // risolta una sola volta: titolo visibile e pannello per-cella
              // condividono lo stesso lookup, mai due fonti divergenti.
              const managedCell = findManagedCell({
                session: tile.session, node: tile.node, ownerId: tile.ownerId,
                cells, nodeGroups,
              });
              // Titolo visibile del tile dal campo Fleet `cell` (es. `Dev`):
              // route/tmuxSession restano identita' tecniche, non in titolo.
              const cellName = cellDisplayName({
                session: tile.session, cell: managedCell, node: tile.node, ownerId: tile.ownerId,
                cells, nodeGroups,
              });
              // D8-griglia: stesso contratto della vista singola — panelUrl
              // opzionale e gia' validato a monte, si consuma senza ri-validare.
              const panelUrl = typeof managedCell?.panelUrl === 'string' ? managedCell.panelUrl.trim() : '';
              const panelCellId = typeof managedCell?.cell === 'string' ? managedCell.cell : '';
              tnodes.push(
                <div
                  key={key}
                  className={`nc-tile-slot${dropClass(ci, ri)}${drag && drag.from === key ? ' nc-tile-source' : ''}`}
                  style={{ flexGrow: tile.height, flexBasis: 0 }}
                  onDragOver={(e) => {
                    if (!isSessionTransfer(e.dataTransfer)) return;
                    e.preventDefault(); e.stopPropagation();
                    const q = quadrantOf(e.clientX, e.clientY, e.currentTarget.getBoundingClientRect());
                    if (!(drag && drag.col === ci && drag.row === ri && drag.quadrant === q)) {
                      setDrag({ col: ci, row: ri, quadrant: q, from: drag?.from, ghost: { x: e.clientX, y: e.clientY } });
                    }
                  }}
                >
                  <GridTile
                    session={tile.session} node={tile.node} ownerId={tile.ownerId} cellName={cellName} token={token} readonly={readonly}
                    focused={focusSession === key}
                    onFocus={onFocus} onClose={closeTile} onOpenSingle={onOpenSingle}
                    onDragTileStart={(k) => setDrag((d) => (d ? { ...d, from: k } : { from: k }))}
                    available={tile.unavailable !== true}
                    stale={tile.stale === true}
                    alive={nodeOnline}
                    sessionAlive={sessionAlive}
                    presence={presenza}
                    fontSize={tile.fontSize}
                    onZoom={(delta) => onLayoutChange(zoomTile(layout, ci, ri, delta))}
                    decks={decks} currentDeck={currentDeck} onSendToDeck={onSendToDeck}
                    panelUrl={panelUrl} panelCellId={panelCellId}
                    panelPort={panelPortForRoute(tile.node ? tile.node.split('/') : [], nodePanelPorts, panelPort)}
                  />
                </div>,
              );
              if (ri < col.tiles.length - 1) {
                tnodes.push(
                  <div key={`h${ri}`}
                    className={`nc-divider-h${gesture && gesture.kind === 'row' && gesture.ci === ci && gesture.ri === ri ? ' dragging' : ''}`}
                    title={t('grid-resize-rows')}
                    onPointerDown={(e) => startRowResize(e, ci, ri)}
                    onDoubleClick={() => doubleRowResize(ci, ri)} />,
                );
              }
              return tnodes;
            })}
          </div>,
        );
        if (ci < ncols - 1) {
          nodes.push(
            <div key={`v${ci}`}
              className={`nc-divider-v${gesture && gesture.kind === 'col' && gesture.ci === ci ? ' dragging' : ''}`}
              title={t('grid-resize-cols')}
              onPointerDown={(e) => startColResize(e, ci)}
              onDoubleClick={() => doubleColResize(ci)} />,
          );
        }
        return nodes;
      })}

      {/* Gesto di resize attivo: scudo che copre terminali e iframe (nessun
          gesto perso, nessuna selezione di testo), linea guida che segue il
          mouse 1:1 — tratteggiata quando è agganciata a 1/3 1/2 2/3 — e badge
          con le misure in px dei due lati della coppia. */}
      {gesture && <div className={`nc-gesture-shield ${gesture.kind === 'col' ? 'col' : 'row'}`} data-testid="nc-gesture-shield" />}
      {gesture && gesture.kind === 'col' && (
        <div className={`nc-gesture-guide v${gesture.live.snapped ? ' snap' : ''}`} data-testid="nc-gesture-guide"
          style={{ left: gesture.coupleLeft + gesture.live.border }} />
      )}
      {gesture && gesture.kind === 'row' && (
        <div className={`nc-gesture-guide h${gesture.live.snapped ? ' snap' : ''}`} data-testid="nc-gesture-guide"
          style={{ top: gesture.coupleTop + gesture.live.border }} />
      )}
      {gesture && (
        <div className="nc-gesture-badge" data-testid="nc-gesture-badge"
          style={gesture.kind === 'col'
            ? { left: gesture.coupleLeft + gesture.live.border, top: '50%' }
            : { top: gesture.coupleTop + gesture.live.border, left: '50%' }}>
          {`${Math.round(gesture.live.border)} px · ${Math.round(gesture.couplePx - gesture.live.border)} px`}
        </div>
      )}

      {/* Spostamento: copia semitrasparente che segue il mouse. */}
      {drag && drag.from && drag.ghost && (
        <div className="nc-drag-ghost" data-testid="nc-drag-ghost" style={{ left: drag.ghost.x, top: drag.ghost.y }}>
          {drag.from}
        </div>
      )}

      {isEnd && <div className="nc-drop-line-v nc-drop-line-end" />}

      {ncols === 0 && (
        <div className="nc-grid-empty">{t('grid-empty')}</div>
      )}
    </div>
  );
}
