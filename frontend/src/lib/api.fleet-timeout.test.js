import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Le azioni di alimentazione (up/down) sono le uniche chiamate di flotta che
// non passavano un tetto d'attesa: un server lento o muto teneva il foglio
// occupato senza via d'uscita. Qui si prova che il tetto c'è, che vale per
// entrambe le azioni e che scade ESATTAMENTE alla costante — non prima.
const { FLEET_ACTION_TIMEOUT_MS, fleetDown, fleetUp } = await import('./api.js');

describe('fleet up/down timeout', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it('la costante esiste ed è il tetto approvato', () => {
    expect(FLEET_ACTION_TIMEOUT_MS).toBe(60000);
  });

  const fetchPendente = () => vi.fn((_url, opts = {}) => new Promise((_res, rej) => {
    // Il server non risponde: la fetch pende finché il segnale non scade.
    if (opts.signal) opts.signal.addEventListener('abort', () => rej(opts.signal.reason), { once: true });
  }));

  it('fleetUp: fetch che non risolve scade con TimeoutError al tetto, non prima', async () => {
    const fetchStub = fetchPendente();
    vi.stubGlobal('fetch', fetchStub);
    let rejected = null;
    const p = fleetUp('t', { cell: 'X' }, []);
    p.catch((e) => { rejected = e; });
    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchStub.mock.calls[0];
    expect(url).toBe('/api/fleet/up');
    expect(opts.method).toBe('POST');
    expect(opts.signal).toBeTruthy(); // il tetto c'è: la fetch viaggia con un AbortController

    await vi.advanceTimersByTimeAsync(FLEET_ACTION_TIMEOUT_MS - 1);
    expect(rejected).toBe(null); // sotto il tetto non scade

    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(rejected && rejected.name).toBe('TimeoutError');
  });

  it('fleetDown: stesso tetto della up', async () => {
    const fetchStub = fetchPendente();
    vi.stubGlobal('fetch', fetchStub);
    let rejected = null;
    const p = fleetDown('t', { cell: 'X' }, []);
    p.catch((e) => { rejected = e; });
    const [url] = fetchStub.mock.calls[0];
    expect(url).toBe('/api/fleet/down');

    await vi.advanceTimersByTimeAsync(FLEET_ACTION_TIMEOUT_MS - 1);
    expect(rejected).toBe(null);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(rejected && rejected.name).toBe('TimeoutError');
  });
});
