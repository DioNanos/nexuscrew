import { describe, expect, it } from 'vitest';
// Griglia desktop — resize a COPPIA in pixel: il bordo segue il mouse 1:1,
// cambiano solo i due adiacenti (somma dei loro pesi costante), le altre
// finestre invariate. Minimi in pixel (120 colonna / 60 riga), aggancio a
// 1/3 1/2 2/3 della coppia. SwapTiles per lo spostamento «centro = scambia».
import {
  resizeColumnCouple, resizeTileCouple, swapTiles, equalize,
} from './grid-model.js';

const layout3 = () => ({
  columns: [
    { width: 1, tiles: [{ session: 'a', height: 1 }] },
    { width: 1, tiles: [{ session: 'b', height: 1 }] },
    { width: 1, tiles: [{ session: 'c', height: 1 }] },
  ],
});

describe('resizeColumnCouple — bordo 1:1, solo la coppia', () => {
  it('2 colonne su 800px: bordo da 400 a 300 -> 0.75/1.25 (somma 2)', () => {
    const l = { columns: [{ width: 1, tiles: [{ session: 'a', height: 1 }] }, { width: 1, tiles: [{ session: 'b', height: 1 }] }] };
    const out = resizeColumnCouple(l, 0, 800, 300);
    expect(out.columns[0].width).toBeCloseTo(0.75, 10);
    expect(out.columns[1].width).toBeCloseTo(1.25, 10);
  });

  it('3 colonne su 900px: bordo della prima coppia da 300 a 150 -> 0.5/1.5, la terza resta 1', () => {
    const out = resizeColumnCouple(layout3(), 0, 900, 150);
    expect(out.columns[0].width).toBeCloseTo(0.5, 10);
    expect(out.columns[1].width).toBeCloseTo(1.5, 10);
    expect(out.columns[2].width).toBe(1);
  });

  it('minimo in px: bordo a 50px con min 120 -> la prima colonna resta 120px-equivalente', () => {
    const out = resizeColumnCouple(layout3(), 0, 900, 50);
    // coppia = 600px: min 120px -> frazione 0.2 -> 0.4/1.6
    expect(out.columns[0].width).toBeCloseTo(0.4, 10);
    expect(out.columns[1].width).toBeCloseTo(1.6, 10);
  });

  it('aggancio: frazione entro soglia va a 1/3 (senza Alt)', () => {
    // coppia 600px: 1/3 = 200px; bordo richiesto 192 (8px di distanza) -> 1/3
    const out = resizeColumnCouple(layout3(), 0, 900, 192);
    expect(out.columns[0].width).toBeCloseTo(2 / 3, 10);
    expect(out.columns[1].width).toBeCloseTo(4 / 3, 10);
  });

  it('Alt disattiva l’aggancio: 192px resta 192px', () => {
    const out = resizeColumnCouple(layout3(), 0, 900, 192, { snap: false });
    expect(out.columns[0].width).toBeCloseTo(0.64, 10); // 192/600*2
    expect(out.columns[1].width).toBeCloseTo(1.36, 10);
  });

  it('metà esatta: 300px su coppia 600 -> 1/1', () => {
    const out = resizeColumnCouple(layout3(), 0, 900, 300, { snap: false });
    expect(out.columns[0].width).toBeCloseTo(1, 10);
    expect(out.columns[1].width).toBeCloseTo(1, 10);
  });
});

describe('resizeTileCouple — righe, solo la coppia', () => {
  it('2 righe su 600px: bordo da 300 a 240 -> 0.8/1.2, min 60 rispettato', () => {
    const l = { columns: [{ width: 1, tiles: [{ session: 'a', height: 1 }, { session: 'b', height: 1 }] }] };
    const out = resizeTileCouple(l, 0, 0, 600, 240);
    expect(out.columns[0].tiles[0].height).toBeCloseTo(0.8, 10);
    expect(out.columns[0].tiles[1].height).toBeCloseTo(1.2, 10);
  });

  it('3 righe: la terza invariata; minimo 60px in frazione', () => {
    const l = { columns: [{ width: 1, tiles: [{ session: 'a', height: 1 }, { session: 'b', height: 1 }, { session: 'c', height: 1 }] }] };
    const out = resizeTileCouple(l, 0, 0, 600, 100);
    // coppia 400px, bordo 100 -> 1/4 -> 0.5/1.5, terza resta 1
    expect(out.columns[0].tiles[0].height).toBeCloseTo(0.5, 10);
    expect(out.columns[0].tiles[1].height).toBeCloseTo(1.5, 10);
    expect(out.columns[0].tiles[2].height).toBe(1);
  });
});

describe('swapTiles — il centro scambia le finestre', () => {
  it('due tile: le sessioni si scambiano slot, geometria e font restano agli slot/ai tile come erano', () => {
    const l = { columns: [
      { width: 2, tiles: [{ session: 'a', height: 2, fontSize: 13 }] },
      { width: 1, tiles: [{ session: 'b', height: 1, fontSize: 11 }] },
    ] };
    const out = swapTiles(l, 'a', 'b');
    expect(out.columns[0].tiles[0].session).toBe('b');
    expect(out.columns[1].tiles[0].session).toBe('a');
    // il font è per-tile e viaggia col tile; geometria (height/larghezze) resta agli slot
    expect(out.columns[0].tiles[0].fontSize).toBe(11);
    expect(out.columns[1].tiles[0].fontSize).toBe(13);
    expect(out.columns[0].tiles[0].height).toBe(2);
    expect(out.columns[1].tiles[0].height).toBe(1);
    expect(out.columns[0].width).toBe(2);
    expect(out.columns[1].width).toBe(1);
  });

  it('tile remoto scambiato mantiene node/ownerId; chiave inesistente -> layout invariato (stesso riferimento)', () => {
    const l = { columns: [
      { width: 1, tiles: [{ session: 'a', height: 1 }, { session: 'b', node: 'peer', ownerId: 'abcd1234abcd1234', height: 1 }] },
    ] };
    const out = swapTiles(l, 'a', 'peer:b');
    expect(out.columns[0].tiles[0].session).toBe('b');
    expect(out.columns[0].tiles[0].node).toBe('peer');
    expect(out.columns[0].tiles[0].ownerId).toBe('abcd1234abcd1234');
    expect(out.columns[0].tiles[1].session).toBe('a');
    expect(out.columns[0].tiles[1].node).toBeUndefined();
    expect(swapTiles(l, 'a', 'non-esiste')).toBe(l);
  });
});

describe('equalize resta compatibile (regressione)', () => {
  it('tutti i pesi a 1', () => {
    const out = equalize(layout3());
    expect(out.columns.every((c) => c.width === 1)).toBe(true);
  });
});
