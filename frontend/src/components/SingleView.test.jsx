import React from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const fixture = vi.hoisted(() => ({ sessions: [], cells: [] }));

vi.mock('../lib/api.js', () => ({
  apiFetch: vi.fn(async () => ({ json: async () => ({ sessions: fixture.sessions }) })),
  fleetStatus: vi.fn(async () => ({ available: true, cells: fixture.cells })),
  fleetUp: vi.fn(), fleetDown: vi.fn(), killSession: vi.fn(),
  getSettings: vi.fn(), nodeAction: vi.fn(), setSessionTechnical: vi.fn(),
}));
// Stub di tutti i componenti figli: SingleView resta isolata (nessuna rete).
vi.mock('./Terminal.jsx', () => ({ default: () => <div data-testid="term" /> }));
vi.mock('./KeyBar.jsx', () => ({ default: () => null }));
vi.mock('./ComposerBar.jsx', () => ({ default: () => null }));
vi.mock('./FilesPanel.jsx', () => ({ default: () => null }));
vi.mock('./Icon.jsx', () => ({ default: () => null }));
vi.mock('./SessionList.jsx', () => ({ default: () => null }));
vi.mock('./Sidebar.jsx', () => ({ default: () => null }));
vi.mock('./GridView.jsx', () => ({ default: () => null }));
vi.mock('./PowerSheet.jsx', () => ({ default: () => null }));
vi.mock('./DeckBar.jsx', () => ({ default: () => null }));
vi.mock('./SettingsPanel.jsx', () => ({ default: () => null }));
vi.mock('./Wizard.jsx', () => ({ default: () => null }));
vi.mock('./NotifyCenter.jsx', () => ({ default: () => null }));
vi.mock('./CellPanel.jsx', () => ({
  // Contratto D8 nuovo: SingleView consegna le COORDINATE per il ticket di
  // visione (cellId, panelUrl, route del nodo, token) — è CellPanel che chiede
  // il ticket e punta l'iframe alla NOSTRA route, mai al panelUrl grezzo.
  default: ({ cellId, panelUrl, route, token, title }) => (
    <div data-testid="cellpanel" data-cell={cellId} data-panelurl={panelUrl}
      data-route={(route || []).join('/')} data-token={token} data-title={title} />
  ),
}));
vi.mock('../lib/i18n.js', () => ({ t: (k) => k }));
vi.mock('../hooks/useLang.js', () => ({ useLang: () => ['en', vi.fn()] }));

import { SingleView } from '../App.jsx';

// jsdom non implementa matchMedia: polyfill minimale (SingleView lo consulta
// nello stato iniziale del composer su touch).
beforeAll(() => {
  if (!window.matchMedia) {
    window.matchMedia = (q) => ({
      matches: false, media: q, onchange: null,
      addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent: () => false,
    });
  }
});

beforeEach(() => {
  fixture.sessions = [{ name: 'cloud-Dev', activity: 0, attached: false, windows: 1 }];
  fixture.cells = [{ cell: 'Dev', tmuxSession: 'cloud-Dev', engine: 'claude.native', key: 'A' }];
});

describe('SingleView title (Tranche D)', () => {
  it('shows the logical Fleet name for a managed cell, never node:session', async () => {
    // cell=Dev, tmuxSession=cloud-Dev -> titolo visibile esatto "Dev".
    render(<SingleView session="cloud-Dev" token="t" onBack={vi.fn()} />);
    await waitFor(() => { expect(screen.getByText('Dev')).toBeTruthy(); });
    expect(screen.queryByText('cloud-Dev')).toBeNull();
    expect(screen.queryByText('workstation:cloud-Dev')).toBeNull();
  });

  it('renders the cellName prop synchronously when provided (desktop overlay reopening)', async () => {
    render(<SingleView session="cloud-Dev" cellName="Dev" token="t" onBack={vi.fn()} />);
    expect(screen.getByText('Dev')).toBeTruthy();
    expect(screen.queryByText('cloud-Dev')).toBeNull();
    // lascia settlare il primo ciclo di load (evita update fuori act).
    await screen.findByText('claude.native·A');
  });

  it('synchronizes the visible title immediately when the opened cell changes', async () => {
    const view = render(<SingleView session="cloud-Dev" cellName="Dev" token="t" onBack={vi.fn()} />);
    expect(screen.getByText('Dev')).toBeTruthy();
    fixture.sessions = [{ name: 'cloud-Trading', activity: 0, attached: false, windows: 1 }];
    fixture.cells = [{ cell: 'Trading', tmuxSession: 'cloud-Trading', engine: 'claude.native', key: 'A' }];
    await act(async () => {
      view.rerender(<SingleView session="cloud-Trading" cellName="Trading" token="t" onBack={vi.fn()} />);
    });
    await waitFor(() => expect(screen.getByText('Trading')).toBeTruthy());
    expect(screen.queryByText('Dev')).toBeNull();
    expect(screen.queryByText('cloud-Trading')).toBeNull();
  });

  it('keeps a short engine·key subtitle for a managed cell', async () => {
    render(<SingleView session="cloud-Dev" token="t" onBack={vi.fn()} />);
    await waitFor(() => { expect(screen.getByText('claude.native·A')).toBeTruthy(); });
  });

  it('falls back to the session name for an unmanaged session', async () => {
    fixture.cells = [];
    fixture.sessions = [{ name: 'scratch-pad', activity: 0, attached: false, windows: 1 }];
    render(<SingleView session="scratch-pad" token="t" onBack={vi.fn()} />);
    await waitFor(() => { expect(screen.getByText('scratch-pad')).toBeTruthy(); });
    expect(screen.queryByText('Dev')).toBeNull();
  });

  it('does not concatenate route or tmuxSession into the visible title for a remote cell', async () => {
    // route workstation, tmuxSession cloud-Dev: il titolo visibile e' "Dev".
    render(<SingleView session="cloud-Dev" node="workstation" cellName="Dev" token="t" onBack={vi.fn()} />);
    expect(screen.getByText('Dev')).toBeTruthy();
    expect(screen.queryByText('workstation:cloud-Dev')).toBeNull();
    expect(screen.queryByText('cloud-Dev')).toBeNull();
    // identificativo tecnico solo nel tooltip di supporto, mai nel testo visibile.
    const b = screen.getByText('Dev');
    expect(b.getAttribute('title')).toContain('workstation');
    expect(b.textContent).toBe('Dev');
    await screen.findByText('claude.native·A');
  });

  it('header title sits in the truncation structure (no mobile overflow regression)', async () => {
    // La CSS rule `.nc-bar-single .nc-bar-center b` applica text-overflow:ellipsis:
    // verifichiamo che il titolo viva in quella struttura (Gate D, overflow mobile).
    render(<SingleView session="cloud-Dev" cellName="Dev" token="t" onBack={vi.fn()} />);
    const b = screen.getByText('Dev');
    expect(b.tagName).toBe('B');
    expect(b.closest('.nc-bar-center')).toBeTruthy();
    expect(b.closest('.nc-bar-single')).toBeTruthy();
    await screen.findByText('claude.native·A');
  });
});

