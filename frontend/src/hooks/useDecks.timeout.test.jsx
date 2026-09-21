import React, { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

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
const secondId = 'c'.repeat(32);
const extraId = 'd'.repeat(32);
const OWNER_UP = { instanceId: remoteId, route: ['peer'], label: 'Peer', status: 'up' };
const OWNER_B = { instanceId: secondId, route: ['beta'], label: 'Beta', status: 'up' };
const OWNER_EXTRA = { instanceId: extraId, route: ['extra'], label: 'Extra', status: 'up' };

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
const secondStore = { decks: [{ name: 'beta', revision: 2, layout: emptyLayout() }] };
const remoteIdDeck = `${remoteId}:dev`;
const secondIdDeck = `${secondId}:beta`;
const stateOf = () => JSON.parse(screen.getByTestId('probe').textContent);
const remoteCalls = () => mocks.getDecks.mock.calls.filter((c) => c[1] && c[1].length).length;

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

  it('owner che fallisce al refresh: solo le SUE deck degradano, le altre restano disponibili', async () => {
    const callsByOwner = {};
    mocks.getDecks.mockImplementation((_t, route = []) => {
      if (!route.length) return Promise.resolve(localStore);
      const owner = route[0];
      callsByOwner[owner] = (callsByOwner[owner] || 0) + 1;
      if (owner === 'peer') {
        // primo giro: risponde; refresh successivo: rifiuta (timeout federato)
        return callsByOwner[owner] <= 1 ? Promise.resolve(remoteStore) : Promise.reject(new Error('timeout'));
      }
      if (owner === 'extra') return new Promise(() => {});
      return Promise.resolve(secondStore);
    });
    const { rerender } = render(<Probe owners={[OWNER_UP, OWNER_B]} current={remoteIdDeck} />);
    await waitFor(() => expect(stateOf().decks.find((d) => d.id === remoteIdDeck)?.available).toBe(true));
    await waitFor(() => expect(stateOf().decks.find((d) => d.id === secondIdDeck)?.available).toBe(true));
    // Refresh: entra un owner in più (canale legittimo: la PRESENZA cambia la
    // firma degli owner) — il peer rifiuta, Beta risponde ancora.
    rerender(<Probe owners={[OWNER_UP, OWNER_B, OWNER_EXTRA]} current={remoteIdDeck} />);
    await waitFor(() => expect(mocks.getRouteConfig.mock.calls.length).toBe(2));
    await waitFor(() => expect(stateOf().decks.find((d) => d.id === remoteIdDeck)?.available).toBe(false));
    expect(stateOf().decks.find((d) => d.id === secondIdDeck)?.available).toBe(true);
    expect(stateOf().decks.some((d) => d.local && d.available)).toBe(true);
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

describe('refresh periodico e flap di topologia', () => {
  it('lista piena + refresh con owner sano: la remota resta disponibile mentre il fetch è in volo', async () => {
    let slow = false;
    let resolveRemote = null;
    mocks.getDecks.mockImplementation((_t, route = []) => {
      if (!route.length) return Promise.resolve(localStore);
      if (route[0] === 'extra') return new Promise(() => {});
      if (!slow) return Promise.resolve(remoteStore);
      return new Promise((res) => { resolveRemote = res; });
    });
    const { rerender } = render(<Probe owners={[OWNER_UP]} current={remoteIdDeck} />);
    await waitFor(() => expect(stateOf().decks.find((d) => d.id === remoteIdDeck)?.available).toBe(true));
    // Refresh con il peer ancora sano ma lento: finché il fetch è in volo la
    // sua deck NON deve passare offline (è questo il lampeggio della rail).
    slow = true;
    rerender(<Probe owners={[OWNER_UP, OWNER_EXTRA]} current={remoteIdDeck} />);
    await waitFor(() => expect(mocks.getRouteConfig.mock.calls.length).toBe(2));
    await act(async () => {});
    expect(stateOf().decks.find((d) => d.id === remoteIdDeck)?.available).toBe(true);
    if (resolveRemote) resolveRemote(remoteStore);
    await waitFor(() => expect(stateOf().decks.find((d) => d.id === remoteIdDeck)?.available).toBe(true));
    expect(mocks.saveDeck).not.toHaveBeenCalled();
  });

  it('un flap di status/label di un owner NON rilancia il caricamento dei deck', async () => {
    mocks.getDecks.mockImplementation((_t, route = []) => (route.length
      ? Promise.resolve(remoteStore)
      : Promise.resolve(localStore)));
    const { rerender } = render(<Probe owners={[OWNER_UP]} current={remoteIdDeck} />);
    await waitFor(() => expect(stateOf().decks.find((d) => d.id === remoteIdDeck)?.available).toBe(true));
    expect(mocks.getRouteConfig.mock.calls.length).toBe(1);
    // La topologia ristampa lo stesso owner con status e label diversi (blip):
    // nessun nuovo loadAll — la firma degli owner resta invariata.
    rerender(<Probe owners={[{ ...OWNER_UP, status: 'down', label: 'Peer-2' }]} current={remoteIdDeck} />);
    await act(async () => { await new Promise((r) => setTimeout(r, 120)); });
    expect(mocks.getRouteConfig.mock.calls.length).toBe(1);
    expect(stateOf().decks.find((d) => d.id === remoteIdDeck)?.available).toBe(true);
    expect(mocks.saveDeck).not.toHaveBeenCalled();
  });
});
