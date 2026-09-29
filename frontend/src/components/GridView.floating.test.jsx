import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';

// Finestre flottanti — la finestra staccata è lo STESSO tile nella stessa posizione
// dell'albero (flag float + position:fixed): staccare e riattaccare NON deve
// smontare il tile. Gesti 1:1 con commit UNA volta al rilascio, clic = primo
// piano + focus (takeSize fisso: il focus non riconnette, vedi
// GridView.focus-reconnect.test.jsx), – riduce, × chiude, Esc annulla.
const spie = { perSessione: {}, focus: [] };

vi.mock('./GridTile.jsx', () => ({
  default: function TileMock({ session, floating, onDetach, onReattach, onClose, onFocus, takeSize, onFloatDragStart, onToggleMinimize, minimized }) {
    const spia = spie.perSessione[session]
      || (spie.perSessione[session] = { istanze: 0, props: {} });
    React.useEffect(() => { spia.istanze += 1; return () => { spia.istanze -= 1; }; }, []);
    spia.props = { floating, takeSize, minimized };
    return (
      <div data-testid={`tile-${session}`}>
        <div className="nc-tile-head" data-testid={`head-${session}`}
          onPointerDown={(e) => { onFocus && onFocus(session); if (floating && onFloatDragStart) onFloatDragStart(e); }}>
          <button data-testid={`detach-${session}`} onClick={() => onDetach && onDetach(session)}>stacca</button>
          {floating && <button data-testid={`reattach-${session}`} onClick={() => onReattach && onReattach(session)}>riattacca</button>}
          {floating && <button data-testid={`min-${session}`} onClick={() => onToggleMinimize && onToggleMinimize(session)}>–</button>}
          {floating && <button data-testid={`close-${session}`} onClick={() => onClose && onClose(session)}>chiudi</button>}
        </div>
      </div>
    );
  },
}));

import GridView from './GridView.jsx';

const evento = (type, props) => {
  const e = new Event(type, { bubbles: true, cancelable: true });
  for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
  return e;
};

const due = () => ({
  columns: [
    { width: 1, tiles: [
      { session: 'a', height: 1, fontSize: 11 },
      { session: 'b', height: 1, fontSize: 11 },
    ] },
    { width: 1, tiles: [{ session: 'sola', height: 1, fontSize: 11 }] },
  ],
});

function monta(layout, extra = {}) {
  const onLayoutChange = vi.fn();
  const onResizeEnd = vi.fn();
  const onFocus = vi.fn();
  const view = render(<GridView layout={layout} onLayoutChange={onLayoutChange} onResizeEnd={onResizeEnd} onFocus={onFocus} {...extra} />);
  return { view, onLayoutChange, onResizeEnd, onFocus };
}

