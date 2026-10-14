import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/api.js', () => ({
  apiFetch: vi.fn(),
  seenKey: (session) => `nc_seen_${session}`,
  routeBase: () => '/api',
}));

import FilesPanel from './FilesPanel.jsx';
import { apiFetch } from '../lib/api.js';

// Il pannello desktop si accende sul criterio condiviso R34 (useDesktop):
// qui si forza matchMedia a rispondere desktop (o meno, nei test di parità).
function matchMediaFisso(matches) {
  const mq = { matches, addEventListener() {}, removeEventListener() {} };
  vi.stubGlobal('matchMedia', vi.fn(() => mq));
}

const ADESSO = Date.now();
const MD = { name: '20261014-0930_2026-10-13_report.md', size: 348160, mtime: ADESSO };
const PNG = { name: '20261014-1000_foto.png', size: 2048, mtime: ADESSO - 3600_000 };
const ZIP = { name: '20261013-0900_archivio.zip', size: 999, mtime: ADESSO - 86_400_000 };

// Rete di ripiego dopo la prima lista: le selezioni del dettaglio chiedono il
// blob d'anteprima senza che ogni test debba pensarci. Il type è quello che
// il server spedirebbe davvero per un .md: la preview navigabile lo guarda.
const BLOB_TESTO = { ok: true, blob: async () => ({ text: async () => 'contenuto', type: 'text/plain' }) };

async function apri(outbox, inbox = []) {
  apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ inbox, outbox }) });
  apiFetch.mockResolvedValue(BLOB_TESTO);
  const view = render(<FilesPanel session="cloud-Dev" token="t" onClose={() => {}} />);
  await screen.findAllByRole('row');
  return view;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  apiFetch.mockReset();
  matchMediaFisso(true);
  // jsdom non ha gli object URL: stub neutrali per ogni anteprima immagine.
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('FilesPanel desktop — intestazione e barra', () => {
  it('titolo «Files of <cella>», percorso mono, caricamento, chiusura, classe desktop', async () => {
    const { container } = await apri([MD]);
    expect(screen.getByText('Files of cloud-Dev')).toBeTruthy();
    expect(screen.getByText('~/NexusFiles/cloud-Dev/outbox')).toBeTruthy();
    expect(screen.getByText('Upload file')).toBeTruthy();
    expect(screen.getByLabelText('close')).toBeTruthy();
    expect(container.querySelector('.nc-files').className).toBe('nc-files nc-files-d');
  });

  it('segmenti col conteggio, uno acceso; Inbox cambia percorso e righe', async () => {
    const { container } = await apri([MD], [{ name: 'b.txt', size: 2, mtime: ADESSO }]);
    const seg = container.querySelector('.nc-filesd-seg');
    const stato = () => [...seg.querySelectorAll('button')].map((b) => `${b.textContent}:${b.className}`);
    expect(stato()).toEqual(['Outbox · 1:on', 'Inbox · 1:']);
    fireEvent.click(seg.querySelectorAll('button')[1]);
    expect(stato()).toEqual(['Outbox · 1:', 'Inbox · 1:on']);
    expect(screen.getByText('~/NexusFiles/cloud-Dev/inbox')).toBeTruthy();
    expect(screen.getByText('b.txt')).toBeTruthy();
    expect(screen.queryByText('report.md')).toBeNull();
  });
});

describe('FilesPanel desktop — lista a griglia', () => {
  it('riga: nome senza prefissi (mai l\'originale in lista), ora, dimensione, badge-tipo', async () => {
    const { container } = await apri([MD]);
    expect(screen.getByText('report.md')).toBeTruthy();
    expect(screen.queryByText(MD.name)).toBeNull();
    expect(container.querySelectorAll('.nc-filesd-row .nc-files-type')[0].textContent).toBe('MD');
    expect(container.querySelector('.nc-filesd-quando').textContent).toMatch(/^\d{2}:\d{2}$/);
    expect(screen.getByText('340 KB')).toBeTruthy();
  });

  it('gruppi per giorno: oggi etichettato, giorni vecchi in coda, recenti prima', async () => {
    const { container } = await apri([ZIP, PNG, MD]);
    const giorni = [...container.querySelectorAll('.nc-filesd-day')].map((h) => h.textContent);
    expect(giorni[0].startsWith('Today · ')).toBe(true);
    expect(giorni).toHaveLength(2);
    // l'ordine segue il momento d'arrivo DAL NOME (lo stamp vince sull'mtime):
    // foto (10:00) prima di report (09:30), ieri in coda
    const nomi = [...container.querySelectorAll('.nc-filesd-name')].map((n) => n.textContent);
    expect(nomi).toEqual(['foto.png', 'report.md', 'archivio.zip']);
  });

  it('il nome in lista non è interattivo: il click sulla riga seleziona, il nome non comanda nulla', async () => {
    await apri([MD]);
    const nome = screen.getByText('report.md');
    expect(nome.tagName).toBe('SPAN');
    expect(nome.tabIndex).toBe(-1);
    expect(apiFetch).toHaveBeenCalledTimes(1); // solo la GET iniziale
  });
});

