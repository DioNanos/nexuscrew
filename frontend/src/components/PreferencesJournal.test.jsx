import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PreferencesJournal from './PreferencesJournal.jsx';
import { appendOrderJournal, readOrderJournal } from '../lib/order-journal.js';
import { PERSIST_KEY } from '../lib/storage-persist.js';

vi.mock('../hooks/useLang.js', () => ({ useLang: () => ['en', vi.fn()] }));

beforeEach(() => { localStorage.clear(); localStorage.setItem('nc_lang', 'en'); });

describe('diario delle preferenze in Impostazioni', () => {
  it('mostra le scritture recenti con motivo e chiavi prima/dopo', () => {
    appendOrderJournal({ reason: 'move', position: 'local', source: 'b', target: 'a', before: ['a', 'b'], after: ['b', 'a'] });
    render(<PreferencesJournal />);
    const row = screen.getByTestId('journal-row');
    expect(row.textContent).toContain('move');
    expect(row.textContent).toContain('a, b');
    expect(row.textContent).toContain('b, a');
  });

  it('senza scritture lo dice, e dichiara lo stato della persistenza dello storage', () => {
    localStorage.setItem(PERSIST_KEY, JSON.stringify({ at: 1, status: 'denied' }));
    render(<PreferencesJournal />);
    expect(screen.getByText('No changes recorded yet.')).toBeTruthy();
    expect(screen.getByTestId('persist-status').textContent).toContain('denied');
  });

  it('copia il diario negli appunti e lo svuota su richiesta', async () => {
    appendOrderJournal({ reason: 'pin', key: 'x', before: [], after: ['x'] });
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    render(<PreferencesJournal />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy journal' }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(JSON.parse(writeText.mock.calls[0][0])[0].reason).toBe('pin');
    fireEvent.click(screen.getByRole('button', { name: 'Clear journal' }));
    expect(readOrderJournal()).toEqual([]);
    expect(screen.getByText('No changes recorded yet.')).toBeTruthy();
  });
});