describe('GridView finestre flottanti', () => {
  it('stacca: flag float nel layout, slot fixed, colonna svuotata collassa, NESSUN remount', async () => {
    spie.perSessione = {};
    const { view, onLayoutChange } = monta(due());
    expect(spie.perSessione.sola.istanze).toBe(1);
    fireEvent.click(screen_by('detach-sola', view));
    await waitFor(() => expect(onLayoutChange).toHaveBeenCalledTimes(1));
    const out = onLayoutChange.mock.calls[0][0];
    const sola = out.columns.flatMap((c) => c.tiles).find((t) => t.session === 'sola');
    expect(sola.float).toMatchObject({ x: expect.any(Number), y: expect.any(Number), w: expect.any(Number), h: expect.any(Number) });
    // il layout ricaricato (come farebbe App) mostra lo slot flottante fixed
    view.rerender(<GridView layout={out} onLayoutChange={onLayoutChange} onResizeEnd={vi.fn()} onFocus={vi.fn()} />);
    const slot = view.container.querySelector('[data-testid="tile-sola"]').closest('.nc-tile-slot');
    await waitFor(() => expect(slot.className).toContain('nc-float'));
    expect(slot.style.position).toBe('fixed');
    // la colonna che conteneva SOLO lei collassa (griglia ricomposta)
    const collassate = view.container.querySelectorAll('.nc-col.nc-col-emptyfloat');
    expect(collassate.length).toBe(1);
    // collasso VERO: l'inline flexGrow della colonna è 0 (l'inline vince sulla classe)
    expect(collassate[0].style.flexGrow).toBe('0');
    // e nessun divisore accanto a una colonna che non occupa spazio
    expect(view.container.querySelectorAll('.nc-divider-v').length).toBe(0);
    // il terminale non si è ricreato
    expect(spie.perSessione.sola.istanze).toBe(1);
    expect(spie.perSessione.a.istanze).toBe(1);
  });

  it('riattacca: flag via, slot nel flusso, sempre nessun remount', async () => {
    spie.perSessione = {};
    const staccata = due();
    staccata.columns[1].tiles[0].float = { x: 0.5, y: 0.2, w: 0.4, h: 0.5 };
    const { view, onLayoutChange } = monta(staccata);
    expect(spie.perSessione.sola.istanze).toBe(1);
    fireEvent.click(screen_by('reattach-sola', view));
    await waitFor(() => expect(onLayoutChange).toHaveBeenCalledTimes(1));
    const out = onLayoutChange.mock.calls[0][0];
    expect(out.columns.flatMap((c) => c.tiles).find((t) => t.session === 'sola').float).toBeUndefined();
    view.rerender(<GridView layout={out} onLayoutChange={onLayoutChange} onResizeEnd={vi.fn()} onFocus={vi.fn()} />);
    const slot = view.container.querySelector('[data-testid="tile-sola"]').closest('.nc-tile-slot');
    await waitFor(() => expect(slot.className).not.toContain('nc-float'));
    expect(slot.style.position).toBe('');
    expect(spie.perSessione.sola.istanze).toBe(1);
  });

  it('sposta dalla barra del titolo: 1:1, UN commit al rilascio, Esc annulla', async () => {
    const layout = due();
    layout.columns[0].tiles[0].float = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
    const { view, onLayoutChange } = monta(layout);
    const head = screen_by('head-a', view);
    fireEvent(head, evento('pointerdown', { clientX: 300, clientY: 200, pointerId: 3 }));
    fireEvent(window, evento('pointermove', { clientX: 150, clientY: 100 }));
    fireEvent(window, evento('pointerup', {}));
    await waitFor(() => expect(onLayoutChange).toHaveBeenCalledTimes(1));
    const out = onLayoutChange.mock.calls[0][0];
    const a = out.columns.flatMap((c) => c.tiles).find((t) => t.session === 'a');
    expect(a.float.x).toBeCloseTo(0.2 - 150 / window.innerWidth, 8);
    expect(a.float.y).toBeCloseTo(0.2 - 100 / window.innerHeight, 8);

    // aggancio al bordo dello schermo: trascinando verso sinistra la finestra
    // si allinea a x=0 (nessun valore fuori schermo)
    fireEvent(head, evento('pointerdown', { clientX: 200, clientY: 200, pointerId: 6 }));
    fireEvent(window, evento('pointermove', { clientX: -400, clientY: 150 }));
    fireEvent(window, evento('pointerup', {}));
    await waitFor(() => expect(onLayoutChange).toHaveBeenCalledTimes(2));
    const agganciata = onLayoutChange.mock.calls[1][0].columns.flatMap((c) => c.tiles).find((t) => t.session === 'a');
    expect(agganciata.float.x).toBe(0);

    // Esc durante il drag: nessun commit
    fireEvent(head, evento('pointerdown', { clientX: 100, clientY: 100, pointerId: 4 }));
    fireEvent(window, evento('pointermove', { clientX: 10, clientY: 10 }));
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent(window, evento('pointerup', {}));
    await new Promise((r) => setTimeout(r, 20));
    // i commit restano quelli dei due drag andati a buon fine (l'Esc non aggiunge)
    expect(onLayoutChange).toHaveBeenCalledTimes(2);
  });

  it('ridimensiona dall’angolo: 1:1, commit + UN onResizeEnd, badge colonne×righe', async () => {
    const layout = due();
    layout.columns[0].tiles[0].float = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
    const { view, onLayoutChange, onResizeEnd } = monta(layout);
    const se = await waitForSe(view);
    fireEvent(se, evento('pointerdown', { clientX: 500, clientY: 400, pointerId: 5 }));
    fireEvent(window, evento('pointermove', { clientX: 300, clientY: 200 }));
    await waitFor(() => expect(view.container.querySelector('.nc-gesture-badge')).toBeTruthy());
    expect(view.container.querySelector('.nc-gesture-badge').textContent).not.toContain('px');
    fireEvent(window, evento('pointerup', {}));
    await waitFor(() => expect(onLayoutChange).toHaveBeenCalledTimes(1));
    const out = onLayoutChange.mock.calls[0][0];
    const a = out.columns.flatMap((c) => c.tiles).find((t) => t.session === 'a');
    expect(a.float.w).toBeCloseTo(0.4 - 200 / window.innerWidth, 8);
    expect(a.float.h).toBeCloseTo(0.4 - 200 / window.innerHeight, 8);
    expect(onResizeEnd).toHaveBeenCalledTimes(1);
  });

  it('clic = primo piano + focus; takeSize fisso per ogni flottante, indipendente dal focus', async () => {
    spie.perSessione = {};
    const layout = due();
    layout.columns[0].tiles[0].float = { x: 0.1, y: 0.1, w: 0.3, h: 0.3 };
    layout.columns[0].tiles[1].float = { x: 0.5, y: 0.1, w: 0.3, h: 0.3 };
    const { view, onFocus } = monta(layout);
    const slotA = view.container.querySelector('[data-testid="tile-a"]').closest('.nc-tile-slot');
    const slotB = view.container.querySelector('[data-testid="tile-b"]').closest('.nc-tile-slot');
    fireEvent.pointerDown(slotA);
    await waitFor(() => expect(onFocus).toHaveBeenCalledWith('a'));
    const zA = Number(slotA.style.zIndex);
    fireEvent.pointerDown(slotB);
    await waitFor(() => expect(Number(slotB.style.zIndex)).toBeGreaterThan(zA));
    // il focus percorso App: la prop focusSession arriva al giro dopo
    view.rerender(<GridView layout={layout} onLayoutChange={vi.fn()} onResizeEnd={vi.fn()} onFocus={onFocus} focusSession="b" />);
    // takeSize non segue il focus (cambiarlo ricreerebbe il terminale): vero per
    // entrambe le flottanti, prima e dopo il cambio di focus
    await waitFor(() => expect(spie.perSessione.b.props.takeSize).toBe(true));
    expect(spie.perSessione.a.props.takeSize).toBe(true);
  });

  it('– riduce a barra titolo e il ripristino la riapre; × chiude', async () => {
    const layout = due();
    layout.columns[0].tiles[0].float = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
    const { view, onLayoutChange } = monta(layout);
    const slot = view.container.querySelector('[data-testid="tile-a"]').closest('.nc-tile-slot');
    await waitFor(() => expect(slot.className).toContain('nc-float'));
    fireEvent.click(screen_by('min-a', view));
    await waitFor(() => expect(slot.className).toContain('nc-float-mini'));
    fireEvent.click(screen_by('min-a', view));
    await waitFor(() => expect(slot.className).not.toContain('nc-float-mini'));
    // × chiude: removeTile
    fireEvent.click(screen_by('close-a', view));
    await waitFor(() => expect(onLayoutChange).toHaveBeenCalledTimes(1));
    const out = onLayoutChange.mock.calls[0][0];
    expect(out.columns.flatMap((c) => c.tiles).find((t) => t.session === 'a')).toBeUndefined();
  });
});

describe('una finestra staccata non è una destinazione di spostamento', () => {
  it('dragover sopra la flottante non accende zone né drop', async () => {
    const layout = due();
    layout.columns[0].tiles[0].float = { x: 0.2, y: 0.2, w: 0.4, h: 0.4 };
    const { view } = monta(layout);
    const slotA = view.container.querySelector('[data-testid="tile-a"]').closest('.nc-tile-slot');
    Object.defineProperty(slotA, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 100, height: 100 }), configurable: true });
    const dt = { types: ['text/nc-session'], getData: () => 'b', setData() {} };
    fireEvent(slotA, evento('dragover', { clientX: 50, clientY: 50, dataTransfer: dt }));
    await new Promise((r) => setTimeout(r, 10));
    expect(slotA.className).not.toContain('drop-');
    expect(view.container.querySelector('[data-testid="nc-drop-zones"]')).toBeNull();
  });
});

function screen_by(testid, view) {
  return view.container.querySelector(`[data-testid="${testid}"]`);
}
async function waitForSe(view) {
  return waitFor(() => {
    const el = view.container.querySelector('[data-testid="float-resize-se"]');
    expect(el).toBeTruthy();
    return el;
  });
}
