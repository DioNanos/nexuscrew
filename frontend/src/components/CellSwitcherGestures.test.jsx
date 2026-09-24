import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

// I bordi del GESTO della lista celle e del CICLO DI VITA della selezione:
// il tap fermo seleziona, un cancel o due dita non consumano l'attivazione
// da tastiera né aprono, lo spostamento conta nel suo massimo (anche se il
// dito torna), e la selezione muore con la riga che non si vede più —
// sparita, fermata col filtro attive, o andata: al ritorno si ricomincia
// dal tocco. Il percorso normale (un tocco seleziona, il secondo apre col
// ricontrollo fresco) sta in CellSwitcher.test.jsx.

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(), fleetStatus: vi.fn(), getRouteSessions: vi.fn(),
  getLiveHost: vi.fn(), designateHostCell: vi.fn(), clearHostCell: vi.fn(),
}));
vi.mock('../lib/api.js', () => ({
  apiFetch: mocks.apiFetch, fleetStatus: mocks.fleetStatus, getRouteSessions: mocks.getRouteSessions,
  getLiveHost: mocks.getLiveHost, designateHostCell: mocks.designateHostCell, clearHostCell: mocks.clearHostCell,
}));
vi.mock('./Terminal.jsx', () => ({ default: (props) => (
  <div data-testid="peek-term" data-session={props.session}
    data-fontsize={props.fontSize} data-readonly={String(!!props.readonly)} />
) }));
vi.mock('./CellPanel.jsx', () => ({
  default: (props) => (
    <div data-testid="peek-panel" data-cell={props.cellId} data-panel-port={props.panelPort} data-route={JSON.stringify(props.route)} />
  ),
}));

import CellSwitcher from './CellSwitcher.jsx';
import { writeCellSwitcherSnapshot } from '../lib/cell-switcher-cache.js';

const active = (cell, tmuxSession) => ({ cell, tmuxSession, active: true, tmux: true, engine: 'claude.native' });

// jsdom non ha PointerEvent: si costruisce un MouseEvent con pointerId e
// isPrimary definiti sopra, come farebbe un browser per un dito vero.
function rowPointer(el, type, x = 20, y = 100, more = {}) {
  const ev = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
  Object.defineProperty(ev, 'pointerId', { value: more.id || 1 });
  Object.defineProperty(ev, 'isPrimary', { value: more.primary !== false });
  fireEvent(el, ev);
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  const cells = [active('cell-One', 'cloud-cell-One'), active('cell-Two', 'cloud-cell-Two')];
  const sessions = cells.map((c) => ({ name: c.tmuxSession, activity: 1 }));
  writeCellSwitcherSnapshot({ sessions, cells, localFresh: true, nodeGroups: [] });
  mocks.apiFetch.mockResolvedValue({ json: async () => ({ sessions }) });
  mocks.getRouteSessions.mockResolvedValue({ sessions: [] });
  mocks.fleetStatus.mockResolvedValue({ available: true, cells });
});