describe('SingleView — pannello per-cella (D8, panelUrl)', () => {
  it('opt-in totale: cella senza panelUrl → nessun bottone, nessun pannello', async () => {
    // fixture.cells (beforeEach) non ha panelUrl.
    render(<SingleView session="cloud-Dev" token="t" onBack={vi.fn()} />);
    await screen.findByText('claude.native·A'); // fleetStatus già consumato
    expect(screen.queryByTitle('panel')).toBeNull();
    expect(screen.queryByTestId('cellpanel')).toBeNull();
  });

  it('opt-in totale: panelUrl stringa vuota → nessuna traccia', async () => {
    fixture.cells = [{ cell: 'Dev', tmuxSession: 'cloud-Dev', engine: 'claude.native', key: 'A', panelUrl: '' }];
    render(<SingleView session="cloud-Dev" token="t" onBack={vi.fn()} />);
    await screen.findByText('claude.native·A');
    expect(screen.queryByTitle('panel')).toBeNull();
    expect(screen.queryByTestId('cellpanel')).toBeNull();
  });

  it('cella con panelUrl: pannello chiuso finché non aperto, poi coordinate esatte per il ticket (LOCALE)', async () => {
    fixture.cells = [{ cell: 'Dev', tmuxSession: 'cloud-Dev', engine: 'claude.native', key: 'A', panelUrl: 'https://127.0.0.1:6901' }];
    render(<SingleView session="cloud-Dev" token="t" onBack={vi.fn()} />);
    const btn = await screen.findByTitle('panel');
    // Chiuso prima del click: nessun pannello (comportamento terminale intatto).
    expect(screen.queryByTestId('cellpanel')).toBeNull();
    fireEvent.click(btn);
    const panel = screen.getByTestId('cellpanel');
    // Il pannello riceve le coordinate per chiedere il ticket: cellId, panelUrl
    // (da cui il percorso della pagina), la via (vuota = locale) e il token.
    // L'URL grezzo NON è più ciò che finisce nell'iframe: è un ingresso della
    // richiesta, e il test fissa QUESTO contratto.
    expect(panel.getAttribute('data-cell')).toBe('Dev');
    expect(panel.getAttribute('data-panelurl')).toBe('https://127.0.0.1:6901');
    expect(panel.getAttribute('data-route')).toBe('');
    expect(panel.getAttribute('data-token')).toBe('t');
    // Il bottone dichiara lo stato (aria-pressed) e il pannello si chiude di nuovo.
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(btn);
    expect(screen.queryByTestId('cellpanel')).toBeNull();
  });

  it('cella REMOTA: le coordinate portano la via federata del nodo che la possiede', async () => {
    fixture.cells = [{ cell: 'Dev', tmuxSession: 'cloud-Dev', engine: 'claude.native', key: 'A', panelUrl: 'https://127.0.0.1:6901' }];
    render(<SingleView session="cloud-Dev" node="Pixel" token="t" onBack={vi.fn()} />);
    fireEvent.click(await screen.findByTitle('panel'));
    const panel = screen.getByTestId('cellpanel');
    expect(panel.getAttribute('data-route')).toBe('Pixel', 'il ticket e l\'iframe passano da /api/route/Pixel/_');
  });

  it('cambio sessione resetta il pannello (nessun leakage fra celle)', async () => {
    const { rerender } = render(<SingleView session="cloud-Dev" token="t" onBack={vi.fn()} />);
    fixture.cells = [{ cell: 'Dev', tmuxSession: 'cloud-Dev', engine: 'claude.native', key: 'A', panelUrl: 'https://127.0.0.1:6901' }];
    await screen.findByTitle('panel');
    fireEvent.click(screen.getByTitle('panel'));
    expect(screen.getByTestId('cellpanel')).toBeTruthy();
    // Switch di cella nella stessa posizione React: il pannello si richiude.
    rerender(<SingleView session="cloud-Fork" token="t" onBack={vi.fn()} />);
    expect(screen.queryByTestId('cellpanel')).toBeNull();
  });
});
