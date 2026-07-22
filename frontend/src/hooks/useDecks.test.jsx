import React, { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getDecks: vi.fn(), getRouteConfig: vi.fn(), getRouteTopology: vi.fn(),
  createDeck: vi.fn(), saveDeck: vi.fn(), renameDeck: vi.fn(), deleteDeck: vi.fn(),
}));

vi.mock('../lib/api.js', () => mocks);

import { useDecks } from './useDecks.js';
import { emptyLayout } from '../lib/grid-model.js';

const localId = 'a'.repeat(32);
const pixelId = 'b'.repeat(32);
const remoteId = `${pixelId}:main`;

function Probe({ owners }) {
  const [layout, setLayout] = useState(emptyLayout());
  const value = useDecks('token', remoteId, layout, setLayout, owners);
  return <pre data-testid="state">{JSON.stringify({
    ready: value.ready,
    ids: value.decks.map((deck) => deck.id),
    error: value.error,
    sessions: layout.columns.flatMap((column) => column.tiles.map((tile) => tile.session)),
  })}</pre>;
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.getRouteConfig.mockResolvedValue({ instanceId: localId });
  mocks.getRouteTopology.mockResolvedValue({ nodes: [] });
  mocks.getDecks.mockImplementation(async (_token, route = []) => ({
    decks: route.length
      ? [{ name: 'main', revision: 1, layout: emptyLayout() }]
      : [
        { name: 'main', revision: 1, layout: emptyLayout() },
        { name: 'local', revision: 1, layout: emptyLayout() },
      ],
  }));
});

describe('useDecks authorization withdrawal', () => {
  it('drops remote records and the active layout when the owner leaves authorized topology', async () => {
    const owner = { instanceId: pixelId, route: ['hub', 'pixel'], label: 'Pixel', status: 'up' };
    const view = render(<Probe owners={[owner]} />);
    await waitFor(() => expect(JSON.parse(screen.getByTestId('state').textContent).ids).toContain(remoteId));

    view.rerender(<Probe owners={[]} />);
    await waitFor(() => {
      const state = JSON.parse(screen.getByTestId('state').textContent);
      expect(state.ids).not.toContain(remoteId);
      expect(state.error).toContain('non più condiviso');
      expect(state.sessions).toEqual([]);
    });
  });
});
