import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from './api.js';

// A call that goes through a peer carries the owner's Authorization: it must never follow a redirect.
describe('apiFetch — redirects towards peers', () => {
  beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, headers: new Headers() }))); });
  afterEach(() => { vi.unstubAllGlobals(); });
  const lastInit = () => fetch.mock.calls.at(-1)[1];

  it('refuses redirects on /api/route/* and /node/*, with or without a timeout', async () => {
    await apiFetch('/api/route/box/_/cells/send', 't', { method: 'POST' });
    expect(lastInit().redirect).toBe('error');
    await apiFetch('/api/route/box/_/sessions', 't', { timeoutMs: 1000 });
    expect(lastInit().redirect).toBe('error');
    await apiFetch('/node/box/api/sessions', 't');
    expect(lastInit().redirect).toBe('error');
  });

  it('leaves the other calls alone, and an explicit choice wins', async () => {
    await apiFetch('/api/sessions', 't');
    expect(lastInit().redirect).toBeUndefined();
    await apiFetch('/api/route/box/_/sessions', 't', { redirect: 'follow' });
    expect(lastInit().redirect).toBe('follow');
  });

  it('keeps sending the Authorization header', async () => {
    await apiFetch('/api/route/box/_/sessions', 'secret');
    expect(lastInit().headers.Authorization).toBe('Bearer secret');
  });
});
