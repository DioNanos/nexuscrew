import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/api.js', () => ({
  apiFetch: vi.fn(),
  seenKey: (session) => `nc_seen_${session}`,
}));

import FilesPanel from './FilesPanel.jsx';
import { apiFetch } from '../lib/api.js';

// Il secondo download da mobile non partiva (16/10): revoca sincrona dell'object
// URL che gareggia col download manager, «busy» mai azzerato che tiene i bottoni
// del foglio «⋯» disabilitati per sempre, reject di rete totalmente muti.
// Qui si tiene il comportamento VOLUTO del download dopo il fix.
const listResponse = {
  ok: true,
  json: async () => ({ inbox: [], outbox: [{ name: 'a.txt', size: 10, mtime: Date.now() }] }),
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

function preparaDownload(url) {
  URL.createObjectURL = vi.fn(() => url);
  URL.revokeObjectURL = vi.fn();
  return vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
}

describe('FilesPanel download — anchor nel DOM e revoca ritardata', () => {
  it('due download di fila fanno due click e la revoca non è sincrona: arriva dopo il ritardo', async () => {
    await apriPannello();
    // il bottone si cerca PRIMA dei fake timers: findByText userebbe i timer
    // beffati e resterebbe appeso
    const dl = screen.getByTitle('download file');
    const click = preparaDownload('blob:x');
    apiFetch.mockResolvedValue({ ok: true, blob: async () => new Blob(['x']) });
    vi.useFakeTimers();
    try {
      fireEvent.click(dl);
      await act(async () => {});
      fireEvent.click(dl);
      await act(async () => {});
      // il secondo tocco deve essere un download vero, non un tocco morto
      expect(click).toHaveBeenCalledTimes(2);
      // il download manager dereferenzia il blob DOPO il ritorno di click():
      // revocare in modo sincrono uccide il download in silenzio
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(60_000); });
      expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      click.mockRestore();
    }
  });

  it('l\'anchor è attaccato al document.body quando scatta il click, e viene rimosso', async () => {
    await apriPannello();
    const attaccatiAlClick = [];
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function () {
      attaccatiAlClick.push(document.body.contains(this));
    });
    apiFetch.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['x']) });
    fireEvent.click(screen.getByTitle('download file'));
    await act(async () => {});
    expect(click).toHaveBeenCalledTimes(1);
    // il click programmatico su anchor detached è meno affidabile su alcuni
    // engine mobile: al click l'anchor deve stare nel DOM
    expect(attaccatiAlClick[0]).toBe(true);
    // ...e non restare appeso al body dopo il download
    expect(document.querySelector('a[download="a.txt"]')).toBeNull();
    click.mockRestore();
  });
});

describe('FilesPanel busy — l\'errore è un messaggio, non un lucchetto', () => {
  it('un refresh riuscito dopo un errore riabilita i bottoni del foglio', async () => {
    const { rerender } = await apriPannello();
    // rete caduta: il download rejecta e lascia l'errore in busy
    apiFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    fireEvent.click(screen.getByTitle('download file'));
    expect(await screen.findByText('errore download')).toBeTruthy();
    // un evento file della sessione fa refresh(): riuscito, busy si azzera
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ inbox: [], outbox: [{ name: 'a.txt', size: 10, mtime: 2 }] }) });
    rerender(<FilesPanel session="cloud-Dev" token="t" onClose={() => {}} filesEvent={{ session: 'cloud-Dev', n: 1 }} />);
    await waitFor(() => expect(screen.queryByText('errore download')).toBeNull());
    fireEvent.click(screen.getByTitle('file actions'));
    await screen.findByTestId('file-actions-sheet');
    expect(screen.getByText('Download').closest('button').disabled).toBe(false);
  });

  it('l\'esito informativo «anteprima non disponibile» non disabilita i bottoni', async () => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ inbox: [], outbox: [{ name: '20261014-0930_foto.png', size: 9, mtime: Date.now() }] }),
    });
    render(<FilesPanel session="cloud-Dev" token="t" onClose={() => {}} />);
    await screen.findByText('foto.png');
    fireEvent.click(screen.getByTitle('file actions'));
    await screen.findByTestId('file-actions-sheet');
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    // blob senza MIME navigabile: esito informativo, non un errore
    apiFetch.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['x']) });
    fireEvent.click(screen.getByText('Preview'));
    expect(await screen.findByText('preview unavailable for this type: download it')).toBeTruthy();
    // il messaggio si vede ma i bottoni restano vivi: si può scaricare subito
    expect(screen.getByText('Download').closest('button').disabled).toBe(false);
    expect(screen.getByText('Copy full name').closest('button').disabled).toBe(false);
    expect(screen.getByText('Delete…').closest('button').disabled).toBe(false);
    open.mockRestore();
  });
});

