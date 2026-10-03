import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// La guardia del poll e' generazionale: un giro appeso su una fetch senza
// scadenza non deve impedire al giro del token successivo di partire, e una
// risposta vecchia che arriva tardi non deve scrivere nulla del giro nuovo.
const calls = vi.hoisted(() => ({
  sessionsByToken: [],
  pending: [],
  vlByToken: [],
}));

vi.mock('../lib/api.js', () => ({
  apiFetch: vi.fn(async () => ({ json: async () => ({ instanceId: 'local', version: 'test' }) })),
  getRouteConfig: vi.fn(async () => ({ instanceId: 'local', version: 'test' })),
  ROSTER_READ_TIMEOUT_MS: 8000,
  getNodes: vi.fn(async (token) => ({ nodes: [{ name: `nodo-${token}`, nodeId: `id-${token}`, tunnel: { status: 'up' }, paired: true }] })),
  getTopology: vi.fn(async () => ({ nodes: [] })),
  getNodeAliases: vi.fn(async () => ({ aliasesByInstanceId: {} })),
  getRouteSessions: vi.fn(async (token, route) => {
    calls.sessionsByToken.push({ token, route: route.join('/') });
    const promise = new Promise((resolve) => { calls.pending.push({ token, resolve }); });
    return promise;
  }),
  fleetStatus: vi.fn(async () => ({ available: false })),
  getVlNodes: vi.fn(async (token) => { calls.vlByToken.push(token); return { nodes: [] }; }),
}));

import { useNodes } from './useNodes.js';

const flushMicrotask = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

beforeEach(() => {
  calls.sessionsByToken = [];
  calls.pending = [];
  calls.vlByToken = [];
  localStorage.clear();
});

describe('guardia generazionale del poll', () => {
  it('un giro appeso non impedisce al giro del token nuovo di partire', async () => {
    const { result, rerender } = renderHook(({ token }) => useNodes(token, true), {
      initialProps: { token: 'vecchio' },
    });
    await act(async () => { await flushMicrotask(); });
    expect(calls.sessionsByToken.some((c) => c.token === 'vecchio')).toBe(true);
    // Il giro del token vecchio e' ancora appeso (nessuna risposta).
    const appeso = calls.pending.find((p) => p.token === 'vecchio');
    expect(appeso).toBeTruthy();

    // Cambio token: il cleanup invalida il giro vecchio e quello nuovo parte.
    rerender({ token: 'nuovo' });
    await act(async () => { await flushMicrotask(); });
    expect(calls.sessionsByToken.some((c) => c.token === 'nuovo')).toBe(true);

    // La risposta TARDIVA del giro vecchio non scrive nulla del giro nuovo:
    // nessun gruppo, nessuna cache, nessun backoff che appartenga al passato.
    appeso.resolve({ sessions: [{ name: 'sessione-vecchia', created: 1 }], at: 1 });
    await act(async () => { await flushMicrotask(); });
    // La risposta tardiva non entra nei gruppi del giro nuovo, e nello sticky
    // il nodo del token vecchio resta marcato STALE (non confermato): lo
    // storage puo' essere scritto dal giro nuovo, mai dalla risposta tardiva.
    const etichette = JSON.stringify(result.current);
    expect(etichette).not.toContain('sessione-vecchia');
    const sticky = JSON.parse(localStorage.getItem('nc-sticky-owners-v1') || 'null');
    if (sticky) {
      const vecchio = sticky.nodes.find((n) => n.name === 'nodo-vecchio');
      if (vecchio) expect(vecchio.stale).toBe(true);
    }
  });
});
