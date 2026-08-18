// R25: la geometria e la policy delle maniglie si provano senza DOM — il
// no-crossing e il clamp sono regole ESATTE, e un test che le guarda solo
// «a occhio» non le difende.
import { describe, expect, it } from 'vitest';
import {
  normalizeRange, clampDraggedCell, rangeToSelect, handlePositions, edgeScrollDirection,
  rangeFromXterm, snapWideCol, wordBoundsAt, zoomLineForRange,
} from './selection-handles.js';

describe('normalizeRange', () => {
  it('ordina due celle gia\' in ordine', () => {
    expect(normalizeRange({ row: 1, col: 2 }, { row: 3, col: 5 }, 80))
      .toEqual({ start: { row: 1, col: 2 }, end: { row: 3, col: 5 } });
  });
  it('scambia due celle date alla rovescia (stessa riga e righe diverse)', () => {
    expect(normalizeRange({ row: 3, col: 5 }, { row: 1, col: 2 }, 80))
      .toEqual({ start: { row: 1, col: 2 }, end: { row: 3, col: 5 } });
    expect(normalizeRange({ row: 4, col: 0 }, { row: 4, col: 9 }, 80).start.col).toBe(0);
  });
  it('sulla stessa cella produce un range di una cella', () => {
    const r = normalizeRange({ row: 2, col: 7 }, { row: 2, col: 7 }, 80);
    expect(rangeToSelect(r, 80).length).toBe(1);
  });
});

describe('clampDraggedCell — le maniglie non si incrociano', () => {
  const base = { cols: 80, maxRow: 100 };
  it('start trascinato OLTRE end si ferma su end', () => {
    const out = clampDraggedCell({ moving: { row: 9, col: 9 }, fixed: { row: 5, col: 3 }, which: 'start', ...base });
    expect(out).toEqual({ row: 5, col: 3 });
  });
  it('end trascinato PRIMA di start si ferma su start', () => {
    const out = clampDraggedCell({ moving: { row: 1, col: 0 }, fixed: { row: 5, col: 3 }, which: 'end', ...base });
    expect(out).toEqual({ row: 5, col: 3 });
  });
  it('sulla stessa riga vale la colonna: start non supera end a destra', () => {
    const out = clampDraggedCell({ moving: { row: 5, col: 40 }, fixed: { row: 5, col: 10 }, which: 'start', ...base });
    expect(out).toEqual({ row: 5, col: 10 });
  });
  it('dentro i limiti il movimento e\' libero', () => {
    const out = clampDraggedCell({ moving: { row: 4, col: 2 }, fixed: { row: 5, col: 3 }, which: 'start', ...base });
    expect(out).toEqual({ row: 4, col: 2 });
  });
  it('i limiti del buffer fermano prima del no-crossing', () => {
    expect(clampDraggedCell({ moving: { row: -3, col: -1 }, fixed: { row: 5, col: 3 }, which: 'start', ...base }))
      .toEqual({ row: 0, col: 0 });
    expect(clampDraggedCell({ moving: { row: 500, col: 999 }, fixed: { row: 5, col: 3 }, which: 'end', ...base }))
      .toEqual({ row: 100, col: 79 });
  });
});

describe('rangeToSelect', () => {
  it('traduce il range in (col, row, lunghezza) lineare su piu\' righe', () => {
    const r = { start: { row: 1, col: 2 }, end: { row: 3, col: 5 } };
    expect(rangeToSelect(r, 80)).toEqual({ col: 2, row: 1, length: (3 * 80 + 5) - (1 * 80 + 2) + 1 });
  });
});

describe('handlePositions', () => {
  const range = { start: { row: 1, col: 2 }, end: { row: 3, col: 5 } };
  const args = { range, viewportY: 0, rows: 24, cellWidth: 10, cellHeight: 20 };
  it('start sulla prima cella, end UNA CELLA OLTRE l\'ultima', () => {
    const p = handlePositions(args);
    expect(p.start.left).toBe(2 * 10);
    expect(p.end.left).toBe((5 + 1) * 10);
  });
  it('le maniglie pendono SOTTO il punto (top = riga+1)', () => {
    const p = handlePositions(args);
    expect(p.start.top).toBe((1 + 1) * 20);
    expect(p.end.top).toBe((3 + 1) * 20);
  });
  it('rispetta l\'offset dello schermo dentro l\'host e il viewport', () => {
    const p = handlePositions({ ...args, viewportY: 1, screenLeft: 4, screenTop: 7 });
    // riga buffer 1 - viewportY 1 = riga visibile 0
    expect(p.start.left).toBe(4 + 20);
    expect(p.start.top).toBe(7 + 20);
  });
  it('una riga fuori dal viewport non e\' visibile', () => {
    const p = handlePositions({ ...args, viewportY: 2 });
    expect(p.start.visible).toBe(false); // riga 1, viewport da 2
    expect(p.end.visible).toBe(true);     // riga 3 visibile
  });
});

