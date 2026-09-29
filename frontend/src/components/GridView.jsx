import { useEffect, useRef, useState } from 'react';
import GridTile from './GridTile.jsx';
import {
  addTile, moveTile, removeTile, sessions, resizeColumnCouple, resizeTileCouple, swapTiles,
  detachTile, reattachTile, updateFloatGeom, MAX_FLOATING,
  dropForQuadrant, zoomTile, refKey, MIN_COL_PX, MIN_ROW_PX, SNAP_POINTS, SNAP_PX, TILE_FONT_DEF,
} from '../lib/grid-model.js';
import { cellDisplayName, findManagedCell } from '../lib/cell-display.js';
import { panelPortForRoute } from '../lib/panel-port.js';
import { tileLifecycle } from '../lib/terminal-lifecycle.js';
import { t } from '../lib/i18n.js';
import { useLang } from '../hooks/useLang.js';
import './GridView.css';

const SIDE = 0.22; // fasce laterali left/right (22%, come il design)
const CENTER_Y = 0.3; // banda verticale del «centro = scambia» (30%..70%)
const transferHas = (transfer, type) => Array.from(transfer?.types || []).includes(type);
const isSessionTransfer = (transfer) => transferHas(transfer, 'text/nc-session');
const isFileTransfer = (transfer) => transferHas(transfer, 'Files') || (transfer?.files?.length || 0) > 0;

function nodeGroupForTile(node, groups) {
  return node && Array.isArray(groups)
    ? groups.find((group) => Array.isArray(group?.route) && group.route.join('/') === node)
    : null;
}

// Zone di spostamento come il design: fasce laterali 22%, in mezzo alto e
// basso al 30%, centro (22%..78% x 30%..70%) = «SCAMBIA».
function quadrantOf(x, y, r) {
  const fx = (x - r.left) / (r.width || 1);
  const fy = (y - r.top) / (r.height || 1);
  if (fx < SIDE) return 'left';
  if (fx > 1 - SIDE) return 'right';
  if (fy >= CENTER_Y && fy <= 1 - CENTER_Y) return 'center';
  return fy < 0.5 ? 'top' : 'bottom';
}

// Le cinque zone della finestra di arrivo, disegnate tutte insieme mentre ci
// passi sopra: frecce ai bordi, scambio al centro (tracciati del design).
const ZONE = [
  ['left', 'M15 6l-6 6 6 6', 22],
  ['top', 'M6 15l6-6 6 6', 22],
  ['center', 'M4 8h16M20 8l-3-3M20 8l-3 3M20 16H4M4 16l3-3M4 16l3 3', 34],
  ['bottom', 'M6 9l6 6 6-6', 22],
  ['right', 'M9 6l6 6-6 6', 22],
];
function DropZones({ active }) {
  return (
    <div className="nc-drop-zones" data-testid="nc-drop-zones" aria-hidden="true">
      {ZONE.map(([nome, d, size]) => (
        <div key={nome} className={`nc-drop-zone ${nome}${active === nome ? ' on' : ''}`} data-zone={nome}>
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d={d} /></svg>
        </div>
      ))}
    </div>
  );
}

