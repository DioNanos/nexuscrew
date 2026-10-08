// Modello puro della griglia a colonne (stile Claude Code desktop):
// columns[] di tiles[]; width/height = pesi flex relativi. Nessun React qui.
const MAX_TILES = 9;
const MIN_W = 0.2;

// --- Multi-node (B2): tile {session, node?} ----------------------
// node = nome del nodo remoto (chiave strict di nodes.json, come il proxy B1);
// assente -> sessione locale (retrocompatibilita' con i layout esistenti).
// Identita' di un tile = refKey "node:session" (tmux vieta ':' nei nomi di
// sessione e i nomi nodo sono ^[a-z0-9-]+$ -> nessuna collisione possibile).
export const NODE_RE = /^[a-z0-9-]{1,32}(?:\/[a-z0-9-]{1,32}){0,3}$/;
export const OWNER_ID_RE = /^[a-f0-9]{16,64}$/;
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
    const ownerId = ref.ownerId === undefined ? undefined
      : typeof ref.ownerId === 'string' && OWNER_ID_RE.test(ref.ownerId) ? ref.ownerId : null;
    if (ownerId === null) return null;
    if (ref.node === undefined || ref.node === null || ref.node === '') {
      return { session: ref.session, ...(ownerId ? { ownerId } : {}) };
    }
    if (typeof ref.node === 'string' && validNodeRoute(ref.node)) {
      return { session: ref.session, node: ref.node, ...(ownerId ? { ownerId } : {}) };
    }
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

// Ordine umano della griglia: riga per riga, da sinistra a destra. Lo storage
// e' column-major, quindi il semplice flatMap trasformava 1,2,3,4 in 1,3,2,4.
export function visualSessions(layout) {
  const out = [];
  const rows = Math.max(0, ...layout.columns.map((column) => column.tiles.length));
  for (let row = 0; row < rows; row += 1) {
    for (const column of layout.columns) if (column.tiles[row]) out.push(refKey(column.tiles[row]));
  }
  return out;
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
  if (r.ownerId) tile.ownerId = r.ownerId;
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
  if (layout.columns.length >= targetCols) {
    let best = 0;
    for (let i = 1; i < layout.columns.length; i += 1) {
      if (layout.columns[i].tiles.length < layout.columns[best].tiles.length) best = i;
    }
    return addTile(layout, ref, { col: best, row: layout.columns[best].tiles.length });
  }
  // I click automatici usano una griglia bilanciata row-major: l'ordine in cui
  // l'utente apre le finestre resta quello visibile anche quando si passa da
  // 2 a 3 colonne. Font per-tile preservato; pesi tornano pari nel layout auto.
  const ordered = [...visualSessions(layout), key];
  const previous = new Map(layout.columns.flatMap((column) => column.tiles.map((tile) => [refKey(tile), tile])));
  const incoming = parseRef(ref);
  const averageWidth = layout.columns.length
    ? layout.columns.reduce((sum, column) => sum + (Number(column.width) || 1), 0) / layout.columns.length
    : 1;
  const columns = Array.from({ length: targetCols }, (_, index) => ({
    width: layout.columns[index]?.width || averageWidth, tiles: [],
  }));
  ordered.forEach((item, index) => {
    const parsed = parseRef(item); if (!parsed) return;
    const old = previous.get(item) || (item === key ? incoming : {}) || {};
    const tile = { session: parsed.session, height: old.height || 1, fontSize: old.fontSize || TILE_FONT_DEF };
    if (parsed.node) tile.node = parsed.node;
    if (old.ownerId) tile.ownerId = old.ownerId;
    // Lo stato di disponibilita' resta attraversando le trasformazioni di
    // VISTA (e' effimero: le sole serializzazioni lo scartano, non l'utente
    // che sposta o riaggiunge una finestra).
    if (old.unavailable === true) tile.unavailable = true;
    if (old.stale === true) tile.stale = true;
    columns[index % targetCols].tiles.push(tile);
  });
  return { columns: columns.filter((column) => column.tiles.length) };
}

