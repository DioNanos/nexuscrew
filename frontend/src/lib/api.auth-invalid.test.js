import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch, AUTH_INVALID_EVENT, isLocalApiPath } from './api.js';

// T2: il 401 dell'autenticazione LOCALE (token che il nodo non riconosce) deve poter riaprire il prompt;
// il 401 di un peer (route federate, /node/…) e i timeout NO.
let events;
const listener = (e) => events.push(e.detail);
beforeEach(() => { events = []; window.addEventListener(AUTH_INVALID_EVENT, listener); });
afterEach(() => { window.removeEventListener(AUTH_INVALID_EVENT, listener); vi.unstubAllGlobals(); });
const stub = (status) => vi.stubGlobal('fetch', vi.fn(async () => ({ status, ok: status < 400, json: async () => ({}) })));

describe('401 locale contro 401 di peer', () => {
  it('classifica i percorsi', () => {
    expect(isLocalApiPath('/api/sessions')).toBe(true);
    expect(isLocalApiPath('/api/nodes')).toBe(true);
    expect(isLocalApiPath('/api/route/device-a/_/sessions')).toBe(false);
    expect(isLocalApiPath('/node/relay/api/sessions')).toBe(false);
    expect(isLocalApiPath('https://example.test/api/x')).toBe(false);
  });

  it('401 su una API locale emette l\'evento col token che ha fallito', async () => {
    stub(401);
    await apiFetch('/api/sessions', 'tok-vecchio');
    expect(events).toEqual([{ token: 'tok-vecchio', path: '/api/sessions' }]);
  });

  it('401 su una route federata NON emette nulla (e' + "'" + ' il peer che rifiuta, non noi)', async () => {
    stub(401);
    await apiFetch('/api/route/device-a/_/sessions', 'tok');
    await apiFetch('/node/relay/api/sessions', 'tok');
    expect(events).toEqual([]);
  });

  it('403, 500 e 200 sulla API locale non emettono nulla', async () => {
    for (const s of [200, 403, 500, 502]) { stub(s); await apiFetch('/api/sessions', 'tok'); }
    expect(events).toEqual([]);
  });

  it('un timeout/abort (nessuna risposta) non emette nulla', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('timeout', 'TimeoutError'); }));
    await expect(apiFetch('/api/sessions', 'tok')).rejects.toBeTruthy();
    expect(events).toEqual([]);
  });
});
