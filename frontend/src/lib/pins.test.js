import { describe, it, expect, beforeEach, vi } from 'vitest';
import { togglePinIn, removePinIn, loadPins } from './pins.js';

beforeEach(() => { localStorage.clear(); });

describe('togglePinIn — ritorna { next, error }', () => {
  it('aggiunge un pin assente', () => {
    const r = togglePinIn([], 'cloud-Dev');
    expect(r.next).toEqual(['cloud-Dev']);
    expect(r.error).toBeNull();
    expect(loadPins()).toEqual(['cloud-Dev']);
  });

  it('rimuove un pin presente', () => {
    const r = togglePinIn(['cloud-Dev'], 'cloud-Dev');
    expect(r.next).toEqual([]);
    expect(r.error).toBeNull();
  });

  it('emerge l\'errore di persistenza (NON lo ingoia)', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    const r = togglePinIn([], 'cloud-Dev');
    expect(r.next).toEqual(['cloud-Dev']); // il next e' calcolato comunque
    expect(r.error).toBeInstanceOf(Error);
    expect(r.error.message).toBe('quota');
    spy.mockRestore();
  });
});

describe('removePinIn — idempotente, distinta da toggle', () => {
  it('rimuove un pin presente', () => {
    const r = removePinIn(['cloud-Dev', 'cloud-Sys'], 'cloud-Dev');
    expect(r.next).toEqual(['cloud-Sys']);
    expect(r.error).toBeNull();
  });

  it('NO-OP se il pin NON e\' presente (NON lo aggiunge, come farebbe toggle)', () => {
    // Era il difetto: clear su una designazione SENZA pin locale (stato ammesso
    // dal contratto) chiamava togglePin e AGGIUNGEVA il pin -> "favorite" invece
    // di "none". removePinIn non aggiunge mai.
    expect(removePinIn([], 'cloud-Dev').next).toEqual([]);
    expect(removePinIn(['cloud-Sys'], 'cloud-Dev').next).toEqual(['cloud-Sys']);
    expect(removePinIn(['cloud-Sys'], 'cloud-Dev').error).toBeNull();
  });

  it('emerge l\'errore di persistenza (clear riuscito ma localStorage fallito)', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('readonly'); });
    const r = removePinIn(['cloud-Dev'], 'cloud-Dev');
    expect(r.next).toEqual([]);
    expect(r.error).toBeInstanceOf(Error);
    spy.mockRestore();
  });
});
