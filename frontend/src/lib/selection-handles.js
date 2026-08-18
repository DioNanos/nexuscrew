// frontend/src/lib/selection-handles.js — R25: geometria e policy delle due
// maniglie della selezione, SOPRA l'API di selezione di xterm.js.
//
// Regola di disegno (approvata da Dev): la VERITA' della selezione vive in
// xterm (buffer, coordinate assolute). Questo modulo NON calcola quali celle
// sono selezionate: trasforma soltanto il range che xterm restituisce
// (getSelectionPosition) in posizioni delle maniglie, e applica le regole del
// gesto (no-crossing, clamp, edge-scroll) PRIMA di ridare a xterm il nuovo
// range via term.select(). Puro e senza DOM: la geometria si prova senza
// browser, che e' l'unico modo di provare il no-crossing e il clamp sul serio.
//
// Convenzioni coordinate (le stesse di xterm):
//  - cella = { row, col }: row e' l'indice ASSOLUTO nel buffer (viewportY e'
//    la prima riga visibile), col e' 0-based;
//  - range = { start: {row,col}, end: {row,col} } con start <= end
//    nell'ordine row-major (row*cols+col).

// R34 — Shift+click desktop: con una selezione attiva, il click SENZA drag
// muove il capo piu' vicino alla cella cliccata (l'equivalente desktop della
// regolazione a maniglie: il mouse non ha puntine, ha questo). Fuori dal range
// si muove il capo di quel lato; dentro il capo piu' vicino (a parita' vince
// start); su un capo, nessun movimento. Non conosce il buffer: lo snap ai
// glifi larghi e' del chiamante, che conosce `moved`.
export function extendRangeToCell({ range, cell, cols }) {
  const c = Number(cols);
  const iS = Number(range.start.row) * c + Number(range.start.col);
  const iE = Number(range.end.row) * c + Number(range.end.col);
  const iC = Number(cell.row) * c + Number(cell.col);
  const out = {
    start: { row: range.start.row, col: range.start.col },
    end: { row: range.end.row, col: range.end.col },
    moved: null,
  };
  if (iC < iS) { out.start = { row: Number(cell.row), col: Number(cell.col) }; out.moved = 'start'; }
  else if (iC > iE) { out.end = { row: Number(cell.row), col: Number(cell.col) }; out.moved = 'end'; }
  else if (iC === iS || iC === iE) { return out; }
  else if (iC - iS <= iE - iC) { out.start = { row: Number(cell.row), col: Number(cell.col) }; out.moved = 'start'; }
  else { out.end = { row: Number(cell.row), col: Number(cell.col) }; out.moved = 'end'; }
  return out;
}

// R34 — policy di VISTA per origine del gesto. La modalita' della UI di
// selezione segue il gesto che l'ha creata, non il device: una selezione nata
// dal tocco mostra maniglie + lente; una nata dal mouse nessuna delle due (il
// mouse ha la selezione nativa precisa e Shift+click per estendere). Origine
// ignota (null) → touch: se la rilevazione fallisce su un telefono, togliere
// le maniglie rende la selezione irregolabile; sul desktop mostrarle e' solo
// brutto. Direzione conservativa = touch.
export function selectionUiPolicy(origin) {
  const touch = origin !== 'mouse';
  return { handles: touch, magnifier: touch };
}

// Converte il range come lo restituisce xterm (getSelectionPosition:
// {start:{x,y}, end:{x,y}}, y = riga assoluta nel buffer, x = colonna)
// nella forma {row,col} usata da questo modulo.
export function rangeFromXterm(pos) {
  if (!pos || !pos.start || !pos.end) return null;
  return {
    start: { row: Number(pos.start.y), col: Number(pos.start.x) },
    end: { row: Number(pos.end.y), col: Number(pos.end.x) },
  };
}

// Ordina due celle in un range start<=end (row-major).
export function normalizeRange(a, b, cols) {
  const ia = Number(a.row) * Number(cols) + Number(a.col);
  const ib = Number(b.row) * Number(cols) + Number(b.col);
  return ia <= ib
    ? { start: { row: a.row, col: a.col }, end: { row: b.row, col: b.col } }
    : { start: { row: b.row, col: b.col }, end: { row: a.row, col: a.col } };
}

// Clamp di una cella trascinata: dentro i limiti del buffer E mai oltre
// l'altra estremita' (le maniglie NON si incrociano: quando si toccano si
// fermano, come Termux). `which` dice quale maniglia si muove: 'start' non
// puo' superare `fixed` verso il basso, 'end' non puo' superarlo verso l'alto.
export function clampDraggedCell({ moving, fixed, which, cols, maxRow }) {
  const c = Number(cols);
  let row = Math.max(0, Math.min(Number(maxRow), Number(moving.row)));
  let col = Math.max(0, Math.min(c - 1, Number(moving.col)));
  const iMoving = row * c + col;
  const iFixed = Number(fixed.row) * c + Number(fixed.col);
  if (which === 'start' && iMoving > iFixed) { row = Number(fixed.row); col = Number(fixed.col); }
  if (which === 'end' && iMoving < iFixed) { row = Number(fixed.row); col = Number(fixed.col); }
  return { row, col };
}

