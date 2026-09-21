import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// Stato sticky degli owner: la lista dei nodi/topologia è uno STATO che un
// fetch fallito o una risposta vuota NON azzera; un owner assente da una
// risposta confermata resta in lista come stale e sparisce solo dopo la
// grazia lunga. Prima di questa modifica il ciclo fallito produceva
// groups=[] (o senza l'owner) e la deck rail svuotava.

const state = vi.hoisted(() => ({
  nodesOk: true,
  topologyOk: true,
  nodesResp: { nodes: [{ name: 'vps', nodeId: 'aaaa', tunnel: { status: 'up' }, paired: true }] },
  topologyResp: {
    nodes: [{ name: 'peer2', route: ['hub', 'peer2'], instanceId: 'bbbb', label: 'Peer2', stale: false }],
  },
  sessionsOk: true,
}));

vi.mock('../lib/api.js', () => ({
  apiFetch: vi.fn(async () => ({ json: async () => ({ instanceId: 'local0', version: 'test' }) })),
  getNodes: vi.fn(async () => {
    if (!state.nodesOk) throw new Error('HTTP 502');
    return state.nodesResp;
  }),
  getTopology: vi.fn(async () => {
    if (!state.topologyOk) throw new Error('HTTP 502');
    return state.topologyResp;
  }),
  getNodeAliases: vi.fn(async () => ({ aliasesByInstanceId: {} })),
  getRouteSessions: vi.fn(async () => {
    if (!state.sessionsOk) { const e = new Error('HTTP 502'); e.status = 502; throw e; }
    return { sessions: [] };
  }),
  fleetStatus: vi.fn(async () => ({ available: false })),
  getVlNodes: vi.fn(async () => ({ nodes: [] })),
}));

import { useNodes } from './useNodes.js';

const findGroup = (groups, name) => groups.find((g) => g.name === name);

describe('useNodes: stato sticky degli owner (lista che non svuota)', () => {
  beforeEach(() => {
    state.nodesOk = true;
    state.topologyOk = true;
    state.sessionsOk = true;
    state.nodesResp = { nodes: [{ name: 'vps', nodeId: 'aaaa', tunnel: { status: 'up' }, paired: true }] };
    state.topologyResp = {
      nodes: [{ name: 'peer2', route: ['hub', 'peer2'], instanceId: 'bbbb', label: 'Peer2', stale: false }],
    };
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('un fetch fallito NON svuota gli owner: restano con flag stale', async () => {
    const { result } = renderHook(() => useNodes('token', true, 0));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(findGroup(result.current, 'vps')).toBeTruthy();
    expect(findGroup(result.current, 'peer2')).toBeTruthy();

    // Ciclo successivo: entrambi i fetch falliscono.
    state.nodesOk = false;
    state.topologyOk = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });

    const vps = findGroup(result.current, 'vps');
    const peerB = findGroup(result.current, 'peer2');
    expect(vps).toBeTruthy();
    expect(peerB).toBeTruthy();
    expect(vps.stale).toBe(true);
    expect(peerB.stale).toBe(true);
  });

  it('una risposta vuota confermata NON azzera gli owner noti', async () => {
    const { result } = renderHook(() => useNodes('token', true, 0));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(findGroup(result.current, 'vps')).toBeTruthy();

    state.nodesResp = { nodes: [] };
    state.topologyResp = { nodes: [] };
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });

    expect(findGroup(result.current, 'vps')).toBeTruthy();
    expect(findGroup(result.current, 'peer2')).toBeTruthy();
  });

  it('owner assente da una risposta confermata resta stale, non sparisce', async () => {
    const { result } = renderHook(() => useNodes('token', true, 0));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(findGroup(result.current, 'peer2')).toBeTruthy();

    // Risposta CONFERMATA senza l'owner federato (blip/purge lato hub).
    state.topologyResp = { nodes: [] };
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });

    const peerB = findGroup(result.current, 'peer2');
    expect(peerB).toBeTruthy();
    expect(peerB.stale).toBe(true);
  });

  it('dopo la grazia di 10 minuti di assenza confermata l\'owner sparisce', async () => {
    const { result } = renderHook(() => useNodes('token', true, 0));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(findGroup(result.current, 'peer2')).toBeTruthy();

    state.topologyResp = { nodes: [] };
    // Un ciclo lo marca stale, poi la grazia scade e il successivo lo rimuove.
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(findGroup(result.current, 'peer2')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 4000); });
    expect(findGroup(result.current, 'peer2')).toBeFalsy();
  });
});
