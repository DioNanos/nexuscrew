import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// Il tasto del pannello nell'intestazione della vista singola nasce e muore
// col `panelUrl` che il fleetStatus pubblica per la cella: la spunta OFF del
// desktop taglia il campo lato server, quindi il tasto — e la sorgente
// Pannello — spariscono senza un `if` nel frontend. Qui si verifica la
// resa: niente panelUrl pubblicato = niente tasto, con lo stesso mock del
// trasporto che usano i test del selettore.
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
  mocks.fleetStatus.mockImplementation(async () => ({
    available: true, cells: [cella('https://127.0.0.1:6901/vnc.html')],
  }));
});

describe('Tasto del pannello nell\'header della vista singola', () => {
  it('con il pannello pubblicato il tasto c\'è', async () => {
    render(<SingleView session="cloud-AIDesktopCell" cellName="AIDesktopCell" token="t" onBack={vi.fn()} />);
    await waitFor(() => { expect(screen.getByTitle('panel')).toBeTruthy(); });
  });

  it('OFF: panelUrl tagliato dal fleetStatus → il tasto NON c\'è più', async () => {
    mocks.fleetStatus.mockImplementation(async () => ({ available: true, cells: [cella('')] }));
    render(<SingleView session="cloud-AIDesktopCell" cellName="AIDesktopCell" token="t" onBack={vi.fn()} />);
    await waitFor(() => { expect(mocks.fleetStatus).toHaveBeenCalled(); });
    // un giro di stabilizzazione: il poll interna può ancora non aver girato
    await waitFor(() => { expect(screen.queryByTitle('panel')).toBeNull(); });
  });
});
