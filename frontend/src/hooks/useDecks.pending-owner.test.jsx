import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

// Un owner la cui lettura nella lista nodi e' ancora in corso ("pending")
// non e' un owner giu': al prossimo giro del poll le deck conservano la
// disponibilita' gia' nota, senza degradazione ne' marcatura stale. Il
// degrado resta legato a uno stato non-up CONFERMATO dalla discovery.
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
const OWNER_PENDING = { instanceId: remoteId, route: ['peer'], label: 'Peer', status: 'pending' };

function Probe({ owners, current }) {
  const [layout, setLayout] = useState(emptyLayout());
  const value = useDecks('token', current, layout, setLayout, owners);
  return <pre data-testid="probe">{JSON.stringify({
    ready: value.ready,
    decks: (value.records || []).map((d) => ({
      id: d.id, local: d.local, available: d.available, stale: d.stale === true,
    })),
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
  mocks.getDecks.mockImplementation((_token, route) => (
    route && route.length ? Promise.resolve(remoteStore) : Promise.resolve(localStore)
  ));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('owner pending: le deck conservano la disponibilita\' nota', () => {
  it('il giro successivo con owner pending non degrada le deck gia\' verificate', async () => {
    vi.useFakeTimers();
    const view = render(<Probe owners={[OWNER_UP]} current={{}} />);
    // Caricamento dell'owner remoto con lo stato up: le deck sono disponibili.
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    const caricate = stateOf().decks.filter((d) => d.id === remoteIdDeck);
    expect(caricate.length).toBeGreaterThan(0);
    expect(caricate.every((d) => d.available === true)).toBe(true);
    // La discovery va in pending (lettura in corso) e il poll del deck parte:
    // nessuna degradazione, nessun marcatore stale.
    view.rerender(<Probe owners={[OWNER_PENDING]} current={{}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(5500); });
    const decks = stateOf().decks.filter((d) => d.id === remoteIdDeck);
    expect(decks.length).toBeGreaterThan(0);
    expect(decks.every((d) => d.available === true)).toBe(true);
    expect(decks.every((d) => d.stale === false)).toBe(true);
  });
});

it('a brief confirmed down still reloads when checking becomes confirmed up', async () => {
  vi.useFakeTimers();
  const view = render(<Probe owners={[OWNER_UP]} current="main" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  const remoteCalls = () => mocks.getDecks.mock.calls.filter(([, route]) => route?.length).length;
  const before = remoteCalls();
  view.rerender(<Probe owners={[{ ...OWNER_UP, status: 'down' }]} current="main" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  view.rerender(<Probe owners={[{ ...OWNER_UP, checking: true }]} current="main" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(remoteCalls()).toBe(before);
  view.rerender(<Probe owners={[OWNER_UP]} current="main" />);
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(remoteCalls()).toBe(before + 1);
});
