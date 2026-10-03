import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';

// Il gesto di resize deve avere un "fine": a pointerup/pointercancel
// il grid chiede UN solo salvataggio (saveNow) invece di affidarsi al debounce.
vi.mock('./GridTile.jsx', () => ({ default: () => <div data-testid="tile-stub" /> }));

import GridView from './GridView.jsx';

const twoCols = { columns: [{ width: 1, tiles: [{ session: 'a', height: 1 }] }, { width: 1, tiles: [{ session: 'b', height: 1 }] }] };
const oneColTwoTiles = { columns: [{ width: 1, tiles: [{ session: 'a', height: 1 }, { session: 'b', height: 1 }] }] };

const down = (el, x = 0, y = 0) => fireEvent.pointerDown(el, { clientX: x, clientY: y, button: 0 });
const premici = (el, init = {}) => el.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0, ...init }));
const muovi = (x, y, extra = {}) => window.dispatchEvent(
  new window.MouseEvent('pointermove', { bubbles: true, clientX: x, clientY: y, ...extra }));
const aspettaGuida = async (container) => waitFor(() => {
  const g = container.querySelector('[data-testid="nc-gesture-guide"]');
  expect(g).toBeTruthy();
  return g;
});

describe('GridView fine resize', () => {
  it('resize colonna: a pointerup chiama onResizeEnd una volta sola', () => {
    const onResizeEnd = vi.fn();
    const onLayoutChange = vi.fn();
    const { container } = render(
      <GridView layout={twoCols} onLayoutChange={onLayoutChange} onResizeEnd={onResizeEnd} />,
    );
    down(container.querySelector('.nc-divider-v'));
    fireEvent.pointerMove(window, { clientX: 40, clientY: 0 });
    expect(onResizeEnd).not.toHaveBeenCalled();
    fireEvent.pointerUp(window);
    expect(onResizeEnd).toHaveBeenCalledTimes(1);
  });

  it('resize riga: a pointerup chiama onResizeEnd una volta sola', () => {
    const onResizeEnd = vi.fn();
    const { container } = render(
      <GridView layout={oneColTwoTiles} onLayoutChange={vi.fn()} onResizeEnd={onResizeEnd} />,
    );
    down(container.querySelector('.nc-divider-h'));
    fireEvent.pointerMove(window, { clientX: 0, clientY: 40 });
    expect(onResizeEnd).not.toHaveBeenCalled();
    fireEvent.pointerUp(window);
    expect(onResizeEnd).toHaveBeenCalledTimes(1);
  });
});

// La guida vive nel sistema di coordinate della
// GRIGLIA (non del viewport: niente offset sidebar+deckbar), la guida di
// riga copre solo la sua colonna, e il badge di riga dice COLONNE×RIGHE
// (larghezza÷charW × altezza÷rowH), non l'inverso.
const rectOf = (l, t, w, h) => ({ left: l, top: t, width: w, height: h, right: l + w, bottom: t + h });
const fissa = (el, r) => {
  el.getBoundingClientRect = () => r;
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: Math.round(r.width) });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: Math.round(r.height) });
};

describe('GridView resize nel viewport reale', () => {
  it('la linea guida col segue il mouse 1:1 dentro la griglia', async () => {
    const { container } = render(<GridView layout={twoCols} onLayoutChange={vi.fn()} />);
    fissa(container.querySelector('.nc-grid'), rectOf(233, 56, 791, 800));
    const cols = container.querySelectorAll('.nc-col');
    fissa(cols[0], rectOf(239, 62, 380, 788));
    fissa(cols[1], rectOf(623, 62, 398, 788));
    // jsdom non ha PointerEvent: fireEvent su window NON porta clientX/Y.
    // Le coordinate vere viaggiano con un MouseEvent.
    premici(container.querySelector('.nc-divider-v'), { clientX: 300, clientY: 400 });
    muovi(500, 400, { altKey: true });
    const guida = await aspettaGuida(container);
    // il confine parte dal punto di presa e SEGUE il dito: +200 px di mouse
    expect(guida.style.left).toBe('267px');
    muovi(600, 400, { altKey: true });
    await waitFor(() => { expect(guida.style.left).toBe('367px'); }); // 1:1 col mouse
  });

  it('la guida di riga copre solo la sua colonna', async () => {
    const { container } = render(<GridView layout={oneColTwoTiles} onLayoutChange={vi.fn()} />);
    fissa(container.querySelector('.nc-grid'), rectOf(233, 56, 791, 800));
    const col = container.querySelector('.nc-col');
    fissa(col, rectOf(233, 56, 791, 800));
    premici(container.querySelector('.nc-divider-h'), { clientX: 400, clientY: 200 });
    muovi(400, 350, { altKey: true });
    const guida = await aspettaGuida(container);
    expect(guida.style.left).toBe('0px');
    expect(guida.style.width).toBe('791px');
    expect(guida.style.top).toBe('294px'); // 350 mouse − 56 origine griglia
  });

  it('il badge di riga dice colonne×righe (larghezza÷charW × altezza÷rowH)', async () => {
    const { container } = render(<GridView layout={oneColTwoTiles} onLayoutChange={vi.fn()} />);
    fissa(container.querySelector('.nc-grid'), rectOf(233, 56, 791, 800));
    const col = container.querySelector('.nc-col');
    fissa(col, rectOf(233, 56, 791, 800));
    premici(container.querySelector('.nc-divider-h'), { clientX: 400, clientY: 200 });
    muovi(400, 350, { altKey: true });
    const badge = await waitFor(() => {
      const b = container.querySelector('[data-testid="nc-gesture-badge"]');
      expect(b).toBeTruthy();
      return b;
    });
    // colonna: 791 px ÷ (11×0.6 = 6.6) = 120 colonne; righe: 150 px ÷ (11×1.2 = 13.2) = 11
    expect(badge.textContent).toContain('120×22');
  });
});

