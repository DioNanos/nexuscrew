import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

async function apriPannello(props) {
  const view = render(<FilesPanel session="cloud-Dev" token="t" onClose={() => {}} {...props} />);
  await screen.findByText('a.txt');
  return view;
}

describe('FilesPanel error messages (R27 #7)', () => {
  it('shows the server error cause on a failed download instead of a generic message', async () => {
    apiFetch.mockResolvedValueOnce({
      ok: false, status: 401, json: async () => ({ error: 'token scaduto' }),
    });
    await apriPannello();
    fireEvent.click(screen.getByTitle('download file'));
    expect(await screen.findByText('errore: token scaduto')).toBeTruthy();
    expect(screen.queryByText('errore download')).toBeNull();
  });

  it('reports a failed delete instead of staying silent and refreshing', async () => {
    apiFetch.mockResolvedValueOnce({
      ok: false, status: 500, json: async () => ({ error: 'box non trovato' }),
    });
    await apriPannello();
    fireEvent.click(screen.getByTitle('delete'));
    expect(await screen.findByText('errore: box non trovato')).toBeTruthy();
    // GET iniziale + DELETE: nessun refresh dopo un delete fallito
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });
});

describe('FilesPanel riga file e scatole', () => {
  it('non ha piu\' il tasto di caricamento ne\' il suo input file', async () => {
    // Il file entra nella cella dal menu allegati del composer (voce «Inbox»,
    // stessa route POST /files/upload): il pannello non lo duplica piu'.
    const { container } = await apriPannello();
    expect(screen.queryByText('upload')).toBeNull();
    expect(container.querySelector('input[type=file]')).toBeNull();
  });

  it('ogni riga scarica quel file dal proprio tastino', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    apiFetch.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['x']) });
    await apriPannello();
    fireEvent.click(screen.getByTitle('download file'));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    const url = String(apiFetch.mock.calls[1][0]);
    expect(url).toContain('/files/download');
    expect(url).toContain('box=outbox');
    expect(url).toContain('name=a.txt');
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it('il nome del file non e\' interattivo: niente tap, niente comando', async () => {
    await apriPannello();
    const nome = screen.getByText('a.txt');
    expect(nome.tagName).toBe('SPAN');
    expect(nome.getAttribute('role')).toBeNull();
    expect(nome.getAttribute('tabindex')).toBeNull();
    expect(nome.tabIndex).toBe(-1);
    fireEvent.click(nome);
    // il click sul nome non fa partire nessuna richiesta: resta il solo GET iniziale
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('il cestino cancella ancora il file della scatola attiva', async () => {
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) }); // DELETE
    apiFetch.mockResolvedValueOnce(listResponse); // refresh
    await apriPannello();
    fireEvent.click(screen.getByTitle('delete'));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
    const [url, token, opts] = apiFetch.mock.calls[1];
    expect(String(url)).toContain('box=outbox');
    expect(String(url)).toContain('name=a.txt');
    expect(token).toBe('t');
    expect(opts).toEqual({ method: 'DELETE' });
  });

  it('il nav mostra le due scatole, una accesa', async () => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ inbox: [{ name: 'b.txt', size: 2, mtime: 1 }], outbox: [{ name: 'a.txt', size: 10, mtime: 1 }] }),
    });
    const { container } = await apriPannello();
    const nav = container.querySelector('.nc-files nav');
    const stato = () => [...nav.querySelectorAll('button')].map((b) => `${b.textContent}:${b.className}`);
    expect(stato()).toEqual(['outbox:on', 'inbox:']);
    expect(screen.getByText('a.txt')).toBeTruthy();
    fireEvent.click(nav.querySelectorAll('button')[1]);
    expect(stato()).toEqual(['outbox:', 'inbox:on']);
    expect(screen.getByText('b.txt')).toBeTruthy();
  });
});
