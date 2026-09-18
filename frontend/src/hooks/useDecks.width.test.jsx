import React, { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// Il poll con finestra sporca deve conservare anche le larghezze di colonna:
// un resize locale (solo width, nessuna tile toccata) non può essere cancellato
// dal merge che arriva mentre l'autosave è in attesa.
const mocks = vi.hoisted(() => ({
  getDecks: vi.fn(), getRouteConfig: vi.fn(), getRouteTopology: vi.fn(),
  createDeck: vi.fn(), saveDeck: vi.fn(), renameDeck: vi.fn(), deleteDeck: vi.fn(),
  saveDeckKeepalive: vi.fn(),
}));

vi.mock('../lib/api.js', () => mocks);

import { useDecks } from './useDecks.js';
import { emptyLayout } from '../lib/grid-model.js';

const localId = 'a'.repeat(32);

function WidthProbe() {
  const [layout, setLayout] = useState(emptyLayout());
  const v = useDecks('token', `${localId}:p-s-t`, layout, setLayout, []);
  return (
    <>
      <button onClick={() => setLayout({ columns: [{ width: 1.7, tiles: [{ session: 'a', height: 1 }] }, { width: 0.3, tiles: [{ session: 'b', height: 1 }] }] })}>resize</button>
      <pre data-testid="widths">{JSON.stringify({ ready: v.ready, widths: layout.columns.map((c) => c.width) })}</pre>
    </>
  );
}

const networkDown = () => Object.assign(new Error('network down'), { status: 0 });

const stateOf = () => JSON.parse(screen.getByTestId('widths').textContent);

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.getRouteConfig.mockResolvedValue({ instanceId: localId });
  mocks.getRouteTopology.mockResolvedValue({ nodes: [] });
});

describe('useDecks poll — larghezze di colonna locali', () => {
  it('il poll di un’altra finestra non cancella il resize locale', async () => {
    let revision = 1;
    const layout = { columns: [{ width: 1, tiles: [{ session: 'a', height: 1 }] }, { width: 1, tiles: [{ session: 'b', height: 1 }] }] };
    mocks.getDecks.mockImplementation(async () => ({
      decks: [
        { name: 'main', revision: 1, layout: emptyLayout() },
        { name: 'p-s-t', revision, layout },
      ],
    }));
    mocks.saveDeck.mockRejectedValue(networkDown());
    render(<WidthProbe />);
    await waitFor(() => expect(stateOf().ready).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'resize' }));
    await waitFor(() => expect(mocks.saveDeck).toHaveBeenCalled(), { timeout: 3000 });

    revision = 2; // un'altra finestra pubblica mentre questa è dirty
    await waitFor(() => expect(mocks.saveDeck.mock.calls.some((c) => c[3] === 2)).toBe(true), { timeout: 9000 });
    expect(stateOf().widths).toEqual([1.7, 0.3]);
  });
});