describe('edgeScrollDirection — la regola di Termux: la maniglia sul bordo, non il dito in una fascia', () => {
  it('maniglia sulla prima riga visibile → verso il piu\' vecchio (-1)', () => {
    expect(edgeScrollDirection({ visibleRow: 0, rows: 24 })).toBe(-1);
  });
  it('maniglia sull\'ultima riga visibile → verso il vivo (+1)', () => {
    expect(edgeScrollDirection({ visibleRow: 23, rows: 24 })).toBe(1);
  });
  it('in mezzo non si scorre', () => {
    expect(edgeScrollDirection({ visibleRow: 1, rows: 24 })).toBe(0);
    expect(edgeScrollDirection({ visibleRow: 22, rows: 24 })).toBe(0);
    expect(edgeScrollDirection({ visibleRow: 10, rows: 24 })).toBe(0);
  });
});

describe('wordBoundsAt — espansione a parola (Termux TextSelectionCursorController)', () => {
  const line = (chars) => ({ getCell: (i) => ({ getChars: () => chars[i] ?? '' }) });
  it('su una parola espande ai confini della parola', () => {
    expect(wordBoundsAt({ line: line('ciao mondo'), col: 6, cols: 80 })).toEqual({ start: 5, end: 9 });
  });
  it('su uno spazio resta una cella', () => {
    expect(wordBoundsAt({ line: line('ciao mondo'), col: 4, cols: 80 })).toEqual({ start: 4, end: 4 });
  });
  it('su una cella vuota resta una cella', () => {
    expect(wordBoundsAt({ line: line('ab  cd'), col: 2, cols: 80 })).toEqual({ start: 2, end: 2 });
  });
  it('ai bordi della riga non esce dai limiti', () => {
    expect(wordBoundsAt({ line: line('abc'), col: 0, cols: 80 })).toEqual({ start: 0, end: 2 });
    expect(wordBoundsAt({ line: line('abc'), col: 2, cols: 80 })).toEqual({ start: 0, end: 2 });
  });
  it('senza line (difensivo) resta la colonna', () => {
    expect(wordBoundsAt({ line: null, col: 3, cols: 80 })).toEqual({ start: 3, end: 3 });
  });
});

describe('snapWideCol — bordo del glifo largo (Termux getValidCurX)', () => {
  const line = (widths) => ({ getCell: (i) => ({ getWidth: () => widths[i] ?? 1 }) });
  it('cella di continuazione: bordo sinistro per start, destro per end', () => {
    expect(snapWideCol({ line: line([1, 2, 0, 1]), col: 2, side: 'start', cols: 80 })).toBe(1);
    expect(snapWideCol({ line: line([1, 2, 0, 1]), col: 2, side: 'end', cols: 80 })).toBe(3);
  });
  it('cella normale o cella del glifo: invariata', () => {
    expect(snapWideCol({ line: line([1, 2, 0, 1]), col: 0, side: 'end', cols: 80 })).toBe(0);
    expect(snapWideCol({ line: line([1, 2, 0, 1]), col: 1, side: 'start', cols: 80 })).toBe(1);
  });
  it('senza line (difensivo) resta la colonna', () => {
    expect(snapWideCol({ line: null, col: 2, side: 'start', cols: 80 })).toBe(2);
  });
});

describe('rangeFromXterm', () => {
  it('traduce {x,y} di xterm in {row,col}', () => {
    expect(rangeFromXterm({ start: { x: 2, y: 1 }, end: { x: 5, y: 3 } }))
      .toEqual({ start: { row: 1, col: 2 }, end: { row: 3, col: 5 } });
  });
  it('senza range restituisce null, non un finto range', () => {
    expect(rangeFromXterm(null)).toBeNull();
    expect(rangeFromXterm({ start: { x: 0, y: 0 } })).toBeNull();
  });
});

