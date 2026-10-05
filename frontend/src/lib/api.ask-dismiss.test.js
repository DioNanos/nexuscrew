import { afterEach, expect, it, vi } from 'vitest';
import * as api from './api.js';
afterEach(() => vi.unstubAllGlobals());
function request() { const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ dismissed: true, scope: 'local', ownerSync: 'pending' }) })); vi.stubGlobal('fetch', fetch); return fetch; }
it('remote card capability opts into the dismissal permissions', async () => {
  const fetch = request(); await api.getAskReplyCapability('fixture', { ownerId: 'owner', askId: 'ask' });
  expect(fetch.mock.calls[0][0]).toContain('dismissals=1');
});
it('local dismissal posts only the canonical closed body to the local relay', async () => {
  const fetch = request(); expect(api.relayAskDismissLocal).toBeTypeOf('function');
  await api.relayAskDismissLocal('fixture', { ownerId: 'owner', askId: 'ask', reason: 'forged', ownerAskTs: 99 });
  const [url, options] = fetch.mock.calls[0]; expect(url).toBe('/api/asks-relay'); expect(options.method).toBe('POST');
  expect(JSON.parse(options.body)).toEqual({ action: 'dismiss-local', ownerId: 'owner', askId: 'ask' });
  expect(options.headers.Authorization).toBe('Bearer fixture'); expect(fetch).toHaveBeenCalledTimes(1);
});