// Geometria/font del tile flottante con quella key (o null).
function floatGeomOf(layout, key) {
  for (const c of layout.columns) {
    for (const t of c.tiles) if (refKey(t) === key) return t.float || null;
  }
  return null;
}
function floatFontOf(layout, key) {
  for (const c of layout.columns) {
    for (const t of c.tiles) if (refKey(t) === key) return t.fontSize || null;
  }
  return null;
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
  // Finestre flottanti: z-order/focus/minimizzazione per dispositivo (vista,
  // non documento: non viaggiano nel deck). floatGesture = drag/resize attivo.
  const [floatUi, setFloatUi] = useState({ z: {}, next: 1, focus: null, mini: {} });
  const [floatGesture, setFloatGesture] = useState(null);
  const floatGestureRef = useRef(null); floatGestureRef.current = floatGesture;
  const gridRef = useRef(null);
  const colRefs = useRef([]);
  const cleanupRef = useRef(null);                   // cleanup del drag-resize attivo

  // I listener globali del resize vanno staccati anche su
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
  // tardivo non fa nulla (drag null -> onDrop ritorna subito). Esc durante un
  // gesto flottante lo ANNULLA: chiude i listener col cancel, nessun commit.
  useEffect(() => {
    if (!drag && !floatGesture) return undefined;
    const esc = (e) => {
      if (e.key !== 'Escape') return;
      setDrag(null);
      if (floatGesture && cleanupRef.current) cleanupRef.current();
    };
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('keydown', esc); };
  }, [drag, floatGesture]);

  // Un drag abortito (esce dalla griglia / dragend senza drop) non
  // deve lasciare l'anteprima appesa.
  useEffect(() => {
    const end = () => setDrag(null);
    window.addEventListener('dragend', end);
    window.addEventListener('drop', end);
    return () => { window.removeEventListener('dragend', end); window.removeEventListener('drop', end); };
  }, []);

  const ncols = layout.columns.length;
  const floatingKeys = layout.columns.flatMap((c) => c.tiles).filter((t) => t.float).map((t) => refKey(t));
  // Colonna i cui tile sono tutti staccati: non occupa spazio nella griglia.
  const tuttaFlottante = (col) => !!col && col.tiles.length > 0 && col.tiles.every((t) => t.float);

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
    // Le coordinate della guida sono RELATIVE alla griglia: il rect dei
    // col è in coordinate viewport e senza sottrarre l'origine della griglia
    // la linea scattava della larghezza di sidebar + barra deck.
    const gRect = gridRef.current ? gridRef.current.getBoundingClientRect() : null;
    const originLeft = gRect ? gRect.left : 0;
    const ra = colRefs.current[ci] ? colRefs.current[ci].getBoundingClientRect() : null;
    const rb = colRefs.current[ci + 1] ? colRefs.current[ci + 1].getBoundingClientRect() : null;
    const coupleLeft = ra && rb && rb.right > ra.left ? ra.left - (gRect ? gRect.left : 0) : 0; // jsdom: rect piatti -> coppia da 0
    const startX = Number.isFinite(e.clientX) ? e.clientX : 0;
    const sumW = layout.columns[ci].width + (layout.columns[ci + 1]?.width || 0);
    const sumTot = layout.columns.reduce((s, c) => s + c.width, 0);
    const couplePx = (ra && rb && rb.right > ra.left) ? (rb.right - ra.left) : gridPx * (sumW / (sumTot || 1));
    const minPx = Math.min(MIN_COL_PX, couplePx / 2);
    const liveOf = (ev) => {
      const x = (Number.isFinite(ev.clientX) ? ev.clientX : startX) - originLeft;
      let border = Math.max(minPx, Math.min(couplePx - minPx, x - coupleLeft));
      let snapped = false;
      if (!ev.altKey) {
        for (const s of SNAP_POINTS) {
          if (Math.abs(border - s * couplePx) <= SNAP_PX) { border = s * couplePx; snapped = true; break; }
        }
      }
      return { border, snapped, alt: ev.altKey === true };
    };
    setGesture({
      kind: 'col', ci, coupleLeft, couplePx, live: liveOf(e),
      pxOther: (gridRef.current && gridRef.current.clientHeight) || 0,
      fsA: layout.columns[ci].tiles[0]?.fontSize || TILE_FONT_DEF,
      fsB: layout.columns[ci + 1].tiles[0]?.fontSize || TILE_FONT_DEF,
    });
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
    // Come per la colonna: coordinate RELATIVE alla griglia, e la guida di
    // riga copre la sola colonna (non attraversa tutta la griglia).
    const gRect = gridRef.current ? gridRef.current.getBoundingClientRect() : null;
    const originTop = gRect ? gRect.top : 0;
    const rr = colEl ? colEl.getBoundingClientRect() : null;
    const colLeft = rr ? rr.left - (gRect ? gRect.left : 0) : 0;
    const colWidth = rr && rr.width > 0 ? rr.width : ((colEl && colEl.clientWidth) || 0);
    const startY = Number.isFinite(e.clientY) ? e.clientY : 0;
    const tiles = layout.columns[ci].tiles;
    const sumH = tiles[ri].height + (tiles[ri + 1]?.height || 0);
    const sumTot = tiles.reduce((s, t) => s + t.height, 0);
    // La coppia comincia alla tile ri, non in cima alla colonna: sopra ci
    // sono le righe 0..ri-1, in proporzione ai pesi (stesso criterio con cui
    // resizeTileCouple ricava i px della coppia).
    const sopra = tiles.slice(0, ri).reduce((s, t) => s + t.height, 0);
    const coupleTop = (rr && rr.height > 0 ? rr.top - originTop : 0) + gridPx * (sopra / (sumTot || 1));
    const couplePx = rr && rr.height > 0 ? gridPx * (sumH / (sumTot || 1)) : gridPx * (sumH / (sumTot || 1));
    const minPx = Math.min(MIN_ROW_PX, couplePx / 2);
    const liveOf = (ev) => {
      const y = (Number.isFinite(ev.clientY) ? ev.clientY : startY) - originTop;
      let border = Math.max(minPx, Math.min(couplePx - minPx, y - coupleTop));
      let snapped = false;
      if (!ev.altKey) {
        for (const s of SNAP_POINTS) {
          if (Math.abs(border - s * couplePx) <= SNAP_PX) { border = s * couplePx; snapped = true; break; }
        }
      }
      return { border, snapped, alt: ev.altKey === true };
    };
    setGesture({
      kind: 'row', ci, ri, coupleTop, couplePx, colLeft, colWidth, live: liveOf(e),
      pxOther: (colEl && colEl.clientWidth) || (gridRef.current && gridRef.current.clientWidth) || 0,
      fsA: tiles[ri].fontSize || TILE_FONT_DEF,
      fsB: tiles[ri + 1].fontSize || TILE_FONT_DEF,
    });
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

  // --- finestre flottanti -----------------------------------------------------
  const DEF_FLOAT = { x: 0.45, y: 0.12, w: 0.42, h: 0.6 };
  const SNAP_FLT_PX = 8;

  function promoteFloat(key) {
    setFloatUi((u) => ({ ...u, z: { ...u.z, [key]: u.next }, next: u.next + 1, focus: key }));
    if (onFocus) onFocus(key);
  }

  function toggleMinimize(key) {
    setFloatUi((u) => ({ ...u, mini: { ...u.mini, [key]: !u.mini[key] } }));
  }

  function detachHere(key) {
    if (floatingKeys.length >= MAX_FLOATING) return;
    onLayoutChange(detachTile(layout, key, DEF_FLOAT));
  }

  // punti di aggancio: bordi schermo + bordi delle ALTRRE flottanti
  function snapAxis(v, others) {
    const win = [0, 1];
    let snapped = false;
    let best = v;
    for (const target of [...win, ...others]) {
      if (Math.abs(v - target) <= SNAP_FLT_PX / window.innerWidth) { best = target; snapped = true; break; }
    }
    return { v: Math.max(0, Math.min(1, best)), snapped };
  }

  function startFloatMove(e, key) {
    e.preventDefault(); e.stopPropagation();
    try { if (e.currentTarget.setPointerCapture && e.pointerId != null) e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* best-effort */ }
    const g0 = floatGeomOf(layout, key);
    if (!g0) return;
    const startX = Number.isFinite(e.clientX) ? e.clientX : 0;
    const startY = Number.isFinite(e.clientY) ? e.clientY : 0;
    const others = (floatingKeys.filter((k) => k !== key)
      .map((k) => floatGeomOf(layout, k))).filter(Boolean);
    const xEdges = others.flatMap((g) => [g.x, g.x + g.w]);
    const yEdges = others.flatMap((g) => [g.y, g.y + g.h]);
    const liveOf = (ev) => {
      const dx = (Number.isFinite(ev.clientX) ? ev.clientX : startX) - startX;
      const dy = (Number.isFinite(ev.clientY) ? ev.clientY : startY) - startY;
      const sx = snapAxis(g0.x + dx / Math.max(1, window.innerWidth), xEdges);
      const sy = snapAxis(g0.y + dy / Math.max(1, window.innerHeight), yEdges);
      return { x: sx.v, y: sy.v, w: g0.w, h: g0.h, snappedX: sx.snapped, snappedY: sy.snapped };
    };
    setFloatGesture({ key, kind: 'move', live: liveOf(e) });
    trackResize(
      (ev) => setFloatGesture((g) => (g ? { ...g, live: liveOf(ev) } : g)),
      () => {
        const live = floatGestureRef.current?.live;
        setFloatGesture(null);
        if (live) onLayoutChange(updateFloatGeom(layout, key, live));
      },
      () => setFloatGesture(null),
    );
  }

  function startFloatResize(e, key, dir) {
    e.preventDefault(); e.stopPropagation();
    try { if (e.currentTarget.setPointerCapture && e.pointerId != null) e.currentTarget.setPointerCapture(e.pointerId); } catch (_) { /* best-effort */ }
    const g0 = floatGeomOf(layout, key);
    if (!g0) return;
    const startX = Number.isFinite(e.clientX) ? e.clientX : 0;
    const startY = Number.isFinite(e.clientY) ? e.clientY : 0;
    const W = Math.max(1, window.innerWidth);
    const H = Math.max(1, window.innerHeight);
    const fs = floatFontOf(layout, key) || TILE_FONT_DEF;
    const charW = Math.max(1, fs * 0.6);
    const rowH = Math.max(1, fs * 1.2);
    const liveOf = (ev) => {
      const dx = ((Number.isFinite(ev.clientX) ? ev.clientX : startX) - startX) / W;
      const dy = ((Number.isFinite(ev.clientY) ? ev.clientY : startY) - startY) / H;
      let { x, y, w, h } = g0;
      if (dir.includes('e')) w = g0.w + dx;
      if (dir.includes('s')) h = g0.h + dy;
      if (dir.includes('w')) { x = g0.x + dx; w = g0.w - dx; }
      if (dir.includes('n')) { y = g0.y + dy; h = g0.h - dy; }
      w = Math.max(0.05, Math.min(1 - x, w));
      h = Math.max(0.05, Math.min(1 - y, h));
      return { x, y, w, h };
    };
    setFloatGesture({ key, kind: 'resize', dir, live: liveOf(e), badge: true });
    trackResize(
      (ev) => setFloatGesture((g) => (g ? { ...g, live: liveOf(ev) } : g)),
      () => {
        const live = floatGestureRef.current?.live;
        setFloatGesture(null);
        if (live) onLayoutChange(updateFloatGeom(layout, key, live));
        if (onResizeEnd) onResizeEnd(); // il terminale si ridimensiona al rilascio
      },
      () => setFloatGesture(null),
    );
  }

  return (
    <div
      className={`nc-grid${gesture || floatGesture ? ' gesturing' : ''}`}
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
            className={`nc-col${isNewCol(ci) ? ' drop-newcol' : ''}${tuttaFlottante(col) ? ' nc-col-emptyfloat' : ''}`}
            ref={(el) => { colRefs.current[ci] = el; }}
            style={{ flexGrow: tuttaFlottante(col) ? 0 : col.width, flexBasis: 0 }}
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
              const fl = tile.float || null;
              const flMini = !!(fl && floatUi.mini[key]);
              tnodes.push(
                <div
                  key={key}
                  className={`nc-tile-slot${dropClass(ci, ri)}${drag && drag.from === key ? ' nc-tile-source' : ''}${fl ? ' nc-float' : ''}${flMini ? ' nc-float-mini' : ''}`}
                  style={fl ? {
                    position: 'fixed',
                    left: `${fl.x * 100}%`, top: `${fl.y * 100}%`,
                    width: `${fl.w * 100}%`, height: flMini ? 'auto' : `${fl.h * 100}%`,
                    zIndex: 20 + (floatUi.z[key] || 0),
                  } : { flexGrow: tile.height, flexBasis: 0 }}
                  onPointerDown={fl ? () => promoteFloat(key) : undefined}
                  onDragOver={(e) => {
                    if (!isSessionTransfer(e.dataTransfer)) return;
                    // una finestra staccata non è una destinazione: nessun drop qui
                    if (fl) { e.stopPropagation(); return; }
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
                    floating={!!fl} minimized={flMini}
                    // takeSize è un'opzione di attach del PTY ed è nelle dipendenze
                    // dell'effetto che crea terminale+socket: se seguisse il focus,
                    // ogni clic ricreerebbe la connessione. Fisso finché la finestra
                    // è staccata; cambia (e riconnette) solo a stacca/riattacca.
                    takeSize={!!fl}
                    onDetach={fl ? undefined : detachHere}
                    onReattach={fl ? (k) => onLayoutChange(reattachTile(layout, k)) : undefined}
                    onToggleMinimize={fl ? toggleMinimize : undefined}
                    onFloatDragStart={fl ? (e) => startFloatMove(e, key) : undefined}
                    onDragTileStart={fl ? undefined : (k) => setDrag((d) => (d ? { ...d, from: k } : { from: k }))}
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
                  {!fl && drag && drag.col === ci && drag.row === ri && drag.quadrant && (
                    <DropZones active={drag.quadrant} />
                  )}
                  {fl && !flMini && ['n', 's', 'e', 'w', 'se'].map((dir) => (
                    <div key={`rz-${dir}`} className={`nc-float-rz ${dir}`} data-testid={`float-resize-${dir}`}
                      onPointerDown={(e) => startFloatResize(e, key, dir)} />
                  ))}
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
        if (ci < ncols - 1 && !tuttaFlottante(col) && !tuttaFlottante(layout.columns[ci + 1])) {
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
      {/* Le linee degli agganci restano visibili DURANTE il gesto (design
          Desktop-Ridimensiona), non solo al momento dello snap. */}
      {gesture && gesture.kind === 'col' && SNAP_POINTS.map((s) => (
        <div key={`ghost-v-${s}`} className="nc-gesture-ghost v"
          style={{ left: gesture.coupleLeft + s * gesture.couplePx }} />
      ))}
      {gesture && gesture.kind === 'row' && SNAP_POINTS.map((s) => (
        <div key={`ghost-h-${s}`} className="nc-gesture-ghost h"
          style={{ top: gesture.coupleTop + s * gesture.couplePx, left: gesture.colLeft, width: gesture.colWidth }} />
      ))}
      {gesture && gesture.kind === 'col' && (
        <div className={`nc-gesture-guide v${gesture.live.snapped ? ' snap' : ''}`} data-testid="nc-gesture-guide"
          style={{ left: gesture.coupleLeft + gesture.live.border }} />
      )}
      {gesture && gesture.kind === 'row' && (
        <div className={`nc-gesture-guide h${gesture.live.snapped ? ' snap' : ''}`} data-testid="nc-gesture-guide"
          style={{ top: gesture.coupleTop + gesture.live.border, left: gesture.colLeft, width: gesture.colWidth }} />
      )}
      {gesture && (
        <div className="nc-gesture-badge" data-testid="nc-gesture-badge"
          style={gesture.kind === 'col'
            ? { left: gesture.coupleLeft + gesture.live.border, top: '50%' }
            : { top: gesture.coupleTop + gesture.live.border, left: '50%' }}>
          {[gesture.fsA, gesture.fsB].map((fs, lato) => {
            const px = lato === 0 ? gesture.live.border : gesture.couplePx - gesture.live.border;
            const charW = Math.max(1, fs * 0.6);
            const rowH = Math.max(1, fs * 1.2);
            // Sempre COLONNE×RIGHE: nel resize di riga la larghezza è
            // quella della colonna (pxOther) e l'altezza è il confine (px).
            const misure = gesture.kind === 'col'
              ? `${Math.round(px / charW)}×${Math.round(gesture.pxOther / rowH)}`
              : `${Math.round(gesture.pxOther / charW)}×${Math.round(px / rowH)}`;
            return (
              <span key={lato} className="nc-gesture-chip">
                {misure}
              </span>
            );
          })}
        </div>
      )}

      {/* Gesto flottante attivo: la finestra segue il live (1:1), guide
          tratteggiate agli agganci, badge colonne×righe nel resize. Scudo
          condiviso col resize di griglia: niente gesti persi sugli iframe. */}
      {floatGesture && (
        <>
          <div className={`nc-gesture-shield ${floatGesture.kind === 'resize' ? 'row' : 'col'}`} data-testid="nc-gesture-shield" />
          {floatGesture.live.snappedX && <div className="nc-float-snap v" style={{ left: `${floatGesture.live.x * 100}%` }} />}
          {floatGesture.live.snappedY && <div className="nc-float-snap h" style={{ top: `${floatGesture.live.y * 100}%` }} />}
          {floatGesture.kind === 'resize' && (() => {
            const fs = floatFontOf(layout, floatGesture.key) || TILE_FONT_DEF;
            const charW = Math.max(1, fs * 0.6);
            const rowH = Math.max(1, fs * 1.2);
            return (
              <div className="nc-gesture-badge" data-testid="nc-gesture-badge"
                style={{ left: `${(floatGesture.live.x + floatGesture.live.w / 2) * 100}%`, top: `${(floatGesture.live.y + floatGesture.live.h) * 100}%` }}>
                <span className="nc-gesture-chip">
                  {`${Math.round((floatGesture.live.w * window.innerWidth) / charW)}×${Math.round((floatGesture.live.h * window.innerHeight) / rowH)}`}
                </span>
              </div>
            );
          })()}
        </>
      )}

      {/* Spostamento: copia semitrasparente che segue il mouse. */}
      {drag && drag.from && drag.ghost && (() => {
        const src = layout.columns.flatMap((c) => c.tiles).find((t) => refKey(t) === drag.from);
        const nome = src ? cellDisplayName({
          session: src.session, node: src.node, ownerId: src.ownerId, cells, nodeGroups,
          cell: findManagedCell({ session: src.session, node: src.node, ownerId: src.ownerId, cells, nodeGroups }),
        }) : drag.from;
        return (
          <div className="nc-drag-ghost" data-testid="nc-drag-ghost" style={{ left: drag.ghost.x, top: drag.ghost.y }}>
            <div className="nc-drag-ghost-head"><span className="nc-dot on" /><b>{nome}</b></div>
            <div className="nc-drag-ghost-body" />
          </div>
        );
      })()}

      {isEnd && <div className="nc-drop-line-v nc-drop-line-end" />}

      {ncols === 0 && (
        <div className="nc-grid-empty">{t('grid-empty')}</div>
      )}
    </div>
  );
}
