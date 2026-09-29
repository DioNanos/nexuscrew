import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useRosterPreferences } from './useRosterPreferences.js';
import { readOrderJournal } from '../lib/order-journal.js';

// O2: l'hook leggeva lo storage una volta al mount e non ascoltava l'evento storage: due finestre della
// stessa origin (PWA + scheda) si sovrascrivevano, l'ultima cancellava i pin/ordini dell'altra.
// Riprodotto: p1 fissa prova1, p2 (stantia) fissa prova2 → nc_pins = ["prova2"].
beforeEach(() => { localStorage.clear(); });
const fuoriDaQui = (key, value) => act(() => {       // l'altra finestra scrive e il browser avvisa QUESTA con un evento storage
  localStorage.setItem(key, JSON.stringify(value));
  window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify(value), storageArea: localStorage }));
});
const silenziosa = (key, value) => localStorage.setItem(key, JSON.stringify(value));   // scrittura senza evento (finestra in background)

describe('due finestre sulla stessa origin', () => {
  it('l\'evento storage aggiorna i pin di questa finestra', () => {
    const { result } = renderHook(() => useRosterPreferences());
    act(() => result.current.togglePin('a'));
    fuoriDaQui('nc_pins', ['a', 'b']);
    expect(result.current.pins).toEqual(['a', 'b']);
  });

  it('caso riprodotto: p1 fissa prova1, p2 stantia fissa prova2 → restano entrambi', () => {
    const p1 = renderHook(() => useRosterPreferences()); const p2 = renderHook(() => useRosterPreferences());
    act(() => p1.result.current.togglePin('prova1'));
    act(() => p2.result.current.togglePin('prova2'));
    expect(JSON.parse(localStorage.getItem('nc_pins'))).toEqual(['prova1', 'prova2']);
  });

  it('anche senza evento (finestra in background) un toggle parte dal valore CORRENTE dello storage', () => {
    const { result } = renderHook(() => useRosterPreferences());
    act(() => result.current.togglePin('a'));
    silenziosa('nc_pins', ['a', 'b']);
    act(() => result.current.togglePin('c'));
    expect(JSON.parse(localStorage.getItem('nc_pins'))).toEqual(['a', 'b', 'c']);
  });

  it('un riordino non cancella le posizioni scritte dall\'altra finestra', () => {
    const { result } = renderHook(() => useRosterPreferences());
    const raw = [{ key: 'x' }, { key: 'y' }];
    silenziosa('nc_sidebar_order_v1', { local: ['x', 'y'], 'id:aa': ['m', 'n'] });   // l'altra finestra ha ordinato un nodo
    act(() => result.current.moveRoster('local', 'y', 'x', raw));
    const salvato = JSON.parse(localStorage.getItem('nc_sidebar_order_v1'));
    expect(salvato['id:aa']).toEqual(['m', 'n']);
    expect(salvato.local).toEqual(['y', 'x']);
  });

  it('una vista cambiata qui non cancella quelle dell\'altra finestra', () => {
    const { result } = renderHook(() => useRosterPreferences());
    silenziosa('nc_sidebar_views_v1', { 'id:aa': { open: false, filter: 'active' } });
    act(() => result.current.updateView('local', { filter: 'pinned' }));
    const salvato = JSON.parse(localStorage.getItem('nc_sidebar_views_v1'));
    expect(salvato['id:aa']).toEqual({ open: false, filter: 'active' });
    expect(salvato.local.filter).toBe('pinned');
  });

  it('localStorage.clear() in un\'altra finestra (evento con chiave null) riporta ai default senza errori', () => {
    const { result } = renderHook(() => useRosterPreferences());
    act(() => result.current.togglePin('a'));
    act(() => { localStorage.clear(); window.dispatchEvent(new StorageEvent('storage', { key: null, storageArea: localStorage })); });
    expect(result.current.pins).toEqual([]);
  });

  it('due istanze nello stesso documento (sidebar e lista) restano allineate senza evento del browser', () => {
    const a = renderHook(() => useRosterPreferences()); const b = renderHook(() => useRosterPreferences());
    act(() => a.result.current.togglePin('z'));
    expect(b.result.current.pins).toEqual(['z']);
  });
});

describe('diario delle scritture', () => {
  it('un riordino annota motivo, posizione, chiavi prima/dopo e visibili', () => {
    const { result } = renderHook(() => useRosterPreferences());
    const raw = [{ key: 'x' }, { key: 'y' }, { key: 'z' }];
    act(() => result.current.moveRoster('local', 'z', 'x', raw));
    const e = readOrderJournal().find((v) => v.reason === 'move');
    expect(e).toBeTruthy();
    expect(e.position).toBe('local'); expect(e.source).toBe('z'); expect(e.target).toBe('x');
    expect(e.visible).toEqual(expect.arrayContaining(['x', 'y', 'z']));
    expect(e.after[0]).toBe('z');
  });
  it('un pin annota il motivo con prima e dopo', () => {
    const { result } = renderHook(() => useRosterPreferences());
    act(() => result.current.togglePin('a'));
    const e = readOrderJournal().find((v) => v.reason === 'pin');
    expect(e.key).toBe('a'); expect(e.before).toEqual([]); expect(e.after).toEqual(['a']);
  });
});
