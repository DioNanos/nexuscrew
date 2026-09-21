import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import assert from 'node:assert';

// Audit fix: `timeoutMs` in apiFetch usa il controller di fetchAbortSignal
// (fix del ReferenceError quando signal+timeoutMs arrivano insieme) e la risposta
// tardiva DOPO il timeout non viene mai consumata: la fetch rispetta il signal.
const { apiFetch } = await import('./api.js');

describe('apiFetch timeout', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('timeout: la fetch rifiuta con TimeoutError entro il limite', async () => {
    const fetchStub = vi.fn((_url, opts = {}) => new Promise((_res, rej) => {
      if (opts.signal) opts.signal.addEventListener('abort', () => rej(opts.signal.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchStub);
    const p = apiFetch('/api/decks', 't', { timeoutMs: 8000 });
    p.catch(() => {}); // la rejection è gestita dall'assertion sotto
    const assertion = expect(p).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(8000);
    await assertion;
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it('signal già abortito + timeoutMs: fetch NON è chiamata, rifiuta con il reason esterno (nessun ReferenceError)', async () => {
    const fetchStub = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchStub);
    const outer = new AbortController();
    outer.abort(new DOMException('operatore', 'AbortError'));
    const p = apiFetch('/api/decks', 't', { timeoutMs: 8000, signal: outer.signal });
    p.catch(() => {});
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('risposta tardiva DOPO il timeout: ignorata (il fetch rispetta l’abort)', async () => {
    const lateResponse = new Response('{}', { status: 200 });
    const fetchStub = vi.fn((_url, opts = {}) => new Promise((res, rej) => {
      const t = setTimeout(() => res(lateResponse), 20000); // risolverebbe DOPO il timeout
      opts.signal.addEventListener('abort', () => { clearTimeout(t); rej(opts.signal.reason); }, { once: true });
    }));
    vi.stubGlobal('fetch', fetchStub);
    const p = apiFetch('/api/decks', 't', { timeoutMs: 8000 });
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(8000);
    await expect(p).rejects.toMatchObject({ name: 'TimeoutError' });
    // La risposta tardiva (timer cancellato all'abort) non arriva mai: nessun
    // consumo post-timeout, nessun crash.
  });
});

describe('apiFetch abort esterno', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('abort esterno DOPO l’avvio: il fetch riceve il reason esterno, non il timeout', async () => {
    const reasons = [];
    const fetchStub = vi.fn((_url, opts = {}) => new Promise((_res, rej) => {
      if (opts.signal) opts.signal.addEventListener('abort', () => rej(opts.signal.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchStub);
    const outer = new AbortController();
    const p = apiFetch('/api/decks', 't', { timeoutMs: 8000, signal: outer.signal });
    p.catch((e) => reasons.push({ name: e.name, message: e.message }));
    await vi.advanceTimersByTimeAsync(100);
    outer.abort(new DOMException('operatore', 'AbortError'));
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(8000); // il timeout non deve mai vincere
    assert.deepEqual(reasons, [{ name: 'AbortError', message: 'operatore' }]);
  });
});