describe('FilesPanel desktop — filtri a pillola', () => {
  it('Tutti/Documenti/Immagini filtrano l\'elenco e il piè di pagina segue', async () => {
    await apri([MD, PNG, ZIP]);
    expect(screen.getAllByRole('row')).toHaveLength(3);
    expect(screen.getByText(/^3 files · /)).toBeTruthy();

    fireEvent.click(screen.getByText('Images'));
    expect(screen.getAllByRole('row')).toHaveLength(1);
    expect(screen.getByText('foto.png')).toBeTruthy();
    // il plurale della stringa i18n è fisso come nel resto dell'app
    expect(screen.getByText(/^1 files · 2 KB$/)).toBeTruthy();

    fireEvent.click(screen.getByText('Documents'));
    expect(screen.getByText('report.md')).toBeTruthy();
    expect(screen.queryByText('foto.png')).toBeNull();

    fireEvent.click(screen.getByText('All'));
    expect(screen.getAllByRole('row')).toHaveLength(3);
  });

  it('filtro senza corrispondenze: messaggio esplicito con l\'etichetta della pillola', async () => {
    await apri([MD]);
    fireEvent.click(screen.getByText('Images'));
    expect(screen.getByText('no file matches "Images"')).toBeTruthy();
    expect(screen.queryByRole('row')).toBeNull();
  });
});

describe('FilesPanel desktop — scorciatoie da tastiera', () => {
  it('«/» porta il focus nella ricerca', async () => {
    await apri([MD]);
    expect(document.activeElement).not.toBe(screen.getByTestId('files-search-input'));
    fireEvent.keyDown(document, { key: '/' });
    expect(document.activeElement).toBe(screen.getByTestId('files-search-input'));
  });

  it('↑↓ muovono la selezione riga per riga, la riga selezionata è marcata', async () => {
    const { container } = await apri([MD, PNG]);
    expect(container.querySelector('.nc-filesd-row.sel')).toBeNull();
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    let sel = container.querySelector('.nc-filesd-row.sel');
    expect(sel).toBeTruthy();
    expect(sel.getAttribute('aria-selected')).toBe('true');
    // prima riga visibile = la più recente (lo stamp del nome): foto 10:00
    expect(within(sel).getByText('foto.png')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'ArrowDown' });
    sel = container.querySelector('.nc-filesd-row.sel');
    expect(within(sel).getByText('report.md')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'ArrowUp' });
    sel = container.querySelector('.nc-filesd-row.sel');
    expect(within(sel).getByText('foto.png')).toBeTruthy();
  });

  it('Invio apre il foglio azioni del file selezionato; Escape lo chiude', async () => {
    await apri([MD]);
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'Enter' });
    const foglio = await screen.findByTestId('file-actions-sheet');
    expect(foglio.querySelector('.nc-filesheet-mono').textContent).toBe(MD.name);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('file-actions-sheet')).toBeNull();
  });

  it('i tasti dentro la ricerca appartengono alla ricerca: nessuna selezione', async () => {
    await apri([MD]);
    const input = screen.getByTestId('files-search-input');
    input.focus();
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(document.querySelector('.nc-filesd-row.sel')).toBeNull();
    expect(screen.queryByTestId('file-actions-sheet')).toBeNull();
  });

  it('Invio senza selezione non fa nulla', async () => {
    await apri([MD]);
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(screen.queryByTestId('file-actions-sheet')).toBeNull();
  });
});

