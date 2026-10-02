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
import { buildNodeGroups } from '../lib/nodes-model.js';
import { buildRemoteRoster } from '../lib/roster-view-model.js';

// La barra dei deck non deve dichiarare OFFLINE un owner per un solo refresh
// federato caduto: la sidebar a sinistra, sullo stesso tunnel, mostra il nodo
// 'up' con le celle live. Un timeout di getDecks lascia le deck con la
// disponibilità già nota, il flag stale e l'istante del refresh fallito
// (badge «in ritardo»); l'offline esplicito arriva solo dal gruppo owner che
// la lista nodi/celle dichiara non-'up', e quando il gruppo torna 'up' il
// caricamento per-owner riparte subito.
//
// Le due viste non condividono la sonda: la sidebar decide «up» da tunnel +
// sessions (+ inventario fleet noto, ANCHE se stale/cache — nodes-model.js
// buildNodeGroups: sessionsAvailable || fleetInventoryPresent), mentre la
// barra deck legge il refresh federato getDecks(route) (payload più pesante,
// timeout federato 8 s in api.js): su un tunnel degradato decks scade mentre
// sessions risponde ancora.
const localId = 'a'.repeat(32);
const remoteId = 'b'.repeat(32);
const extraId = 'c'.repeat(32);
const OWNER_PEER_UP = { instanceId: remoteId, route: ['peer'], label: 'Peer', status: 'up' };
const OWNER_PEER_DOWN = { instanceId: remoteId, route: ['peer'], label: 'Peer', status: 'down' };
const OWNER_EXTRA = { instanceId: extraId, route: ['extra'], label: 'Extra', status: 'up' };

function Probe({ owners, current }) {
  const [layout, setLayout] = useState(emptyLayout());
  const value = useDecks('token', current, layout, setLayout, owners);
  return <pre data-testid="probe">{JSON.stringify({
    ready: value.ready,
    decks: (value.records || []).map((d) => ({
      id: d.id, local: d.local, available: d.available,
      stale: d.stale === true, refreshFailedAt: d.refreshFailedAt || null,
    })),
  })}</pre>;
}

const localStore = { decks: [{ name: 'main', revision: 3, layout: emptyLayout() }] };
const remoteStore = { decks: [{ name: 'dev', revision: 7, layout: emptyLayout() }] };
const remoteIdDeck = `${remoteId}:dev`;
const stateOf = () => JSON.parse(screen.getByTestId('probe').textContent);

// La sidebarvista dello STESSO istante: sessions lette, fleet NON leggibile a
// questo giro (ultima lista buona in cache, fleetState 'stale') — la forma
// esatta che useNodes produce quando la lettura fleet fallisce ma il peer
// risponde a sessions.
const sidebarGroups = buildNodeGroups({
  nodes: [{ name: 'peer', label: 'Peer', nodeId: remoteId, tunnel: { status: 'up' } }],
  topology: [],
  remote: { peer: { sessions: [{ name: 'cloud-Dev', preview: 'ok' }], at: 1 } },
  fleet: { peer: { available: false, fleetState: 'stale', cells: [{ cell: 'Dev', tmuxSession: 'cloud-Dev', tmux: true, engine: 'claude' }] } },
  aliases: {},
});

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  mocks.getRouteConfig.mockResolvedValue({ instanceId: localId });
  mocks.getRouteTopology.mockResolvedValue({ nodes: [] });
});

