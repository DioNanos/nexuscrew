import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';

// La fonte viva della vista VL (mobile): UNA GET dei nodi VL dell'owner mentre
// una vista è aperta. Qui gli asseriti sono due cose che la vista decide di
// conseguenza — chi è il peer, e se la risposta che arriva ha ancora il diritto
// di dichiararlo. La prima è l'identità (nodo + owner + route): senza owner sul
// peer il confronto con la sessione fallisce e la vista si chiude su un nodo che
// c'è. La seconda è l'ordine: una risposta partita prima non può sovrascrivere
// quella partita dopo.

const mocks = vi.hoisted(() => ({ getVlNodes: vi.fn() }));

vi.mock('../lib/api.js', () => ({ getVlNodes: mocks.getVlNodes }));

import { VL_LIVE_POLL_MS, useVlNodeLive } from './useVlNodeLive.js';

const OWNER_A = 'a'.repeat(32);
const OWNER_B = 'b'.repeat(32);
const NODE = 'c'.repeat(32);

const sessione = (extra = {}) => ({ nodeId: NODE, ownerInstanceId: OWNER_A, route: [], ...extra });
// La risposta dichiara la propria fonte, come l'API vera: busta e nodi.
const risposta = (generation, extra = {}) => ({
  instanceId: OWNER_A,
  nodes: [{ nodeId: NODE, label: 'Nodo VL', online: true, lastSeen: Date.now(), generation }],
  ...extra,
});

