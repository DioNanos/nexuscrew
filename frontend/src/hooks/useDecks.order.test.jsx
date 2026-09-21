import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

// Ordine della deck rail: l'ordine è quello dell'array (la DeckBar non ordina).
// Un owner che risponde DOPO non deve spostare le sue deck in coda — né le sue
// né quelle degli altri. Prima di questa modifica mergeOwner ricomponeva
// [...others, ...mine], quindi ogni risposta tardiva rimescolava la rail.

const mocks = vi.hoisted(() => ({
  getDecks: vi.fn(), getRouteConfig: vi.fn(), getRouteTopology: vi.fn(),
  createDeck: vi.fn(), saveDeck: vi.fn(), renameDeck: vi.fn(), deleteDeck: vi.fn(),
}));

vi.mock('../lib/api.js', () => mocks);

import { useDecks } from './useDecks.js';
import { emptyLayout } from '../lib/grid-model.js';

const localId = 'a'.repeat(32);
const OWNERS = [
  { instanceId: 'b'.repeat(32), route: ['hub', 'oa'], label: 'A', status: 'up' },
  { instanceId: 'c'.repeat(32), route: ['hub', 'ob'], label: 'B', status: 'up' },
  { instanceId: 'd'.repeat(32), route: ['hub', 'oc'], label: 'C', status: 'up' },
];
const deckOf = (ownerId) => `${ownerId}:main`;

function Probe({ owners }) {
  const [layout, setLayout] = useState(emptyLayout());
  const value = useDecks('token', 'local:main', layout, setLayout, owners);
  return <pre data-testid="state">{JSON.stringify({ ids: value.decks.map((d) => d.id) })}</pre>;
}

const ids = () => JSON.parse(screen.getByTestId('state').textContent).ids;
const tick = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

// Il server remoto risponde solo alle route elencate in `answering`.
function serveOnly(routeNames) {
  mocks.getDecks.mockImplementation(async (_token, route = []) => {
    if (!route.length) return { decks: [{ name: 'main', revision: 1, layout: emptyLayout() }] };
    if (routeNames.includes(route[route.length - 1])) return { decks: [{ name: 'main', revision: 1, layout: emptyLayout() }] };
    throw new Error('fetch failed');
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.getRouteConfig.mockResolvedValue({ instanceId: localId });
  mocks.getRouteTopology.mockResolvedValue({ nodes: [] });
  serveOnly(['oa', 'ob', 'oc']);
});
afterEach(() => { vi.useRealTimers(); });

describe('useDecks: la rail non si rimescola quando gli owner rispondono a tempi diversi', () => {
  it('una risposta tardiva non cambia l\'indice delle sue deck né degli altri', async () => {
    const view = render(<Probe owners={OWNERS} />);
    await tick(50); // il reload per-owner parte con setTimeout(0): serve un tick vero
    // Ordine stabilito: locali, poi A, B, C (ordine di prima risposta).
    const before = ids();
    expect(before).toContain(deckOf(OWNERS[0].instanceId));
    expect(before).toContain(deckOf(OWNERS[1].instanceId));
    expect(before).toContain(deckOf(OWNERS[2].instanceId));

    // Refresh: risponde SOLO A, B e C degradano (nessun merge per loro).
    serveOnly(['oa']);
    view.rerender(<Probe owners={OWNERS} />);
    await tick(5600);

    // Il refresh di un owner non è un riordino: l'array resta identico.
    expect(ids()).toEqual(before);
  });

  it('reload da cache mantiene l\'ordine noto', async () => {
    const view = render(<Probe owners={OWNERS} />);
    await tick(50);
    const before = ids();
    expect(before.length).toBeGreaterThan(1);

    // Reload della pagina: la lista riparte dalla CACHE (ordine noto) e al
    // refresh risponde un solo owner — che non deve spostarsi in coda.
    serveOnly(['ob']);
    view.unmount();
    render(<Probe owners={OWNERS} />);
    await tick(5600);

    expect(ids()).toEqual(before);
  });
});
