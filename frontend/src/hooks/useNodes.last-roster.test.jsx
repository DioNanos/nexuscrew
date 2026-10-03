import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

const state = vi.hoisted(() => ({ failFleet: false }));
const cells = [
  { cell: 'Dev', tmuxSession: 'cloud-Dev', engine: 'claude', active: true },
  { cell: 'Fork', tmuxSession: 'cloud-Fork', engine: 'codex', active: false },
];

vi.mock('../lib/api.js', () => ({
  ROSTER_READ_TIMEOUT_MS: 8000,
  apiFetch: vi.fn(async () => ({ json: async () => ({ instanceId: 'local', version: 'test' }) })),
  getRouteConfig: vi.fn(async () => ({ instanceId: 'local', version: 'test' })),
  getNodes: vi.fn(async () => ({ nodes: [{ name: 'vps', nodeId: 'a'.repeat(32), tunnel: { status: 'up' }, paired: true }] })),
  getTopology: vi.fn(async () => ({ nodes: [] })),
  getNodeAliases: vi.fn(async () => ({ aliasesByInstanceId: {} })),
  getRouteSessions: vi.fn(async () => ({ sessions: [{ name: 'cloud-Dev' }] })),
  fleetStatus: vi.fn(async () => { if (state.failFleet) throw new Error('fetch failed'); return { available: true, cells }; }),
  getVlNodes: vi.fn(async () => ({ nodes: [] })),
}));

import { useNodes } from './useNodes.js';

describe('useNodes: ultimo elenco celle buono per instanceId (O1, nodo remoto)', () => {
  beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); state.failFleet = false; });
  afterEach(() => { vi.useRealTimers(); });

  it('PWA riaperta con il fleet del peer in errore: le celle dell\'ultima lettura restano, marcate stale', async () => {
    const first = renderHook(() => useNodes('token', true, 0));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(first.result.current.find((g) => g.name === 'vps').cells.map((c) => c.cell)).toEqual(['Dev', 'Fork']);
    first.unmount();
    state.failFleet = true; // memoria persa, il fleet del peer non risponde
    const second = renderHook(() => useNodes('token', true, 0));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const g = second.result.current.find((x) => x.name === 'vps');
    expect(g.cells.map((c) => c.cell)).toEqual(['Dev', 'Fork']);
    expect(g.fleetState).toBe('stale');
    expect(g.cells.every((c) => c.tmux !== true)).toBe(true);
  });

  it('senza lettura salvata il fleet in errore non inventa celle', async () => {
    state.failFleet = true;
    const { result } = renderHook(() => useNodes('token', true, 0));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.find((x) => x.name === 'vps').cells).toEqual([]);
  });
});
