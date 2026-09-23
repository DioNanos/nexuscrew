// La scadenza di `apiFetch` deve coprire anche la LETTURA DEL BODY, non solo
// l'arrivo degli header: `fetch` risolve sugli header, e un body aperto e
// incompleto lascerebbe la lettura appesa — con il poll che resta occupato e
// ogni tick successivo saltato.
//
// Il `fetch` qui e' un MODELLO del comportamento misurato di Node: risolve
// subito con gli header, e il body (`json()`) resta in attesa finche' la signal
// non viene abortita. E' un modello e non un server vero per una ragione
// precisa: in jsdom il body di una `fetch` reale non si comporta come in Node
// (rigetta subito con un TypeError invece di attendere), quindi con un server
// vero questo test non proverebbe niente. Il comportamento modellato e' quello
// misurato a mano in Node: header a ~60 ms, body che rigetta all'abort con
// TimeoutError.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from './api.js';
import { createPollGuard } from './poll-guard.js';

afterEach(() => { vi.unstubAllGlobals(); });

// Header subito, body appeso: esattamente cio' che `fetch` consegna quando il
// server ha scritto gli header e non chiude il corpo.
function fetchConBodyAppeso() {
  return vi.fn((_url, opts = {}) => Promise.resolve({
    ok: true,
    status: 200,
    json: () => new Promise((_res, rej) => {
      opts.signal.addEventListener('abort', () => rej(opts.signal.reason), { once: true });
    }),
  }));
}

describe('apiFetch: la scadenza copre il body', () => {
  it('body che non arriva: il giro si chiude entro il tetto e il tick successivo riparte', async () => {
    vi.stubGlobal('fetch', fetchConBodyAppeso());
    const guard = createPollGuard();
    const turno = guard.begin();
    const t0 = Date.now();
    let errore = null;
    try {
      const r = await apiFetch('/api/decks', 't', { timeoutMs: 300 });
      await r.json();
      throw new Error('il body non doveva arrivare');
    } catch (e) {
      errore = e;
    } finally {
      guard.end(turno);
    }
    const durata = Date.now() - t0;
    // Il body deve essere ABORTITO dalla scadenza, non fallire per altro:
    // un errore diverso significa che il test non sta provando quel che dice.
    expect(String(errore && errore.name)).toMatch(/Abort|Timeout/);
    expect(durata).toBeLessThan(3000);
    // E la guardia e' libera: il tick successivo riparte.
    expect(guard.begin()).not.toBeNull();
  });
});
