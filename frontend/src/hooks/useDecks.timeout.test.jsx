import React, { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getDecks: vi.fn(), getRouteConfig: vi.fn(), getRouteTopology: vi.fn(),
  createDeck: vi.fn(), saveDeck: vi.fn(), renameDeck: vi.fn(), deleteDeck: vi.fn(),
  saveDeckKeepalive: vi.fn(),
}));

vi.mock('../lib/api.js', () => mocks);

import { useDecks } from './useDecks.js';
import { emptyLayout } from '../lib/grid-model.js';

const localId = 'a'.repeat(32);
const remoteId = 'b'.repeat(32);
const OWNER_UP = { instanceId: remoteId, route: ['peer'], label: 'Peer', status: 'up' };

// un owner remoto che NON risponde (tunnel «su a metà»: socket aperto,
// fetch che non risolve) non deve mai bloccare le deck LOCALI: il hook pubblica
// le locali al primo giro e i remoti si aggiornano per owner ai giri seguenti
// (ownersSig) o degradano al timeout federato. Mai una persistenza del remoto.
function Probe({ owners, current }) {
  const [layout, setLayout] = useState(emptyLayout());
  const value = useDecks('token', current, layout, setLayout, owners);
  return <pre data-testid="probe">{JSON.stringify({
    ready: value.ready,
    decks: (value.records || []).map((d) => ({ id: d.id, local: d.local, available: d.available })),
  })}</pre>;
}

const localStore = { decks: [{ name: 'main', revision: 3, layout: emptyLayout() }] };
const remoteStore = { decks: [{ name: 'dev', revision: 7, layout: emptyLayout() }] };
const remoteIdDeck = `${remoteId}:dev`;
const stateOf = () => JSON.parse(screen.getByTestId('probe').textContent);

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.getRouteConfig.mockResolvedValue({ instanceId: localId });
  mocks.getRouteTopology.mockResolvedValue({ nodes: [] });
});

describe('owner remoto senza risposta', () => {
  it('owner muta al primo giro: le LOCALI sono pronte, nessun remoto, nessuna persistenza', async () => {
    mocks.getDecks.mockImplementation((_t, route = []) => (route.length
      ? new Promise(() => {}) // tunnel «su a metà»: non risolve mai
      : Promise.resolve(localStore)));
    render(<Probe owners={[OWNER_UP]} current="main" />);
    await waitFor(() => expect(stateOf().ready).toBe(true));
    const decks = stateOf().decks;
    expect(decks.some((d) => d.local && d.available)).toBe(true);
    expect(decks.some((d) => d.id === remoteIdDeck)).toBe(false);
    expect(mocks.saveDeck).not.toHaveBeenCalled();
  });

  it('giro successivo con owner che risponde: merge, poi owner muta → degrado available:false', async () => {
    let remoteCalls = 0;
    let pend;
    mocks.getDecks.mockImplementation((_t, route = []) => {
      if (!route.length) return Promise.resolve(localStore);
      remoteCalls += 1;
      if (remoteCalls === 1) return Promise.resolve(remoteStore);
      return new Promise((res) => { pend = res; }); // giro 2: non risolve
    });
    const { rerender } = render(<Probe owners={[OWNER_UP]} current={remoteIdDeck} />);
    await waitFor(() => expect(stateOf().decks.find((d) => d.id === remoteIdDeck)?.available).toBe(true));
    // Cambia ownersSig (nuova label) → il hook rifà il giro con il fetch muta:
    // il remoto PRECEDENTE viene pubblicato degradato (available:false) subito.
    rerender(<Probe owners={[{ ...OWNER_UP, label: 'Peer-2' }]} current={remoteIdDeck} />);
    await waitFor(() => expect(stateOf().decks.find((d) => d.id === remoteIdDeck)?.available).toBe(false));
    expect(mocks.saveDeck).not.toHaveBeenCalled();
  });

  it('owner che risponde in tempo: merge corretto (controllo positivo)', async () => {
    mocks.getDecks.mockImplementation((_t, route = []) => (route.length
      ? Promise.resolve(remoteStore)
      : Promise.resolve(localStore)));
    render(<Probe owners={[OWNER_UP]} current={remoteIdDeck} />);
    await waitFor(() => {
      const remote = stateOf().decks.find((d) => d.id === remoteIdDeck);
      expect(remote?.available).toBe(true);
      expect(remote?.local).toBe(false);
      expect(stateOf().decks.some((d) => d.local)).toBe(true);
    });
    expect(mocks.saveDeck).not.toHaveBeenCalled();
  });
});