// R25-zoom rev4: una colonna bersaglio che cade DENTRO un glifo largo (cella
// di continuazione, getWidth() === 0) viene portata al bordo del glifo.
// VARIANTE CONSAPEVOLE di Termux getValidCurX (che porta SEMPRE al bordo
// destro): qui la maniglia start / il punto iniziale vanno al bordo SINISTRO
// (glifo incluso). Sul punto iniziale il risultato netto coincide con Termux
// (l'espansione a parola include comunque il glifo) ed e' coerente con una
// selezione che parte dall'inizio del glifo; la end va al bordo destro, come
// Termux. Mai una maniglia a meta' di un emoji o di un CJK. Colonne di
// terminale, non indici di stringa: la stessa famiglia del difetto che ha
// fatto tornare indietro due volte la barra.
export function snapWideCol({ line, col, side, cols }) {
  const c = Math.max(0, Math.min(Number(cols) - 1, Number(col)));
  const cell = line && typeof line.getCell === 'function' ? line.getCell(c) : null;
  const width = cell && typeof cell.getWidth === 'function' ? Number(cell.getWidth()) : 1;
  if (width !== 0) return c;
  return side === 'end' ? Math.min(Number(cols) - 1, c + 1) : Math.max(0, c - 1);
}

// R25-zoom rev4 (Termux TextSelectionCursorController): espansione a parola
// del punto premuto. Se la cella contiene una parola (non vuota, non spazio)
// la selezione si espande ai confini della parola; se e' spazio o vuota
// resta una cella. Confine = cella vuota o spazio, come in Termux
// (`!"".equals(text(...))`). `line` e' l'IBufferLine vero o un mock con la
// STESSA firma: getCell(col) → { getChars() }.
export function wordBoundsAt({ line, col, cols }) {
  const c = Math.max(0, Math.min(Number(cols) - 1, Number(col)));
  const charsAt = (i) => {
    const cell = line && typeof line.getCell === 'function' ? line.getCell(i) : null;
    return cell && typeof cell.getChars === 'function' ? cell.getChars() : '';
  };
  if (charsAt(c) === '' || charsAt(c) === ' ') return { start: c, end: c };
  let start = c;
  while (start > 0) {
    const ch = charsAt(start - 1);
    if (ch === '' || ch === ' ') break;
    start -= 1;
  }
  let end = c;
  while (end < Number(cols) - 1) {
    const ch = charsAt(end + 1);
    if (ch === '' || ch === ' ') break;
    end += 1;
  }
  return { start, end };
}

// R34 — le due puntine a meno di un target tattile di distanza (selezione
// corta) vengono marcate "tight": il CSS le scagliona in verticale (la start
// piu' in alto, la end piu' in basso) e le piega ai lati opposti, cosi' il
// dito trova due prese distinte anche su una parola di due caratteri. Soglia
// = larghezza del target tattile (>=44px: HIG Apple / Material).
export function handlesTooClose({ startLeft, endLeft, targetWidth = 46 }) {
  return Math.abs(Number(endLeft) - Number(startLeft)) < Number(targetWidth);
}

// R34 — layout della bolla lente: VICINO alla maniglia attiva, mai in cima
// fissa a coprire righe. Sopra l'ancora per default; se non c'e' spazio
// ribalta SOTTO la puntina (la maniglia in drag nelle prime righe non deve
// finire coperta dalla lente che la descrive); orizzontalmente centrata
// sull'ancora e clampata ai margini dell'host. Coordinate px nello spazio
// dell'host (come handlePositions). pinHeight = ingombro verticale della
// puntina sotto l'ancora (barretta + pallino), per il ribalto.
export function magnifierLayout({ anchorLeft, anchorTop, hostWidth, hostHeight, bubbleWidth, bubbleHeight, pinHeight = 30, margin = 4, gap = 8 }) {
  const w = Number(bubbleWidth);
  const h = Number(bubbleHeight);
  const m = Number(margin);
  const maxLeft = Math.max(m, Number(hostWidth) - m - w);
  const left = Math.max(m, Math.min(maxLeft, Number(anchorLeft) - Math.round(w / 2)));
  let top = Number(anchorTop) - Number(gap) - h;
  let flipped = false;
  if (top < m) { top = Number(anchorTop) + Number(pinHeight) + Number(gap); flipped = true; }
  const maxTop = Math.max(m, Number(hostHeight) - m - h);
  if (top > maxTop) top = maxTop;
  return { left, top, flipped };
}

// Argomenti per term.select() a partire da un range ordinato: xterm vuole
// (colonna, riga, lunghezza) in ordine lineare row-major.
export function rangeToSelect(range, cols) {
  const c = Number(cols);
  const a = Number(range.start.row) * c + Number(range.start.col);
  const b = Number(range.end.row) * c + Number(range.end.col);
  return { col: range.start.col, row: range.start.row, length: b - a + 1 };
}

