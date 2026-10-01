import { beforeEach, describe, expect, it } from 'vitest';
import { loadToken, saveToken, TOKEN_KEY } from './token-store.js';

// T1: il token digitato o incollato deve arrivare nello storage; il salvataggio
// tiene UN solo posto per volta, cosi' un token vecchio nell'altro store non
// oscura quello nuovo (revisione: sessionStorage veniva letto prima di localStorage).
beforeEach(() => { sessionStorage.clear(); localStorage.clear(); });

describe('token-store', () => {
  it('ricorda=true: scrive in localStorage e toglie la copia di sessione', () => {
    sessionStorage.setItem(TOKEN_KEY, 'vecchio');
    saveToken('nuovo', { remember: true });
    expect(localStorage.getItem(TOKEN_KEY)).toBe('nuovo');
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('ricorda=false: scrive in sessionStorage e toglie la copia persistente', () => {
    localStorage.setItem(TOKEN_KEY, 'vecchio');
    saveToken('nuovo', { remember: false });
    expect(sessionStorage.getItem(TOKEN_KEY)).toBe('nuovo');
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('il token vecchio di sessione non oscura quello nuovo salvato in locale', () => {
    sessionStorage.setItem(TOKEN_KEY, 'vecchio');
    saveToken('nuovo', { remember: true });
    expect(loadToken()).toBe('nuovo');
  });

  it('loadToken: nessun token -> stringa vuota; spazi ignorati; storage che lancia non rompe', () => {
    expect(loadToken()).toBe('');
    saveToken('  abc  ', { remember: true });
    expect(loadToken()).toBe('abc');
    const broken = { getItem() { throw new Error('private mode'); }, setItem() { throw new Error('quota'); }, removeItem() {} };
    expect(loadToken({ local: broken, session: broken })).toBe('');
    expect(saveToken('x', { remember: true, local: broken, session: broken })).toEqual({ ok: false, where: null });
  });

  it('saveToken rifiuta un token vuoto senza toccare lo storage', () => {
    localStorage.setItem(TOKEN_KEY, 'buono');
    expect(saveToken('   ', { remember: true }).ok).toBe(false);
    expect(localStorage.getItem(TOKEN_KEY)).toBe('buono');
  });

  it('saveToken riporta DOVE ha scritto (per l\'avviso quando il browser rifiuta lo storage)', () => {
    expect(saveToken('abc', { remember: true })).toEqual({ ok: true, where: 'local' });
    expect(saveToken('abc', { remember: false })).toEqual({ ok: true, where: 'session' });
  });
});
