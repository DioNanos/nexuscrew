// R34 — extendRangeToCell: Shift+click desktop. Con una selezione attiva, il
// click (senza drag) muove il capo PIU' VICINO alla cella cliccata: e'
// l'equivalente desktop della regolazione a maniglie — il mouse non ha le
// puntine, ha questo. Regole esatte, provate senza DOM: fuori dal range si
// muove il capo di quel lato, dentro si muove il capo piu' vicino (a parita'
// vince start: chiudere la selezione verso l'inizio e' il gesto meno
// sorprendente), su un capo non si muove nulla.
import { describe, expect, it } from 'vitest';
import { extendRangeToCell } from './selection-handles.js';

// cols=80: start (1,2) → 82, end (1,11) → 91.
const range = { start: { row: 1, col: 2 }, end: { row: 1, col: 11 } };

describe('R34 — extendRangeToCell (Shift+click)', () => {
  it('click DOPO la fine: si muove end, start resta', () => {
    expect(extendRangeToCell({ range, cell: { row: 1, col: 30 }, cols: 80 }))
      .toEqual({ start: { row: 1, col: 2 }, end: { row: 1, col: 30 }, moved: 'end' });
  });
  it('click PRIMA dell\'inizio: si muove start', () => {
    expect(extendRangeToCell({ range, cell: { row: 1, col: 0 }, cols: 80 }))
      .toEqual({ start: { row: 1, col: 0 }, end: { row: 1, col: 11 }, moved: 'start' });
  });
  it('click su un\'altra riga PRIMA (row-major): start si sposta su quella riga', () => {
    expect(extendRangeToCell({ range, cell: { row: 0, col: 70 }, cols: 80 }))
      .toEqual({ start: { row: 0, col: 70 }, end: { row: 1, col: 11 }, moved: 'start' });
  });
  it('click DENTRO, piu\' vicino allo start: si muove start', () => {
    // (1,4) → 84: distanza da start 2, da end 7.
    expect(extendRangeToCell({ range, cell: { row: 1, col: 4 }, cols: 80 }))
      .toEqual({ start: { row: 1, col: 4 }, end: { row: 1, col: 11 }, moved: 'start' });
  });
  it('click DENTRO, piu\' vicino all\'end: si muove end', () => {
    // (1,9) → 89: distanza da start 7, da end 2.
    expect(extendRangeToCell({ range, cell: { row: 1, col: 9 }, cols: 80 }))
      .toEqual({ start: { row: 1, col: 2 }, end: { row: 1, col: 9 }, moved: 'end' });
  });
  it('click esattamente su un capo: nessun movimento', () => {
    expect(extendRangeToCell({ range, cell: { row: 1, col: 2 }, cols: 80 }).moved).toBeNull();
    expect(extendRangeToCell({ range, cell: { row: 1, col: 11 }, cols: 80 }).moved).toBeNull();
  });
});
