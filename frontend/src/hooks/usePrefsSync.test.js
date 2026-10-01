import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sync = vi.hoisted(() => ({ syncPrefs: vi.fn(), resolveConflict: vi.fn() }));
vi.mock('../lib/prefs-sync.js', async (orig) => ({ ...(await orig()), syncPrefs: sync.syncPrefs, resolveConflict: sync.resolveConflict }));

import { usePrefsSync, resetPrefsSyncState, resolveSharedConflict } from './usePrefsSync.js';

beforeEach(() => { vi.useFakeTimers(); sync.syncPrefs.mockReset(); sync.resolveConflict.mockReset(); resetPrefsSyncState(); });
afterEach(() => { vi.useRealTimers(); });

describe('usePrefsSync', () => {
  it('senza token non parla col server', async () => {
    renderHook(() => usePrefsSync(''));
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(sync.syncPrefs).not.toHaveBeenCalled();
  });

  it('con il token fa un giro dopo un breve ritardo e ne espone l\'esito', async () => {
    sync.syncPrefs.mockResolvedValue({ status: 'restored', revision: 3 });
    const { result } = renderHook(() => usePrefsSync('tok'));
    expect(sync.syncPrefs).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(sync.syncPrefs).toHaveBeenCalledTimes(1);
    expect(result.current.state.status).toBe('restored');
  });

  it('i cambi di preferenze si caricano in un solo giro dopo una pausa (debounce)', async () => {
    sync.syncPrefs.mockResolvedValue({ status: 'synced', revision: 1 });
    renderHook(() => usePrefsSync('tok'));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    for (let i = 0; i < 5; i += 1) { window.dispatchEvent(new Event('nexuscrew-roster-preferences')); await act(async () => { await vi.advanceTimersByTimeAsync(500); }); }
    expect(sync.syncPrefs).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    expect(sync.syncPrefs).toHaveBeenCalledTimes(2);
  });

  it('con un conflitto aperto non carica nulla finche\' l\'utente non sceglie', async () => {
    localStorage.setItem('nc_device_id_v1', 'd'.repeat(32));
    sync.syncPrefs.mockResolvedValue({ status: 'conflict', revision: 2, conflict: { local: {}, server: {}, revision: 2, deviceId: 'd'.repeat(32) } });
    sync.resolveConflict.mockResolvedValue({ status: 'uploaded', revision: 3 });
    const { result } = renderHook(() => usePrefsSync('tok'));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(result.current.state.status).toBe('conflict');
    window.dispatchEvent(new Event('nexuscrew-roster-preferences'));
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(sync.syncPrefs).toHaveBeenCalledTimes(1);
    await act(async () => { await result.current.resolve('local'); });
    expect(sync.resolveConflict).toHaveBeenCalledWith('local', expect.anything(), expect.objectContaining({ token: 'tok' }));
    expect(result.current.state.status).toBe('uploaded');
  });

  const CONFLICT = (deviceId) => ({ status: 'conflict', revision: 2, conflict: { local: {}, server: {}, revision: 2, deviceId } });
  const DEV = 'd'.repeat(32);

  it('cambio di token con un conflitto pendente: il conflitto del login precedente sparisce e il nuovo login sincronizza', async () => {
    localStorage.setItem('nc_device_id_v1', DEV);
    sync.syncPrefs.mockResolvedValueOnce(CONFLICT(DEV)).mockResolvedValue({ status: 'synced', revision: 1 });
    const { result, rerender } = renderHook(({ t }) => usePrefsSync(t), { initialProps: { t: 'tokA' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(result.current.state.status).toBe('conflict');
    rerender({ t: 'tokB' });
    expect(result.current.state.status).not.toBe('conflict');
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(sync.syncPrefs).toHaveBeenCalledTimes(2);
    expect(sync.syncPrefs.mock.calls[1][0]).toMatchObject({ token: 'tokB' });
    expect(result.current.state.status).toBe('synced');
  });

  it('token che sparisce (401/logout): il conflitto non resta appeso', async () => {
    localStorage.setItem('nc_device_id_v1', DEV);
    sync.syncPrefs.mockResolvedValue(CONFLICT(DEV));
    const { result, rerender } = renderHook(({ t }) => usePrefsSync(t), { initialProps: { t: 'tokA' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(result.current.state.status).toBe('conflict');
    rerender({ t: '' });
    expect(result.current.state.status).not.toBe('conflict');
  });

  it('la scelta su un conflitto di un altro login non parte: nessuna chiamata col token nuovo e id vecchio', async () => {
    localStorage.setItem('nc_device_id_v1', DEV);
    sync.syncPrefs.mockResolvedValue(CONFLICT(DEV));
    const { result } = renderHook(() => usePrefsSync('tokA'));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    await act(async () => { await resolveSharedConflict('tokB', 'local'); });
    expect(sync.resolveConflict).not.toHaveBeenCalled();
    expect(result.current.state.status).not.toBe('conflict');
  });

  it('conflitto legato al dispositivo: se l\'id del browser cambia, la scelta non parte', async () => {
    localStorage.setItem('nc_device_id_v1', DEV);
    sync.syncPrefs.mockResolvedValue(CONFLICT(DEV));
    renderHook(() => usePrefsSync('tokA'));
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    localStorage.setItem('nc_device_id_v1', 'e'.repeat(32));
    await act(async () => { await resolveSharedConflict('tokA', 'server'); });
    expect(sync.resolveConflict).not.toHaveBeenCalled();
  });
});