// Aggiunta STABILE: usata dalla riconciliazione dopo un conflitto di revisione.
// Le tile gia' presenti non si muovono mai (nessun reflow bilanciato): la nuova
// va in fondo alla colonna meno piena, o apre la prima colonna su griglia
// vuota. L'ordine delle finestre esistenti resta quello che l'utente vede.
export function addTileStable(layout, ref) {
  const r = parseRef(ref);
  if (!r) return layout;
  const key = refKey(r);
  if (!key || sessions(layout).includes(key) || sessions(layout).length >= MAX_TILES) return layout;
  // La geometria del delta viaggia sull'oggetto tile (parseRef tiene solo
  // l'identita'): si ripara qui come farebbe normalize.
  const raw = ref && typeof ref === 'object' ? ref : {};
  const props = {
    height: Math.max(MIN_W, Number(raw.height) || 1),
    fontSize: repairFont(raw.fontSize),
    ...(r.ownerId ? { ownerId: r.ownerId } : {}),
  };
  if (!layout.columns.length) {
    return addTile(layout, r, null, props);
  }
  let best = 0;
  for (let i = 1; i < layout.columns.length; i += 1) {
    if (layout.columns[i].tiles.length < layout.columns[best].tiles.length) best = i;
  }
  return addTile(layout, r, { col: best, row: layout.columns[best].tiles.length }, props);
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
  // Preserva le proprietà per-tile attraverso il remove+add.
  const old = layout.columns.flatMap((c) => c.tiles).find((t) => refKey(t) === key);
  return addTile(removeTile(layout, key), key, drop, {
    fontSize: old.fontSize, height: old.height,
    ...(old.ownerId ? { ownerId: old.ownerId } : {}),
    // Lo stato effimero di disponibilita' non si azzera spostando la tile:
    // resta offline (o stale) fino al prossimo tick della topologia.
    ...(old.unavailable === true ? { unavailable: true } : {}),
    ...(old.stale === true ? { stale: true } : {}),
  });
}

