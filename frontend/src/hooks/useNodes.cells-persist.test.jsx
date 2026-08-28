import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// Il sintomo riportato, end-to-end: «la lista sparisce anche se c'è già segnato
// che è OFFLINE». Tre giri guidati:
//  1) nodo up, fleet dichiara 3 celle -> 3 visibili, nessuna preservata;
//  2) il nodo CADE (tunnel down): niente fetch per quella route, l'ultimo
//     elenco resta visibile marcato non-raggiungibile (cellsPreserved, ogni
//     cella preserved);
//  3) il nodo torna su e il fleet ne dichiara 2: la terza SPARISCE — il dato
//     autorevole sostituisce per intero (P2), non si unisce al ricordo.

const state = vi.hoisted(() => ({
  tunnel: 'up',
  cells: [
    { cell: 'Dev', tmuxSession: 'cloud-Dev', engine: 'claude', active: true },
    { cell: 'Fork', tmuxSession: 'cloud-Fork', engine: 'codex', active: true },
    { cell: 'Research', tmuxSession: 'cloud-Research', engine: 'glm', active: true },
  ],
}));

vi.mock('../lib/api.js', () => ({
  apiFetch: vi.fn(async () => ({ json: async () => ({ instanceId: 'local', version: 'test' }) })),
  getNodes: vi.fn(async () => ({
    nodes: [{ name: 'vps', nodeId: 'a'.repeat(32), tunnel: { status: state.tunnel }, paired: true }],
  })),
  getTopology: vi.fn(async () => ({ nodes: [] })),
  getNodeAliases: vi.fn(async () => ({ aliasesByInstanceId: {} })),
  getRouteSessions: vi.fn(async () => ({ sessions: [{ name: 'cloud-Dev' }] })),
  fleetStatus: vi.fn(async () => ({ available: true, cells: state.cells })),
  getVlNodes: vi.fn(async () => ({ nodes: [] })),
}));

import { useNodes } from './useNodes.js';

describe("useNodes: l'elenco celle sopravvive alla caduta del nodo", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.tunnel = 'up';
    state.cells = [
      { cell: 'Dev', tmuxSession: 'cloud-Dev', engine: 'claude', active: true },
      { cell: 'Fork', tmuxSession: 'cloud-Fork', engine: 'codex', active: true },
      { cell: 'Research', tmuxSession: 'cloud-Research', engine: 'glm', active: true },
    ];
  });
  afterEach(() => { vi.useRealTimers(); });

  it('up(3) -> down conserva 3 marcate -> up(2): la terza sparisce', async () => {
    const { result } = renderHook(() => useNodes('token', true, 0));

    // Giro 1: nodo su, 3 celle vive.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    let g = result.current.find((x) => x.name === 'vps');
    expect(g.status).toBe('up');
    expect(g.cells.map((c) => c.cell)).toEqual(['Dev', 'Fork', 'Research']);
    expect(g.cellsPreserved).toBeUndefined();
    expect(g.cells.every((c) => c.preserved === undefined)).toBe(true);

    // Giro 2: il nodo CADE. Ramo esercitato: nodo diretto down + payload
    // fleet presentato dalla cache come elenco fermo.
    state.tunnel = 'down';
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    g = result.current.find((x) => x.name === 'vps');
    expect(g.status).toBe('down');
    expect(g.cellsPreserved).toBe(true);
    expect(g.cells.map((c) => c.cell)).toEqual(['Dev', 'Fork', 'Research'], "l'ultimo elenco resta visibile");
    expect(g.cells.every((c) => c.preserved === true)).toBe(true, 'ogni cella è marcata non raggiungibile');

    // Giro 3: torna su con 2 celle -> la terza SPARISCE (P2, il test che
    // nessuno scrive): il dato autorevole sostituisce, non unisce.
    state.tunnel = 'up';
    state.cells = state.cells.slice(0, 2);
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    g = result.current.find((x) => x.name === 'vps');
    expect(g.status).toBe('up');
    expect(g.cells.map((c) => c.cell)).toEqual(['Dev', 'Fork'], 'rimozione vera: la terza cella non esiste più');
    expect(g.cellsPreserved).toBeUndefined();
  });

  it('down persistente: l\'elenco NON si svuota col passare dei giri (nessun TTL)', async () => {
    const { result } = renderHook(() => useNodes('token', true, 0));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    state.tunnel = 'down';
    for (let i = 0; i < 5; i++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    }
    const g = result.current.find((x) => x.name === 'vps');
    expect(g.status).toBe('down');
    expect(g.cells.length).toBe(3, 'dopo 5 giri giù le celle restano: mai «vuoto» per timeout');
    expect(g.cellsPreserved).toBe(true);
  });
});
