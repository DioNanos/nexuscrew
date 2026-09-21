import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

// Lista deck sticky: un flap di topologia (owner assente un ciclo) e un fetch
// remoto fallito NON rimuovono le deck; la rimozione arriva solo da una
// risposta confermata dell'owner (lista senza la deck) o da una negazione
// esplicita (403/404). Prima di questa modifica l'owner assente veniva
// filtrato via e le sue deck sparivano dalla rail.
// Nota harness: niente waitFor (si blocca coi fake timers) — gli effetti si
// scorano con advanceTimersByTimeAsync dentro act.

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
const owner = { instanceId: pixelId, route: ['hub', 'pixel'], label: 'Pixel', status: 'up' };

function Probe({ owners }) {
  const [layout, setLayout] = useState(emptyLayout());
  const value = useDecks('token', remoteId, layout, setLayout, owners);
  return <pre data-testid="state">{JSON.stringify({
    ids: value.decks.map((deck) => deck.id),
    available: value.decks.filter((d) => !d.local).map((d) => d.available === false),
    refreshFailedAt: value.decks.filter((d) => !d.local).map((d) => d.refreshFailedAt || 0),
    error: value.error,
  })}</pre>;
}

const state = () => JSON.parse(screen.getByTestId('state').textContent);
const tick = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.getRouteConfig.mockResolvedValue({ instanceId: localId });
  mocks.getRouteTopology.mockResolvedValue({ nodes: [] });
  mocks.getDecks.mockImplementation(async (_token, route = []) => ({
    decks: route.length
      ? [{ name: 'main', revision: 1, layout: emptyLayout() }]
      : [{ name: 'main', revision: 1, layout: emptyLayout() }],
  }));
});
afterEach(() => { vi.useRealTimers(); });

describe('useDecks: lista sticky (le deck non spariscono per un blip)', () => {
  it('un flap di topologia non rimuove le deck dell\'owner assente', async () => {
    const view = render(<Probe owners={[owner]} />);
    await tick(0);
    expect(state().ids).toContain(remoteId);

    // L'owner sparisce dalla topologia per un ciclo.
    view.rerender(<Probe owners={[]} />);
    await tick(50);
    expect(state().ids).toContain(remoteId);

    // E torna: la deck è ancora lì.
    view.rerender(<Probe owners={[owner]} />);
    await tick(50);
    expect(state().ids).toContain(remoteId);
  });

  it('un fetch remoto fallito mantiene il dato precedente con available:false', async () => {
    render(<Probe owners={[owner]} />);
    await tick(0);
    expect(state().ids).toContain(remoteId);

    // Il refresh dell'owner fallisce (timeout di rete, nessuno status).
    mocks.getDecks.mockImplementation(async (_token, route = []) => {
      if (route.length) throw new Error('fetch failed');
      return { decks: [{ name: 'main', revision: 1, layout: emptyLayout() }] };
    });
    await tick(5600); // oltre il boundary: il setTimeout(0) del reload per-owner deve cadere dentro l'avanzamento

    expect(state().ids).toContain(remoteId);
    expect(state().available).toEqual([true]);
    expect(state().refreshFailedAt[0]).toBeGreaterThan(0);
  });

  it('la deck rimossa dall\'owner sparisce al primo refresh buono', async () => {
    render(<Probe owners={[owner]} />);
    await tick(0);
    expect(state().ids).toContain(remoteId);

    mocks.getDecks.mockImplementation(async (_token, route = []) => ({
      decks: route.length ? [] : [{ name: 'main', revision: 1, layout: emptyLayout() }],
    }));
    await tick(5600); // oltre il boundary: il setTimeout(0) del reload per-owner deve cadere dentro l'avanzamento

    expect(state().ids).not.toContain(remoteId);
    expect(state().error).toContain('non più condiviso');
  });

  it('la negazione esplicita (403) slogga le deck dell\'owner', async () => {
    render(<Probe owners={[owner]} />);
    await tick(0);
    expect(state().ids).toContain(remoteId);

    const denied = new Error('HTTP 403');
    denied.status = 403;
    mocks.getDecks.mockImplementation(async (_token, route = []) => {
      if (route.length) throw denied;
      return { decks: [{ name: 'main', revision: 1, layout: emptyLayout() }] };
    });
    await tick(5600); // oltre il boundary: il setTimeout(0) del reload per-owner deve cadere dentro l'avanzamento

    expect(state().ids).not.toContain(remoteId);
  });
});

// F1 (audit indipendente): la deck di un owner UNPAIRATO deve avere una via di
// rimozione. Il blip resta un blip, ma un'assenza che supera la grazia non e'
// piu' un blip: e' un fatto, e le sue deck sloggano.

describe('useDecks: la grazia di rimozione e la cache per instanceId (F1)', () => {
  it('owner scaduto dalla grazia: le sue deck spariscono (il blip no)', async () => {
    const view = render(<Probe owners={[owner]} />);
    await tick(0);
    expect(state().ids).toContain(remoteId);

    // L'owner sparisce: prima della grazia resta (blip), come già garantito.
    view.rerender(<Probe owners={[]} />);
    await tick(50);
    expect(state().ids).toContain(remoteId);

    // Passata la grazia, il poll successivo lo rimuove: nessuna perpetuità.
    await tick(10 * 60 * 1000 + 5600);
    expect(state().ids).not.toContain(remoteId);
  });

  it('la cache di un altro instanceId non viene caricata al cambio di nodo', async () => {
    // Il codice precedente leggeva la cache da una chiave SENZA instanceId: la
    // lista scritta da un nodo compariva al reload di un ALTRO nodo, come se
    // le sue deck fossero nostre.
    const view = render(<Probe owners={[owner]} />);
    await tick(0);
    expect(state().ids).toContain(remoteId); // la lista del primo nodo e' in cache

    // Lo stesso browser ora parla con un ALTRO nodo locale (reload), e il
    // refresh dell'owner fallisce: l'unica fonte possibile e' la cache.
    mocks.getRouteConfig.mockResolvedValue({ instanceId: 'c'.repeat(32) });
    mocks.getDecks.mockImplementation(async (_token, route = []) => {
      if (route.length) throw new Error('fetch failed');
      return { decks: [{ name: 'main', revision: 1, layout: emptyLayout() }] };
    });
    view.unmount();
    render(<Probe owners={[owner]} />);
    await tick(0);
    expect(state().ids).not.toContain(remoteId);
  });
});
