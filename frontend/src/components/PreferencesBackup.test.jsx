import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const h = vi.hoisted(() => ({ state: { status: 'idle' }, resolve: vi.fn() }));
vi.mock('../hooks/usePrefsSync.js', () => ({ usePrefsSyncState: () => h.state, resolveSharedConflict: (token, choice) => h.resolve(choice) }));
vi.mock('../hooks/useLang.js', () => ({ useLang: () => ['en', vi.fn()] }));

import PreferencesBackup from './PreferencesBackup.jsx';
import { collectPrefs } from '../lib/prefs-sync.js';

beforeEach(() => { localStorage.clear(); localStorage.setItem('nc_lang', 'en'); h.state = { status: 'idle' }; h.resolve.mockReset(); });

const file = (text) => new File([text], 'prefs.json', { type: 'application/json' });
const upload = async (text) => {
  const input = screen.getByLabelText('Import preferences');
  Object.defineProperty(input, 'files', { value: [file(text)], configurable: true });
  await act(async () => { fireEvent.change(input); });
};

describe('backup delle preferenze in Impostazioni', () => {
  it('mostra lo stato del sync in chiaro', () => {
    h.state = { status: 'restored', revision: 3, at: Date.now() };
    render(<PreferencesBackup />);
    expect(screen.getByTestId('sync-status').textContent).toContain('restored');
  });

  it('un conflitto offre due scelte esplicite e le inoltra', () => {
    h.state = { status: 'conflict', revision: 2, conflict: { local: { pins: ['a'] }, server: { pins: ['b'] }, revision: 2, deviceId: 'd' } };
    render(<PreferencesBackup />);
    fireEvent.click(screen.getByRole('button', { name: 'Keep this device' }));
    expect(h.resolve).toHaveBeenCalledWith('local');
    fireEvent.click(screen.getByRole('button', { name: 'Use server copy' }));
    expect(h.resolve).toHaveBeenCalledWith('server');
  });

  it('importa un file valido quando lo storage e\' vuoto', async () => {
    localStorage.setItem('nc_pins', JSON.stringify(['n:a']));
    const text = (await import('../lib/prefs-sync.js')).exportPrefs();
    localStorage.clear(); localStorage.setItem('nc_lang', 'en');
    render(<PreferencesBackup />);
    await upload(text);
    await waitFor(() => expect(collectPrefs().pins).toEqual(['n:a']));
  });

  it('con preferenze locali non vuote chiede conferma e, se rifiutata, non tocca nulla', async () => {
    localStorage.setItem('nc_pins', JSON.stringify(['n:a']));
    const text = (await import('../lib/prefs-sync.js')).exportPrefs();
    localStorage.setItem('nc_pins', JSON.stringify(['n:locale']));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<PreferencesBackup />);
    await upload(text);
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(collectPrefs().pins).toEqual(['n:locale']);
    confirm.mockReturnValue(true);
    await upload(text);
    await waitFor(() => expect(collectPrefs().pins).toEqual(['n:a']));
    confirm.mockRestore();
  });

  it('un file non valido mostra l\'errore e non tocca nulla', async () => {
    localStorage.setItem('nc_pins', JSON.stringify(['n:locale']));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<PreferencesBackup />);
    await upload('{"kind":"altro"}');
    expect((await screen.findByRole('alert')).textContent).toContain('not a NexusCrew preferences file');
    expect(collectPrefs().pins).toEqual(['n:locale']);
  });
});
