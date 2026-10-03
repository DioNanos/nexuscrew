import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';

// Il gesto della griglia desktop: resize a coppia in px
// (bordo 1:1, UN solo onLayoutChange al rilascio, non adiacenti invariate),
// aggancio magnetico con Alt che lo spegne, doppio clic = coppia a metà,
// annullamento (pointercancel/blur/unmount, Esc durante lo spostamento),
// scambio al centro, nessuna ricreazione di tile durante il gesto.
// jsdom non porta clientX/clientY né dataTransfer negli eventi sintetici:
// eventi costruiti a mano con le proprietà definite.
const spia = { istanze: 0 };

vi.mock('./GridTile.jsx', () => ({
  default: function TileMock({ session, onDragTileStart }) {
    React.useEffect(() => { spia.istanze += 1; return () => { spia.istanze -= 1; }; }, []);
    return (
      <div className="nc-tile-head" data-testid={`tile-${session}`} draggable
        onDragStart={(e) => { e.dataTransfer.setData('text/nc-session', session); if (onDragTileStart) onDragTileStart(session); }} />
    );
  },
}));

import GridView from './GridView.jsx';

const evento = (type, props) => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
  return e;
};
const dtDi = (nome) => ({
  types: ['text/nc-session'],
  getData: (t) => (t === 'text/nc-session' ? nome : ''),
  setData() {},
});

const twoCols = () => ({ columns: [{ width: 1, tiles: [{ session: 'a', height: 1 }] }, { width: 1, tiles: [{ session: 'b', height: 1 }] }] });
const threeCols = () => ({ columns: [
  { width: 1, tiles: [{ session: 'a', height: 1 }] },
  { width: 1, tiles: [{ session: 'b', height: 1 }] },
  { width: 1, tiles: [{ session: 'c', height: 1 }] },
] });
const oneColTwoRows = () => ({ columns: [{ width: 1, tiles: [{ session: 'a', height: 1 }, { session: 'b', height: 1 }] }] });

function montaGrid(layout, extra = {}) {
  const onLayoutChange = vi.fn();
  const onResizeEnd = vi.fn();
  const view = render(
    <GridView layout={layout} onLayoutChange={onLayoutChange} onResizeEnd={onResizeEnd} {...extra} />,
  );
  return { view, onLayoutChange, onResizeEnd };
}

function misura(view, w = 800, h = 600) {
  const grid = view.container.querySelector('.nc-grid');
  Object.defineProperty(grid, 'clientWidth', { value: w, configurable: true });
  Object.defineProperty(grid, 'clientHeight', { value: h, configurable: true });
  return grid;
}

