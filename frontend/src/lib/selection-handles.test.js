// R25: la geometria e la policy delle maniglie si provano senza DOM — il
// no-crossing e il clamp sono regole ESATTE, e un test che le guarda solo
// «a occhio» non le difende.
import { describe, expect, it } from 'vitest';
import {
  normalizeRange, clampDraggedCell, rangeToSelect, handlePositions, edgeScrollDirection,
  rangeFromXterm,
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