// La coppia di un divisore NON comincia dove comincia la colonna: fra la 2ª e
// la 3ª riga la coppia parte dalla 2ª tile. Stessa cosa per le colonne: fra la
// 2ª e la 3ª la coppia parte dalla 2ª colonna.
describe('GridView resize: coppie che non partono dall\'inizio', () => {
  const treRighe = { columns: [{ width: 1, tiles: [
    { session: 'a', height: 1 }, { session: 'b', height: 1 }, { session: 'c', height: 1 },
  ] }] };
  const treColonne = { columns: [
    { width: 1, tiles: [{ session: 'a', height: 1 }] },
    { width: 1, tiles: [{ session: 'b', height: 1 }] },
    { width: 1, tiles: [{ session: 'c', height: 1 }] },
  ] };

  it('fra 2ª e 3ª riga: −50 px spostano il confine di 50 px, non lo schiacciano in fondo', async () => {
    const onLayoutChange = vi.fn();
    const { container } = render(<GridView layout={treRighe} onLayoutChange={onLayoutChange} />);
    fissa(container.querySelector('.nc-grid'), rectOf(240, 56, 900, 900));
    fissa(container.querySelector('.nc-col'), rectOf(240, 56, 900, 900));
    // 3 righe da 300 px: il divisore fra 2ª e 3ª sta a y = 56 + 600
    const div = container.querySelectorAll('.nc-divider-h')[1];
    premici(div, { clientX: 400, clientY: 656 });
    muovi(400, 606, { altKey: true });
    const guida = await aspettaGuida(container);
    expect(guida.style.top).toBe('550px'); // 606 − 56: la guida sta sotto il mouse
    window.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, clientX: 400, clientY: 606, altKey: true }));
    await waitFor(() => expect(onLayoutChange).toHaveBeenCalled());
    const [l] = onLayoutChange.mock.calls[onLayoutChange.mock.calls.length - 1];
    const h = l.columns[0].tiles.map((t) => Math.round(t.height * 1000) / 1000);
    // coppia 2ª+3ª = 600 px, confine a 250 px dal suo inizio: 2 × 250/600
    expect(h).toEqual([1, 0.833, 1.167]);
  });

  it('fra 2ª e 3ª colonna: la guida sta sotto il mouse e cambia solo la coppia', async () => {
    const onLayoutChange = vi.fn();
    const { container } = render(<GridView layout={treColonne} onLayoutChange={onLayoutChange} />);
    fissa(container.querySelector('.nc-grid'), rectOf(240, 56, 900, 800));
    const cols = container.querySelectorAll('.nc-col');
    fissa(cols[0], rectOf(240, 56, 300, 800));
    fissa(cols[1], rectOf(540, 56, 300, 800));
    fissa(cols[2], rectOf(840, 56, 300, 800));
    premici(container.querySelectorAll('.nc-divider-v')[1], { clientX: 840, clientY: 300 });
    muovi(790, 300, { altKey: true });
    const guida = await aspettaGuida(container);
    expect(guida.style.left).toBe('550px'); // 790 − 240
    window.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, clientX: 790, clientY: 300, altKey: true }));
    await waitFor(() => expect(onLayoutChange).toHaveBeenCalled());
    const [l] = onLayoutChange.mock.calls[onLayoutChange.mock.calls.length - 1];
    expect(l.columns.map((c) => Math.round(c.width * 1000) / 1000)).toEqual([1, 0.833, 1.167]);
  });
});