describe('GridView gesto resize a coppia', () => {
  it('il divisore tra seconda e terza riga segue la sua coppia', async () => {
    const layout = { columns: [{ width: 1, tiles: [
      { session: 'a', height: 1 }, { session: 'b', height: 1 }, { session: 'c', height: 1 },
    ] }] };
    const { view, onLayoutChange } = montaGrid(layout);
    const grid = misura(view, 800, 600);
    const col = view.container.querySelector('.nc-col');
    Object.defineProperty(grid, 'getBoundingClientRect', { value: () => ({ top: 100, left: 0, width: 800, height: 600 }), configurable: true });
    Object.defineProperty(col, 'getBoundingClientRect', { value: () => ({ top: 100, left: 0, width: 800, height: 600 }), configurable: true });
    Object.defineProperty(col, 'clientHeight', { value: 600, configurable: true });
    const second = view.container.querySelectorAll('.nc-divider-h')[1];
    fireEvent(second, evento('pointerdown', { clientX: 5, clientY: 500, pointerId: 7 }));
    fireEvent(window, evento('pointermove', { clientX: 5, clientY: 450, altKey: true }));
    fireEvent(window, evento('pointerup', {}));
    await waitFor(() => expect(onLayoutChange).toHaveBeenCalledTimes(1));
    const tiles = onLayoutChange.mock.calls[0][0].columns[0].tiles;
    expect(tiles[0].height).toBe(1);
    expect(tiles[1].height).toBeCloseTo(0.75, 10);
    expect(tiles[2].height).toBeCloseTo(1.25, 10);
  });
  it('2 colonne: il bordo segue il mouse 1:1 e UN solo onLayoutChange al rilascio', async () => {
    const { view, onLayoutChange, onResizeEnd } = montaGrid(twoCols());
    misura(view, 800);
    const divisore = view.container.querySelector('.nc-divider-v');
    fireEvent(divisore, evento('pointerdown', { clientX: 400, clientY: 10, pointerId: 1 }));
    fireEvent(window, evento('pointermove', { clientX: 340, clientY: 10 }));
    fireEvent(window, evento('pointermove', { clientX: 300, clientY: 10 }));
    expect(onLayoutChange).not.toHaveBeenCalled(); // durante il gesto il layout non cambia
    fireEvent(window, evento('pointerup', { }));
    await waitFor(() => expect(onLayoutChange).toHaveBeenCalledTimes(1));
    const out = onLayoutChange.mock.calls[0][0];
    expect(out.columns[0].width).toBeCloseTo(0.75, 10);
    expect(out.columns[1].width).toBeCloseTo(1.25, 10);
    expect(onResizeEnd).toHaveBeenCalledTimes(1);
  });

  it('3 colonne: cambiano solo le due adiacenti, la terza resta esattamente 1', async () => {
    const { view, onLayoutChange } = montaGrid(threeCols());
    misura(view, 900);
    const divisore = view.container.querySelector('.nc-divider-v');
    fireEvent(divisore, evento('pointerdown', { clientX: 300, clientY: 5, pointerId: 1 }));
    fireEvent(window, evento('pointermove', { clientX: 150, clientY: 5 }));
    fireEvent(window, evento('pointerup', {}));
    await waitFor(() => expect(onLayoutChange).toHaveBeenCalledTimes(1));
    const out = onLayoutChange.mock.calls[0][0];
    expect(out.columns[0].width).toBeCloseTo(0.5, 10);
    expect(out.columns[1].width).toBeCloseTo(1.5, 10);
    expect(out.columns[2].width).toBe(1);
  });

  it('righe: stesso contratto in verticale', async () => {
    const { view, onLayoutChange } = montaGrid(oneColTwoRows());
    misura(view, 800, 600);
    const divisore = view.container.querySelector('.nc-divider-h');
    fireEvent(divisore, evento('pointerdown', { clientX: 5, clientY: 300, pointerId: 1 }));
    fireEvent(window, evento('pointermove', { clientX: 5, clientY: 240 }));
    fireEvent(window, evento('pointerup', {}));
    await waitFor(() => expect(onLayoutChange).toHaveBeenCalledTimes(1));
    const out = onLayoutChange.mock.calls[0][0];
    expect(out.columns[0].tiles[0].height).toBeCloseTo(0.8, 10);
    expect(out.columns[0].tiles[1].height).toBeCloseTo(1.2, 10);
  });

  it('aggancio: vicino a 1/2 la coppia torna pari; con Alt resta dove sta il mouse', async () => {
    const aggancio = await (async () => {
      const { view, onLayoutChange } = montaGrid(twoCols());
      misura(view, 800);
      const d = view.container.querySelector('.nc-divider-v');
      fireEvent(d, evento('pointerdown', { clientX: 400, clientY: 5, pointerId: 1 }));
      fireEvent(window, evento('pointermove', { clientX: 392, clientY: 5 }));
      fireEvent(window, evento('pointerup', {}));
      await waitFor(() => expect(onLayoutChange).toHaveBeenCalledTimes(1));
      return onLayoutChange.mock.calls[0][0];
    })();
    expect(aggancio.columns[0].width).toBeCloseTo(1, 10); // agganciato a 1/2

    const { view, onLayoutChange } = montaGrid(twoCols());
    misura(view, 800);
    const d = view.container.querySelector('.nc-divider-v');
    fireEvent(d, evento('pointerdown', { clientX: 400, clientY: 5, pointerId: 2 }));
    fireEvent(window, evento('pointermove', { clientX: 392, clientY: 5, altKey: true }));
    fireEvent(window, evento('pointerup', {}));
    await waitFor(() => expect(onLayoutChange).toHaveBeenCalledTimes(1));
    const libero = onLayoutChange.mock.calls[0][0];
    expect(libero.columns[0].width).toBeCloseTo(0.98, 10);
    expect(libero.columns[1].width).toBeCloseTo(1.02, 10);
  });

  it('doppio clic sul divisore: coppia a metà con un solo salvataggio', async () => {
    const { view, onLayoutChange, onResizeEnd } = montaGrid(threeCols());
    misura(view, 900);
    fireEvent.dblClick(view.container.querySelector('.nc-divider-v'));
    await waitFor(() => expect(onLayoutChange).toHaveBeenCalledTimes(1));
    const out = onLayoutChange.mock.calls[0][0];
    expect(out.columns[0].width).toBeCloseTo(1, 10);
    expect(out.columns[1].width).toBeCloseTo(1, 10);
    expect(onResizeEnd).toHaveBeenCalledTimes(1);
  });

  it('pointercancel e blur annullano: nessun layout, nessun salvataggio, gesto pulito', async () => {
    for (const fine of ['pointercancel', 'blur']) {
      const { view, onLayoutChange, onResizeEnd } = montaGrid(twoCols());
      misura(view, 800);
      const d = view.container.querySelector('.nc-divider-v');
      fireEvent(d, evento('pointerdown', { clientX: 400, clientY: 5, pointerId: 1 }));
      fireEvent(window, evento('pointermove', { clientX: 300, clientY: 5 }));
      fireEvent(window, evento(fine, {}));
      expect(onLayoutChange).not.toHaveBeenCalled();
      expect(onResizeEnd).not.toHaveBeenCalled();
      await waitFor(() => expect(view.container.querySelector('.nc-gesture-shield')).toBeNull());
      // il gesto è davvero chiuso: un pointerup tardivo non applica nulla
      fireEvent(window, evento('pointerup', {}));
      await new Promise((r) => setTimeout(r, 10));
      expect(onLayoutChange).not.toHaveBeenCalled();
    }
  });

  it('smontare a metà gesto non lascia listener né crasha', () => {
    const { view, onLayoutChange } = montaGrid(twoCols());
    misura(view, 800);
    const d = view.container.querySelector('.nc-divider-v');
    fireEvent(d, evento('pointerdown', { clientX: 400, clientY: 5, pointerId: 1 }));
    fireEvent(window, evento('pointermove', { clientX: 350, clientY: 5 }));
    view.unmount();
    fireEvent(window, evento('pointermove', { clientX: 300, clientY: 5 }));
    fireEvent(window, evento('pointerup', {}));
    expect(onLayoutChange).not.toHaveBeenCalled();
    expect(true).toBe(true); // nessuna eccezione = pulito
  });

  it('il badge mostra le misure COLONNE×RIGHE dei due lati (non i pixel)', async () => {
    const { view, onLayoutChange } = montaGrid(twoCols());
    misura(view, 800, 600); // fontSize tile 11: charW 6.6, rowH 13.2
    const d = view.container.querySelector('.nc-divider-v');
    fireEvent(d, evento('pointerdown', { clientX: 400, clientY: 10, pointerId: 1 }));
    fireEvent(window, evento('pointermove', { clientX: 300, clientY: 10 }));
    await waitFor(() => expect(view.container.querySelector('.nc-gesture-badge')).toBeTruthy());
    const badge = view.container.querySelector('.nc-gesture-badge');
    // lato A: 300px/6.6 = 45 colonne; lato B: 500px/6.6 = 76; righe 600/13.2 = 45
    expect(badge.textContent).toContain('45×45');
    expect(badge.textContent).toContain('76×45');
    expect(badge.textContent).not.toContain('px');
    fireEvent(window, evento('pointerup', {}));
    await waitFor(() => expect(onLayoutChange).toHaveBeenCalledTimes(1));
  });

  it('durante il gesto nessun tile si ricrea (spia istanze) e lo scudo copre la griglia', async () => {
    const prima = spia.istanze;
    const { view, onLayoutChange } = montaGrid(threeCols());
    expect(spia.istanze).toBe(prima + 3);
    misura(view, 900);
    const d = view.container.querySelector('.nc-divider-v');
    fireEvent(d, evento('pointerdown', { clientX: 300, clientY: 5, pointerId: 1 }));
    for (let i = 0; i < 5; i += 1) fireEvent(window, evento('pointermove', { clientX: 300 - i * 10, clientY: 5 }));
    await waitFor(() => expect(view.container.querySelector('.nc-gesture-shield')).toBeTruthy());
    expect(view.container.querySelectorAll('.nc-gesture-guide').length).toBeGreaterThan(0);
    fireEvent(window, evento('pointerup', {}));
    await waitFor(() => expect(onLayoutChange).toHaveBeenCalledTimes(1));
    expect(spia.istanze).toBe(prima + 3); // mai smontati/ricreati
    view.unmount();
  });
});

