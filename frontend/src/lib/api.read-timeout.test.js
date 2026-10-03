// I tetti di lettura del roster e il signal esterno attraversano tutto lo
// stack: le opzioni del chiamante arrivano a fetch, il timeout copre anche il
// body, una risposta sana cancella il timer, e l'abort di cleanup propaga il
// proprio motivo senza diventare un evento di token locale invalido.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getVlNodes, getRouteSessions, getRouteConfig, AUTH_INVALID_EVENT } from './api.js';

// I tetti come letterali: il test deve compilare anche sulla base precedente
// (dove le costanti non esistono) e fallire per COMPORTAMENTO, non per import.
const VL_READ_TIMEOUT_MS = 4000;
const ROSTER_READ_TIMEOUT_MS = 8000;

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

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
    const invalid = vi.fn();
    window.addEventListener(AUTH_INVALID_EVENT, invalid);
    const controller = new AbortController();
    let esito;
    getVlNodes('token', [], { signal: controller.signal }).then(
      (j) => { esito = { ok: j }; },
      (e) => { esito = { errore: e }; },
    );
    await vi.advanceTimersByTimeAsync(100);
    const reason = new DOMException('cleanup', 'AbortError');
    controller.abort(reason);
    await vi.advanceTimersByTimeAsync(ROSTER_READ_TIMEOUT_MS);
    // L'abort di cleanup ha vinto sul timeout: il motivo e' quello del chiamante.
    expect(seen[0]).not.toBeNull();
    expect(esito.errore).toBe(reason);
    expect(invalid).not.toHaveBeenCalled();
    window.removeEventListener(AUTH_INVALID_EVENT, invalid);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('una risposta sana cancella il timer: nessun abort dopo il body', async () => {
    vi.useFakeTimers();
    const seen = [];
    vi.stubGlobal('fetch', vi.fn((_url, opts) => { seen.push(opts.signal); return Promise.resolve({
      ok: true, status: 200, json: async () => ({ nodes: [] }),
    }); }));
    let esito;
    getVlNodes('token').then((j) => { esito = { ok: j }; }, (e) => { esito = { errore: e }; });
    await vi.advanceTimersByTimeAsync(ROSTER_READ_TIMEOUT_MS + 1000);
    expect(esito && esito.ok).toEqual({ nodes: [] });
    expect(seen[0]?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

it('the bounded config helper cleans the body timeout and outer abort listener on success', async()=>{
  vi.useFakeTimers(); const outer=new AbortController(), seen=[];
  const remove=vi.spyOn(outer.signal,'removeEventListener');
  vi.stubGlobal('fetch',vi.fn(async(_url,opts)=>{seen.push(opts.signal);return {ok:true,status:200,json:async()=>({instanceId:'local'})};}));
  await expect(getRouteConfig('token',[],{timeoutMs:8000,signal:outer.signal})).resolves.toEqual({instanceId:'local'});
  expect(vi.getTimerCount()).toBe(0); expect(remove).toHaveBeenCalledWith('abort',expect.any(Function));
  await vi.advanceTimersByTimeAsync(9000); expect(seen[0].aborted).toBe(false);
});
