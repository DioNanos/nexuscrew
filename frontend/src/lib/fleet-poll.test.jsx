import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Il treno di letture condiviso: contratto di rete, non di UI. Le invarianti
// sono tre — un solo giro per tick per route, route diverse treni diversi,
// nessun traffico senza osservatori — più la consegna immediata dello
// snapshot corrente a chi arriva in corsa (e' il coalescing: chi apre una
// cella non rilancia la lettura che la finestra ha appena fatto).
vi.mock('./api.js', () => ({
  apiFetch: vi.fn(async (url) => ({ json: async () => ({ sessions: [{ name: 'cloud-Dev' }] }) })),
  fleetStatus: vi.fn(async () => ({ available: true, cells: [] })),
}));

import { apiFetch } from './api.js';
import {
  subscribeFleetRoute, readFleetRoute, refreshFleetRoute, FLEET_POLL_MS,
} from './fleet-poll.js';

const sessionsCalls = () => apiFetch.mock.calls.filter(([url]) => String(url).endsWith('/sessions')).length;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

describe('treno di lettura per route', () => {
  it('più consumatori sulla stessa route: un solo giro per tick', async () => {
    const a = []; const b = [];
    const offA = subscribeFleetRoute('t', [], (s) => a.push(s));
    await vi.advanceTimersByTimeAsync(0);
    const offB = subscribeFleetRoute('t', [], (s) => b.push(s));
    await vi.advanceTimersByTimeAsync(FLEET_POLL_MS * 3);
    // avvio + 3 tick: una lettura sessions per giro, non una per consumatore.
    expect(sessionsCalls()).toBe(4);
    expect(a.length).toBeGreaterThanOrEqual(4);
    expect(b.length).toBeGreaterThanOrEqual(3);
    offA(); offB();
  });

  it('chi arriva in corsa riceve subito lo snapshot corrente, senza letture nuove', async () => {
    const seen = [];
    const offA = subscribeFleetRoute('t', [], () => {});
    await vi.advanceTimersByTimeAsync(FLEET_POLL_MS);
    const before = sessionsCalls();
    const offB = subscribeFleetRoute('t', [], (s) => seen.push(s));
    expect(seen).toHaveLength(1);
    expect(sessionsCalls()).toBe(before);
    offA(); offB();
  });

  it('route diverse: treni diversi, mai letture incrociate', async () => {
    const local = []; const hub = [];
    const offLocal = subscribeFleetRoute('t', [], (s) => local.push(s));
    const offHub = subscribeFleetRoute('t', ['hub'], (s) => hub.push(s));
    await vi.advanceTimersByTimeAsync(FLEET_POLL_MS);
    const localUrls = apiFetch.mock.calls.map(([u]) => String(u));
    expect(localUrls).toContain('/api/sessions');
    expect(localUrls).toContain('/api/route/hub/_/sessions');
    expect(local[0].sessionsJson.sessions[0].name).toBe('cloud-Dev');
    expect(hub[0].sessionsJson.sessions[0].name).toBe('cloud-Dev');
    offLocal(); offHub();
  });

  it('ultimo osservatore via: il treno si ferma e non genera più traffico', async () => {
    const off = subscribeFleetRoute('t', [], () => {});
    await vi.advanceTimersByTimeAsync(FLEET_POLL_MS);
    const atStop = sessionsCalls();
    off();
    await vi.advanceTimersByTimeAsync(FLEET_POLL_MS * 3);
    expect(sessionsCalls()).toBe(atStop);
    expect(readFleetRoute([], 't')).toBeNull();
  });

  it('un giro in volo: il tick successivo si salta, non si accoda', async () => {
    let sblocca = null;
    apiFetch.mockImplementationOnce(() => new Promise((resolve) => { sblocca = resolve; }));
    const off = subscribeFleetRoute('t', [], () => {});
    await vi.advanceTimersByTimeAsync(FLEET_POLL_MS * 2);
    // Solo la lettura in volo: i tick arrivati nel frattempo sono saltati.
    expect(sessionsCalls()).toBe(1);
    sblocca({ json: async () => ({ sessions: [] }) });
    await vi.advanceTimersByTimeAsync(0);
    off();
  });

  it('refreshFleetRoute chiede un ciclo subito, entro la guardia', async () => {
    const off = subscribeFleetRoute('t', [], () => {});
    await vi.advanceTimersByTimeAsync(0);
    const before = sessionsCalls();
    refreshFleetRoute([], 't');
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionsCalls()).toBe(before + 1);
    off();
  });

  it('token diverso: treno diverso (mai letture con credenziali vecchie)', async () => {
    const offA = subscribeFleetRoute('t1', [], () => {});
    await vi.advanceTimersByTimeAsync(0);
    const offB = subscribeFleetRoute('t2', [], () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(apiFetch.mock.calls.some(([, t]) => t === 't1')).toBe(true);
    expect(apiFetch.mock.calls.some(([, t]) => t === 't2')).toBe(true);
    offA(); offB();
  });
});
