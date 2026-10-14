import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

  it('reports a failed delete (sheet, confirm) instead of staying silent and refreshing', async () => {
    apiFetch.mockResolvedValueOnce({
      ok: false, status: 500, json: async () => ({ error: 'box non trovato' }),
    });
    await apriPannello();
    // il delete ora vive nel foglio azioni: «⋯» -> Delete… -> conferma
    fireEvent.click(screen.getByTitle('file actions'));
    fireEvent.click(await screen.findByText('Delete…'));
    fireEvent.click(await screen.findByRole('button', { name: 'delete' }));
    // l'errore si vede DENTRO il foglio aperto, che resta aperto
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

  it('il nav mostra le due scatole col conteggio, una accesa', async () => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ inbox: [{ name: 'b.txt', size: 2, mtime: 1 }], outbox: [{ name: 'a.txt', size: 10, mtime: 1 }] }),
    });
    const { container } = await apriPannello();
    const nav = container.querySelector('.nc-files nav');
    const stato = () => [...nav.querySelectorAll('button')].map((b) => `${b.textContent}:${b.className}`);
    expect(stato()).toEqual(['Outbox · 1:on', 'Inbox · 1:']);
    expect(screen.getByText('a.txt')).toBeTruthy();
    fireEvent.click(nav.querySelectorAll('button')[1]);
    expect(stato()).toEqual(['Outbox · 1:', 'Inbox · 1:on']);
    expect(screen.getByText('b.txt')).toBeTruthy();
  });
});

describe('FilesPanel riga a due livelli e gruppi per giorno', () => {
  const oggi = Date.now();

  function lista(files) {
    return { ok: true, json: async () => ({ inbox: [], outbox: files }) };
  }

  async function apriConLista(files, attesa) {
    apiFetch.mockReset();
    apiFetch.mockResolvedValueOnce(lista(files));
    const view = render(<FilesPanel session="cloud-Dev" token="t" onClose={() => {}} />);
    await screen.findByText(attesa);
    return view;
  }

  it('mostra il nome SENZA prefissi e mai il nome originale in lista', async () => {
    await apriConLista([
      { name: '20261014-0930_2026-10-13_report.md', size: 348160, mtime: oggi },
    ], 'report.md');
    expect(screen.getByText('report.md')).toBeTruthy();
    expect(screen.queryByText('20261014-0930_2026-10-13_report.md')).toBeNull();
    expect(screen.queryByText('2026-10-13_report.md')).toBeNull();
  });

  it('badge-tipo con l\'estensione e sottoriga mono con dimensione leggibile', async () => {
    const { container } = await apriConLista([
      { name: '20261014-0930_report.md', size: 348160, mtime: oggi },
    ], 'report.md');
    const tipo = container.querySelector('.nc-files-type');
    expect(tipo.textContent).toBe('MD');
    expect(tipo.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText(/340 KB/)).toBeTruthy();
    expect(screen.queryByText(/340K/)).toBeNull();
  });

  it('senza estensione il badge è l\'icona file generica', async () => {
    const { container } = await apriConLista([
      { name: '20261014-0930_note', size: 5, mtime: oggi },
    ], 'note');
    const tipo = container.querySelector('.nc-files-type');
    expect(tipo.textContent).toBe('');
    expect(tipo.querySelector('svg')).toBeTruthy();
  });

  it('raggruppa per giorno: oggi etichettato, giorni vecchi in coda, recenti prima', async () => {
    await apriConLista([
      { name: '20200110-0800_vecchio.log', size: 1, mtime: 1 },        // dal nome: 10 gennaio 2020
      { name: 'oggi_b.zip', size: 2, mtime: oggi - 3600_000 },         // dall'mtime: un'ora fa
      { name: 'oggi_a.zip', size: 2, mtime: oggi },                     // dall'mtime: adesso
    ], 'vecchio.log');
    const giorni = [...document.querySelectorAll('.nc-files-day')].map((h) => h.textContent);
    expect(giorni).toHaveLength(2);
    expect(giorni[0].startsWith('Today · ')).toBe(true);
    expect(giorni[1]).toBe('January 10');
    // nel gruppo di oggi l'ordine è dal più recente
    const nomi = [...document.querySelectorAll('.nc-files-daygroup ul .nc-files-name')].map((n) => n.textContent);
    expect(nomi).toEqual(['oggi_a.zip', 'oggi_b.zip', 'vecchio.log']);
  });
});

