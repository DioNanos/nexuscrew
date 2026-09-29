import { describe, expect, it, beforeEach } from 'vitest';
import {
  isSameRef, toggleSideRef,
  readSavedDual, writeSavedDual, clearSavedDual,
  DUAL_MIN_W, clampWeight,
} from './dual-view.js';

describe('isSameRef', () => {
  it('uguaglianza per sessione+nodo, il nodo assente conta come locale', () => {
    expect(isSameRef({ session: 'a' }, { session: 'a' })).toBe(true);
    expect(isSameRef({ session: 'a', node: 'x' }, { session: 'a', node: 'x' })).toBe(true);
    expect(isSameRef({ session: 'a', node: 'x' }, { session: 'a' })).toBe(false);
    expect(isSameRef({ session: 'a' }, { session: 'b' })).toBe(false);
    expect(isSameRef(null, { session: 'a' })).toBe(false);
  });
});

describe('toggleSideRef (tocco sulla riga della lista rapida)', () => {
  const main = { session: 'cloud-Dev' };
  const fork = { session: 'cloud-Fork' };
  const forkRemota = { session: 'cloud-Fork', node: 'Pixel', ownerId: 'o' };

  it('affianca una riga diversa dalla cella aperta (ref pulito da campi display)', () => {
    expect(toggleSideRef(main, null, { ...forkRemota, cellName: 'Fork', key: 'Pixel:cloud-Fork' }))
      .toEqual(forkRemota);
  });

  it('la cella aperta NON si affianca a se stessa: no-op', () => {
    expect(toggleSideRef(main, null, main)).toBeNull();
    const gia = fork;
    expect(toggleSideRef(main, gia, { session: 'cloud-Dev' })).toBe(gia);
  });

  it('secondo tocco sulla riga affiancata: la toglie', () => {
    expect(toggleSideRef(main, fork, fork)).toBeNull();
  });

  it('toccare una terza riga sostituisce la side', () => {
    const trading = { session: 'cloud-Trading' };
    expect(toggleSideRef(main, fork, trading)).toEqual(trading);
  });

  it('riga senza sessione: nessuna decisione (invariato)', () => {
    const gia = fork;
    expect(toggleSideRef(main, gia, { cellName: 'X' })).toBe(gia);
    expect(toggleSideRef(main, null, null)).toBeNull();
  });
});

describe('ricordo per dispositivo (localStorage)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('scrive e rilegge la coppia {main, side} senza campi display', () => {
    writeSavedDual({ session: 'cloud-Dev', cellName: 'Dev' }, { session: 'cloud-Fork', node: 'Pixel' });
    expect(readSavedDual()).toEqual({
      main: { session: 'cloud-Dev' },
      side: { session: 'cloud-Fork', node: 'Pixel' },
    });
  });

  it('write senza side pulisce il ricordo (chiusura = dimentica)', () => {
    writeSavedDual({ session: 'cloud-Dev' }, { session: 'cloud-Fork' });
    writeSavedDual({ session: 'cloud-Dev' }, null);
    expect(readSavedDual()).toBeNull();
    expect(localStorage.getItem('nc_dual_side')).toBeNull();
  });

  it('dato corrotto o incompleto: nessun ricordo, mai un throw', () => {
    localStorage.setItem('nc_dual_side', '{non json');
    expect(readSavedDual()).toBeNull();
    localStorage.setItem('nc_dual_side', JSON.stringify({ main: { session: 'a' } }));
    expect(readSavedDual()).toBeNull();
    clearSavedDual();
    expect(readSavedDual()).toBeNull();
  });
});

describe('pesi della maniglia', () => {
  it('nessun pannello collassa sotto il minimo 0.2 (come le colonne griglia)', () => {
    expect(DUAL_MIN_W).toBe(0.2);
    expect(clampWeight(0.5)).toBe(0.5);
    expect(clampWeight(0.01)).toBe(0.2);
  });
});
