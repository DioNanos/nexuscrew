import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/api.js', () => ({
  apiFetch: vi.fn(),
  seenKey: (session) => `nc_seen_${session}`,
}));

import FilesPanel from './FilesPanel.jsx';
import { apiFetch } from '../lib/api.js';

const listResponse = {
  ok: true,
  json: async () => ({ inbox: [], outbox: [{ name: 'a.txt', size: 10, mtime: 1 }] }),
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  apiFetch.mockReset();
  apiFetch.mockResolvedValueOnce(listResponse);
});

describe('FilesPanel error messages (R27 #7)', () => {
  it('shows the server error cause on a failed download instead of a generic message', async () => {
    apiFetch.mockResolvedValueOnce({
      ok: false, status: 401, json: async () => ({ error: 'token scaduto' }),
    });
    render(<FilesPanel session="cloud-Dev" token="t" onClose={() => {}} />);
    fireEvent.click(await screen.findByText('a.txt'));
    expect(await screen.findByText('errore: token scaduto')).toBeTruthy();
    expect(screen.queryByText('errore download')).toBeNull();
  });

  it('reports a failed delete instead of staying silent and refreshing', async () => {
    apiFetch.mockResolvedValueOnce({
      ok: false, status: 500, json: async () => ({ error: 'box non trovato' }),
    });
    render(<FilesPanel session="cloud-Dev" token="t" onClose={() => {}} />);
    fireEvent.click(await screen.findByTitle('delete'));
    expect(await screen.findByText('errore: box non trovato')).toBeTruthy();
    // GET iniziale + DELETE: nessun refresh dopo un delete fallito
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });
});
