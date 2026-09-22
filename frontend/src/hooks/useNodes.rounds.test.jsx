import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// Tre proprieta' del poll dei peer, tutte e tre invisibili a occhio nudo e
// tutte e tre in grado di ricreare un terminale o di mostrare un elenco che
// non e' piu' nostro:
//
//  1. ROUND ORDINATI — le fetch federate hanno timeout fino a 8 s contro un
//     poll di 4 s: senza guardia due giri si sovrappongono, e una risposta
//     vecchia puo' atterrare dopo una nuova e sovrascriverla.
//  2. L'ULTIMO DATO BUONO E L'ULTIMO TENTATIVO sono due cose diverse: un
//     tentativo fallito non prova che la sessione sia finita, e non deve
//     distruggere la lettura buona che lo precedeva.
//  3. LA CACHE E' DEL TOKEN CHE L'HA RIEMPITA: dopo un cambio di token quella
//     di prima non e' un dato, e' un residuo di un'altra sessione.

const NODES = {
  nodes: [{ name: 'vps', nodeId: 'aaaa', tunnel: { status: 'up' }, paired: true }],
};

const calls = vi.hoisted(() => ({ sessions: 0, okTimes: 1, pending: [], hang: false, instanceId: 'local' }));

vi.mock('../lib/api.js', () => ({
  apiFetch: vi.fn(async () => ({ json: async () => ({ instanceId: calls.instanceId, version: 'test' }) })),
  getNodes: vi.fn(async () => NODES),
  getTopology: vi.fn(async () => ({ nodes: [] })),
  getNodeAliases: vi.fn(async () => ({ aliasesByInstanceId: {} })),
  getRouteSessions: vi.fn(() => {
    calls.sessions += 1;
    if (calls.hang) return new Promise((resolve) => { calls.pending.push(resolve); });
    if (calls.sessions > calls.okTimes) {
      const e = new Error('HTTP 502');
      e.status = 502;
      return Promise.reject(e);
    }
    return Promise.resolve({ sessions: [{ name: 'viva', created: 1700 }] });
  }),
  fleetStatus: vi.fn(async () => ({ available: false })),
  getVlNodes: vi.fn(async () => ({ nodes: [] })),
}));

import { useNodes } from './useNodes.js';
import { tileLifecycle, advanceTileRuntime, initialTileRuntime } from '../lib/terminal-lifecycle.js';

const gruppoDi = (groups) => groups.find((g) => g.name === 'vps');
const chiavi = (groups) => new Set(groups.flatMap((g) => g.sessions.map((s) => s.key)));
const campione = (groups) => tileLifecycle({
  tileKey: 'vps:viva', node: 'vps', nodeGroups: groups, sessionsAlive: chiavi(groups), nowMs: 0,
});

describe('useNodes: round, cache e token', () => {
  beforeEach(() => {
    calls.sessions = 0;
    calls.okTimes = 1;
    calls.pending = [];
    calls.hang = false;
    calls.instanceId = 'local';
    vi.useFakeTimers();
  });
  afterEach(() => { vi.useRealTimers(); });

  it('un giro non parte mentre il precedente e\' in volo, e la risposta tardiva non si perde', async () => {
    calls.hang = true;
    const { result } = renderHook(() => useNodes('token', true, 0));

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(calls.sessions).toBe(1);

    // Due giri di poll mentre la prima fetch e' ancora appesa: nessuno dei due
    // apre un secondo round. E' la proprieta' che rende impossibile il
    // riordino, invece di provare a ripararlo dopo.
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(calls.sessions).toBe(1);

    // La risposta tardiva atterra: viene applicata, non scartata.
    await act(async () => {
      calls.pending[0]({ sessions: [{ name: 'viva', created: 1700 }] });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(gruppoDi(result.current).status).toBe('up');
    expect(gruppoDi(result.current).sessions.map((s) => s.name)).toContain('viva');

    // E solo adesso riparte un giro nuovo.
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(calls.sessions).toBe(2);
  });

  it('un tentativo fallito non ricrea il terminale, e non cancella la lettura buona', async () => {
    calls.okTimes = 1; // la prima risponde, poi il peer cade
    const { result } = renderHook(() => useNodes('token', true, 0));

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const uno = campione(result.current);
    expect(uno.presenza).toBe('presente-verificata');

    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    const due = campione(result.current);
    expect(due.presenza).not.toBe('assente-verificata');

    // Il peer torna: la sessione non e' MAI risultata assente in una lettura
    // autorevole, quindi il terminale non si ricrea.
    calls.okTimes = 99;
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    const tre = campione(result.current);
    expect(tre.presenza).toBe('presente-verificata');

    let stato = advanceTileRuntime(initialTileRuntime(), uno).runtime;
    expect(advanceTileRuntime(stato, due).generazione).toBe(0);
    stato = advanceTileRuntime(stato, due).runtime;
    expect(advanceTileRuntime(stato, tre).generazione).toBe(0);
  });

  it('il cambio di token butta la cache: il peer in backoff viene reinterrogato', async () => {
    calls.okTimes = 0; // il peer non risponde mai
    const { rerender } = renderHook(({ t }) => useNodes(t, true, 0), { initialProps: { t: 'uno' } });

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(calls.sessions).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(calls.sessions).toBe(2);
    // Terzo giro: il backoff e' maturato e il peer morto NON si interroga.
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(calls.sessions).toBe(2);

    // Token diverso = un'altra sessione: il backoff accumulato dall'altra non
    // vale, e la cache non e' nostra.
    rerender({ t: 'due' });
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(calls.sessions).toBe(3);
  });

  it('un\'altra istanza locale butta la cache: la rotta puo\' essere la stessa', async () => {
    // Le risposte dei peer sono indicizzate per ROTTA, e un'altra istanza puo'
    // riusare la stessa rotta. Il residuo di quel nodo non e' un dato nostro —
    // e si vede dal backoff: senza la pulizia il peer resta «morto» per il
    // ritardo accumulato da un'altra istanza e il giro successivo lo salta.
    calls.okTimes = 0; // il peer non risponde mai
    renderHook(() => useNodes('token', true, 0));

    await act(async () => { await vi.advanceTimersByTimeAsync(0); });      // giro 1: fail
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });   // giro 2: fail
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });   // giro 3: saltato
    expect(calls.sessions).toBe(2);

    // Il nodo locale cambia identita': il giro che lo scopre e' il quarto.
    calls.instanceId = 'altra';
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });   // giro 4
    expect(calls.sessions).toBe(3);

    // giro 5: il backoff riparte da ZERO per la nuova istanza, quindi si
    // interroga. Col residuo di prima sarebbe ancora saltato.
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(calls.sessions).toBe(4);
  });
});