// Migrazione mirata di ref tile persistiti. replacements = Map<oldKey,newKey>;
// ritorna lo stesso oggetto se non cambia nulla, così React/useDecks non salva
// in loop. Ogni nuova ref passa dalla stessa validazione strict parseRef().
export function remapTileRefs(layout, replacements) {
  if (!(replacements instanceof Map) || replacements.size === 0) return layout;
  let changed = false;
  const next = clone(layout);
  for (const column of next.columns) {
    for (const tile of column.tiles) {
      const replacement = replacements.get(refKey(tile));
      if (!replacement) continue;
      const parsed = parseRef(replacement);
      if (!parsed) continue;
      tile.session = parsed.session;
      if (parsed.node) tile.node = parsed.node; else delete tile.node;
      if (parsed.ownerId) tile.ownerId = parsed.ownerId;
      changed = true;
    }
  }
  return changed ? normalize(next) : layout;
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

// --- Griglia desktop: resize a COPPIA in pixel ----------------------------
// Il bordo segue il mouse 1:1 e cambiano SOLO i due adiacenti: la somma dei
// loro pesi resta costante, le altre finestre non si muovono. I minimi sono
// in PIXEL della coppia (non pesi), l'aggancio magnetico scatta solo vicino
// a 1/3, 1/2, 2/3 della coppia (linee tratteggiate) e si spegne con Alt.
export const MIN_COL_PX = 120;
export const MIN_ROW_PX = 60;
export const SNAP_POINTS = [1 / 3, 0.5, 2 / 3];
export const SNAP_PX = 16;

// Frazione del bordo richiesta -> frazione valida: clamp ai minimi (in px
// della coppia, mai oltre la metà) e aggancio opzionale ai divisori canonici.
function coupleFraction(borderPx, couplePx, minPx, snap) {
  if (!(couplePx > 0)) return 0.5;
  const fMin = Math.max(0, Math.min(0.5, minPx / couplePx));
  let f = borderPx / couplePx;
  f = Math.max(fMin, Math.min(1 - fMin, f));
  if (snap) {
    for (const s of SNAP_POINTS) {
      if (Math.abs(f - s) * couplePx <= SNAP_PX) { f = s; break; }
    }
  }
  return f;
}

// gridPx = larghezza dell'intera griglia in px; borderPx = posizione del
// bordo richiesta dal mouse, in px dall'inizio della coppia. opts.half
// forza la coppia a metà (doppio clic sulla maniglia).
export function resizeColumnCouple(layout, colIdx, gridPx, borderPx, opts = {}) {
  const l = clone(layout);
  const a = l.columns[colIdx];
  const b = l.columns[colIdx + 1];
  if (!a || !b) return layout;
  const sumTot = l.columns.reduce((s, c) => s + (Number(c.width) || 1), 0);
  const sum = (Number(a.width) || 1) + (Number(b.width) || 1);
  const couplePx = (Number(gridPx) || 0) * (sum / (sumTot || 1));
  const f = opts.half === true ? 0.5 : coupleFraction(borderPx, couplePx, opts.minPx ?? MIN_COL_PX, opts.snap !== false);
  a.width = sum * f;
  b.width = sum * (1 - f);
  return l;
}

// Qui gridPx = altezza della COLONNA in px; borderPx dall'inizio della coppia
// di tile (ri | ri+1). opts.half = doppio clic.
export function resizeTileCouple(layout, colIdx, rowIdx, gridPx, borderPx, opts = {}) {
  const l = clone(layout);
  const col = l.columns[colIdx];
  const a = col && col.tiles[rowIdx];
  const b = col && col.tiles[rowIdx + 1];
  if (!a || !b) return layout;
  const sumTot = col.tiles.reduce((s, t) => s + (Number(t.height) || 1), 0);
  const sum = (Number(a.height) || 1) + (Number(b.height) || 1);
  const couplePx = (Number(gridPx) || 0) * (sum / (sumTot || 1));
  const f = opts.half === true ? 0.5 : coupleFraction(borderPx, couplePx, opts.minPx ?? MIN_ROW_PX, opts.snap !== false);
  a.height = sum * f;
  b.height = sum * (1 - f);
  return l;
}

// «Centro = SCAMBIA»: le due finestre si scambiano di posto. L'identità e le
// proprietà per-tile (font, node, ownerId, stato effimero) viaggiano col tile;
// la geometria (height dello slot, width delle colonne) resta agli slot.
export function swapTiles(layout, keyA, keyB) {
  if (!keyA || !keyB || keyA === keyB) return layout;
  const l = clone(layout);
  let pa = null; let pb = null;
  for (const c of l.columns) {
    for (let i = 0; i < c.tiles.length; i += 1) {
      const k = refKey(c.tiles[i]);
      if (k === keyA && !pa) pa = { col: c, i };
      else if (k === keyB && !pb) pb = { col: c, i };
    }
  }
  if (!pa || !pb) return layout;
  const ta = pa.col.tiles[pa.i];
  const tb = pb.col.tiles[pb.i];
  const senzaGeometria = (t) => { const out = { ...t }; delete out.height; return out; };
  pa.col.tiles[pa.i] = { ...senzaGeometria(tb), height: ta.height };
  pb.col.tiles[pb.i] = { ...senzaGeometria(ta), height: tb.height };
  return l;
}

// --- Finestre flottanti -----------------------------------------
// La VISTA tiene lo staccato nelle columns con un flag `float` (geometria in
// FRAZIONI di schermo, 0..1): il GridTile resta alla stessa posizione
// dell'albero — reso position:fixed dal CSS — e non si smonta mai (il
// terminale si riconnette solo a stacca/riattacca, per takeSize). La SERIALIZZAZIONE (record del deck) sposta gli staccati FUORI: griglia
// pura + lista `floating` a livello record (validata dal server).
export const MAX_FLOATING = 6;

const clampFloatGeom = (g) => {
  let { x, y, w, h } = g;
  w = Math.max(0.05, Math.min(1, Number(w) || 0.3));
  h = Math.max(0.05, Math.min(1, Number(h) || 0.3));
  x = Math.max(0, Math.min(1 - w, Number(x) || 0));
  y = Math.max(0, Math.min(1 - h, Number(y) || 0));
  return { x, y, w, h };
};

function trovaTile(l, key) {
  for (const c of l.columns) {
    for (let i = 0; i < c.tiles.length; i += 1) if (refKey(c.tiles[i]) === key) return { tile: c.tiles[i] };
  }
  return null;
}

// Stacca: mette il flag float (clampato). Oltre MAX_FLOATING non fa nulla
// (ritorna lo stesso riferimento: nessun salvataggio inutile).
export function detachTile(layout, ref, geom) {
  const l = clone(layout);
  const key = refKey(ref);
  if (floatingRefs(l).length >= MAX_FLOATING) return layout;
  const hit = trovaTile(l, key);
  if (!hit || hit.tile.float) return layout;
  hit.tile.float = clampFloatGeom(geom || {});
  return l;
}

// Riattacca: toglie il flag. Il tile non si è mai mosso dall'albero: torna
// nel flusso della griglia ESATTAMENTE dov'era (design: «dov'era»).
export function reattachTile(layout, ref) {
  const l = clone(layout);
  const hit = trovaTile(l, refKey(ref));
  if (!hit || !hit.tile.float) return layout;
  delete hit.tile.float;
  return l;
}

// Sposta/ridimensiona una flottante (drag dal titolo, resize dal bordo):
// aggiorna solo la geometria del flag, clampata dentro lo schermo.
export function updateFloatGeom(layout, ref, geom) {
  const l = clone(layout);
  const hit = trovaTile(l, refKey(ref));
  if (!hit || !hit.tile.float) return layout;
  hit.tile.float = clampFloatGeom(geom);
  return l;
}

// refKey di tutti gli staccati (in ordine di griglia).
export function floatingRefs(layout) {
  return layout.columns.flatMap((c) => c.tiles).filter((t) => t.float).map((t) => refKey(t));
}

// Vista -> record: griglia SENZA staccati (le colonne che restano vuote
// spariscono: il formato del server non le ammette) + lista floating con i
// soli campi del record (nessun height: la geometria è nel float).
export function stripFloating(layout) {
  const floating = [];
  const columns = [];
  for (const c of layout.columns) {
    const tiles = [];
    for (const t of c.tiles) {
      if (t.float) {
        const f = { session: t.session, ...t.float, fontSize: t.fontSize };
        if (t.node) f.node = t.node;
        if (t.ownerId) f.ownerId = t.ownerId;
        floating.push(f);
      } else {
        tiles.push(t);
      }
    }
    if (tiles.length) columns.push({ width: c.width, tiles });
  }
  return { grid: { columns }, floating };
}

// Record -> vista: la griglia resta, gli staccati rientrano con addTileStable
// (colonna meno piena, mai reflow degli altri) + il loro flag float.
// Flottanti nel merge (poll con finestra sporca, ritentativo dopo un 409), a
// TRE vie, tutte nelle STESSE coordinate: base = il record su cui la finestra
// sporca ha lavorato, remote = il record nuovo, local = la vista sporca.
// Presenza: una flottante tolta da una parte e non toccata dall'altra resta
// tolta; una aggiunta da una parte entra. Geometria di una finestra presente
// ovunque, PER CAMPO (x, y, w, h, fontSize): locale = base -> vince il remoto;
// remoto = base -> vince il locale; cambiati entrambi -> vince il locale. Il
// risultato torna dentro lo schermo. Tetto MAX_FLOATING.
const CAMPI_FLOAT = ['x', 'y', 'w', 'h', 'fontSize'];
const stessoValore = (a, b) => Math.abs((Number(a) || 0) - (Number(b) || 0)) < 1e-9;
const stessaGeometria = (a, b) => CAMPI_FLOAT.every((k) => stessoValore(a[k], b[k]));
function fondiGeometria(base, remote, local) {
  if (!base) return local;
  const out = { ...local };
  for (const k of CAMPI_FLOAT) {
    if (stessoValore(local[k], base[k]) && !stessoValore(remote[k], base[k])) out[k] = remote[k];
  }
  return { ...out, ...clampFloatGeom(out) };
}
export function fondeFloating(baseFloating, remoteFloating, localFloating) {
  const perChiave = (list) => new Map((Array.isArray(list) ? list : [])
    .map((f) => [refKey(f), f]).filter(([k]) => k));
  const base = perChiave(baseFloating);
  const remote = perChiave(remoteFloating);
  const local = perChiave(localFloating);
  const out = [];
  for (const [k, f] of local) {
    // tolta altrove e qui intatta: resta tolta
    if (!remote.has(k) && base.has(k) && stessaGeometria(f, base.get(k))) continue;
    out.push(remote.has(k) ? fondiGeometria(base.get(k), remote.get(k), f) : f);
  }
  for (const [k, f] of remote) {
    // gia' presa dalla vista, oppure tolta qui (c'era nella base)
    if (local.has(k) || base.has(k)) continue;
    out.push(f);
  }
  return out.slice(0, MAX_FLOATING);
}

// Stato di una finestra nel merge: staccata, in griglia o assente. Si
// decide a tre vie come un campo (se la vista locale non l'ha toccata vince
// il remoto, altrimenti vince il locale; spostarla o ridimensionarla da
// staccata conta come toccarla), SOLO per le finestre staccate da
// qualche parte (base, remoto o vista): le tile mai staccate restano come le
// decide il merge della griglia. base/remote/local = { grid, floating }, tutti
// nelle stesse coordinate; grid/floating = il risultato dei due merge.
export function riconciliaStaccate(grid, floating, base, remote, local) {
  const staccate = (v) => (Array.isArray(v.floating) ? v.floating : []);
  const stato = (v, k) => (staccate(v).some((f) => refKey(f) === k) ? 'float'
    : sessions(v.grid).includes(k) ? 'grid' : '');
  const tileIn = (layout, k) => layout.columns.flatMap((c) => c.tiles).find((t) => refKey(t) === k);
  const chiavi = new Set([...staccate(base), ...staccate(remote), ...staccate(local)].map((f) => refKey(f)).filter(Boolean));
  let g = grid;
  let fl = Array.isArray(floating) ? floating : [];
  const geom = (v, k) => staccate(v).find((f) => refKey(f) === k);
  for (const k of chiavi) {
    const sl = stato(local, k);
    const sb = stato(base, k);
    // toccata qui: cambiata di stato, o staccata e spostata/ridimensionata
    const toccata = sl !== sb || (sl === 'float' && !stessaGeometria(geom(local, k), geom(base, k)));
    const fin = toccata ? sl : stato(remote, k);
    if (fin !== 'grid' && sessions(g).includes(k)) g = removeTile(g, k);
    if (fin !== 'float') fl = fl.filter((f) => refKey(f) !== k);
    if (fin === 'grid' && !sessions(g).includes(k)) {
      const t = tileIn(remote.grid, k) || tileIn(local.grid, k) || tileIn(base.grid, k);
      if (t) g = addTileStable(g, t);
    }
    if (fin === 'float' && !fl.some((f) => refKey(f) === k)) {
      const f = [remote, local, base].map((v) => staccate(v).find((x) => refKey(x) === k)).find(Boolean);
      if (f) fl = [...fl, f];
    }
  }
  return { grid: g, floating: fl.slice(0, MAX_FLOATING) };
}

// Due viste sono la stessa se hanno le stesse colonne, tile, pesi e font, e
// le stesse staccate con la stessa geometria — senza badare all'ordine delle
// chiavi degli oggetti (un merge ricostruisce le tile in un altro ordine).
export function stessaVista(a, b) {
  const firma = (layout) => {
    const { grid, floating } = stripFloating(layout || emptyLayout());
    return JSON.stringify({
      g: grid.columns.map((c) => [c.width, c.tiles.map((t) => [refKey(t), t.ownerId || '', t.height, t.fontSize])]),
      f: floating.map((f) => [refKey(f), f.ownerId || '', f.x, f.y, f.w, f.h, f.fontSize]),
    });
  };
  return firma(a) === firma(b);
}

export function materializeFloating(grid, floating) {
  let out = grid;
  for (const f of Array.isArray(floating) ? floating : []) {
    const ref = { session: f.session };
    if (f.node) ref.node = f.node;
    if (f.ownerId) ref.ownerId = f.ownerId;
    const key = refKey(ref);
    if (!key || sessions(out).includes(key)) continue;
    // Le flottanti NON contano contro il tetto della griglia: il server le
    // tiene in un campo del record a parte (9 della griglia + fino a 6
    // flottanti), e la vista le rende position:fixed — aggiungerle con
    // addTileStable le farebbe sparire oltre il nono tile.
    const l = clone(out);
    if (!l.columns.length) l.columns.push({ width: 1, tiles: [] });
    let best = 0;
    for (let i = 1; i < l.columns.length; i += 1) {
      if (l.columns[i].tiles.length < l.columns[best].tiles.length) best = i;
    }
    const tile = { session: ref.session, height: 1, fontSize: f.fontSize || TILE_FONT_DEF, float: clampFloatGeom(f) };
    if (ref.node) tile.node = ref.node;
    if (ref.ownerId) tile.ownerId = ref.ownerId;
    l.columns[best].tiles.push(tile);
    out = l;
  }
  return out;
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
  if (t.ownerId) out.ownerId = t.ownerId;
  if (t.unavailable === true) out.unavailable = true;
  if (t.stale === true) out.stale = true;
  return out;
}

export function toGrid2x2(layout) {
  const ss = capped(visualSessions(layout));
  if (ss.length === 0) return emptyLayout();
  const mk = (key) => rebuildTile(layout, key);
  const left = ss.filter((_key, index) => index % 2 === 0);
  const right = ss.filter((_key, index) => index % 2 === 1);
  const columns = [{ width: 1, tiles: left.map(mk) }];
  if (right.length) columns.push({ width: 1, tiles: right.map(mk) });
  return { columns };
}

// Preset: una colonna per sessione, pesi 1.
export function toColumns(layout) {
  return { columns: capped(visualSessions(layout)).map((key) => ({ width: 1, tiles: [rebuildTile(layout, key)] })) };
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
        .filter((t) => t.ownerId == null || (typeof t.ownerId === 'string' && OWNER_ID_RE.test(t.ownerId)))
        .map((t) => {
          const out = { session: t.session, height: Math.max(MIN_W, Number(t.height) || 1), fontSize: repairFont(t.fontSize) };
          if (t.node != null) out.node = t.node;
          if (t.ownerId != null) out.ownerId = t.ownerId;
          // Il flag `float` è VISTA STABILE (finestra staccata): normalize non
          // lo scarta, altrimenti il primo passaggio di
          // resolveLayoutForViewer/cloneLayout lo spegne e la finestra torna
          // da sola nella griglia.
          if (t.float) out.float = clampFloatGeom(t.float);
          // `unavailable`/`stale` sono stato EFFIMERO di disponibilita': derivano
          // dal tick della topologia e NON si copiano nel layout normalizzato:
          // mai serializzati (nemmeno via localStorage), mai parte del confronto
          // che decide l'autosave. Un flip di disponibilita' = zero scritture.
          return out;
        }),
    }))
    .filter((c) => c.tiles.length > 0);
  // Tetti separati, come nel record del server: 9 tile di griglia e, a parte,
  // MAX_FLOATING staccate. Un tetto unico sulla vista farebbe sparire una tile
  // (di griglia o flottante) quando la griglia è piena e c'è una staccata.
  const seen = new Set();
  let inGriglia = 0; let staccate = 0;
  for (const c of columns) {
    c.tiles = c.tiles.filter((t) => {
      const k = refKey(t);
      if (seen.has(k)) return false;
      if (t.float ? staccate >= MAX_FLOATING : inGriglia >= MAX_TILES) return false;
      seen.add(k);
      if (t.float) staccate += 1; else inGriglia += 1;
      return true;
    });
  }
  return { columns: columns.filter((c) => c.tiles.length > 0) };
}