describe('zoomLineForRange — la barra di zoom spezza la riga della maniglia in focus', () => {
  const COLS = 21; // 21 celle come una riga '0123456789abcdefghij'
  // Mock fedele all'IBufferLine di xterm (stessa firma, nessuna firma
  // inventata): translateToString(trimRight, startColumn, endColumn) conta
  // CELLE. I grafi e le loro larghezze sono un DATO del caso, come nel
  // terminale: un char wide occupa 2 celle, il combining sta nella cella del
  // grafo base — qui non si reinventa wcwidth, si dichiara la riga.
  function xtermLine(graphs, widths, cols = COLS) {
    const cells = [];
    widths.forEach((w, i) => { for (let k = 0; k < w; k++) cells.push(i); });
    return {
      translateToString(trimRight, startColumn = 0, endColumn = cols) {
        const s = Math.max(0, Math.min(cells.length, Number(startColumn)));
        const e = Math.max(s, Math.min(cells.length, Number(endColumn)));
        const idx = new Set(cells.slice(s, e));
        const out = graphs.filter((_, i) => idx.has(i)).join('');
        return trimRight ? out.replace(/\s+$/, '') : out;
      },
    };
  }
  function asciiLine(text) {
    return xtermLine([...text], [...text].map(() => 1));
  }
  const RIGA2 = '0123456789abcdefghij'; // 21 caratteri ASCII = 21 celle

  it('stessa riga: selezionata la porzione start.col..end.col, il resto ai lati', () => {
    const range = { start: { row: 2, col: 3 }, end: { row: 2, col: 6 } };
    expect(zoomLineForRange({ range, side: 'start', line: asciiLine(RIGA2), cols: COLS }))
      .toEqual({ row: 2, before: '012', sel: '3456', after: '789abcdefghij' });
  });
  it('focus start su range multi-riga: prima dalla colonna di start, selezionato fino a fine riga', () => {
    const range = { start: { row: 2, col: 3 }, end: { row: 5, col: 2 } };
    expect(zoomLineForRange({ range, side: 'start', line: asciiLine(RIGA2), cols: COLS }))
      .toEqual({ row: 2, before: '012', sel: '3456789abcdefghij', after: '' });
  });
  it('focus end su range multi-riga: selezionato dall\'inizio fino alla colonna di end', () => {
    const range = { start: { row: 2, col: 3 }, end: { row: 5, col: 4 } };
    expect(zoomLineForRange({ range, side: 'end', line: asciiLine(RIGA2), cols: COLS }))
      .toEqual({ row: 5, before: '', sel: '01234', after: '56789abcdefghij' });
  });
  it('WIDE (CJK): un char da 2 celle non desincronizza le colonne — audit r25zoom', () => {
    // 'a界b': 3 grafi JS, 4 CELLE. La colonna 3 e' la 'b': string.slice(3)
    // leggerrebbe fuori stringa; per colonne legge la cella giusta.
    const line = xtermLine(['a', '界', 'b'], [1, 2, 1], 4);
    const range = { start: { row: 0, col: 3 }, end: { row: 0, col: 3 } };
    expect(zoomLineForRange({ range, side: 'start', line, cols: 4 }))
      .toEqual({ row: 0, before: 'a界', sel: 'b', after: '' });
  });
  it('EMOJI: 👍 occupa due celle, la selezione dopo l\'emoji parte dalla colonna giusta', () => {
    const line = xtermLine(['x', '👍', 'y'], [1, 2, 1], 4);
    const range = { start: { row: 0, col: 3 }, end: { row: 0, col: 3 } };
    expect(zoomLineForRange({ range, side: 'start', line, cols: 4 }))
      .toEqual({ row: 0, before: 'x👍', sel: 'y', after: '' });
  });
  it('COMBINING: il grafo base+marca sta in UNA cella, non in due', () => {
    // 'a'+U+0301 e' un grafo (a + combining acute): 1 cella. 'b' la seconda.
    const line = xtermLine(['a\u0301', 'b'], [1, 1], 2);
    const range = { start: { row: 0, col: 1 }, end: { row: 0, col: 1 } };
    expect(zoomLineForRange({ range, side: 'start', line, cols: 2 }))
      .toEqual({ row: 0, before: 'a\u0301', sel: 'b', after: '' });
  });
  it('selezione OLTRE il testo reale (riga accorciata sotto la selezione): evidenziazione vuota', () => {
    const range = { start: { row: 2, col: 3 }, end: { row: 2, col: 6 } };
    expect(zoomLineForRange({ range, side: 'start', line: asciiLine('ab'), cols: COLS }))
      .toEqual({ row: 2, before: 'ab', sel: '', after: '' });
  });
  it('riga vuota: barra vuota, niente crash', () => {
    const range = { start: { row: 7, col: 0 }, end: { row: 7, col: 0 } };
    expect(zoomLineForRange({ range, side: 'start', line: xtermLine([], []), cols: COLS }))
      .toEqual({ row: 7, before: '', sel: '', after: '' });
  });
  it('senza range o senza riga niente barra', () => {
    expect(zoomLineForRange({ range: null, side: 'start', line: asciiLine(RIGA2), cols: COLS })).toBeNull();
    expect(zoomLineForRange({ range: { start: { row: 0, col: 0 }, end: { row: 0, col: 0 } }, side: 'start', line: null, cols: COLS })).toBeNull();
  });
});
