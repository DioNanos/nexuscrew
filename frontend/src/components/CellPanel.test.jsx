import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// L'i18n è mockato con la traduzione italiana REALE di 'panel-unreachable':
// il test verifica che il messaggio dichiari il limite (entrambe le cause),
// non solo che la chiave esista. Le altre chiavi passano attraverso.
vi.mock('../lib/i18n.js', () => ({
  t: (k) => (k === 'panel-unreachable'
    ? 'Pannello non raggiungibile: servizio fermo oppure certificato non ancora accettato. Apri l\'URL in una scheda: se è il certificato, accettalo lì, poi torna qui.'
    : k),
}));

import CellPanel from './CellPanel.jsx';

describe('CellPanel (D8: pannello per-cella da panelUrl)', () => {
  let openSpy;

  beforeEach(() => {
    openSpy = vi.fn();
    vi.stubGlobal('open', openSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stato 1 — url assente o vuota: lo stato è reso, nessun iframe', () => {
    const { container } = render(<CellPanel url="" title="Dev" />);
    // Lo stato è reso (role=status), non un silenzio.
    expect(screen.getByRole('status').textContent).toContain('panel-none');
    // Nessun iframe in nessuna forma.
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('stato 1 (variante) — url undefined: stessa resa esplicita', () => {
    const { container } = render(<CellPanel title="Dev" />);
    expect(screen.getByRole('status').textContent).toContain('panel-none');
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('probe OK — iframe presente con l\'URL esatto della cella', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({})));
    const { container } = render(<CellPanel url="https://127.0.0.1:6901" title="Dev" />);
    await waitFor(() => {
      const frame = container.querySelector('iframe');
      expect(frame).toBeTruthy();
      expect(frame.getAttribute('src')).toBe('https://127.0.0.1:6901');
    });
  });

  it('stati 2/3 — probe fallita: rende il limite (entrambe le cause) e l\'azione scheda', async () => {
    // Certificato self-signed rifiutato e servizio fermo producono lo stesso
    // esito osservabile (fetch no-cors -> TypeError): il pannello NON indovina,
    // dichiara entrambe le cause (limite scritto) e offre l'azione.
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    render(<CellPanel url="https://127.0.0.1:6901" title="Dev" />);
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('Pannello non raggiungibile');
    // Il messaggio dichiara il limite: entrambe le cause nominate.
    expect(status.textContent).toContain('certificato');
    expect(status.textContent).toContain('raggiungibile');
    // Nessun iframe mentre la probe è rossa.
    expect(document.querySelector('iframe')).toBeNull();
    // Azione suggerita: aprire l'URL in una scheda (accetta il certificato).
    fireEvent.click(screen.getByTitle('panel-open'));
    expect(openSpy).toHaveBeenCalledWith('https://127.0.0.1:6901', '_blank', 'noopener,noreferrer');
  });

  it('stati 2/3 — Riprova riesegue la probe: da rossa a iframe verde', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('Failed to fetch');
      return {};
    }));
    const { container } = render(<CellPanel url="https://127.0.0.1:6901" title="Dev" />);
    await screen.findByRole('status'); // unreachable
    fireEvent.click(screen.getByTitle('panel-retry'));
    await waitFor(() => {
      expect(container.querySelector('iframe')).toBeTruthy();
    });
    expect(calls).toBe(2);
  });

  it('ritorno alla scheda (visibilitychange) dopo l\'accettazione: auto-riprova', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new TypeError('Failed to fetch');
      return {};
    }));
    const { container } = render(<CellPanel url="https://127.0.0.1:6901" title="Dev" />);
    await screen.findByRole('status'); // unreachable
    fireEvent.click(screen.getByTitle('panel-open')); // l'operatore accetta il certificato lì
    document.dispatchEvent(new Event('visibilitychange')); // e torna
    await waitFor(() => {
      expect(container.querySelector('iframe')).toBeTruthy();
    });
    expect(calls).toBe(2);
  });
});
