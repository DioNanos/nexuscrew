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
