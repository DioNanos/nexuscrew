import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// La voce Pannello del menu ⋯ della barra nasce e muore col `panelUrl` che il
// fleetStatus pubblica per la cella: la spunta OFF del desktop taglia il campo
// lato server, quindi la voce — e la sorgente Pannello — spariscono senza un
// `if` nel frontend. Qui si verifica la resa aprendo il menu: niente panelUrl
// pubblicato = niente voce (non una voce spenta), con lo stesso mock del
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
import { t } from './lib/i18n.js';

// Il menu ⋯ della barra: si apre dal tasto e restituisce le sue voci
// (le azioni non stanno piu' in fila nella barra).
async function apriMenu() {
  fireEvent.click(screen.getByTitle(t('bar-menu-open')));
  await waitFor(() => { expect(screen.getByRole('menu')).toBeTruthy(); });
  return screen.getByRole('menu');
}

// La voce si cerca per `data-cellaction`, non per testo: col sottotitolo il
// testo accessibile non e' la sola etichetta.
const voce = (menu, id) => [...menu.querySelectorAll('[data-cellaction]')]
  .find((v) => v.dataset.cellaction === id);

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

describe('Voce Pannello nel menu ⋯ della vista singola', () => {
  it('con il pannello pubblicato la voce c\'è, nel menu', async () => {
    render(<SingleView session="cloud-AIDesktopCell" cellName="AIDesktopCell" token="t" onBack={vi.fn()} />);
    const menu = await apriMenu();
    expect(voce(menu, 'panel')).toBeTruthy();
  });

  it('OFF: panelUrl tagliato dal fleetStatus → la voce NON c\'è più', async () => {
    mocks.fleetStatus.mockImplementation(async () => ({ available: true, cells: [cella('')] }));
    render(<SingleView session="cloud-AIDesktopCell" cellName="AIDesktopCell" token="t" onBack={vi.fn()} />);
    await waitFor(() => { expect(mocks.fleetStatus).toHaveBeenCalled(); });
    // un giro di stabilizzazione: il poll interna può ancora non aver girato
    await waitFor(() => { expect(screen.getByTitle(t('bar-menu-open'))).toBeTruthy(); });
    const menu = await apriMenu();
    expect(voce(menu, 'panel')).toBeUndefined();
    // non e' una voce spenta che occupa posto: restano le altre tre.
    expect(menu.querySelectorAll('[data-cellaction]')).toHaveLength(3);
  });
});
