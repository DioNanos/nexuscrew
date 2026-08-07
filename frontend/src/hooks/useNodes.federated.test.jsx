import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

// LA FORMA FEDERATA: nodo VL su un owner, interfaccia su un altro.
// È l'unico caso che riguarda chi guarda dal telefono, ed è quello che
// nessun test copriva: il mio E2E aveva nodo e hub sullo stesso owner.
//
// I dati NON sono inventati: topology e /api/vl-nodes riproducono le
// risposte REALI misurate sull'infrastruttura viva il 2026-08-06 via proxy
// federato (topology del telefono: owner cloud-example-com a un hop,
// non stale; vl-nodes di VPS3: N900 online con session dichiarata).

const PHONE_INSTANCE = '5c588d7441c73b414f0912b30305f269';
const VPS_INSTANCE = '1f2e3d4c5b6a79880123456789abcdef';
const N900_ID = '82dffb30040048879162878d75306bbe';

const PHONE_TOPOLOGY = {
  nodes: [
    { name: 'cloud-example-com', instanceId: VPS_INSTANCE, route: ['cloud-example-com'], stale: false, label: 'VPS_Cloud' },
    { name: 'nexus-crew-0e88', instanceId: '0e88cdc9cd977e5db29ffcdba839e924', route: ['cloud-example-com', 'nexus-crew-0e88'], stale: false },
  ],
};

const VPS_VL_NODES = {
  instanceId: VPS_INSTANCE,
  protocol: 'vl-node/1',
  nodes: [{
    nodeId: N900_ID,
    label: 'N900',
    pairedAt: 1785601321838,
    online: true,
    lastSeen: 1785982674769,
    generation: 1,
    version: '0.1.0',
    capabilities: ['status', 'health', 'prompt'],
    health: { state: 'running', uptimeSec: 371554, rssBytes: 2097152, processCount: 2, brokerReachable: true },
    session: { attached: true, profile: 'ollama' },
    inflight: null,
    lastAck: null,
  }],
};

const calls = vi.hoisted(() => ({ vlRoutes: [] }));

vi.mock('../lib/api.js', () => ({
  apiFetch: vi.fn(async () => ({ json: async () => ({ instanceId: PHONE_INSTANCE, version: 'test' }) })),
  getNodes: vi.fn(async () => ({ nodes: [] })),
  getTopology: vi.fn(async () => PHONE_TOPOLOGY),
  getNodeAliases: vi.fn(async () => ({ aliasesByInstanceId: {} })),
  getRouteSessions: vi.fn(async () => ({ sessions: [] })),
  fleetStatus: vi.fn(async () => ({ available: false })),
  getVlNodes: vi.fn(async (_token, route = []) => {
    calls.vlRoutes.push(Array.isArray(route) ? [...route] : route);
    if (Array.isArray(route) && route.join('/') === 'cloud-example-com') return VPS_VL_NODES;
    return { nodes: [] };
  }),
}));

import { useNodes } from './useNodes.js';
import { fleetStatus, getRouteSessions, getTopology, getVlNodes } from '../lib/api.js';

beforeEach(() => {
  calls.vlRoutes.length = 0;
  vi.mocked(fleetStatus).mockClear();
  vi.mocked(getRouteSessions).mockClear();
  vi.mocked(getTopology).mockClear();
  vi.mocked(getVlNodes).mockClear();
});

describe('useNodes — aggregazione federata dei nodi VL', () => {
  it('interroga /api/vl-nodes sugli owner federati, non solo sul locale', async () => {
    renderHook(() => useNodes('token', true));
    await waitFor(() => {
      expect(calls.vlRoutes).toContainEqual([]);
      expect(calls.vlRoutes).toContainEqual(['cloud-example-com']);
    });
    // gli owner a più hop non sono interrogati due volte per instanceId, e
    // il locale resta uno solo: niente tempesta di richieste per giro.
    expect(calls.vlRoutes.filter((r) => r.length === 0)).toHaveLength(1);
  });

  it('il N900 di un owner remoto diventa un gruppo sidebar con la sessione dichiarata', async () => {
    const { result } = renderHook(() => useNodes('token', true));
    await waitFor(() => {
      const vl = (result.current || []).filter((g) => g.kind === 'vl');
      expect(vl).toHaveLength(1);
    });
    const group = result.current.find((g) => g.kind === 'vl');
    expect(group.label).toBe('N900');
    expect(group.status).toBe('up');
    expect(group.sessions).toHaveLength(1);
    expect(group.sessions[0].name).toBe('ollama');
    // la route dell'owner è ciò che instrada eventi e comandi: perderla
    // significa interrogare l'owner sbagliato dalla vista sessione.
    expect(group.peer.route).toEqual(['cloud-example-com']);
    expect(group.peer.ownerInstanceId).toBe(VPS_INSTANCE);
    expect(group.peer.isLocal).toBe(false);
  });
});

describe('useNodes — VL locale con route vuota', () => {
  it('un VL node locale (route [], session.attached) non fa interrogare il fleet locale', async () => {
    // Il VL node dell'owner locale ha route=[]: non e' una posizione fleet,
    // e la sua route vuota non deve mai finire nella lista `routes` che
    // useNodes interroga con fleetStatus/getRouteSessions (rifletterebbe il
    // fleet locale sotto l'etichetta del device VL). La topology include il
    // local owner con route=[] (come un VL owner locale).
    const localVl = {
      nodeId: N900_ID, label: 'N900', pairedAt: 1785601321838, online: true,
      lastSeen: 1785982674769, generation: 1, version: '0.1.0',
      capabilities: ['status', 'health', 'prompt'],
      health: { state: 'running', uptimeSec: 371554, rssBytes: 2097152, processCount: 2, brokerReachable: true },
      session: { attached: true, profile: 'ollama' },
      inflight: null, lastAck: null,
    };
    vi.mocked(getTopology).mockResolvedValue({
      nodes: [{ instanceId: PHONE_INSTANCE, name: 'local', route: [], stale: false, label: 'Local' }],
    });
    vi.mocked(getVlNodes).mockImplementation(async (_token, route = []) => (
      Array.isArray(route) && route.length === 0 ? { nodes: [localVl] } : { nodes: [] }
    ));
    const { result } = renderHook(() => useNodes('token', true));
    await waitFor(() => {
      const vl = (result.current || []).filter((g) => g.kind === 'vl');
      expect(vl).toHaveLength(1);
    });
    // La route vuota del VL locale non e' una posizione fleet: nessuna
    // interrogazione fleetStatus/getRouteSessions con route=[].
    expect(fleetStatus).not.toHaveBeenCalledWith('token', []);
    expect(getRouteSessions).not.toHaveBeenCalledWith('token', []);
    // Il gruppo VL resta display-only: sessione dichiarata, zero celle fleet.
    const group = result.current.find((g) => g.kind === 'vl');
    expect(group.label).toBe('N900');
    expect(group.sessions.map((s) => s.name)).toEqual(['ollama']);
    expect(group.cells).toEqual([]);
  });
});
