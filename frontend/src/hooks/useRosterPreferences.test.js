import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRosterPreferences } from './useRosterPreferences.js';

// L'hook e' condiviso dalla Sidebar desktop e dalla SessionList mobile: questi
// test coprono la logica di entrambi i rami (stesso codice, stessa fonte di
// verita' localStorage).

beforeEach(() => { localStorage.clear(); });

describe('removePin — calcola sul valore CORRENTE, no lost update', () => {
  it('un pin aggiunto in un\'altra shell (localStorage) sopravvive a un removePin su stato React stale', () => {
    // Caso dell\'auditor: clear in volo su AuditCell1, nel mentre aggiunto un
    // preferito su AuditCell2 altrove. Lo stato React di questa istanza e\' stale,
    // ma la fonte di verita\' (localStorage) e\' aggiornata. removePin deve leggere
    // il corrente, non la closure.
    const { result } = renderHook(() => useRosterPreferences());
    act(() => result.current.togglePin('AuditCell1'));            // React [AuditCell1], ls [AuditCell1]
    // aggiunta "esterna" direttamente in localStorage (l'altra shell):
    act(() => { localStorage.setItem('nc_pins', JSON.stringify(['AuditCell1', 'AuditCell2'])); });
    // React e\' stale ([AuditCell1]); removePin('AuditCell1') legge il CORRENTE:
    act(() => result.current.removePin('AuditCell1'));
    expect(result.current.pins).toEqual(['AuditCell2']);          // AuditCell2 sopravvive
    expect(JSON.parse(localStorage.getItem('nc_pins'))).toEqual(['AuditCell2']);
  });

  it('regression: leggendo la closure stale, un secondo pin verrebbe perso', () => {
    // Questo test passa solo se removePin legge loadPins(); passerebbe [] leggendo
    // lo stato React catturato (che e\' ancora ['A'] e non vede 'B').
    const { result } = renderHook(() => useRosterPreferences());
    act(() => result.current.togglePin('A'));
    act(() => { localStorage.setItem('nc_pins', JSON.stringify(['A', 'B'])); });
    act(() => result.current.removePin('A'));
    expect(result.current.pins).toEqual(['B']);
  });
});

describe('pinError + retry — fallimento SEGNALATO e RITENTABILE (contratto rev6 §2.1)', () => {
  it('un localStorage.setItem fallito dopo un clear emerge come pinError', () => {
    const { result } = renderHook(() => useRosterPreferences());
    act(() => result.current.togglePin('A'));                     // ls [A]
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    act(() => result.current.removePin('A'));
    expect(result.current.pinError).toBeTruthy();
    expect(result.current.pinError.key).toBe('A');
    spy.mockRestore();
  });

  it('retry riprova e a riuscita pulisce pinError (e persiste davvero)', () => {
    const { result } = renderHook(() => useRosterPreferences());
    act(() => result.current.togglePin('A'));
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    act(() => result.current.removePin('A'));
    expect(result.current.pinError).toBeTruthy();
    spy.mockRestore();                                            // ora setItem funziona
    act(() => result.current.retryPinPersist());
    expect(result.current.pinError).toBeNull();
    expect(JSON.parse(localStorage.getItem('nc_pins'))).toEqual([]); // rimosso davvero
  });

  it('clearPinError nasconde l\'avviso (dismiss utente)', () => {
    const { result } = renderHook(() => useRosterPreferences());
    act(() => result.current.togglePin('A'));
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('q'); });
    act(() => result.current.removePin('A'));
    spy.mockRestore();
    expect(result.current.pinError).toBeTruthy();
    act(() => result.current.clearPinError());
    expect(result.current.pinError).toBeNull();
  });
});
