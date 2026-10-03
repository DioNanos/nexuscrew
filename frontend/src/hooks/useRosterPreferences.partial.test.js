import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useRosterPreferences } from './useRosterPreferences.js';
import { readOrderJournal } from '../lib/order-journal.js';
import { buildLocalRoster, buildRemoteRoster } from '../lib/roster-view-model.js';

beforeEach(() => localStorage.clear());

const cells = [{ cell: 'A', tmuxSession: 'a', tmux: false }, { cell: 'B', tmuxSession: 'b', tmux: false }];
const byName = new Map();

describe('riordino bloccato quando la lista e\' parziale (O1)', () => {
  it('il roster locale dichiara il motivo: sessioni non lette, o fleet illeggibile senza elenco', () => {
    expect(buildLocalRoster(cells, [], byName, undefined, { autorevole: true }).some((i) => i.partial)).toBe(false);
    expect(buildLocalRoster(cells, [], byName, undefined, { autorevole: false })[0].partial).toBe('sessions');
    expect(buildLocalRoster([], [{ name: 'tmux1' }], byName, undefined, { autorevole: true, fleetStale: true })[0].partial).toBe('fleet');
    // con un elenco ripristinato (ultimo buono) il riordino e' sicuro: nessun blocco
    expect(buildLocalRoster(cells, [], byName, undefined, { autorevole: true, fleetStale: true }).some((i) => i.partial)).toBe(false);
  });

  it('il roster remoto: sessioni non disponibili o fleet stale vuoto = parziale', () => {
    const base = { route: ['n'], status: 'up', cells: [], unmanaged: [{ name: 's' }] };
    expect(buildRemoteRoster({ ...base, sessionsAvailable: false }).rawItems[0].partial).toBe('sessions');
    expect(buildRemoteRoster({ ...base, fleetState: 'stale' }).rawItems[0].partial).toBe('fleet');
    expect(buildRemoteRoster({ ...base, fleetState: 'available' }).rawItems.some((i) => i.partial)).toBe(false);
  });

  it('moveRoster su lista parziale non scrive, spiega il perche\' e lo annota nel diario', () => {
    localStorage.setItem('nc_sidebar_order_v1', JSON.stringify({ local: ['x', 'y', 'z'] }));
    const items = ['y', 'z'].map((key) => ({ key, type: 'session', label: key, live: true, partial: 'fleet' }));
    const { result } = renderHook(() => useRosterPreferences());
    act(() => result.current.moveRoster('local', 'z', 'y', items));
    expect(JSON.parse(localStorage.getItem('nc_sidebar_order_v1'))).toEqual({ local: ['x', 'y', 'z'] });
    expect(result.current.reorderBlocked).toMatchObject({ reason: 'fleet', position: 'local' });
    expect(readOrderJournal().at(-1)).toMatchObject({ reason: 'reorder-blocked', note: 'fleet' });
  });

  it('stepRoster (tastiera) e\' bloccato allo stesso modo; su lista completa il blocco sparisce', () => {
    const partial = ['y', 'z'].map((key) => ({ key, type: 'session', label: key, live: true, partial: 'sessions' }));
    const whole = partial.map((i) => ({ ...i, partial: undefined }));
    const { result } = renderHook(() => useRosterPreferences());
    act(() => result.current.stepRoster('local', 'z', -1, partial));
    expect(localStorage.getItem('nc_sidebar_order_v1')).toBeNull();
    expect(result.current.reorderBlocked.reason).toBe('sessions');
    act(() => result.current.stepRoster('local', 'z', -1, whole));
    expect(JSON.parse(localStorage.getItem('nc_sidebar_order_v1')).local).toEqual(['z', 'y']);
    expect(result.current.reorderBlocked).toBeNull();
  });
});