// Dopo un errore il foglio «⋯» deve restare USABILE.
// L'errore è un messaggio visibile e non disabilita nulla: il retry parte
// dallo stesso foglio, senza chiuderlo, senza refresh e senza aggirare col
// pulsante di riga. Vale per entrambe le viste (il foglio è comune).
describe('FilesPanel foglio — dopo un errore il foglio resta usabile (entrambe le viste)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  for (const desktop of [false, true]) {
    describe(desktop ? 'vista desktop' : 'vista mobile', () => {
      beforeEach(() => {
        vi.stubGlobal('matchMedia', vi.fn(() => ({
          matches: desktop, addEventListener() {}, removeEventListener() {},
        })));
      });

      async function apriFoglio() {
        render(<FilesPanel session="cloud-Dev" token="t" onClose={() => {}} />);
        await screen.findByText('a.txt');
        fireEvent.click(screen.getByTitle('file actions'));
        await screen.findByTestId('file-actions-sheet');
      }

      // in vista desktop il click su «⋯» seleziona anche la riga e il
      // pannello dettaglio ha i SUOI Scarica/Copia/Elimina: i selettori
      // puntano sempre l'azione DEL FOGLIO.
      const azione = (name) => screen.getByTestId('file-actions-sheet')
        .querySelector(`[data-fileaction="${name}"]`);

      it('download fallito (HTTP): retry dallo stesso foglio, senza refresh', async () => {
        await apriFoglio();
        apiFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: 'box non trovato' }) });
        const click = preparaDownload('blob:x');
        fireEvent.click(azione('download'));
        expect(await screen.findByText('errore: box non trovato')).toBeTruthy();
        // il download dal foglio lo chiude: lo si riapre sullo stesso file e
        // i bottoni devono essere GIÀ abilitati — l'errore non è un lucchetto
        fireEvent.click(screen.getByTitle('file actions'));
        await screen.findByTestId('file-actions-sheet');
        expect(azione('download').disabled).toBe(false);
        expect(azione('copy').disabled).toBe(false);
        expect(azione('delete').disabled).toBe(false);
        // la SECONDA richiesta parte dal foglio e arriva fino al click
        apiFetch.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['x']) });
        fireEvent.click(azione('download'));
        await act(async () => {});
        expect(click).toHaveBeenCalledTimes(1);
        click.mockRestore();
      });

      it('download fallito (reject di rete): retry dallo stesso foglio, senza refresh', async () => {
        await apriFoglio();
        apiFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
        const click = preparaDownload('blob:y');
        fireEvent.click(azione('download'));
        expect(await screen.findByText('errore download')).toBeTruthy();
        fireEvent.click(screen.getByTitle('file actions'));
        await screen.findByTestId('file-actions-sheet');
        expect(azione('download').disabled).toBe(false);
        apiFetch.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['y']) });
        fireEvent.click(azione('download'));
        await act(async () => {});
        expect(click).toHaveBeenCalledTimes(1);
        click.mockRestore();
      });

      it('anteprima fallita: Scarica, Copia ed Elimina abilitati nello stesso foglio', async () => {
        await apriFoglio();
        apiFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
        fireEvent.click(screen.getByText('Preview'));
        // l'errore si vede DENTRO il foglio, che l'anteprima non chiude
        expect(await screen.findByText('errore download')).toBeTruthy();
        const sheet = screen.getByTestId('file-actions-sheet');
        for (const action of ['download', 'copy', 'delete']) {
          expect(sheet.querySelector(`[data-fileaction="${action}"]`).disabled).toBe(false);
        }
      });
    });
  }
});

describe('FilesPanel download — gli errori di rete non sono muti', () => {
  it('un reject di rete nel download produce un messaggio visibile', async () => {
    await apriPannello();
    apiFetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    fireEvent.click(screen.getByTitle('download file'));
    expect(await screen.findByText('errore download')).toBeTruthy();
  });
});
