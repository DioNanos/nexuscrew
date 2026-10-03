import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// Il bottone Pannello della barra nasce e muore col `panelUrl` che il
// fleetStatus pubblica per la cella: la spunta OFF del desktop taglia il campo
// lato server, quindi il bottone — e la sorgente Pannello — spariscono senza un
// `if` nel frontend oltre a quello sulla presenza del campo. Qui si verifica la
// resa: niente panelUrl pubblicato = niente bottone (non un bottone spento),
// con lo stesso mock del trasporto che usano i test del selettore.
const mocks = vi.hoisted(() => ({ fleetStatus: vi.fn() }));

vi.mock('./components/Terminal.jsx', () => ({ default: () => null }));
vi.mock('./components/KeyBar.jsx', () => ({ default: () => null }));
vi.mock('./components/FilesPanel.jsx', () => ({ default: () => null }));
vi.mock('./components/ComposerBar.jsx', () => ({ default: () => null }));
vi.mock('./components/CellPanel.jsx', () => ({ default: () => null }));
vi.mock('./components/CellSwitcher.jsx', () => ({ default: () => null }));
vi.mock('./components/SessionList.jsx', () => ({ default: () => null }));
vi.mock('./components/GridView.jsx', () => ({ default: () => null }));
vi.mock('./components/Sidebar.jsx', () => ({ default: () => null }));
vi.mock('./components/SettingsPanel.jsx', () => ({ default: () => null }));
vi.mock('./components/Wizard.jsx', () => ({ default: () => null }));
vi.mock('./components/NotifyCenter.jsx', () => ({ default: () => null }));
vi.mock('./components/PowerSheet.jsx', () => ({ default: () => null }));
vi.mock('./components/DeckBar.jsx', () => ({ default: () => null }));
vi.mock('./components/VlSessionView.jsx', () => ({ default: () => null }));
vi.mock('./lib/api.js', () => ({
  apiFetch: vi.fn().mockRejectedValue(new Error('no network in test')),
  fleetStatus: mocks.fleetStatus,
  fleetUp: vi.fn(), fleetDown: vi.fn(), fleetBoot: vi.fn(),
  killSession: vi.fn(), getSettings: vi.fn(), nodeAction: vi.fn(),
  renameNodeLabel: vi.fn(), setSessionTechnical: vi.fn(),
  getLiveHost: vi.fn(), designateHostCell: vi.fn(), clearHostCell: vi.fn(),
}));

import { SingleView } from './App.jsx';
import { t } from './lib/i18n.js';

const cella = (panelUrl) => ({
  cell: 'AIDesktopCell', tmuxSession: 'cloud-AIDesktopCell',
  engine: 'claude.native', status: 'ferma', ...(panelUrl ? { panelUrl } : {}),
});

beforeEach(() => {
  if (!window.matchMedia) {
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  }
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  // Il tasto AI Desktop e' un'opzione per dispositivo SPENTA di default
  // (decisione dell'operatore sulla PR #7): qui si accende, e il caso del default la
  // lascia spenta da solo. Il tasto file (acceso di default) serve da segnale
  // che il poll ha pubblicato lo stato della cella.
  localStorage.setItem('nc_bar_panel_button', 'on');
  mocks.fleetStatus.mockImplementation(async () => ({
    available: true, cells: [cella('https://127.0.0.1:6901/vnc.html')],
  }));
});

describe('Bottone Pannello della barra (vista singola)', () => {
  it('con il pannello pubblicato il bottone c\'è, in barra', async () => {
    render(<SingleView session="cloud-AIDesktopCell" cellName="AIDesktopCell" token="t" onBack={vi.fn()} />);
    await waitFor(() => { expect(screen.getByTitle(t('bar-menu-panel'))).toBeTruthy(); });
    expect(screen.getByTitle(t('bar-menu-panel')).getAttribute('aria-label')).toBe(t('bar-menu-panel'));
  });

  it('DEFAULT: opzione mai salvata → il tasto NON c\'è, resta solo la voce del menu ⋯', async () => {
    localStorage.removeItem('nc_bar_panel_button');
    render(<SingleView session="cloud-AIDesktopCell" cellName="AIDesktopCell" token="t" onBack={vi.fn()} />);
    await waitFor(() => { expect(screen.getByTitle(t('bar-menu-files'))).toBeTruthy(); });
    expect(screen.queryByTitle(t('bar-menu-panel'))).toBeNull();
    // la voce nel menu ⋯ resta comunque (dalla barra non si toglie niente)
    expect(screen.getByTitle(t('bar-menu-open'))).toBeTruthy();
  });

  it('OFF: panelUrl tagliato dal fleetStatus → il bottone NON c\'è più', async () => {
    mocks.fleetStatus.mockImplementation(async () => ({ available: true, cells: [cella('')] }));
    render(<SingleView session="cloud-AIDesktopCell" cellName="AIDesktopCell" token="t" onBack={vi.fn()} />);
    await waitFor(() => { expect(mocks.fleetStatus).toHaveBeenCalled(); });
    // un giro di stabilizzazione: il poll interna può ancora non aver girato
    await waitFor(() => { expect(screen.getByTitle(t('bar-menu-files'))).toBeTruthy(); });
    expect(screen.queryByTitle(t('bar-menu-panel'))).toBeNull();
  });
});
