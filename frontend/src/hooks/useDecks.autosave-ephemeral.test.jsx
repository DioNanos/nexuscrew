import React, { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getDecks: vi.fn(), getRouteConfig: vi.fn(), getRouteTopology: vi.fn(),
  createDeck: vi.fn(), saveDeck: vi.fn(), renameDeck: vi.fn(), deleteDeck: vi.fn(),
}));

vi.mock('../lib/api.js', () => mocks);

import { useDecks } from './useDecks.js';
import { addTileSmart, emptyLayout } from '../lib/grid-model.js';

const localId = 'a'.repeat(32);

// Sonda con i due trigger che interessano l'autosave: l'edit dell'utente
// (setLayout di un cambio vero) e l'aggiornamento di vista effimero
// (viewUpdate che cambia solo il riferimento, come un flip di disponibilita').
function Probe() {
  const [layout, setLayout] = useState(emptyLayout());
  const value = useDecks('token', 'local:main', layout, setLayout, []);
  return (
    <div>
      <button
        type="button"
        data-testid="edit"
        onClick={() => setLayout(addTileSmart(layout, 'cloud-Dev'))}
      />
      <button
        type="button"
        data-testid="flip"
        onClick={() => value.viewUpdate((current) => ({
          ...current,
          columns: current.columns.map((column) => ({
            ...column, tiles: column.tiles.map((tile) => ({ ...tile })),
          })),
        }))}
      />
      <pre data-testid="ready">{String(value.ready)}</pre>
    </div>
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.getRouteConfig.mockResolvedValue({ instanceId: localId });
  mocks.getRouteTopology.mockResolvedValue({ nodes: [] });
  mocks.getDecks.mockResolvedValue({
    decks: [{ name: 'main', revision: 1, layout: emptyLayout() }],
  });
  mocks.saveDeck.mockImplementation(async (_token, name, layout, revision) => (
    { name, revision: (revision || 0) + 1, layout }
  ));
});

describe('autosave vs aggiornamenti di vista effimeri', () => {
  it('flip effimero a finestra pulita: zero PUT', async () => {
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'));
    fireEvent.click(screen.getByTestId('flip'));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(mocks.saveDeck).not.toHaveBeenCalled();
  });

  it('edit utente + flip effimero a ~300 ms: esattamente 1 PUT, il salvataggio non viene annullato né rinviato per sempre', async () => {
    render(<Probe />);
    await waitFor(() => expect(screen.getByTestId('ready').textContent).toBe('true'));
    fireEvent.click(screen.getByTestId('edit'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    fireEvent.click(screen.getByTestId('flip'));
    // debounce 650 ms riorientato dal flip: il PUT deve arrivare comunque
    await waitFor(() => expect(mocks.saveDeck).toHaveBeenCalledTimes(1), { timeout: 2000 });
    // e restare esattamente 1: il flip non accoda altri salvataggi
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(mocks.saveDeck).toHaveBeenCalledTimes(1);
    // il payload e' canonico: nessuno stato effimero di disponibilita'
    const [, , savedLayout] = mocks.saveDeck.mock.calls[0];
    expect(JSON.stringify(savedLayout)).not.toContain('unavailable');
    expect(JSON.stringify(savedLayout)).not.toContain('"stale"');
  });
});
