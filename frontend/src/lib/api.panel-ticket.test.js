import { afterEach, describe, expect, it, vi } from 'vitest';
import { requestPanelTicket } from './api.js';

// Il difetto NASCE qui, non nel componente: `requestPanelTicket` traduce una
// risposta HTTP in una CAUSA, e il componente decide cosa mostrare guardando
// solo la causa. Finché questa classificazione non aveva un test suo, un
// rifiuto permanente poteva rientrare nel secchio `denied` senza che nessun
// rosso lo dicesse — e il test del componente sarebbe rimasto verde, perché
// gli si passa la causa già classificata.

const risposta = (status, body) => Promise.resolve({
  status,
  json: () => Promise.resolve(body),
});

describe('requestPanelTicket: da risposta HTTP a causa', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  const chiedi = (status, body) => {
    vi.stubGlobal('fetch', vi.fn(() => risposta(status, body)));
    return requestPanelTicket('token', [], 'Dev');
  };

  it('200 con ticket: passa', async () => {
    expect(await chiedi(200, { ticket: 'TK-1' })).toEqual({ ok: true, ticket: 'TK-1' });
  });

  it('403 con reason panel-not-granted: il permesso si concede sul nodo owner', async () => {
    expect(await chiedi(403, { reason: 'panel-not-granted' }))
      .toEqual({ ok: false, cause: 'not-granted' });
  });

  it('403 SENZA reason (nodo in sola lettura): causa propria, non «denied»', async () => {
    // È la catena che l'audit ha percorso: `READONLY` blocca ogni mutazione
    // federata, e l'emissione del biglietto è una mutazione. La risposta ha il
    // solo campo `error`, quindi non combacia con `panel-not-granted` e
    // finiva nel catch-all.
    const esito = await chiedi(403, { error: 'READONLY: federated mutation blocked' });
    expect(esito).toEqual({ ok: false, cause: 'node-refused' });
    // Detto esplicitamente: se questo torna `denied`, il pannello riproporrà
    // un Riprova che non può cambiare l'esito.
    expect(esito.cause).not.toBe('denied');
  });

  it('404 e 401 restano cause distinte', async () => {
    expect(await chiedi(404, {})).toEqual({ ok: false, cause: 'no-panel' });
    expect(await chiedi(401, {})).toEqual({ ok: false, cause: 'unauthorized' });
  });

  it('quel che resta è transitorio e vale «denied»: lì riprovare ha senso', async () => {
    expect(await chiedi(409, {})).toEqual({ ok: false, cause: 'denied' });
    expect(await chiedi(500, {})).toEqual({ ok: false, cause: 'denied' });
    expect(await chiedi(503, {})).toEqual({ ok: false, cause: 'denied' });
  });

  it('un 200 senza ticket non è un successo', async () => {
    expect(await chiedi(200, { ok: true })).toEqual({ ok: false, cause: 'denied' });
  });
});