describe('FilesPanel ricerca per nome', () => {
  function listaDoppia() {
    return {
      ok: true,
      json: async () => ({
        inbox: [],
        outbox: [
          { name: '20261014-0930_report.md', size: 10, mtime: Date.now() },
          { name: '20260101-0900_foto.png', size: 20, mtime: Date.now() - 7200_000 },
        ],
      }),
    };
  }

  async function apriConDue() {
    apiFetch.mockReset();
    apiFetch.mockResolvedValueOnce(listaDoppia());
    const view = render(<FilesPanel session="cloud-Dev" token="t" onClose={() => {}} />);
    await screen.findByText('report.md');
    return view;
  }

  it('filtra l\'elenco caricato lato client, senza richieste', async () => {
    await apriConDue();
    fireEvent.change(screen.getByLabelText('search files'), { target: { value: 'report' } });
    expect(screen.getByText('report.md')).toBeTruthy();
    expect(screen.queryByText('foto.png')).toBeNull();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('la ricerca vede anche il nome originale: il prefisso è cercabile', async () => {
    await apriConDue();
    fireEvent.change(screen.getByLabelText('search files'), { target: { value: '20260101' } });
    expect(screen.getByText('foto.png')).toBeTruthy();
    expect(screen.queryByText('report.md')).toBeNull();
  });

  it('nessun risultato: messo esplicito, svuotare ripristina', async () => {
    await apriConDue();
    fireEvent.change(screen.getByLabelText('search files'), { target: { value: 'zzz' } });
    expect(screen.getByText('no file matches "zzz"')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('search files'), { target: { value: '' } });
    expect(screen.getByText('report.md')).toBeTruthy();
    expect(screen.getByText('foto.png')).toBeTruthy();
  });
});

describe('FilesPanel foglio azioni (⋯)', () => {
  const FILE = { name: '20261014-0930_2026-10-13_report.md', size: 348160, mtime: Date.now() };

  async function apriConFileFoglioabile() {
    apiFetch.mockReset();
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ inbox: [], outbox: [FILE] }) });
    render(<FilesPanel session="cloud-Dev" token="t" onClose={() => {}} />);
    await screen.findByText('report.md');
  }

  async function apriFoglio() {
    fireEvent.click(screen.getByTitle('file actions'));
    await screen.findByTestId('file-actions-sheet');
  }

  it('apre il foglio con nome visualizzato, nome ORIGINALE completo in mono e meta', async () => {
    await apriConFileFoglioabile();
    await apriFoglio();
    const foglio = screen.getByTestId('file-actions-sheet');
    expect(foglio.querySelector('.nc-filesheet-nome').textContent).toBe('report.md');
    expect(foglio.querySelector('.nc-filesheet-mono').textContent).toBe(FILE.name);
    const meta = foglio.querySelector('.nc-filesheet-meta').textContent;
    expect(meta).toContain('340 KB');
    expect(meta).toContain('Outbox');
    expect(meta).toContain('cloud-Dev');
  });

  it('la X chiude il foglio, la lista resta', async () => {
    await apriConFileFoglioabile();
    await apriFoglio();
    // Due X in pagina (pannello e foglio): quella del foglio sta nel dialogo.
    const foglio = screen.getByTestId('file-actions-sheet');
    fireEvent.click(within(foglio).getByLabelText('close'));
    expect(screen.queryByTestId('file-actions-sheet')).toBeNull();
    expect(screen.getByText('report.md')).toBeTruthy();
  });

  it('Escape chiude il foglio come il velo e la X', async () => {
    await apriConFileFoglioabile();
    await apriFoglio();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('file-actions-sheet')).toBeNull();
  });

  it('Elimina… chiede conferma; annullare non spedisce nulla', async () => {
    await apriConFileFoglioabile();
    await apriFoglio();
    fireEvent.click(screen.getByText('Delete…'));
    expect(screen.getByTestId('file-delete-confirm')).toBeTruthy();
    expect(screen.getByText('Delete "report.md"?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(screen.queryByTestId('file-delete-confirm')).toBeNull();
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });

  it('la conferma Elimina spedisce il nome ORIGINALE con la box attiva, rinfresca e chiude', async () => {
    await apriConFileFoglioabile();
    await apriFoglio();
    fireEvent.click(screen.getByText('Delete…'));
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) }); // DELETE
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ inbox: [], outbox: [] }) }); // refresh
    fireEvent.click(screen.getByRole('button', { name: 'delete' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
    const [url, token, opts] = apiFetch.mock.calls[1];
    expect(String(url)).toContain('/files');
    expect(String(url)).toContain('box=outbox');
    expect(String(url)).toContain(`name=${encodeURIComponent(FILE.name)}`);
    expect(token).toBe('t');
    expect(opts).toEqual({ method: 'DELETE' });
    await waitFor(() => expect(screen.queryByTestId('file-actions-sheet')).toBeNull());
  });

  it('Scarica nel foglio scarica col nome ORIGINALE e chiude il foglio', async () => {
    await apriConFileFoglioabile();
    await apriFoglio();
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    apiFetch.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['x']) });
    fireEvent.click(screen.getByText('Download'));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(String(apiFetch.mock.calls[1][0])).toContain(`name=${encodeURIComponent(FILE.name)}`);
    await waitFor(() => expect(screen.queryByTestId('file-actions-sheet')).toBeNull());
    click.mockRestore();
  });

  it('Copia nome completo copia il nome ORIGINALE e lo dice', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await apriConFileFoglioabile();
    await apriFoglio();
    fireEvent.click(screen.getByText('Copy full name'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(FILE.name));
    expect(await screen.findByText('full name copied')).toBeTruthy();
  });
});