describe('divergenza sidebar online vs barra deck offline', () => {
  it('un refresh federato fallito lascia il deck disponibile con stale, mentre il gruppo nodo resta up con cella live', async () => {
    // Premessa (fonte della SX): con sessions lette e inventario fleet noto
    // anche solo da cache, il gruppo e' 'up' e la cella e' live.
    const group = sidebarGroups.find((g) => g.name === 'peer');
    expect(group?.status).toBe('up');
    const roster = buildRemoteRoster(group);
    const cellRow = roster.rawItems.find((item) => item.type === 'cell');
    expect(cellRow?.live).toBe(true);

    // Barra deck: primo giro l'owner risponde, il refresh successivo scade
    // (timeout federato del solo endpoint decks).
    let peerCalls = 0;
    mocks.getDecks.mockImplementation((_t, route = []) => {
      if (!route.length) return Promise.resolve(localStore);
      if (route[0] === 'peer') {
        peerCalls += 1;
        return peerCalls <= 1 ? Promise.resolve(remoteStore) : Promise.reject(new Error('timeout'));
      }
      return new Promise(() => {}); // owner extra: mai risposta, non blocca
    });

    const { rerender } = render(<Probe owners={[OWNER_PEER_UP]} current="main" />);
    await waitFor(() => expect(stateOf().ready).toBe(true));
    await waitFor(() => expect(stateOf().decks.find((d) => d.id === remoteIdDeck)?.available).toBe(true));

    // Nuovo giro di loadAll (canale legittimo: cambia la firma degli owner).
    rerender(<Probe owners={[OWNER_PEER_UP, OWNER_EXTRA]} current="main" />);
    await waitFor(() => expect(mocks.getRouteConfig.mock.calls.length).toBe(2));
    const chip = await waitFor(() => {
      const found = stateOf().decks.find((d) => d.id === remoteIdDeck);
      expect(found?.stale).toBe(true);
      return found;
    });

    // Post-fix: il fetch caduto NON spegne il deck — disponibilità invariata
    // (true), stale + istante del refresh fallito per il badge «in ritardo».
    expect(chip.available).not.toBe(false);
    expect(typeof chip.refreshFailedAt).toBe('number');

    // La coerenza con la SX resta: stesso owner, stesso istante — gruppo 'up'
    // + cella live, barra deck NON offline.
    expect(group?.status).toBe('up');
    expect(cellRow?.live).toBe(true);
    expect(stateOf().decks.find((d) => d.id === remoteIdDeck)?.available).not.toBe(false);
    expect(mocks.saveDeck).not.toHaveBeenCalled();
  });

  it('owner con gruppo non-up: le sue deck sono available false e nessun reload parte', async () => {
    let peerCalls = 0;
    mocks.getDecks.mockImplementation((_t, route = []) => {
      if (!route.length) return Promise.resolve(localStore);
      if (route[0] === 'peer') {
        peerCalls += 1;
        return Promise.resolve(remoteStore);
      }
      return new Promise(() => {});
    });

    const { rerender } = render(<Probe owners={[OWNER_PEER_UP]} current="main" />);
    await waitFor(() => expect(stateOf().ready).toBe(true));
    await waitFor(() => expect(stateOf().decks.find((d) => d.id === remoteIdDeck)?.available).toBe(true));
    const callsAfterFirstLoad = mocks.getRouteConfig.mock.calls.length;

    // Il gruppo owner passa a non-'up': al prossimo loadAll il degrado è
    // esplicito (available:false) e nessun caricamento per-owner parte.
    rerender(<Probe owners={[OWNER_PEER_DOWN, OWNER_EXTRA]} current="main" />);
    await waitFor(() => expect(stateOf().decks.find((d) => d.id === remoteIdDeck)?.available).toBe(false));
    await waitFor(() => expect(mocks.getRouteConfig.mock.calls.length).toBe(callsAfterFirstLoad + 1));
    expect(peerCalls).toBe(1);
  });

  it('quando il gruppo torna up il caricamento per-owner riparte e il deck torna disponibile', async () => {
    let peerCalls = 0;
    mocks.getDecks.mockImplementation((_t, route = []) => {
      if (!route.length) return Promise.resolve(localStore);
      if (route[0] === 'peer') {
        peerCalls += 1;
        return Promise.resolve(remoteStore);
      }
      return new Promise(() => {});
    });

    // owner 'up' (prima lista valida) → non-'up' (degrado al loadAll con la
    // lista nuova) → di nuovo 'up' con STESSA identità (ownersSig invariato:
    // solo la firma degli stati cambia).
    const { rerender } = render(<Probe owners={[OWNER_PEER_UP]} current="main" />);
    await waitFor(() => expect(stateOf().decks.find((d) => d.id === remoteIdDeck)?.available).toBe(true));
    rerender(<Probe owners={[OWNER_PEER_DOWN, OWNER_EXTRA]} current="main" />);
    await waitFor(() => expect(stateOf().decks.find((d) => d.id === remoteIdDeck)?.available).toBe(false));

    rerender(<Probe owners={[OWNER_PEER_UP, OWNER_EXTRA]} current="main" />);
    await waitFor(() => {
      const chip = stateOf().decks.find((d) => d.id === remoteIdDeck);
      expect(chip?.available).toBe(true);
      return chip;
    });
    expect(peerCalls).toBeGreaterThanOrEqual(2);
  });
});
