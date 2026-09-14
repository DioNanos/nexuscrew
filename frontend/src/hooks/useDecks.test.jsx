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
import { writeLayoutRaw } from '../lib/deck-model.js';

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

// The two ids of a deck that lives on THIS node.
//
// Opening a deck in a new tab produces an owner-qualified URL — even for a deck
// of the node the browser is already talking to: `/deck/<nodeId>/<name>`. The
// record for that deck is local, and local records carry the id `local:<name>`.
// Resolving the current deck by the id in the URL therefore has to accept both
// forms, or the grid stays empty ("drag a session here") with the deck open.
function SelfOwnerProbe({ owners, deck }) {
  const [layout, setLayout] = useState(emptyLayout());
  const value = useDecks('token', deck, layout, setLayout, owners);
  return <pre data-testid="self-state">{JSON.stringify({
    ids: value.decks.map((d) => d.id),
    sessions: layout.columns.flatMap((column) => column.tiles.map((tile) => tile.session)),
  })}</pre>;
}

const twoTiles = () => ({ columns: [{ tiles: [{ session: 'cloud-a' }, { session: 'cloud-b' }] }] });

describe('useDecks self-owner deck URL', () => {
  beforeEach(() => {
    mocks.getDecks.mockImplementation(async (_token, route = []) => ({
      decks: route.length
        ? [{ name: 'main', revision: 1, layout: emptyLayout() }]
        : [
          { name: 'main', revision: 1, layout: emptyLayout() },
          { name: 'p-s-t', revision: 1, layout: twoTiles() },
        ],
    }));
  });

  it('installs the local layout when the URL names this node as the owner', async () => {
    writeLayoutRaw('p-s-t', twoTiles());
    render(<SelfOwnerProbe owners={[]} deck={`${localId}:p-s-t`} />);
    await waitFor(() => {
      const state = JSON.parse(screen.getByTestId('self-state').textContent);
      expect(state.ids).toContain('local:p-s-t');
      expect(state.sessions).toEqual(['cloud-a', 'cloud-b']);
    });
  });

  it('NEGATIVE: a remote owner still takes the federated path, never the local layout', async () => {
    writeLayoutRaw('p-s-t', twoTiles());
    const owner = { instanceId: pixelId, route: ['hub', 'pixel'], label: 'Pixel', status: 'up' };
    render(<SelfOwnerProbe owners={[owner]} deck={`${pixelId}:p-s-t`} />);
    await waitFor(() => {
      const state = JSON.parse(screen.getByTestId('self-state').textContent);
      expect(state.ids).not.toContain(`${pixelId}:p-s-t`);
      expect(state.sessions).toEqual([]);
    });
  });
});