describe('FilesPanel anteprima nel foglio', () => {
  it('offerta solo per i tipi che il browser mostra in linea', async () => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ inbox: [], outbox: [{ name: '20261014-0930_foto.png', size: 9, mtime: Date.now() }] }),
    });
    const prima = render(<FilesPanel session="cloud-Dev" token="t" onClose={() => {}} />);
    await screen.findByText('foto.png');
    fireEvent.click(screen.getByTitle('file actions'));
    expect(await screen.findByText('Preview')).toBeTruthy();
    prima.unmount();

    apiFetch.mockReset();
    apiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ inbox: [], outbox: [{ name: '20261014-0930_archivio.zip', size: 9, mtime: Date.now() }] }),
    });
    render(<FilesPanel session="cloud-Dev" token="t" onClose={() => {}} />);
    await screen.findByText('archivio.zip');
    fireEvent.click(screen.getByTitle('file actions'));
    await screen.findByTestId('file-actions-sheet');
    expect(screen.queryByText('Preview')).toBeNull();
  });

  it('apre il blob del nome ORIGINALE in una nuova scheda', async () => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ inbox: [], outbox: [{ name: '20261014-0930_foto.png', size: 9, mtime: Date.now() }] }),
    });
    render(<FilesPanel session="cloud-Dev" token="t" onClose={() => {}} />);
    await screen.findByText('foto.png');
    fireEvent.click(screen.getByTitle('file actions'));
    URL.createObjectURL = vi.fn(() => 'blob:img');
    URL.revokeObjectURL = vi.fn();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    apiFetch.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['x'], { type: 'image/png' }) });
    fireEvent.click(await screen.findByText('Preview'));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(2));
    expect(String(apiFetch.mock.calls[1][0])).toContain('name=20261014-0930_foto.png');
    expect(open).toHaveBeenCalledWith('blob:img', '_blank', 'noopener');
    open.mockRestore();
  });

  // Con «noopener» window.open torna SEMPRE null, anche quando la scheda si
  // apre davvero (comportamento documentato dell'API): il null NON è una
  // prova di fallimento e non deve produrre errori né revoca immediata.
  it('null di noopener: nessun falso errore, l\'object URL è revocato solo dopo il ritardo', async () => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ inbox: [], outbox: [{ name: '20261014-0930_foto.png', size: 9, mtime: Date.now() }] }),
    });
    render(<FilesPanel session="cloud-Dev" token="t" onClose={() => {}} />);
    await screen.findByText('foto.png');
    fireEvent.click(screen.getByTitle('file actions'));
    URL.createObjectURL = vi.fn(() => 'blob:img');
    URL.revokeObjectURL = vi.fn();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    apiFetch.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['x'], { type: 'image/png' }) });
    // il bottone si trova PRIMA dei fake timers: findByText dentro waitFor
    // userebbe i timer beffati e resterebbe appeso
    const bottone = await screen.findByText('Preview');
    vi.useFakeTimers();
    try {
      fireEvent.click(bottone);
      await act(async () => {});
      expect(open).toHaveBeenCalledWith('blob:img', '_blank', 'noopener');
      // nessun falso «preview failed»: il null di noopener non è un errore
      expect(screen.queryByText('preview failed')).toBeNull();
      // la scheda aperta deve avere il tempo di consumare il blob…
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
      // …ma dopo il ritardo l'URL non resta appeso per la vita della PWA
      act(() => { vi.advanceTimersByTime(60_000); });
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:img');
    } finally {
      vi.useRealTimers();
      open.mockRestore();
    }
  });

  it('window.open che lancia: lo dice e revoca subito l\'object URL', async () => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ inbox: [], outbox: [{ name: '20261014-0930_foto.png', size: 9, mtime: Date.now() }] }),
    });
    render(<FilesPanel session="cloud-Dev" token="t" onClose={() => {}} />);
    await screen.findByText('foto.png');
    fireEvent.click(screen.getByTitle('file actions'));
    URL.createObjectURL = vi.fn(() => 'blob:img');
    URL.revokeObjectURL = vi.fn();
    const open = vi.spyOn(window, 'open').mockImplementation(() => { throw new Error('open failed'); });
    apiFetch.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['x'], { type: 'image/png' }) });
    fireEvent.click(await screen.findByText('Preview'));
    expect(await screen.findByText('preview failed')).toBeTruthy();
    // fallimento certo (eccezione): nessun consumatore, revoca subito
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:img');
    open.mockRestore();
  });
});

