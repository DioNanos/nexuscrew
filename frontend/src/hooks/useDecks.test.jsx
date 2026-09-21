import React, { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

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
  it('drops remote records and the active layout when the owner CONFIRMS the deck is gone (answer without it)', async () => {
    // Contratto sticky: l'owner assente dalla topologia (blip) NON slogga le
    // sue deck (visto in useDecks.sticky.test.jsx). La revoca vera si vede
    // quando l'owner RISPONDE e la risposta non contiene più la deck.
    const owner = { instanceId: pixelId, route: ['hub', 'pixel'], label: 'Pixel', status: 'up' };
    const view = render(<Probe owners={[owner]} />);
    await waitFor(() => expect(JSON.parse(screen.getByTestId('state').textContent).ids).toContain(remoteId));

    mocks.getDecks.mockImplementation(async (_token, route = []) => ({
      decks: route.length
        ? []
        : [{ name: 'main', revision: 1, layout: emptyLayout() }],
    }));
    view.rerender(<Probe owners={[owner]} />);
    // Il refresh arriva dal poll periodico (ownersSig invariato: nessun reload
    // immediato) — dentro la finestra del waitFor esteso.
    await waitFor(() => {
      const state = JSON.parse(screen.getByTestId('state').textContent);
      expect(state.ids).not.toContain(remoteId);
      expect(state.error).toContain('non più condiviso');
      expect(state.sessions).toEqual([]);
    }, { timeout: 6500 });
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

// Every lookup of "the current deck" must know both ids of a self-owner deck:
// the one in the URL and the one the local record carries. These three cases are
// the ones that stayed broken when only install() knew the mapping.
function DirtyProbe({ owners, deck }) {
  const [layout, setLayout] = useState(emptyLayout());
  const value = useDecks('token', deck, layout, setLayout, owners);
  return (
    <div>
      <button type="button" onClick={() => setLayout({ columns: [{ tiles: [{ session: 'edited' }] }] })}>edit</button>
      <button type="button" onClick={() => { value.saveNow && value.saveNow(); }}>save</button>
      <pre data-testid="dirty-state">{JSON.stringify({
        ids: value.decks.map((d) => d.id),
        sessions: layout.columns.flatMap((column) => column.tiles.map((tile) => tile.session)),
        error: value.error,
      })}</pre>
    </div>
  );
}

describe('useDecks self-owner deck URL — the other lookups', () => {
  it('(a) with no local layout saved, the layout that comes from the server is installed', async () => {
    // The record exists on the server; this browser has never saved that deck.
    mocks.getDecks.mockImplementation(async (_token, route = []) => ({
      decks: route.length
        ? [{ name: 'main', revision: 1, layout: emptyLayout() }]
        : [
          { name: 'main', revision: 1, layout: emptyLayout() },
          { name: 'p-s-t', revision: 1, layout: twoTiles() },
        ],
    }));
    render(<SelfOwnerProbe owners={[]} deck={`${localId}:p-s-t`} />);
    await waitFor(() => {
      const state = JSON.parse(screen.getByTestId('self-state').textContent);
      expect(state.sessions).toEqual(['cloud-a', 'cloud-b']);
    });
  });

  it('(b) an edit on the self-owner tab is saved to the local record', async () => {
    mocks.getDecks.mockImplementation(async (_token, route = []) => ({
      decks: route.length
        ? [{ name: 'main', revision: 1, layout: emptyLayout() }]
        : [
          { name: 'main', revision: 1, layout: emptyLayout() },
          { name: 'p-s-t', revision: 1, layout: twoTiles() },
        ],
    }));
    mocks.saveDeck.mockImplementation(async (_token, name, layout, revision) => (
      { name, revision: (revision || 0) + 1, layout }
    ));
    render(<DirtyProbe owners={[]} deck={`${localId}:p-s-t`} />);
    await screen.findByRole('button', { name: 'edit' });
    await waitFor(() => expect(JSON.parse(screen.getByTestId('dirty-state').textContent).ids).toContain('local:p-s-t'));

    fireEvent.click(screen.getByRole('button', { name: 'edit' }));
    await waitFor(() => expect(mocks.saveDeck).toHaveBeenCalled(), { timeout: 4000 });
    expect(mocks.saveDeck.mock.calls[0][1]).toBe('p-s-t');
    expect(JSON.parse(screen.getByTestId('dirty-state').textContent).error).toBe('');
  });

  it('(c) a newer revision on the server is applied to the self-owner tab by the poll', async () => {
    let revision = 1;
    mocks.getDecks.mockImplementation(async (_token, route = []) => ({
      decks: route.length
        ? [{ name: 'main', revision: 1, layout: emptyLayout() }]
        : [
          { name: 'main', revision: 1, layout: emptyLayout() },
          { name: 'p-s-t', revision, layout: revision === 1 ? twoTiles() : { columns: [{ tiles: [{ session: 'from-server' }] }] } },
        ],
    }));
    render(<SelfOwnerProbe owners={[]} deck={`${localId}:p-s-t`} />);
    await waitFor(() => expect(JSON.parse(screen.getByTestId('self-state').textContent).sessions).toEqual(['cloud-a', 'cloud-b']));

    revision = 2;
    await waitFor(() => {
      expect(JSON.parse(screen.getByTestId('self-state').textContent).sessions).toEqual(['from-server']);
    }, { timeout: 9000 });
  });
});
