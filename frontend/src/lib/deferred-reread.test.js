import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDeferredReread } from './deferred-reread.js';

// Dopo un'azione la cui risposta è andata persa, il roster si rilegge una volta
// sola, in differita, per la sola tupla che l'ha chiesta. Chi chiede due volte
// nella stessa finestra non raddoppia la lettura: la rilettura legge lo stato
// corrente, e due letture non vedrebbero nulla di diverso. E non si riarma da
// sé: è una rilettura, non un poll.
describe('deferred reread', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  it('coalesces several requests for the same tuple into one read', async () => {
    const r = createDeferredReread({ delayMs: 500 });
    const esegui = vi.fn();
    expect(r.programma('peer|cell', esegui)).toBe(true);
    expect(r.programma('peer|cell', esegui)).toBe(false);
    expect(r.programma('peer|cell', vi.fn())).toBe(false);
    expect(esegui).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    expect(esegui).toHaveBeenCalledTimes(1);
    expect(r.pendenti()).toEqual([]);
  });

  it('keeps distinct tuples distinct', async () => {
    const r = createDeferredReread({ delayMs: 500 });
    const a = vi.fn();
    const b = vi.fn();
    r.programma('peer|a', a);
    r.programma('peer|b', b);
    await vi.advanceTimersByTimeAsync(500);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it('does not fire after a cancel, and cancelling an unknown key is silent', async () => {
    const r = createDeferredReread({ delayMs: 500 });
    const esegui = vi.fn();
    r.programma('peer|cell', esegui);
    r.annulla('peer|cell');
    r.annulla('mai-vista');
    await vi.advanceTimersByTimeAsync(1000);
    expect(esegui).not.toHaveBeenCalled();
    expect(r.pendenti()).toEqual([]);
  });

  it('cancels everything on unmount', async () => {
    const r = createDeferredReread({ delayMs: 500 });
    const a = vi.fn();
    const b = vi.fn();
    r.programma('peer|a', a);
    r.programma('peer|b', b);
    r.annullaTutto();
    await vi.advanceTimersByTimeAsync(1000);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it('reads once, not in a loop: the key is free again after the read', async () => {
    const r = createDeferredReread({ delayMs: 500 });
    const esegui = vi.fn();
    r.programma('peer|cell', esegui);
    await vi.advanceTimersByTimeAsync(500);
    expect(esegui).toHaveBeenCalledTimes(1);
    // nessun riarmo automatico
    await vi.advanceTimersByTimeAsync(5000);
    expect(esegui).toHaveBeenCalledTimes(1);
    // ma una richiesta nuova, esplicita, riarma: la finestra e' chiusa
    expect(r.programma('peer|cell', esegui)).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(esegui).toHaveBeenCalledTimes(2);
  });

  it('survives a read that throws, and reports it without escaping', async () => {
    const onError = vi.fn();
    const r = createDeferredReread({ delayMs: 500, onError });
    r.programma('peer|cell', async () => { throw new Error('rete'); });
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0][0].message)).toBe('rete');
    // e la chiave resta utilizzabile
    const dopo = vi.fn();
    expect(r.programma('peer|cell', dopo)).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(dopo).toHaveBeenCalledTimes(1);
  });

  it('never arms without a key or without a function', async () => {
    const r = createDeferredReread({ delayMs: 500 });
    expect(r.programma('', vi.fn())).toBe(false);
    expect(r.programma(null, vi.fn())).toBe(false);
    expect(r.programma('peer|cell', null)).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.pendenti()).toEqual([]);
  });
});
