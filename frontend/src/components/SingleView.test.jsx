import React from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';

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
