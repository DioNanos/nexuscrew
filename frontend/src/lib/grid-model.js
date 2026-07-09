// Modello puro della griglia a colonne (stile Claude Code desktop):
// columns[] di tiles[]; width/height = pesi flex relativi. Nessun React qui.
const MAX_TILES = 9;
const MIN_W = 0.2;

export function emptyLayout() { return { columns: [] }; }

export function sessions(layout) {
  return layout.columns.flatMap((c) => c.tiles.map((t) => t.session));
}

const clone = (l) => ({ columns: l.columns.map((c) => ({ width: c.width, tiles: c.tiles.map((t) => ({ ...t })) })) });

export function addTile(layout, session, drop) {
  if (sessions(layout).includes(session)) return layout;
  if (sessions(layout).length >= MAX_TILES) return layout;
  const l = clone(layout);
  const tile = { session, height: 1 };
  if (drop === 'end') { l.columns.push({ width: 1, tiles: [tile] }); return l; }
  if (drop && typeof drop.col === 'number' && typeof drop.row === 'number' && l.columns[drop.col]) {
    l.columns[drop.col].tiles.splice(drop.row, 0, tile); return l;
  }
  if (drop && typeof drop.col === 'number') {
    const at = Math.max(0, Math.min(l.columns.length, drop.col));
    l.columns.splice(at, 0, { width: 1, tiles: [tile] }); return l;
  }
  l.columns.push({ width: 1, tiles: [tile] });
  return l;
}

// Crescita bilanciata "a griglia" per il click (niente colonne infinite):
// n. colonne target = ceil(sqrt(n)); sotto target apre una colonna, altrimenti
// impila nella colonna con meno tile. 1->[[a]] 2->side 3/4->2x2 5->3 colonne.
export function addTileSmart(layout, session) {
  if (sessions(layout).includes(session)) return layout;
  if (sessions(layout).length >= MAX_TILES) return layout;
  const n = sessions(layout).length + 1;
  const targetCols = Math.ceil(Math.sqrt(n));
  if (layout.columns.length < targetCols) return addTile(layout, session, 'end');
  let best = 0;
  for (let i = 1; i < layout.columns.length; i += 1) {
    if (layout.columns[i].tiles.length < layout.columns[best].tiles.length) best = i;
  }
  return addTile(layout, session, { col: best, row: layout.columns[best].tiles.length });
}

export function removeTile(layout, session) {
  const l = clone(layout);
  for (const c of l.columns) c.tiles = c.tiles.filter((t) => t.session !== session);
  l.columns = l.columns.filter((c) => c.tiles.length > 0);
  return l;
}

export function moveTile(layout, session, drop) {
  if (!sessions(layout).includes(session)) return layout;
  return addTile(removeTile(layout, session), session, drop);
}

export function resizeColumn(layout, colIdx, width) {
  const l = clone(layout);
  if (l.columns[colIdx]) l.columns[colIdx].width = Math.max(MIN_W, Number(width) || 1);
  return l;
}

export function resizeTile(layout, colIdx, rowIdx, height) {
  const l = clone(layout);
  const t = l.columns[colIdx] && l.columns[colIdx].tiles[rowIdx];
  if (t) t.height = Math.max(MIN_W, Number(height) || 1);
  return l;
}

// Drop direzionale: dato un tile (colIdx,rowIdx) e un quadrante, ritorna il
// descrittore drop per addTile/moveTile. Input invalidi → null.
export function dropForQuadrant(layout, colIdx, rowIdx, quadrant) {
  const col = layout.columns[colIdx];
  if (!col) return null;
  if (!col.tiles[rowIdx]) return null;
  switch (quadrant) {
    case 'left': return { col: colIdx };
    case 'right': return { col: colIdx + 1 };
    case 'top': return { col: colIdx, row: rowIdx };
    case 'bottom': return { col: colIdx, row: rowIdx + 1 };
    default: return null;
  }
}

// Preset: tutti i pesi (width colonne + height tiles) a 1.
export function equalize(layout) {
  const l = clone(layout);
  for (const c of l.columns) { c.width = 1; for (const t of c.tiles) t.height = 1; }
  return l;
}

// Preset: ridistribuisce le sessioni esistenti su 2 colonne bilanciate.
function capped(list) { return list.slice(0, MAX_TILES); }

export function toGrid2x2(layout) {
  const ss = capped(sessions(layout));
  if (ss.length === 0) return emptyLayout();
  const firstN = Math.ceil(ss.length / 2);
  const left = ss.slice(0, firstN);
  const right = ss.slice(firstN);
  const columns = [{ width: 1, tiles: left.map((session) => ({ session, height: 1 })) }];
  if (right.length) columns.push({ width: 1, tiles: right.map((session) => ({ session, height: 1 })) });
  return { columns };
}

// Preset: una colonna per sessione, pesi 1.
export function toColumns(layout) {
  return { columns: capped(sessions(layout)).map((session) => ({ width: 1, tiles: [{ session, height: 1 }] })) };
}

// Snap di una frazione ai divisori canonici 25/50/75% entro ±3%.
export function snapFraction(f) {
  for (const s of [0.25, 0.5, 0.75]) if (Math.abs(f - s) <= 0.03) return s;
  return f;
}

// Ripara input da localStorage: qualunque garbage → layout valido.
export function normalize(raw) {
  if (!raw || !Array.isArray(raw.columns)) return emptyLayout();
  const columns = raw.columns
    .map((c) => ({
      width: Math.max(MIN_W, Number(c && c.width) || 1),
      tiles: (Array.isArray(c && c.tiles) ? c.tiles : [])
        .filter((t) => t && typeof t.session === 'string' && t.session)
        .map((t) => ({ session: t.session, height: Math.max(MIN_W, Number(t.height) || 1) })),
    }))
    .filter((c) => c.tiles.length > 0);
  const seen = new Set();
  for (const c of columns) {
    c.tiles = c.tiles.filter((t) => !seen.has(t.session) && seen.add(t.session) && seen.size <= MAX_TILES);
  }
  return { columns: columns.filter((c) => c.tiles.length > 0) };
}