describe('CellSwitcher — i bordi del gesto e della selezione', () => {
  it('un puntatore fermo seleziona: pointerdown e click nello stesso punto', async () => {
    render(<CellSwitcher token="t" onClose={() => {}} onPick={() => {}} />);
    const riga = await screen.findByRole('button', { name: /^cell-One / });
    rowPointer(riga, 'pointerdown');
    fireEvent.click(riga, { clientX: 20, clientY: 100, detail: 1 });
    expect(screen.queryByTestId('peek-term')).not.toBeNull();
  });

  it('un cancel non consuma l\'attivazione da tastiera che viene dopo', async () => {
    render(<CellSwitcher token="t" onClose={() => {}} onPick={() => {}} />);
    const riga = await screen.findByRole('button', { name: /^cell-One / });
    rowPointer(riga, 'pointerdown');
    rowPointer(riga, 'pointercancel');
    // Invio/Spazio: click senza gesto di puntatore (detail 0, coordinate 0).
    fireEvent.click(riga, { detail: 0, clientX: 0, clientY: 0 });
    expect(screen.queryByTestId('peek-term')).not.toBeNull();
  });

  it('una seconda dita invalida il gesto: il click del primo dito non apre', async () => {
    const pick = vi.fn();
    render(<CellSwitcher token="t" onClose={() => {}} onPick={pick} />);
    const riga = await screen.findByRole('button', { name: /^cell-One / });
    fireEvent.click(riga); // primo tocco (tastiera nei test): seleziona
    rowPointer(riga, 'pointerdown', 20, 100, { id: 1 });
    rowPointer(riga, 'pointerdown', 21, 100, { id: 2, primary: false });
    await act(async () => {
      fireEvent.click(riga, { clientX: 20, clientY: 100, detail: 1 });
      await Promise.resolve();
    });
    expect(pick).not.toHaveBeenCalled();
  });

  it('il gesto appartiene alla riga dove è nato: un click su un\'altra riga non lo conclude', async () => {
    render(<CellSwitcher token="t" onClose={() => {}} onPick={() => {}} />);
    const una = await screen.findByRole('button', { name: /^cell-One / });
    const due = await screen.findByRole('button', { name: /^cell-Two / });
    rowPointer(una, 'pointerdown', 20, 100);
    // Il click arriva sull'ALTRA riga, in un punto vicino al punto di partenza:
    // senza la riga nel gesto, la sola distanza non basterebbe a scartarlo.
    fireEvent.click(due, { clientX: 22, clientY: 102, detail: 1 });
    expect(due.getAttribute('data-selected')).toBeNull();
    expect(screen.queryByTestId('peek-term')).toBeNull();
  });

  it('solo il puntatore primario apre il gesto: un down secondario non seleziona', async () => {
    render(<CellSwitcher token="t" onClose={() => {}} onPick={() => {}} />);
    const riga = await screen.findByRole('button', { name: /^cell-One / });
    rowPointer(riga, 'pointerdown', 20, 100, { id: 2, primary: false });
    fireEvent.click(riga, { clientX: 20, clientY: 100, detail: 1 });
    expect(screen.queryByTestId('peek-term')).toBeNull();
    expect(riga.getAttribute('data-selected')).toBeNull();
  });

  it('lo spostamento conta nel suo MASSIMO: il dito che torna non è un tap', async () => {
    render(<CellSwitcher token="t" onClose={() => {}} onPick={() => {}} />);
    const riga = await screen.findByRole('button', { name: /^cell-One / });
    rowPointer(riga, 'pointerdown', 20, 100);
    rowPointer(riga, 'pointermove', 60, 100); // via
    rowPointer(riga, 'pointermove', 20, 100); // e ritorno
    rowPointer(riga, 'pointerup', 20, 100);
    fireEvent.click(riga, { clientX: 20, clientY: 100, detail: 1 });
    expect(screen.queryByTestId('peek-term')).toBeNull();
  });

  it('la riga che sparisce azzerà la selezione: alla chiave che torna NON si riapre da sola', async () => {
    render(<CellSwitcher token="t" onClose={() => {}} onPick={() => {}} pollMs={20} />);
    fireEvent.click(await screen.findByRole('button', { name: /^cell-One / }));
    expect(screen.queryByTestId('peek-term')).not.toBeNull();
    mocks.fleetStatus.mockResolvedValue({ available: true, cells: [] });
    await waitFor(() => expect(screen.queryByTestId('peek-term')).toBeNull(), { timeout: 4000 });
    mocks.fleetStatus.mockResolvedValue({ available: true, cells: [active('cell-One', 'cloud-cell-One')] });
    await screen.findByRole('button', { name: /^cell-One / }, { timeout: 4000 });
    expect(screen.queryByTestId('peek-term')).toBeNull();
  });

  it('la cella fermata ma ancora in flotta chiude l\'anteprima (filtro attive)', async () => {
    render(<CellSwitcher token="t" onClose={() => {}} onPick={() => {}} pollMs={20} />);
    fireEvent.click(await screen.findByRole('button', { name: /^cell-One / }));
    mocks.fleetStatus.mockResolvedValue({ available: true, cells: [
      { ...active('cell-One', 'cloud-cell-One'), active: false, tmux: false },
    ] });
    await waitFor(() => expect(screen.queryByRole('button', { name: /^cell-One / })).toBeNull(), { timeout: 4000 });
    expect(screen.queryByTestId('peek-term')).toBeNull();
  });
});
