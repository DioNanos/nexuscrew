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
