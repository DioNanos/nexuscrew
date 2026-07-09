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
  for (const c of columns) c.tiles = c.tiles.filter((t) => !seen.has(t.session) && seen.add(t.session));
  return { columns: columns.filter((c) => c.tiles.length > 0) };
}
