import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useRosterPreferences } from './useRosterPreferences.js';
import { registerRouteIdentities, resetRouteRegistry } from '../lib/route-identity.js';

const X = 'a'.repeat(32);
const group = (name) => ({ name, route: [name], instanceId: X });
const store = (key) => JSON.parse(localStorage.getItem(key));
const items = ['nuovo:c1', 'nuovo:c2', 'nuovo:c3'].map((key) => ({ key, type: 'cell', label: key, live: true }));

beforeEach(() => { localStorage.clear(); resetRouteRegistry(); });

describe('useRosterPreferences con identita\' del nodo', () => {
  it('dopo la rinomina il riordino scrive sotto id:<instanceId> e non tocca la voce per nome', () => {
    localStorage.setItem('nc_sidebar_order_v1', JSON.stringify({ vecchio: ['vecchio:c3', 'vecchio:c1', 'vecchio:c2'] }));
    registerRouteIdentities([group('vecchio')]);
    resetRouteRegistry();
    registerRouteIdentities([group('nuovo')]);
    const { result } = renderHook(() => useRosterPreferences());
    expect(result.current.orders.nuovo).toEqual(['nuovo:c3', 'nuovo:c1', 'nuovo:c2']);
    act(() => result.current.moveRoster('nuovo', 'nuovo:c2', 'nuovo:c3', items));
    expect(store('nc_sidebar_order_v1')[`id:${X}`]).toEqual(['nuovo:c2', 'nuovo:c3', 'nuovo:c1']);
    expect(store('nc_sidebar_order_v1').vecchio).toEqual(['vecchio:c3', 'vecchio:c1', 'vecchio:c2']);
    expect(result.current.orders.nuovo).toEqual(['nuovo:c2', 'nuovo:c3', 'nuovo:c1']);
  });

  it('la vista (aperto/chiuso) segue il nodo dopo la rinomina', () => {
    localStorage.setItem('nc_sidebar_views_v1', JSON.stringify({ vecchio: { open: false, filter: 'all' } }));
    registerRouteIdentities([group('vecchio')]);
    resetRouteRegistry();
    registerRouteIdentities([group('nuovo')]);
    const { result } = renderHook(() => useRosterPreferences());
    expect(result.current.viewFor('nuovo').open).toBe(false);
    act(() => result.current.updateView('nuovo', { open: true }));
    expect(store('nc_sidebar_views_v1')[`id:${X}`].open).toBe(true);
    expect(store('nc_sidebar_views_v1').vecchio.open).toBe(false);
  });

  it('la posizione locale e i nodi senza identita\' restano per nome', () => {
    const { result } = renderHook(() => useRosterPreferences());
    act(() => result.current.updateView('local', { open: false }));
    expect(store('nc_sidebar_views_v1').local.open).toBe(false);
  });
});