// Posizioni (px, relative all'host del terminale) delle due maniglie per il
// range corrente. `screenLeft/screenTop` sono l'offset dello .xterm-screen
// dentro l'host; cellWidth/cellHeight le misure di una cella.
// La maniglia start sta SULLA prima cella; la end UNA CELLA OLTRE l'ultima
// (come Termux: positionAtCursor(mSelX2 + 1, ...)) — cosi' il punto indicato
// resta l'ultimo carattere selezionato, non il primo escluso.
// Entrambe pendono SOTTO il punto: il dito che trascina non copre la cella.
// `visible` e' false quando la riga e' fuori dal viewport (le maniglie non si
// disegnano nel nulla: chi le ha perse oltre il bordo le ritrova scorrendo).
export function handlePositions({ range, viewportY, rows, cellWidth, cellHeight, screenLeft = 0, screenTop = 0 }) {
  const out = {};
  for (const which of ['start', 'end']) {
    const cell = range[which];
    const visibleRow = Number(cell.row) - Number(viewportY);
    const visible = visibleRow >= 0 && visibleRow < Number(rows);
    const x = (which === 'start' ? Number(cell.col) : Number(cell.col) + 1) * Number(cellWidth);
    out[which] = {
      left: Number(screenLeft) + x,
      top: Number(screenTop) + (visibleRow + 1) * Number(cellHeight),
      visible,
    };
  }
  return out;
}

// Direzione di edge-scroll mentre una maniglia e' trascinata — la regola di
// Termux: si scorre quando la MANIGLIA raggiunge la riga visibile in cima o
// in fondo, non quando il dito entra in una fascia. `visibleRow` e' la riga
// della cella puntata, relativa al viewport (riga buffer - viewportY).
// Ritorna l'argomento per term.scrollLines: -1 = verso il piu' vecchio,
// +1 = verso il vivo, 0 = fermo. Mentre il dito resta fermo sul bordo un
// intervallo ripete lo scroll: a ogni giro la STESSA posizione del dito mappa
// a una riga diversa (le coordinate sono assolute nel buffer), quindi la
// selezione si estende finche' il buffer non finisce o il dito rientra.
export function edgeScrollDirection({ visibleRow, rows }) {
  const r = Number(visibleRow);
  if (r <= 0) return -1;
  if (r >= Number(rows) - 1) return 1;
  return 0;
}

// La barra di zoom: il testo della riga della maniglia in focus, spezzato in
// prima/selezionato/dopo. L'idea e' della PR #5; qui la struttura e' quella
// delle maniglie — la riga arriva dal buffer di xterm AL MOMENTO della
// chiamata, non da uno stato parallelo, quindi la barra segue il drag, lo
// scroll e il testo vivo con lo stesso battito che ridisegna le maniglie.
//
// La spezzatura lavora in COLONNE di xterm, non in indici JS: `line` e'
// l'IBufferLine vero (o un mock con la STESSA firma) e i tre segmenti si
// leggono con translateToString(trimRight, startColumn, endColumn) — perche'
// un carattere wide (emoji, CJK) occupa due celle e un combining sta nella
// cella del base: string.slice sulle colonne leggerebbe il carattere
// sbagliato o niente (audit r25zoom: colonne tagliate come indici JS).
// `side` dice quale maniglia guida la barra ('start'|'end').
// Se la porzione selezionata e' tutta spazi (selezione nata su una riga poi
// accorciata, o oltre il testo reale) l'evidenziazione e' vuota: le celle
// selezionate esistono, ma non c'e' testo da mostrare — non si evidenzia
// rumore.
export function zoomLineForRange({ range, side, line, cols }) {
  if (!range || !range.start || !range.end || !line) return null;
  const lastCol = Math.max(0, Number(cols) - 1);
  const focus = side === 'end' ? range.end : range.start;
  const row = Number(focus.row);
  // Colonne del range VIVE su questa riga (fino a fine riga = lastCol sulla
  // riga di start; dall'inizio sulla riga di end). Le maniglie stanno ai
  // capi, quindi il focus e' sempre un capo; il ramo intermedio resta come
  // difesa se un domani la barra seguisse una riga interna.
  let fromCol, toCol;
  if (Number(range.start.row) === Number(range.end.row)) {
    fromCol = Number(range.start.col); toCol = Number(range.end.col);
  } else if (row === Number(range.start.row)) {
    fromCol = Number(range.start.col); toCol = lastCol;
  } else if (row === Number(range.end.row)) {
    fromCol = 0; toCol = Number(range.end.col);
  } else {
    fromCol = 0; toCol = lastCol;
  }
  fromCol = Math.max(0, Math.min(lastCol, fromCol));
  toCol = Math.max(fromCol, Math.min(lastCol, toCol));
  const before = line.translateToString(true, 0, fromCol);
  let sel = line.translateToString(false, fromCol, toCol + 1);
  if (sel.replace(/\s+$/, '') === '') sel = '';
  const after = line.translateToString(true, Math.min(lastCol + 1, toCol + 1), lastCol + 1);
  return { row, before, sel, after };
}
