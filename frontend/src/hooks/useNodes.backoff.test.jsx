import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// R21 — la prova che il backoff NON e' una condanna.
//
// Il briefing e' esplicito: «quando il peer torna raggiungibile la cadenza
// torna normale — e questo va TESTATO, altrimenti il backoff diventa una
// condanna». Qui si guida l'orologio: un peer che fallisce due volte viene
// saltato al terzo giro (la guardia), poi torna a rispondere e il giro
// successivo lo si interroga DI NUOVO alla cadenza normale (il recupero).
// Se il recupero non funzionasse, il conteggio delle chiamate resterebbe
// fermo — ed e' esattamente quello che il test vedrebbe.

const NODES = {
  nodes: [{ name: 'vps', nodeId: 'aaaa', tunnel: { status: 'up' }, paired: true }],
};

const calls = vi.hoisted(() => ({ sessions: 0, failTimes: 2 }));

vi.mock('../lib/api.js', () => ({
  apiFetch: vi.fn(async () => ({ json: async () => ({ instanceId: 'local', version: 'test' }) })),
  getNodes: vi.fn(async () => NODES),
  getTopology: vi.fn(async () => ({ nodes: [] })),
  getNodeAliases: vi.fn(async () => ({ aliasesByInstanceId: {} })),
  getRouteSessions: vi.fn(async () => {
    calls.sessions += 1;
    if (calls.sessions <= calls.failTimes) {
      const e = new Error('HTTP 502');
      e.status = 502;
      throw e;
    }
    return { sessions: [{ name: 'tornata' }] };
  }),
  fleetStatus: vi.fn(async () => ({ available: false })),
  getVlNodes: vi.fn(async () => ({ nodes: [] })),
}));

import { useNodes } from './useNodes.js';
import { fleetStatus, getRouteSessions } from '../lib/api.js';

describe('useNodes: backoff sui peer morti, recupero quando tornano (R21)', () => {
  beforeEach(() => {
    calls.sessions = 0;
    calls.failTimes = 2;
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('fallisce due volte, viene saltato un giro, poi torna e la cadenza riprende', async () => {
    const { result } = renderHook(() => useNodes('token', true, 0));

    // Giro iniziale: prima chiamata, fallisce (502).
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(calls.sessions).toBe(1);
    let g = result.current.find((x) => x.name === 'vps');
    expect(g.status).toBe('unreachable');
    expect(g.cause).toBe('peer-assente');

    // +4 s: il primo fallimento non rallenta il recupero, si riprova.
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(calls.sessions).toBe(2);
    g = result.current.find((x) => x.name === 'vps');
    expect(g.cause).toBe('peer-assente');

    // +4 s (8 totali): secondo fallimento -> ritardo raddoppiato (8 s da qui):
    // QUESTO giro il peer morto NON si interroga. E' la guardia del backoff:
    // il conteggio delle chiamate resta fermo, chi guarda gli altri peer
    // non viene intasato.
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(calls.sessions).toBe(2);

    // +4 s (12 totali): il ritardo e' maturato, si riprova — e stavolta il
    // peer RISPONDE.
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(calls.sessions).toBe(3);
    g = result.current.find((x) => x.name === 'vps');
    expect(g.status).toBe('up');

    // +4 s (16 totali): la cadenza e' di nuovo NORMALE — il backoff non e'
    // una condanna: si interroga al giro successivo, non dopo il vecchio
    // ritardo residuo.
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(calls.sessions).toBe(4);
  });

  it('la causa del 403 arriva fino al gruppo: chi guarda sa cosa fare', async () => {
    const { getRouteSessions } = await import('../lib/api.js');
    getRouteSessions.mockImplementationOnce(async () => {
      const e = new Error('HTTP 403');
      e.status = 403;
      throw e;
    });
    const { result } = renderHook(() => useNodes('token', true, 1));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const g = result.current.find((x) => x.name === 'vps');
    expect(g.status).toBe('unreachable');
    // La causa viaggia model -> gruppo (nodes-model) -> dato per la UI; il
    // testo con l'azione lo compone roster-view-model, testato a parte.
    expect(g.cause).toBe('peer-nega');
  });

  it('conserva le celle Fleet durante il giro remoto in backoff (ramo stale)', async () => {
    calls.failTimes = 0;
    fleetStatus.mockResolvedValue({
      available: true,
      cells: [{ cell: 'Dev', tmuxSession: 'cloud-Dev', active: true }],
    });
    const peerError = new Error('HTTP 502');
    peerError.status = 502;
    getRouteSessions
      .mockResolvedValueOnce({ sessions: [{ name: 'cloud-Dev' }] })
      .mockRejectedValueOnce(peerError)
      .mockRejectedValueOnce(peerError)
      .mockResolvedValue({ sessions: [{ name: 'cloud-Dev' }] });

    const { result } = renderHook(() => useNodes('token', true, 7));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.find((x) => x.name === 'vps').cells).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    // Il terzo giro è saltato dal backoff: deve esporre l'ultima lista nota,
    // marcandola stale, invece di trasformare fleet assente in celle vuote.
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    const group = result.current.find((x) => x.name === 'vps');
    expect(group.cells).toHaveLength(1);
    expect(group.fleetState).toBe('stale');
    expect(group.fleetAvailable).toBe(false);
  });

  it('conserva le celle Fleet quando la lettura remota viene rifiutata (ramo stale)', async () => {
    calls.failTimes = 0;
    fleetStatus
      .mockResolvedValueOnce({ available: true, cells: [{ cell: 'Dev', tmuxSession: 'cloud-Dev' }] })
      .mockRejectedValueOnce(new Error('fleet HTTP 502'));
    const { result } = renderHook(() => useNodes('token', true, 8));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.find((x) => x.name === 'vps').cells).toHaveLength(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    const group = result.current.find((x) => x.name === 'vps');
    expect(group.cells).toHaveLength(1);
    expect(group.fleetState).toBe('stale');
    expect(group.fleetAvailable).toBe(false);
  });
});