describe('FilesPanel desktop — pannello dettaglio', () => {
  function dettaglio(container) { return container.querySelector('.nc-filesd-detail'); }

  it('senza selezione: segnaposto; al click sulla riga: nome, ORIGINALE in mono e meta', async () => {
    const { container } = await apri([MD]);
    expect(within(dettaglio(container)).getByText('Select a file to see its details.')).toBeTruthy();
    fireEvent.click(screen.getByText('report.md'));
    const d = dettaglio(container);
    expect(within(d).getByText('report.md')).toBeTruthy();
    expect(within(d).getByText(MD.name)).toBeTruthy();
    const dd = [...d.querySelectorAll('dd')].map((x) => x.textContent);
    expect(dd[0]).toMatch(/2026/);
    expect(dd[1]).toBe('340 KB');
    expect(dd[2]).toBe('Outbox · cloud-Dev');
    expect(dd[3]).toBe('MD');
  });

  it('anteprima testo dei tipi testuali: il contenuto del blob in un <pre>', async () => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ inbox: [], outbox: [MD] }) });
    apiFetch.mockResolvedValue({ ok: true, blob: async () => ({ text: async () => '# Titolo\n corpo' }) });
    const { container } = render(<FilesPanel session="cloud-Dev" token="t" onClose={() => {}} />);
    await screen.findAllByRole('row');
    fireEvent.click(screen.getByText('report.md'));
    const pre = await screen.findByTestId('files-detail-text');
    expect(pre.textContent).toBe('# Titolo\n corpo');
    expect(String(apiFetch.mock.calls[1][0])).toContain(`name=${encodeURIComponent(MD.name)}`);
  });

  it('miniatura delle immagini: object URL della route, alt col nome visualizzato', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:img');
    URL.revokeObjectURL = vi.fn();
    const { container } = await apri([PNG]);
    fireEvent.click(screen.getByText('foto.png'));
    const img = await screen.findByTestId('files-detail-img');
    expect(img.getAttribute('src')).toBe('blob:img');
    expect(img.getAttribute('alt')).toBe('foto.png');
  });

  it('tipi non anteprimabili: né <pre> né miniatura, né tasto Apri', async () => {
    const { container } = await apri([ZIP]);
    fireEvent.click(screen.getByText('archivio.zip'));
    await waitFor(() => expect(within(dettaglio(container)).getByText('archivio.zip')).toBeTruthy());
    expect(screen.queryByTestId('files-detail-text')).toBeNull();
    expect(screen.queryByTestId('files-detail-img')).toBeNull();
    expect(within(dettaglio(container)).queryByText('Open')).toBeNull();
  });

  it('«Apri» apre il blob del nome ORIGINALE in una nuova scheda', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:img');
    URL.revokeObjectURL = vi.fn();
    // noopener: il ritorno reale è null anche quando la scheda si apre
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { container } = await apri([PNG]);
    fireEvent.click(screen.getByText('foto.png'));
    fireEvent.click(await within(dettaglio(container)).findByText('Open'));
    // lista + anteprima selezione + Apri: la chiamata d'azione è la terza
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
    expect(String(apiFetch.mock.calls[2][0])).toContain('name=20261014-1000_foto.png');
    expect(open).toHaveBeenCalledWith('blob:img', '_blank', 'noopener');
    open.mockRestore();
  });

  it('«Download» primario scarica col nome ORIGINALE', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { container } = await apri([MD]);
    fireEvent.click(screen.getByText('report.md'));
    fireEvent.click(await within(dettaglio(container)).findByText('Download'));
    // lista + anteprima selezione + scarico: la chiamata d'azione è la terza
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
    expect(String(apiFetch.mock.calls[2][0])).toContain(`name=${encodeURIComponent(MD.name)}`);
    click.mockRestore();
  });

  it('«Copy full name» copia il nome ORIGINALE e lo dice', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const { container } = await apri([MD]);
    fireEvent.click(screen.getByText('report.md'));
    fireEvent.click(await within(dettaglio(container)).findByText('Copy full name'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(MD.name));
    expect(await within(dettaglio(container)).findByText('full name copied')).toBeTruthy();
  });
});