describe('FilesPanel anteprima sicura (SVG e MIME del blob)', () => {
  // Un SVG ostile con script e handler: la sicurezza è NON navigarci mai come
  // documento (in <img> gli script non girano; da scaricato è un file qualunque).
  const SVG_CON_SCRIPT = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>';

  function montaConFile(file) {
    apiFetch.mockReset();
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ inbox: [], outbox: [file] }) });
    return render(<FilesPanel session="cloud-Dev" token="t" onClose={() => {}} />);
  }

  it('SVG: nel foglio azioni non c\'è la voce Anteprima — si scarica e basta', async () => {
    await montaConFile({ name: '20261014-0930_logo.svg', size: 300, mtime: Date.now() });
    await screen.findByText('logo.svg');
    fireEvent.click(screen.getByTitle('file actions'));
    await screen.findByTestId('file-actions-sheet');
    expect(screen.queryByText('Preview')).toBeNull();
    expect(screen.getByText('Download')).toBeTruthy();
  });

  it('blob SVG arrivato sotto nome .png: nessuna navigazione, avviso esplicito, nessun object URL', async () => {
    await montaConFile({ name: '20261014-0930_foto.png', size: 300, mtime: Date.now() });
    await screen.findByText('foto.png');
    fireEvent.click(screen.getByTitle('file actions'));
    URL.createObjectURL = vi.fn(() => 'blob:svg');
    URL.revokeObjectURL = vi.fn();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    apiFetch.mockResolvedValueOnce({ ok: true, blob: async () => new Blob([SVG_CON_SCRIPT], { type: 'image/svg+xml' }) });
    fireEvent.click(await screen.findByText('Preview'));
    expect(await screen.findByText('preview unavailable for this type: download it')).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('MIME assente sul blob: chiuso lo stesso (fail closed), niente navigazione', async () => {
    await montaConFile({ name: '20261014-0930_nota.txt', size: 12, mtime: Date.now() });
    await screen.findByText('nota.txt');
    fireEvent.click(screen.getByTitle('file actions'));
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    apiFetch.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['x']) });
    fireEvent.click(await screen.findByText('Preview'));
    expect(await screen.findByText('preview unavailable for this type: download it')).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it('l\'object URL dell\'anteprima aperta viene revocato dopo un ritardo prudente', async () => {
    await montaConFile({ name: '20261014-0930_foto.png', size: 9, mtime: Date.now() });
    await screen.findByText('foto.png');
    fireEvent.click(screen.getByTitle('file actions'));
    await screen.findByTestId('file-actions-sheet');
    URL.createObjectURL = vi.fn(() => 'blob:img');
    URL.revokeObjectURL = vi.fn();
    // noopener: il ritorno reale è null anche quando la scheda si apre
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    apiFetch.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['x'], { type: 'image/png' }) });
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByText('Preview'));
      await act(async () => {});
      expect(open).toHaveBeenCalledWith('blob:img', '_blank', 'noopener');
      // la nuova scheda deve averne il tempo: niente revoca immediata…
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
      // …ma dopo il ritardo l'URL non resta appeso per la vita della PWA
      act(() => { vi.advanceTimersByTime(60_000); });
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:img');
    } finally {
      vi.useRealTimers();
      open.mockRestore();
    }
  });
});

describe('FilesPanel X di chiusura', () => {
  it('la X usa la classe condivisa nc-ntf-x (toast e pannello ASK) con aria-label invariata', async () => {
    const onClose = vi.fn();
    await apriPannello({ onClose });
    const x = screen.getByLabelText('close');
    // Fissa il riuso dello stile condiviso: la classe deve restare nc-ntf-x,
    // non uno stile nuovo per-componente o il bottone nativo del browser.
    expect(x.className).toBe('nc-ntf-x');
    expect(x.getAttribute('type')).toBe('button');
    expect(x.getAttribute('aria-label')).toBe('close');
    fireEvent.click(x);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