// Merge remoto ⊕ delta locale per il poll con finestra sporca.
// Ciclo 1, senza base a tre vie: il remoto dà la struttura (colonne e tile che
// esistono ancora), per le sessioni condivise vince la geometria LOCALE
// (ultima modifica dell'utente, decisione D2), le tile presenti solo in locale
// sono il delta e vengono aggiunte in coda con addTileSmart.
export function mergeRemoteWithLocal(remote, local) {
  let out = normalize(remote);
  const localNorm = normalize(local);
  const localByKey = new Map();
  for (const column of localNorm.columns) {
    for (const tile of column.tiles) localByKey.set(refKey(tile), tile);
  }
  for (const column of out.columns) {
    for (let i = 0; i < column.tiles.length; i += 1) {
      const k = refKey(column.tiles[i]);
      if (localByKey.has(k)) column.tiles[i] = localByKey.get(k);
    }
  }
  // Le larghezze di colonna sono geometria locale SOLO a struttura invariata:
  // una colonna remota eredita la larghezza locale quando ha lo STESSO insieme
  // di tile di una colonna locale (il resize tocca solo `width`). Se il remoto
  // ha ristrutturato le colonne (tile spostate, fuse o divise), la larghezza
  // locale apparterrebbe a un'altra struttura: quella colonna tiene la
  // larghezza del remoto, già passata dalla regola di `normalize`
  // (`Math.max(MIN_W, …)`, grid-model.js:276).
  const widthBySignature = new Map();
  for (const column of localNorm.columns) {
    const signature = column.tiles.map((t) => refKey(t)).sort().join('|');
    if (!widthBySignature.has(signature)) widthBySignature.set(signature, column.width);
  }
  for (const column of out.columns) {
    const signature = column.tiles.map((t) => refKey(t)).sort().join('|');
    const w = widthBySignature.get(signature);
    if (w != null) column.width = w;
  }
  for (const [key, tile] of localByKey) {
    if (sessions(out).includes(key)) continue;
    out = addTileStable(out, tile);
  }
  return out;
}
