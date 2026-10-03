// I tetti di lettura del roster e il signal esterno attraversano tutto lo
// stack: le opzioni del chiamante arrivano a fetch, il timeout copre anche il
// body, una risposta sana cancella il timer, e l'abort di cleanup propaga il
// proprio motivo senza diventare un evento di token locale invalido.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getVlNodes, getRouteSessions } from './api.js';

// I tetti come letterali: il test deve compilare anche sulla base precedente
// (dove le costanti non esistono) e fallire per COMPORTAMENTO, non per import.
const VL_READ_TIMEOUT_MS = 4000;
const ROSTER_READ_TIMEOUT_MS = 8000;

afterEach(() => { vi.unstubAllGlobals(); });

// Header subito, body appeso fino all'abort: il modello del comportamento di
// Node (in jsdom la fetch vera rigetta subito, e il test non proverrebbe il
// tetto). Ogni chiamata registra il signal ricevuto: nullo significa che le
// opzioni del chiamante non sono arrivate a fetch.
function fetchConBodyAppeso(signalSeen) {
  return vi.fn((_url, opts = {}) => {
    signalSeen.push(opts.signal || null);
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => new Promise((res, rej) => {
        if (!opts.signal) return rej(new Error('nessun signal: il tetto non puo\' scattare'));
        opts.signal.addEventListener('abort', () => rej(opts.signal.reason), { once: true });
        if (opts.signal.aborted) rej(opts.signal.reason);
      }),
    });
  });
}

describe('tetti di lettura e signal esterno', () => {
  it('getVlNodes applica il tetto di 4 s anche in locale, coprendo il body', async () => {
    vi.useFakeTimers();
    const seen = [];
    vi.stubGlobal('fetch', fetchConBodyAppeso(seen));
    let esito;
    getVlNodes('token').then(
      (j) => { esito = { ok: j }; },
      (e) => { esito = { errore: e }; },
    );
    await vi.advanceTimersByTimeAsync(VL_READ_TIMEOUT_MS - 1);
    expect(esito).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(seen[0]).not.toBeNull();
    expect(String(esito.errore && esito.errore.name)).toMatch(/Abort|Timeout/);
  });

  it('getRouteSessions e le letture roster accettano il tetto del chiamante (8 s)', async () => {
    vi.useFakeTimers();
    const seen = [];
    vi.stubGlobal('fetch', fetchConBodyAppeso(seen));
    let esito;
    getRouteSessions('token', ['vps'], { timeoutMs: ROSTER_READ_TIMEOUT_MS }).then(
      (j) => { esito = { ok: j }; },
      (e) => { esito = { errore: e }; },
    );
    await vi.advanceTimersByTimeAsync(ROSTER_READ_TIMEOUT_MS - 1);
    expect(esito).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(seen[0]).not.toBeNull();
    expect(String(esito.errore && esito.errore.name)).toMatch(/Abort|Timeout/);
  });

  it('il signal esterno del chiamante propaga l\'abort con il suo motivo', async () => {
    vi.useFakeTimers();
    const seen = [];
    vi.stubGlobal('fetch', fetchConBodyAppeso(seen));
    const controller = new AbortController();
    let esito;
    getRouteSessions('token', ['vps'], { timeoutMs: ROSTER_READ_TIMEOUT_MS, signal: controller.signal }).then(
      (j) => { esito = { ok: j }; },
      (e) => { esito = { errore: e }; },
    );
    await vi.advanceTimersByTimeAsync(100);
    controller.abort(new DOMException('cleanup', 'AbortError'));
    await vi.advanceTimersByTimeAsync(ROSTER_READ_TIMEOUT_MS);
    // L'abort di cleanup ha vinto sul timeout: il motivo e' quello del chiamante.
    expect(seen[0]).not.toBeNull();
    expect(String(esito.errore && esito.errore.name)).toMatch(/Abort/);
  });

  it('una risposta sana cancella il timer: nessun abort dopo il body', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok: true, status: 200, json: async () => ({ nodes: [] }),
    })));
    let esito;
    getVlNodes('token').then((j) => { esito = { ok: j }; }, (e) => { esito = { errore: e }; });
    await vi.advanceTimersByTimeAsync(ROSTER_READ_TIMEOUT_MS + 1000);
    expect(esito && esito.ok).toEqual({ nodes: [] });
  });
});