describe('FilesPanel desktop — eliminazione dal dettaglio', () => {
  function dettaglio(container) { return container.querySelector('.nc-filesd-detail'); }

  it('conferma inline: annullare non spedisce, confermare elimina il nome ORIGINALE e rinfresca', async () => {
    const { container } = await apri([MD]);
    fireEvent.click(screen.getByText('report.md'));
    fireEvent.click(await within(dettaglio(container)).findByText('Delete…'));
    const conferma = await screen.findByTestId('files-detail-confirm');
    expect(within(conferma).getByText('Delete "report.md"?')).toBeTruthy();
    fireEvent.click(within(conferma).getByRole('button', { name: 'cancel' }));
    expect(screen.queryByTestId('files-detail-confirm')).toBeNull();
    expect(apiFetch).toHaveBeenCalledTimes(2); // lista + blob anteprima

    fireEvent.click(await within(dettaglio(container)).findByText('Delete…'));
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) }); // DELETE
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ inbox: [], outbox: [] }) }); // refresh
    fireEvent.click(await within(screen.getByTestId('files-detail-confirm')).getByRole('button', { name: 'delete' }));
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(4));
    const [url, token, opts] = apiFetch.mock.calls[2];
    expect(String(url)).toContain('/files');
    expect(String(url)).toContain('box=outbox');
    expect(String(url)).toContain(`name=${encodeURIComponent(MD.name)}`);
    expect(token).toBe('t');
    expect(opts).toEqual({ method: 'DELETE' });
    // il file eliminato non c'è più: la selezione cade, il dettaglio torna segnaposto
    await waitFor(() => expect(within(dettaglio(container)).getByText('Select a file to see its details.')).toBeTruthy());
    expect(document.querySelectorAll('.nc-filesd-row')).toHaveLength(0);
  });

  it('delete fallito: la causa del server si vede, la conferma resta aperta (R27 #7)', async () => {
    const { container } = await apri([MD]);
    fireEvent.click(screen.getByText('report.md'));
    fireEvent.click(await within(dettaglio(container)).findByText('Delete…'));
    apiFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: 'box non trovata' }) });
    fireEvent.click(await within(screen.getByTestId('files-detail-confirm')).getByRole('button', { name: 'delete' }));
    expect(await screen.findByText('errore: box non trovata')).toBeTruthy();
    expect(screen.getByTestId('files-detail-confirm')).toBeTruthy();
    // GET lista + blob anteprima + DELETE fallito: NESSUN refresh dopo il fallimento
    expect(apiFetch).toHaveBeenCalledTimes(3);
  });
});

describe('FilesPanel desktop — caricamento file', () => {
  it('«Upload file» posta sulla route esistente e rinfresca; il file entra in Inbox', async () => {
    const { container } = await apri([MD]);
    const input = container.querySelector('input.nc-filesd-upload-input');
    const file = new File(['contenuto'], 'nota.txt', { type: 'text/plain' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ path: '/upload/nota.txt' }) }); // POST
    apiFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ inbox: [{ name: '20261014-1111_nota.txt', size: 10, mtime: Date.now() }], outbox: [MD] }),
    }); // refresh
    fireEvent.change(input);
    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(3));
    const [url, , opts] = apiFetch.mock.calls[1];
    expect(String(url)).toContain('/files/upload');
    expect(opts.method).toBe('POST');
    expect(opts.body).toBeInstanceOf(FormData);
    fireEvent.click(container.querySelector('.nc-filesd-seg button:nth-child(2)'));
    expect(await screen.findByText('nota.txt')).toBeTruthy();
  });

  it('caricamento fallito: la causa finisce nel canale busy', async () => {
    const { container } = await apri([MD]);
    const input = container.querySelector('input.nc-filesd-upload-input');
    Object.defineProperty(input, 'files', { value: [new File(['x'], 'a.txt')], configurable: true });
    apiFetch.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({ error: 'sessione andata' }) });
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ inbox: [], outbox: [MD] }) });
    fireEvent.change(input);
    expect(await screen.findByText('upload error: sessione andata')).toBeTruthy();
  });
});

