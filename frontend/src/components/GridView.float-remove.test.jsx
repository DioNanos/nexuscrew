import React, { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

// Togliere una finestra staccata: «rimetti nella griglia» e la × stanno nella
// barra del titolo, che è anche la maniglia per spostare la finestra. Un
// pointerdown sui tasti NON deve avviare lo spostamento: nel browser lo
// spostamento cattura il puntatore, il click non arriva al tasto e il
// pointerup salva la geometria invariata — la finestra resta staccata.
vi.mock('./Terminal.jsx', () => ({ default: () => <div data-testid="term" /> }));
vi.mock('./ComposerBar.jsx', () => ({ default: () => null }));
vi.mock('./FilesPanel.jsx', () => ({ default: () => null }));
vi.mock('./CellPanel.jsx', () => ({ default: () => null }));
vi.mock('./CellPopup.jsx', () => ({ default: () => null }));
vi.mock('./Icon.jsx', () => ({ default: () => null }));
vi.mock('../lib/i18n.js', () => ({ t: (k) => k }));
vi.mock('../hooks/useLang.js', () => ({ useLang: () => ['en', vi.fn()] }));

import GridView from './GridView.jsx';

const iniziale = () => ({ columns: [
  { width: 1, tiles: [{ session: 'a', height: 1, fontSize: 11 }] },
  { width: 1, tiles: [{ session: 'dev', height: 1, fontSize: 11, float: { x: 0.4, y: 0.2, w: 0.4, h: 0.5 } }] },
] });

function monta() {
  const chiamate = [];
  let corrente = iniziale();
  function Genitore() {
    const [layout, setLayout] = useState(iniziale());
    corrente = layout;
    return <GridView layout={layout} onLayoutChange={(l) => { chiamate.push(l); setLayout(l); }} onFocus={() => {}} focusSession="a" />;
  }
  const view = render(<Genitore />);
  return { view, chiamate, stato: () => corrente };
}

// la sequenza vera di un clic col mouse: pointerdown sul tasto (bolle fino
// alla barra), pointerup sulla finestra, click sul tasto
function clicVero(el) {
  const r = { bubbles: true, button: 0, clientX: 10, clientY: 10 };
  act(() => { el.dispatchEvent(new window.MouseEvent('pointerdown', r)); });
  act(() => { window.dispatchEvent(new window.MouseEvent('pointerup', r)); });
  act(() => { el.dispatchEvent(new window.MouseEvent('click', r)); });
}
const flottanti = (l) => l.columns.flatMap((c) => c.tiles).filter((t) => t.float).map((t) => t.session);
const sessioni = (l) => l.columns.flatMap((c) => c.tiles).map((t) => t.session).sort();

describe('togliere una finestra staccata dai tasti della sua barra', () => {
  it('«rimetti nella griglia»: una sola modifica, la finestra torna in griglia', () => {
    const { view, chiamate, stato } = monta();
    clicVero(view.getByLabelText('tile-reattach'));
    expect(chiamate).toHaveLength(1);
    expect(flottanti(stato())).toEqual([]);
    expect(sessioni(stato())).toEqual(['a', 'dev']);
  });

  it('× sulla finestra staccata: una sola modifica, la finestra sparisce', () => {
    const { view, chiamate, stato } = monta();
    const barra = view.container.querySelector('.nc-float-head');
    clicVero(barra.querySelector('.nc-tile-close'));
    expect(chiamate).toHaveLength(1);
    expect(sessioni(stato())).toEqual(['a']);
  });

  it('riduci: nessuno spostamento avviato, nessuna modifica del layout', () => {
    const { view, chiamate } = monta();
    clicVero(view.getByLabelText('tile-minimize'));
    expect(chiamate).toHaveLength(0);
  });

  it('la barra fuori dai tasti resta la maniglia: trascinare sposta la finestra', () => {
    const { view, chiamate, stato } = monta();
    const nome = view.container.querySelector('.nc-float-head');
    act(() => { nome.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0, clientX: 100, clientY: 100 })); });
    act(() => { window.dispatchEvent(new window.MouseEvent('pointermove', { bubbles: true, clientX: 100 + window.innerWidth * 0.1, clientY: 100 })); });
    act(() => { window.dispatchEvent(new window.MouseEvent('pointerup', { bubbles: true, clientX: 100 + window.innerWidth * 0.1, clientY: 100 })); });
    expect(chiamate).toHaveLength(1);
    expect(flottanti(stato())).toEqual(['dev']);
    expect(stato().columns[1].tiles[0].float.x).toBeCloseTo(0.5, 5);
  });
});