function differita() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('useVlNodeLive — identità e ordine della fonte viva', () => {
  beforeEach(() => mocks.getVlNodes.mockReset());
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  // L'adapter ricava `ownerInstanceId` dall'owner che gli si passa. Se
  // l'hook gli passa solo la route, il peer nasce con owner nullo e il
  // confronto con la sessione (che l'owner ce l'ha, perché viene dalla lista
  // vera) fallisce: `risolviVlSession` risponde null e App chiude la vista.
  it('porta l owner della sessione sul peer, non null', async () => {
    mocks.getVlNodes.mockResolvedValue(risposta(2));
    const h = renderHook(() => useVlNodeLive('t', sessione(), true));
    await act(async () => {});
    expect(h.result.current, 'la fonte ha risposto: il peer c’è').not.toBeNull();
    expect(h.result.current.trovato).toBe(true);
    expect(h.result.current.peer.ownerInstanceId,
      'l’owner della selezione deve arrivare sul peer: è metà dell’identità').toBe(OWNER_A);
  });

  it('con un owner federato conserva owner e route della sessione', async () => {
    mocks.getVlNodes.mockResolvedValue(risposta(2, { instanceId: OWNER_B }));
    const h = renderHook(() => useVlNodeLive('t', sessione({ ownerInstanceId: OWNER_B, route: ['owner-a'] }), true));
    await act(async () => {});
    expect(mocks.getVlNodes).toHaveBeenCalledWith('t', ['owner-a']);
    expect(h.result.current?.peer?.ownerInstanceId, 'owner federato, non quello locale').toBe(OWNER_B);
    expect(h.result.current.peer.route).toEqual(['owner-a']);
  });

  // Una route può essere riassegnata a un altro owner (la topologia cambia
  // mentre la vista è aperta). La risposta partita quando la route era di A non
  // può essere pubblicata come se fosse di B: sarebbe la stessa route con
  // l'identità di un altro dispositivo — e la conversazione mostrata sarebbe di
  // un device che l'operatore non sta guardando.
  it('una route riassegnata non sostituisce l identità', async () => {
    const prima = differita();
    const dopo = differita();
    mocks.getVlNodes.mockReturnValueOnce(prima.promise).mockReturnValueOnce(dopo.promise);
    const h = renderHook(({ s }) => useVlNodeLive('t', s, true), {
      initialProps: { s: sessione({ ownerInstanceId: OWNER_A, route: ['r1'] }) },
    });
    h.rerender({ s: sessione({ ownerInstanceId: OWNER_B, route: ['r1'] }) });
    await act(async () => { prima.resolve(risposta(2)); });
    expect(h.result.current,
      'la risposta dell’owner precedente non si pubblica sulla nuova identità').toBeNull();
    await act(async () => { dopo.resolve(risposta(2, { instanceId: OWNER_B })); });
    expect(h.result.current.trovato).toBe(true);
    expect(h.result.current.peer.ownerInstanceId).toBe(OWNER_B);
  });

  // Il token cambia mentre una lettura è in volo. Il ref `vivo`
  // era condiviso fra gli effetti: il cleanup lo metteva a false e il nuovo
  // effetto lo riportava a true, così la risposta vecchia passava il controllo.
  it('una risposta della credenziale vecchia non azzera il risultato nuovo', async () => {
    const vecchia = differita();
    const nuova = differita();
    mocks.getVlNodes.mockReturnValueOnce(vecchia.promise).mockReturnValueOnce(nuova.promise);
    const h = renderHook(({ token }) => useVlNodeLive(token, sessione(), true), {
      initialProps: { token: 'vecchio' },
    });
    h.rerender({ token: 'nuovo' });
    await act(async () => { nuova.resolve(risposta(2)); });
    expect(h.result.current.peer.generation).toBe(2);
    await act(async () => { vecchia.resolve({ instanceId: OWNER_A, nodes: [] }); });
    expect(h.result.current.trovato,
      'la risposta vecchia non può dichiarare sparito il peer attuale').toBe(true);
    expect(h.result.current.peer.generation).toBe(2);
  });

  // Stessa regola sul ramo che non è un successo: una credenziale vecchia non
  it('un errore della credenziale vecchia non azzera il risultato nuovo', async () => {
    const vecchia = differita();
    const nuova = differita();
    mocks.getVlNodes.mockReturnValueOnce(vecchia.promise).mockReturnValueOnce(nuova.promise);
    const h = renderHook(({ token }) => useVlNodeLive(token, sessione(), true), {
      initialProps: { token: 'vecchio' },
    });
    h.rerender({ token: 'nuovo' });
    await act(async () => { nuova.resolve(risposta(2)); });
    await act(async () => { vecchia.reject(new Error('vecchia credenziale')); });
    expect(h.result.current, 'l’errore vecchio non cancella ciò che si è appena letto').not.toBeNull();
    expect(h.result.current.trovato).toBe(true);
  });

  // Due giri dello stesso effetto si sovrappongono (la richiesta
  // precedente impiega più del periodo). La risposta più vecchia arriva per
  // ultima e faceva retrocedere la generazione pubblicata.
  it('due giri sovrapposti non retrocedono la generazione', async () => {
    vi.useFakeTimers();
    const primo = differita();
    const secondo = differita();
    mocks.getVlNodes.mockReturnValueOnce(primo.promise).mockReturnValueOnce(secondo.promise);
    const h = renderHook(() => useVlNodeLive('t', sessione(), true));
    await act(async () => { vi.advanceTimersByTime(VL_LIVE_POLL_MS); });
    await act(async () => { secondo.resolve(risposta(2)); });
    expect(h.result.current.peer.generation).toBe(2);
    await act(async () => { primo.resolve(risposta(1)); });
    expect(h.result.current.peer.generation,
      'la risposta tardiva non è corrente e non si pubblica').toBe(2);
  });

  // La riattivazione dopo una disabilitazione è un effetto nuovo, e la
  // risposta rimasta in volo da quello spento non deve parlare per lui.
  it('dopo la riattivazione vale solo la risposta del nuovo effetto', async () => {
    const spenta = differita();
    const viva = differita();
    mocks.getVlNodes.mockReturnValueOnce(spenta.promise).mockReturnValueOnce(viva.promise);
    const h = renderHook(({ attivo }) => useVlNodeLive('t', sessione(), attivo), {
      initialProps: { attivo: true },
    });
    h.rerender({ attivo: false });
    expect(h.result.current, 'disattivata: nessun esito, non l’ultimo rimasto').toBeNull();
    h.rerender({ attivo: true });
    await act(async () => { viva.resolve(risposta(2)); });
    await act(async () => { spenta.resolve({ instanceId: OWNER_A, nodes: [] }); });
    expect(h.result.current.trovato, 'la risposta dell’effetto spento non vale più').toBe(true);
  });
});