describe('FilesPanel desktop — piè di pagina', () => {
  it('numero file e dimensione totale dell\'elenco filtrato, con le scorciatoie accanto', async () => {
    const { container } = await apri([MD, PNG, ZIP]);
    expect(screen.getByText(/^3 files · 34\d KB$/)).toBeTruthy();
    const tasti = container.querySelector('.nc-filesd-tasti');
    expect([...tasti.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['↑↓', 'Enter', '/']);
    expect(tasti.getAttribute('title')).toContain('Enter');
  });
});

describe('FilesPanel desktop — parità mobile', () => {
  it('senza criterio desktop (matchMedia falso) resta la vista mobile, senza dettaglio né caricamento', async () => {
    matchMediaFisso(false);
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ inbox: [], outbox: [MD] }) });
    const { container } = render(<FilesPanel session="cloud-Dev" token="t" onClose={() => {}} />);
    await screen.findByText('report.md');
    expect(container.querySelector('.nc-files').className).toBe('nc-files');
    expect(container.querySelector('.nc-filesd-detail')).toBeNull();
    expect(screen.queryByText('Upload file')).toBeNull();
    expect(screen.queryByTestId('files-search-input')).toBeNull();
  });
});

describe('FilesPanel desktop — «Apri» sicuro (SVG, MIME del blob, revoca)', () => {
  const SVG = { name: '20261014-1030_logo.svg', size: 512, mtime: ADESSO - 1800_000 };
  const SVG_CON_SCRIPT = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>';

  function dettaglio(container) { return container.querySelector('.nc-filesd-detail'); }

  it('SVG: miniatura <img> nel dettaglio, ma NESSUN tasto Open che lo navighi', async () => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ inbox: [], outbox: [SVG] }) });
    apiFetch.mockResolvedValue({ ok: true, blob: async () => new Blob([SVG_CON_SCRIPT], { type: 'image/svg+xml' }) });
    const { container } = render(<FilesPanel session="cloud-Dev" token="t" onClose={() => {}} />);
    await screen.findAllByRole('row');
    fireEvent.click(screen.getByText('logo.svg'));
    // l'anteprima inline è un <img>: l'SVG non è mai un documento attivo
    const img = await screen.findByTestId('files-detail-img');
    expect(img.tagName).toBe('IMG');
    expect(within(dettaglio(container)).queryByText('Open')).toBeNull();
    expect(within(dettaglio(container)).getByText('Download')).toBeTruthy();
  });

  it('blob SVG arrivato sotto nome .png: «Apri» non naviga, avvisa e non crea object URL', async () => {
    const { container } = await apri([PNG]);
    fireEvent.click(screen.getByText('foto.png'));
    await within(dettaglio(container)).findByText('Open');
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    // la miniatura <img> inline crea già il suo object URL: quello è legittimo,
    // ciò che non deve accadere è che ne crei un ALTRO il click su «Apri»
    const createPrima = URL.createObjectURL.mock.calls.length;
    apiFetch.mockReset();
    apiFetch.mockResolvedValueOnce({ ok: true, blob: async () => new Blob([SVG_CON_SCRIPT], { type: 'image/svg+xml' }) });
    fireEvent.click(within(dettaglio(container)).getByText('Open'));
    expect(await screen.findByText('preview unavailable for this type: download it')).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
    expect(URL.createObjectURL.mock.calls.length).toBe(createPrima);
    open.mockRestore();
  });

  it('«Apri» revoca l\'object URL dopo un ritardo prudente, non prima', async () => {
    // noopener: il ritorno reale è null anche quando la scheda si apre
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    let n = 0;
    URL.createObjectURL = vi.fn(() => `blob:open-${++n}`);
    URL.revokeObjectURL = vi.fn();
    const { container } = await apri([PNG]);
    fireEvent.click(screen.getByText('foto.png'));
    await within(dettaglio(container)).findByText('Open');
    apiFetch.mockResolvedValueOnce({ ok: true, blob: async () => new Blob(['x'], { type: 'image/png' }) });
    vi.useFakeTimers();
    try {
      fireEvent.click(within(dettaglio(container)).getByText('Open'));
      await act(async () => {});
      expect(open).toHaveBeenCalledWith('blob:open-2', '_blank', 'noopener');
      expect(URL.revokeObjectURL).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(60_000); });
      expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:open-2');
    } finally {
      vi.useRealTimers();
      open.mockRestore();
    }
  });
});
