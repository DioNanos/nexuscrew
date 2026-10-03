import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// Le fonti della lista nodi non fanno barriera fra loro: la discovery si
// pubblica quando arriva, sessions e fleet girano in parallelo per ogni
// route, e il VL e' un arricchimento separato. Un peer sano non aspetta un
// peer lento, e una fonte lenta non nasconde quella che ha gia' risposto.
const calls = vi.hoisted(() => ({
  sessions: [],
  fleet: [],
  vl: [],
  vlPending: false,
  vlPendingResolve: null,
  vlResolvers: [],
  sessionsPendingRoute: null,
  fleetPending: false,
  fleetPendingReject: null,
  multiNodes: false,
}));

const NODO_A = { name: 'vpsa', nodeId: 'aaaa', tunnel: { status: 'up' }, paired: true };
const NODO_B = { name: 'vpsb', nodeId: 'bbbb', tunnel: { status: 'up' }, paired: true };

vi.mock('../lib/api.js', () => ({
  apiFetch: vi.fn(async () => ({ json: async () => ({ instanceId: 'local', version: 'test' }) })),
  getRouteConfig: vi.fn(async () => ({ instanceId: 'local', version: 'test' })),
  ROSTER_READ_TIMEOUT_MS: 8000,
  getNodes: vi.fn(async () => ({ nodes: (calls.vlPending || calls.multiNodes) ? [NODO_A, NODO_B] : [NODO_A] })),
  getTopology: vi.fn(async () => ({ nodes: [] })),
  getNodeAliases: vi.fn(async () => ({ aliasesByInstanceId: {} })),
  getRouteSessions: vi.fn(async (token, route) => {
    const key = route.join('/');
    calls.sessions.push(key);
    if (key === calls.sessionsPendingRoute) {
      return new Promise((resolve) => { calls.pendingResolve = resolve; });
    }
    return { sessions: [{ name: 'viva', created: 1700 }], at: 1 };
  }),
  fleetStatus: vi.fn(async (token, route) => {
    const key = route.join('/');
    calls.fleet.push(key);
    if (calls.fleetPending) {
      return new Promise((_resolve, reject) => { calls.fleetPendingReject = reject; });
    }
    return { available: true, cells: [{ cell: 'Cella', tmuxSession: 'cloud-Cella', tmux: true, engine: 'claude' }], capabilities: [] };
  }),
  getVlNodes: vi.fn(async (token, route) => {
    calls.vl.push(route.join('/') || 'local');
    if (calls.vlPending) {
      return new Promise((resolve) => { calls.vlPendingResolve = resolve; calls.vlResolvers.push(resolve); });
    }
    return { nodes: [] };
  }),
}));

import { saveLastRoster, loadLastRoster } from '../lib/last-roster.js';
import { useNodes } from './useNodes.js';

const flushMicrotask = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

const gruppoDi = (groups, name) => groups.find((g) => g.name === name);

beforeEach(() => {
  calls.sessions = [];
  calls.fleet = [];
  calls.vl = [];
  calls.vlPending = false;
  calls.vlPendingResolve = null; calls.vlResolvers = [];
  calls.sessionsPendingRoute = null;
  calls.fleetPending = false;
  calls.fleetPendingReject = null;
  calls.multiNodes = false;
  localStorage.clear();
});

describe('useNodes: nessuna barriera fra le fonti', () => {
  it('un owner VL appeso non impedisce alle letture sessions/fleet di partire e pubblicare', async () => {
    calls.vlPending = true;
    const { result } = renderHook(() => useNodes('token', true));
    await act(async () => { await flushMicrotask(); });
    // Le letture principali sono PARTITE (nessuna barriera davanti al VL).
    expect(calls.sessions).toContain('vpsa');
    expect(calls.fleet).toContain('vpsa');
    // E il gruppo e' pubblicato con la sua sessione, senza aspettare il VL.
    const gruppo = gruppoDi(result.current, 'vpsa');
    expect(gruppo).toBeTruthy();
    expect(gruppo.sessions.map((s) => s.name)).toContain('viva');
    for (const resolve of calls.vlResolvers) resolve({nodes:[]});
    await act(async () => { await flushMicrotask(); });
    expect(gruppoDi(result.current, 'vpsa')).toBeTruthy();
  });

  it('due peer: A sano si pubblica subito; il fleet sano di B esce senza aspettare le sessions di B', async () => {
    calls.vlPending = false;
    calls.multiNodes = true;
    calls.sessionsPendingRoute = 'vpsb';
    const { result } = renderHook(() => useNodes('token', true));
    await act(async () => { await flushMicrotask(); });
    // A e' visibile con la sua sessione mentre B ha sessions appese.
    const a = gruppoDi(result.current, 'vpsa');
    expect(a).toBeTruthy();
    expect(a.sessions.map((s) => s.name)).toContain('viva');
    // Il fleet di B e' stato comunque interrogato: le fonti sono parallele.
    expect(calls.fleet).toContain('vpsb');
    // Le celle di B arrivano col loro esito, senza la barriera delle sessions.
    expect(gruppoDi(result.current, 'vpsb')).toBeTruthy();
    expect(gruppoDi(result.current, 'vpsb').cells.map(c => c.cell)).toEqual(['Cella']);
    calls.pendingResolve({ sessions: [{ name: 'b-session', created: 1700 }], at: 2 });
    await act(async () => { await flushMicrotask(); });
    const b = gruppoDi(result.current, 'vpsb');
    expect(b).toBeTruthy();
    expect(b.cells.map((c) => c.cell)).toContain('Cella');
    expect(b.sessions.map(s => s.name)).toEqual(['b-session']);
  });

  it('fleet appeso: la sessione esce subito e il rifiuto conserva l\'ultimo roster come stale', async () => {
    saveLastRoster('id:aaaa', [{cell:'Saved',tmuxSession:'cloud-Saved'}]);
    const saved = loadLastRoster('id:aaaa');
    calls.fleetPending = true;
    const { result } = renderHook(() => useNodes('token', true));
    await act(async () => { await flushMicrotask(); });
    // Il gruppo con la sessione esiste PRIMA che il fleet risponda.
    const prima = gruppoDi(result.current, 'vpsa');
    expect(prima).toBeTruthy();
    expect(prima.sessions.map((s) => s.name)).toContain('viva');
    // Il fleet rifiuta (il tetto di 8 s lo chiuderebbe): l'ultimo roster buono
    // resta, marcato non verificabile, e la sessione resta in vista.
    calls.fleetPendingReject(new Error('HTTP 502'));
    await act(async () => { await flushMicrotask(); });
    const dopo = gruppoDi(result.current, 'vpsa');
    expect(dopo).toBeTruthy();
    expect(dopo.sessions.map((s) => s.name)).toContain('viva');
    expect(dopo.cells.map(c=>c.cell)).toEqual(['Saved']);
    expect(dopo.fleetState).toBe('stale');
    expect(loadLastRoster('id:aaaa')).toEqual(saved);
  });
});
