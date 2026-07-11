// Modello puro della griglia a colonne (stile Claude Code desktop):
// columns[] di tiles[]; width/height = pesi flex relativi. Nessun React qui.
const MAX_TILES = 9;
const MIN_W = 0.2;

// --- Multi-node (B2, design §5): tile {session, node?} ----------------------
// node = nome del nodo remoto (chiave strict di nodes.json, come il proxy B1);
// assente -> sessione locale (retrocompatibilita' con i layout esistenti).
// Identita' di un tile = refKey "node:session" (tmux vieta ':' nei nomi di
// sessione e i nomi nodo sono ^[a-z0-9-]+$ -> nessuna collisione possibile).
export const NODE_RE = /^[a-z0-9-]{1,32}(?:\/[a-z0-9-]{1,32}){0,3}$/;
const validNodeRoute = (node) => NODE_RE.test(node) && new Set(node.split('/')).size === node.split('/').length;

// ref: stringa ("sess" locale, "nodo:sess" remota) o oggetto {session, node?}.
// -> {session, node?} normalizzato, o null su input invalido (fail-closed).
export function parseRef(ref) {
  if (typeof ref === 'string' && ref) {
    const i = ref.indexOf(':');
    if (i < 0) return { session: ref };
    const node = ref.slice(0, i);
    const session = ref.slice(i + 1);
    if (!validNodeRoute(node) || !session) return null;
    return { session, node };
  }
  if (ref && typeof ref === 'object' && typeof ref.session === 'string' && ref.session) {
    if (ref.node === undefined || ref.node === null || ref.node === '') return { session: ref.session };
    if (typeof ref.node === 'string' && validNodeRoute(ref.node)) return { session: ref.session, node: ref.node };
    return null;
  }
  return null;
}

// refKey({session,node?}|string) -> chiave stabile del tile.
export function refKey(ref) {
  const r = parseRef(ref);
  if (!r) return '';
  return r.node ? `${r.node}:${r.session}` : r.session;
}

// Font per-tile (zoom nel grid): stessi bound dello zoom single-view.
export const TILE_FONT_MIN = 9;
export const TILE_FONT_MAX = 24;
export const TILE_FONT_DEF = 11;
// Riparazione (normalize): valore valido passa, garbage torna al default.
const repairFont = (v) => {
  const n = Number(v);
  return n >= TILE_FONT_MIN && n <= TILE_FONT_MAX ? n : TILE_FONT_DEF;
};

export function emptyLayout() { return { columns: [] }; }

// Chiavi (refKey) di tutti i tile del layout. Per i layout solo-locali coincide
// con i nomi sessione (comportamento storico invariato).
export function sessions(layout) {
  return layout.columns.flatMap((c) => c.tiles.map((t) => refKey(t)));
}

const clone = (l) => ({ columns: l.columns.map((c) => ({ width: c.width, tiles: c.tiles.map((t) => ({ ...t })) })) });

