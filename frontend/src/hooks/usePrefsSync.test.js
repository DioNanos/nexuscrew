import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sync = vi.hoisted(() => ({ syncPrefs: vi.fn(), resolveConflict: vi.fn() }));
vi.mock('../lib/prefs-sync.js', async (orig) => ({ ...(await orig()), syncPrefs: sync.syncPrefs, resolveConflict: sync.resolveConflict }));

import { usePrefsSync, resetPrefsSyncState } from './usePrefsSync.js';

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
    sync.syncPrefs.mockResolvedValue({ status: 'conflict', revision: 2, conflict: { local: {}, server: {}, revision: 2, deviceId: 'd' } });
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
});
