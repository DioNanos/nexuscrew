import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// L'i18n è mockato con le traduzioni italiane REALI delle cause nuove: il test
// verifica che il messaggio dica la causa GIUSTA (nonGranted dice «concedere
// sul nodo», denied dice «biglietto»), non solo che la chiave esista.
vi.mock('../lib/i18n.js', () => ({
  t: (k) => ({
    'panel-not-granted': 'Questo nodo non concede il pannello a chi lo chiede: l\'accesso va concesso sul nodo che possiede la cella, non riprovando qui.',
    'panel-denied': 'Ingresso al pannello rifiutato: il biglietto non è più valido. Riprova: verrà chiesto un biglietto nuovo.',
  }[k] || k),
}));

// Il ticket arriva da requestPanelTicket: qui si mocka SOLO il trasporto —
// i casi danno gli esiti classificati che il vero modulo produce.
vi.mock('../lib/api.js', () => ({
  requestPanelTicket: vi.fn(),
  routeBase: (route) => Array.isArray(route) && route.length
    ? `/api/route/${route.map(encodeURIComponent).join('/')}/_` : '',
}));

import CellPanel from './CellPanel.jsx';
import { requestPanelTicket } from '../lib/api.js';

const ticketOk = (ticket = 'TK-1234567890') => requestPanelTicket.mockResolvedValue({ ok: true, ticket });

describe('CellPanel (D8: ingresso al pannello via ticket)', () => {
  beforeEach(() => { requestPanelTicket.mockReset(); });
  afterEach(() => { vi.clearAllMocks(); });

  it('senza cella o senza token: stato reso (panel-none), nessun iframe, nessuna richiesta', () => {
    const { container } = render(<CellPanel cellId="" panelUrl="https://127.0.0.1:6901/vnc.html" route={[]} token="t" title="A" />);
    expect(screen.getByRole('status').textContent).toContain('panel-none');
    expect(container.querySelector('iframe')).toBeNull();
    expect(requestPanelTicket).not.toHaveBeenCalled();
  });

  it('flusso locale: ticket ok → iframe alla NOSTRA route con la pagina del panelUrl, mai al panelUrl grezzo', async () => {
    ticketOk();
    const { container } = render(
      <CellPanel cellId="A" panelUrl="https://127.0.0.1:6901/vnc.html" route={[]} token="t" title="A" />,
    );
    await waitFor(() => { expect(container.querySelector('iframe')).toBeTruthy(); });
    const src = container.querySelector('iframe').getAttribute('src');
    expect(src.startsWith('/panel/A/vnc.html?ticket=TK-1234567890')).toBe(true);
    expect(src.includes('127.0.0.1:6901')).toBe(false, 'il loopback del container non compare mai nell\'iframe');
    expect(requestPanelTicket).toHaveBeenCalledWith('t', [], 'A', expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('flusso REMOTO: il ticket e l\'iframe passano dalla via federata del nodo', async () => {
    ticketOk('TK-REMOTE');
    const { container } = render(
      <CellPanel cellId="A" panelUrl="https://127.0.0.1:6901/" route={['Pixel']} token="t" title="A" />,
    );
    await waitFor(() => { expect(container.querySelector('iframe')).toBeTruthy(); });
    expect(requestPanelTicket).toHaveBeenCalledWith('t', ['Pixel'], 'A', expect.anything());
    const src = container.querySelector('iframe').getAttribute('src');
    expect(src.startsWith('/api/route/Pixel/_/panel/A/?ticket=TK-REMOTE')).toBe(true);
  });

  it('not-granted: causa NOMINATA con la sua azione (concedere sul nodo), non collassata', async () => {
    requestPanelTicket.mockResolvedValue({ ok: false, cause: 'not-granted' });
    const { container } = render(
      <CellPanel cellId="A" panelUrl="https://127.0.0.1:6901/" route={[]} token="t" title="A" />,
    );
    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('non concede il pannello'); });
    expect(screen.getByRole('status').textContent).toContain('nodo che possiede la cella');
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('denied (biglietto rifiutato): messaggio proprio, e Riprova chiede un biglietto NUOVO', async () => {
    requestPanelTicket.mockResolvedValueOnce({ ok: false, cause: 'denied' });
    const { container } = render(
      <CellPanel cellId="A" panelUrl="https://127.0.0.1:6901/" route={[]} token="t" title="A" />,
    );
    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('biglietto non è più valido'); });
    requestPanelTicket.mockResolvedValueOnce({ ok: true, ticket: 'TK-NUOVO' });
    fireEvent.click(screen.getByTitle('panel-retry'));
    await waitFor(() => { expect(container.querySelector('iframe')).toBeTruthy(); });
    expect(container.querySelector('iframe').getAttribute('src')).toContain('ticket=TK-NUOVO');
    expect(requestPanelTicket).toHaveBeenCalledTimes(2);
  });

  it('unauthorized e no-panel: cause distinte dal backend, rese con lo stato giusto', async () => {
    requestPanelTicket.mockResolvedValueOnce({ ok: false, cause: 'unauthorized' });
    const { container, rerender } = render(
      <CellPanel cellId="A" panelUrl="https://127.0.0.1:6901/" route={[]} token="t" title="A" />,
    );
    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('biglietto non è più valido'); });
    requestPanelTicket.mockResolvedValueOnce({ ok: false, cause: 'no-panel' });
    rerender(<CellPanel cellId="A" panelUrl="https://127.0.0.1:6901/" route={[]} token="t" title="A" />);
    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('panel-none'); });
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('timeout deterministico: il nostro timer chiude la partita, stato panel-timeout NON unreachable', async () => {
    requestPanelTicket.mockImplementation((_t, _route, _cell, { signal }) => new Promise((_res, rej) => {
      signal.addEventListener('abort', () => rej(new DOMException('The operation was aborted.', 'AbortError')));
    }));
    render(<CellPanel cellId="A" panelUrl="https://127.0.0.1:6901/" route={[]} token="t" title="A" requestTimeoutMs={30} />);
    await waitFor(() => {
      expect(screen.getByRole('status').textContent).toContain('panel-timeout');
    }, { timeout: 2000 });
    expect(screen.getByRole('status').textContent).not.toContain('unreachable');
    expect(screen.queryByTitle('panel-open')).toBeNull();
  });

  it('rete che cade: panel-unreachable (verso la NOSTRA origine) con Riprova', async () => {
    requestPanelTicket.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<CellPanel cellId="A" panelUrl="https://127.0.0.1:6901/" route={[]} token="t" title="A" />);
    await waitFor(() => { expect(screen.getByRole('status').textContent).toContain('panel-unreachable'); });
    expect(screen.getByTitle('panel-retry')).toBeTruthy();
  });
});