export function addTile(layout, ref, drop, props) {
  const r = parseRef(ref);
  if (!r) return layout;
  if (sessions(layout).includes(refKey(r))) return layout;
  if (sessions(layout).length >= MAX_TILES) return layout;
  const l = clone(layout);
  const tile = { session: r.session, height: 1, fontSize: TILE_FONT_DEF, ...(props || {}) };
  if (r.node) tile.node = r.node;
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
export function addTileSmart(layout, ref) {
  const key = refKey(ref);
  if (!key) return layout;
  if (sessions(layout).includes(key)) return layout;
  if (sessions(layout).length >= MAX_TILES) return layout;
  const n = sessions(layout).length + 1;
  const targetCols = Math.ceil(Math.sqrt(n));
  if (layout.columns.length < targetCols) return addTile(layout, ref, 'end');
  let best = 0;
  for (let i = 1; i < layout.columns.length; i += 1) {
    if (layout.columns[i].tiles.length < layout.columns[best].tiles.length) best = i;
  }
  return addTile(layout, ref, { col: best, row: layout.columns[best].tiles.length });
}

export function removeTile(layout, ref) {
  const key = refKey(ref);
  const l = clone(layout);
  for (const c of l.columns) c.tiles = c.tiles.filter((t) => refKey(t) !== key);
  l.columns = l.columns.filter((c) => c.tiles.length > 0);
  return l;
}

export function moveTile(layout, ref, drop) {
  const key = refKey(ref);
  if (!sessions(layout).includes(key)) return layout;
  // Preserva le proprietà per-tile (fontSize) attraverso il remove+add.
  const old = layout.columns.flatMap((c) => c.tiles).find((t) => refKey(t) === key);
  return addTile(removeTile(layout, key), key, drop, { fontSize: old.fontSize });
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

// Zoom font di un singolo tile: delta relativo con clamp ai bound.
// Indici invalidi → layout invariato (stesso riferimento).
export function zoomTile(layout, colIdx, rowIdx, delta) {
  const cur = layout.columns[colIdx] && layout.columns[colIdx].tiles[rowIdx];
  if (!cur) return layout;
  const l = clone(layout);
  const t = l.columns[colIdx].tiles[rowIdx];
  const base = Number(t.fontSize) || TILE_FONT_DEF;
  t.fontSize = Math.max(TILE_FONT_MIN, Math.min(TILE_FONT_MAX, base + (Number(delta) || 0)));
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

// I preset ricostruiscono i tile: fontSize e node per-tile vanno riportati a mano.
function tileByKey(layout, key) {
  return layout.columns.flatMap((c) => c.tiles).find((x) => refKey(x) === key);
}
function rebuildTile(layout, key) {
  const t = tileByKey(layout, key) || {};
  const out = { session: t.session, height: 1, fontSize: t.fontSize || TILE_FONT_DEF };
  if (t.node) out.node = t.node;
  return out;
}

export function toGrid2x2(layout) {
  const ss = capped(sessions(layout));
  if (ss.length === 0) return emptyLayout();
  const mk = (key) => rebuildTile(layout, key);
  const firstN = Math.ceil(ss.length / 2);
  const left = ss.slice(0, firstN);
  const right = ss.slice(firstN);
  const columns = [{ width: 1, tiles: left.map(mk) }];
  if (right.length) columns.push({ width: 1, tiles: right.map(mk) });
  return { columns };
}

// Preset: una colonna per sessione, pesi 1.
export function toColumns(layout) {
  return { columns: capped(sessions(layout)).map((key) => ({ width: 1, tiles: [rebuildTile(layout, key)] })) };
}

// Snap di una frazione ai divisori canonici 25/50/75% entro ±3%.
export function snapFraction(f) {
  for (const s of [0.25, 0.5, 0.75]) if (Math.abs(f - s) <= 0.03) return s;
  return f;
}

// Ripara input da localStorage: qualunque garbage → layout valido.
// node: assente → tile locale (layout pre-B2 invariati); valido → conservato;
// garbage → tile SCARTATO (fail-closed: mai reindirizzare l'input a una
// sessione locale omonima).
export function normalize(raw) {
  if (!raw || !Array.isArray(raw.columns)) return emptyLayout();
  const columns = raw.columns
    .map((c) => ({
      width: Math.max(MIN_W, Number(c && c.width) || 1),
      tiles: (Array.isArray(c && c.tiles) ? c.tiles : [])
        .filter((t) => t && typeof t.session === 'string' && t.session)
        .filter((t) => t.node == null || (typeof t.node === 'string' && validNodeRoute(t.node)))
        .map((t) => {
          const out = { session: t.session, height: Math.max(MIN_W, Number(t.height) || 1), fontSize: repairFont(t.fontSize) };
          if (t.node != null) out.node = t.node;
          return out;
        }),
    }))
    .filter((c) => c.tiles.length > 0);
  const seen = new Set();
  for (const c of columns) {
    c.tiles = c.tiles.filter((t) => !seen.has(refKey(t)) && seen.add(refKey(t)) && seen.size <= MAX_TILES);
  }
  return { columns: columns.filter((c) => c.tiles.length > 0) };
}
