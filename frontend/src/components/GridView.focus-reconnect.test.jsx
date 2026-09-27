import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

// Il focus tra finestre (staccate o in griglia) non deve MAI ricreare il
// terminale. takeSize è un'opzione di attach del PTY: sta nelle dipendenze
// dell'effetto che crea xterm+socket, quindi se cambiasse col focus ogni
// clic distruggerebbe e ricreerebbe la connessione (schermo nero/lampeggio).
// Qui GridView e GridTile sono VERI; il Terminal finto replica l'effetto di
// connessione con lo STESSO elenco di dipendenze di Terminal.jsx.
const spie = vi.hoisted(() => ({ perSessione: {} }));

vi.mock('./Terminal.jsx', () => ({
  default: function TermSpia({
    session, node, token, readonly, takeSize, sendRef, composerRef, actionRef, ctrlRef, setCtrlArmed, onFiles,
  }) {
    const spia = spie.perSessione[session]
      || (spie.perSessione[session] = { connessioni: 0, takeSize: [] });
    React.useEffect(() => {
      spia.connessioni += 1;
      spia.takeSize.push(takeSize);
    }, [session, node, token, readonly, takeSize, sendRef, composerRef, actionRef, ctrlRef, setCtrlArmed, onFiles]);
    return <div data-testid={`term-${session}`} />;
  },
}));
vi.mock('./ComposerBar.jsx', () => ({ default: () => null }));
vi.mock('./FilesPanel.jsx', () => ({ default: () => null }));
vi.mock('./CellPanel.jsx', () => ({ default: () => null }));
vi.mock('./CellPopup.jsx', () => ({ default: () => null }));
vi.mock('./Icon.jsx', () => ({ default: () => null }));
vi.mock('../lib/i18n.js', () => ({ t: (k) => k }));
vi.mock('../hooks/useLang.js', () => ({ useLang: () => ['en', vi.fn()] }));

import GridView from './GridView.jsx';

const layout = {
  columns: [
    { width: 1, tiles: [
      { session: 'a', height: 1, fontSize: 11, float: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 } },
      { session: 'b', height: 1, fontSize: 11, float: { x: 0.5, y: 0.1, w: 0.3, h: 0.3 } },
    ] },
    { width: 1, tiles: [{ session: 'c', height: 1, fontSize: 11 }] },
  ],
};

const griglia = (focus, l = layout) => (
  <GridView layout={l} onLayoutChange={() => {}} onResizeEnd={() => {}} onFocus={() => {}} focusSession={focus} />
);

beforeEach(() => { spie.perSessione = {}; });

describe('focus tra finestre: nessuna ricreazione del terminale', () => {
  it('due flottanti + una in griglia: clic A → B → griglia → A = 0 ricreazioni', () => {
    const view = render(griglia('a'));
    const prima = Object.fromEntries(['a', 'b', 'c'].map((s) => [s, spie.perSessione[s].connessioni]));
    expect(prima).toEqual({ a: 1, b: 1, c: 1 });
    for (const focus of ['b', 'c', 'a']) view.rerender(griglia(focus));
    // nessuna connessione ricreata da nessun cambio di focus
    expect(spie.perSessione.a.connessioni).toBe(1);
    expect(spie.perSessione.b.connessioni).toBe(1);
    expect(spie.perSessione.c.connessioni).toBe(1);
  });

  it('takeSize è fisso finché la finestra è staccata: vero per le flottanti, falso in griglia', () => {
    render(griglia('c'));
    expect(spie.perSessione.a.takeSize).toEqual([true]);
    expect(spie.perSessione.b.takeSize).toEqual([true]);
    expect(spie.perSessione.c.takeSize).toEqual([false]);
  });

  it('staccare riconnette UNA volta (takeSize cambia: è un\'opzione di attach), il focus dopo no', () => {
    const inGriglia = { columns: [
      { width: 1, tiles: [{ session: 'a', height: 1, fontSize: 11 }] },
      { width: 1, tiles: [{ session: 'c', height: 1, fontSize: 11 }] },
    ] };
    const staccata = { columns: [
      { width: 1, tiles: [{ session: 'a', height: 1, fontSize: 11, float: { x: 0.1, y: 0.1, w: 0.3, h: 0.3 } }] },
      { width: 1, tiles: [{ session: 'c', height: 1, fontSize: 11 }] },
    ] };
    const view = render(griglia('c', inGriglia));
    expect(spie.perSessione.a.connessioni).toBe(1);
    view.rerender(griglia('c', staccata));
    expect(spie.perSessione.a.connessioni).toBe(2); // una sola, dichiarata
    view.rerender(griglia('a', staccata));
    view.rerender(griglia('c', staccata));
    expect(spie.perSessione.a.connessioni).toBe(2);
    expect(spie.perSessione.c.connessioni).toBe(1);
  });
});
