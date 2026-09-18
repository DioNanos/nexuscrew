import React, { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getDecks: vi.fn(), getRouteConfig: vi.fn(), getRouteTopology: vi.fn(),
  createDeck: vi.fn(), saveDeck: vi.fn(), renameDeck: vi.fn(), deleteDeck: vi.fn(),
  saveDeckKeepalive: vi.fn(),
}));

vi.mock('../lib/api.js', () => mocks);

import { useDecks } from './useDecks.js';
import { emptyLayout } from '../lib/grid-model.js';

const localId = 'a'.repeat(32);

// Finestra dirty contro un deck che un'altra finestra ha salvato.
// 409 = conflitto di revisione: il hook deve ribattere il layout LOCALE sulla
// revisione remota (vince l'ultima modifica dell'utente) e ritentare UNA volta;
// al secondo 409 l'errore deve restare visibile con l'azione di ricarica.
function ConflictProbe({ deck = `${localId}:p-s-t` }) {
  const [layout, setLayout] = useState(emptyLayout());
  const value = useDecks('token', deck, layout, setLayout, []);
  return (
    <div>
      <button type="button" onClick={() => setLayout({ columns: [{ width: 1, tiles: [{ session: 'edited', height: 1 }] }] })}>edit</button>
      {value.conflict && (
        <button type="button" onClick={() => value.reloadCurrent()}>reload-btn</button>
      )}
      <pre data-testid="probe">{JSON.stringify({
        ready: value.ready,
        saveState: value.saveState,
        error: value.error,
        conflict: !!value.conflict,
        sessions: layout.columns.flatMap((c) => c.tiles.map((t) => t.session)),
      })}</pre>
    </div>
  );
}

const conflict409 = (rev) => Object.assign(
  new Error('deck modificato da un’altra finestra'),
  { status: 409, data: { current: { name: 'p-s-t', revision: rev, layout: { columns: [{ width: 1, tiles: [{ session: 'from-other-window', height: 1 }] }] } } } },
);

const networkDown = () => Object.assign(new Error('network down'), { status: 0 });

const localStore = (rev, layout) => ({
  decks: [
    { name: 'main', revision: 1, layout: emptyLayout() },
    { name: 'p-s-t', revision: rev, layout },
  ],
});

const stateOf = () => JSON.parse(screen.getByTestId('probe').textContent);

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.getRouteConfig.mockResolvedValue({ instanceId: localId });
  mocks.getRouteTopology.mockResolvedValue({ nodes: [] });
  mocks.getDecks.mockImplementation(async () => localStore(1, emptyLayout()));
});

describe('useDecks 409 — rebase e retry singolo', () => {
  it('al 409 ribatte il layout locale sulla revisione remota e ritenta una volta', async () => {
    mocks.saveDeck
      .mockRejectedValueOnce(conflict409(5))
      .mockImplementation(async (_t, name, layout, revision) => ({ name, revision: revision + 1, layout }));
    render(<ConflictProbe />);
    await waitFor(() => expect(stateOf().ready).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'edit' }));

    await waitFor(() => expect(mocks.saveDeck).toHaveBeenCalledTimes(2), { timeout: 4000 });
    // il ritento usa la revisione portata dal 409 (quella dell'altra finestra)
    expect(mocks.saveDeck.mock.calls[1][3]).toBe(5);
    await waitFor(() => expect(stateOf().error).toBe(''));
    expect(stateOf().conflict).toBe(false);
  });

  it('al secondo 409 l’errore resta visibile con l’azione di ricarica, senza retry a buon mercato', async () => {
    mocks.saveDeck.mockRejectedValue(conflict409(5));
    render(<ConflictProbe />);
    await waitFor(() => expect(stateOf().ready).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'edit' }));

    await waitFor(() => expect(mocks.saveDeck).toHaveBeenCalledTimes(2), { timeout: 4000 });
    expect(mocks.saveDeck.mock.calls[1][3]).toBe(5);
    expect(stateOf().saveState).toBe('error');
    expect(stateOf().error).toContain('finestra');
    expect(stateOf().conflict).toBe(true);
    expect(screen.getByRole('button', { name: 'reload-btn' })).toBeTruthy();
    // niente terzo tentativo in loop
    await new Promise((r) => setTimeout(r, 300));
    expect(mocks.saveDeck).toHaveBeenCalledTimes(2);
  });
});

describe('useDecks poll — finestra dirty e remoto più nuovo', () => {
  it('fa il merge remoto ⊕ delta locale invece di restare indietro', async () => {
    let revision = 1;
    mocks.getDecks.mockImplementation(async () => localStore(revision, revision === 1
      ? emptyLayout()
      : { columns: [{ width: 1, tiles: [{ session: 'from-server', height: 1 }] }] }));
    mocks.saveDeck.mockRejectedValue(networkDown());
    render(<ConflictProbe />);
    await waitFor(() => expect(stateOf().sessions).toEqual([]));
    fireEvent.click(screen.getByRole('button', { name: 'edit' }));
    await waitFor(() => expect(mocks.saveDeck).toHaveBeenCalled(), { timeout: 4000 });
    expect(stateOf().error).toContain('network down');

    revision = 2; // un'altra finestra pubblica mentre questa è dirty
    await waitFor(() => {
      const s = stateOf().sessions;
      expect(s).toContain('from-server');
      expect(s).toContain('edited');
    }, { timeout: 9000 });
    // il merge converge: l'autosave riparte con il layout fuso
    await waitFor(() => {
      const last = mocks.saveDeck.mock.calls[mocks.saveDeck.mock.calls.length - 1];
      const saved = last[2].columns.flatMap((c) => c.tiles.map((t) => t.session));
      expect(saved).toContain('from-server');
      expect(saved).toContain('edited');
    }, { timeout: 4000 });
  });
});

describe('useDecks pagehide — flush keepalive', () => {
  it('a chiusura pagina invia il PUT keepalive se dirty', async () => {
    mocks.saveDeck.mockRejectedValue(networkDown());
    render(<ConflictProbe />);
    await waitFor(() => expect(stateOf().ready).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'edit' }));
    await waitFor(() => expect(mocks.saveDeck).toHaveBeenCalled(), { timeout: 4000 });
    expect(mocks.saveDeckKeepalive).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('pagehide'));
    expect(mocks.saveDeckKeepalive).toHaveBeenCalledTimes(1);
    expect(mocks.saveDeckKeepalive.mock.calls[0][1]).toBe('p-s-t');
  });

  it('a chiusura pagina NON invia nulla se non c’è nulla di dirty', async () => {
    render(<ConflictProbe />);
    await waitFor(() => expect(stateOf().ready).toBe(true));
    window.dispatchEvent(new Event('pagehide'));
    expect(mocks.saveDeckKeepalive).not.toHaveBeenCalled();
  });
});