describe('GridView spostamento: ghost, zone, scambio, Esc', () => {
  function rectSu(el, r) {
    for (const [k, v] of Object.entries(r)) Object.defineProperty(el, k, { value: v, configurable: true });
    Object.defineProperty(el, 'getBoundingClientRect', { value: () => r, configurable: true });
  }

  it('dragOver sul centro di un’altra finestra: zona center, drop = scambio', async () => {
    const { view, onLayoutChange } = montaGrid(twoCols());
    const slots = view.container.querySelectorAll('.nc-tile-slot');
    rectSu(slots[1], { left: 0, top: 0, width: 100, height: 100 });
    fireEvent(view.container.querySelector('[data-testid="tile-a"]'), evento('dragstart', { dataTransfer: dtDi('a') }));
    fireEvent(slots[1], evento('dragover', { clientX: 50, clientY: 50, dataTransfer: dtDi('a') }));
    await waitFor(() => expect(slots[1].className).toContain('drop-center'));
    // le CINQUE zone del design sono tutte disegnate, accesa solo quella attiva
    const zone = slots[1].querySelectorAll('.nc-drop-zone');
    expect(Array.from(zone).map((z) => z.getAttribute('data-zone'))).toEqual(['left', 'top', 'center', 'bottom', 'right']);
    expect(Array.from(zone).filter((z) => z.className.includes(' on')).map((z) => z.getAttribute('data-zone'))).toEqual(['center']);
    // la copia che segue il mouse porta il titolo della finestra spostata
    expect(view.container.querySelector('[data-testid="nc-drag-ghost"]').textContent).toContain('a');
    fireEvent(slots[1], evento('drop', { clientX: 50, clientY: 50, dataTransfer: dtDi('a') }));
    await waitFor(() => expect(onLayoutChange).toHaveBeenCalledTimes(1));
    const out = onLayoutChange.mock.calls[0][0];
    expect(out.columns[0].tiles[0].session).toBe('b');
    expect(out.columns[1].tiles[0].session).toBe('a');
    // geometria invariata
    expect(out.columns[0].width).toBe(1);
    expect(out.columns[1].width).toBe(1);
  });

  it('Esc durante lo spostamento annulla: anteprima via e drop ignorato', async () => {
    const { view, onLayoutChange } = montaGrid(twoCols());
    const slots = view.container.querySelectorAll('.nc-tile-slot');
    rectSu(slots[1], { left: 0, top: 0, width: 100, height: 100 });
    fireEvent(view.container.querySelector('[data-testid="tile-a"]'), evento('dragstart', { dataTransfer: dtDi('a') }));
    fireEvent(slots[1], evento('dragover', { clientX: 50, clientY: 50, dataTransfer: dtDi('a') }));
    await waitFor(() => expect(slots[1].className).toContain('drop-center'));
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(slots[1].className).not.toContain('drop-center'));
    fireEvent(slots[1], evento('drop', { clientX: 50, clientY: 50, dataTransfer: dtDi('a') }));
    await new Promise((r) => setTimeout(r, 10));
    expect(onLayoutChange).not.toHaveBeenCalled();
  });

  it('il bordo con freccia resta per i quattro lati (regressione zone)', async () => {
    const { view } = montaGrid(twoCols());
    const slots = view.container.querySelectorAll('.nc-tile-slot');
    rectSu(slots[1], { left: 0, top: 0, width: 100, height: 100 });
    fireEvent(view.container.querySelector('[data-testid="tile-a"]'), evento('dragstart', { dataTransfer: dtDi('a') }));
    fireEvent(slots[1], evento('dragover', { clientX: 95, clientY: 50, dataTransfer: dtDi('a') }));
    await waitFor(() => expect(slots[1].className).toContain('drop-right'));
  });
});
