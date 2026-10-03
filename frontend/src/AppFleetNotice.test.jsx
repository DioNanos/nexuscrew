import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// L'esito delle azioni cella nel workspace desktop:
// esiti benigni → notice a scadenza su una RIGA SUA sotto la barra dei deck
// (mai dentro .nc-deckbar, dove copriva i chip e non si toglieva più); errori
// veri → nel foglio PowerSheet, che resta aperto sull'errore. La barra deck
// continua a mostrare SOLO gli errori di deck, com'era.
//
// App è montata per intero con le api finte; DeckBar e PowerSheet sono VERI
// (sono loro gli oggetti della prova); GridView è uno stub che espone
// l'apertura del foglio (onPower) e il cambio layout (per l'errore di deck).

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(), fleetStatus: vi.fn(), fleetBoot: vi.fn(), killSession: vi.fn(),
  getSettings: vi.fn(), nodeAction: vi.fn(), renameNodeLabel: vi.fn(), setSessionTechnical: vi.fn(),
  getLiveHost: vi.fn(), designateHostCell: vi.fn(), clearHostCell: vi.fn(),
  fleetUp: vi.fn(), fleetDown: vi.fn(),
  getDecks: vi.fn(), createDeck: vi.fn(), saveDeck: vi.fn(), saveDeckKeepalive: vi.fn(),
  renameDeck: vi.fn(), deleteDeck: vi.fn(), getRouteConfig: vi.fn(), getRouteTopology: vi.fn(),
  getNodes: vi.fn(), getTopology: vi.fn(), getNodeAliases: vi.fn(), getRouteSessions: vi.fn(),
  getVlNodes: vi.fn(),
}));

vi.mock('./lib/api.js', () => ({
  ROSTER_READ_TIMEOUT_MS: 8000,
  apiFetch: mocks.apiFetch, fleetStatus: mocks.fleetStatus, fleetBoot: mocks.fleetBoot,
  killSession: mocks.killSession, getSettings: mocks.getSettings, nodeAction: mocks.nodeAction,
  renameNodeLabel: mocks.renameNodeLabel, setSessionTechnical: mocks.setSessionTechnical,
  getLiveHost: mocks.getLiveHost, designateHostCell: mocks.designateHostCell,
  clearHostCell: mocks.clearHostCell, fleetUp: mocks.fleetUp, fleetDown: mocks.fleetDown,
  getDecks: mocks.getDecks, createDeck: mocks.createDeck, saveDeck: mocks.saveDeck,
  saveDeckKeepalive: mocks.saveDeckKeepalive, renameDeck: mocks.renameDeck,
  deleteDeck: mocks.deleteDeck, getRouteConfig: mocks.getRouteConfig,
  getRouteTopology: mocks.getRouteTopology, getNodes: mocks.getNodes,
  getTopology: mocks.getTopology, getNodeAliases: mocks.getNodeAliases,
  getRouteSessions: mocks.getRouteSessions, getVlNodes: mocks.getVlNodes,
}));
vi.mock('./lib/sw-update.js', () => ({ reportServerVersions: vi.fn() }));
vi.mock('./components/Terminal.jsx', () => ({ default: () => null }));
vi.mock('./components/KeyBar.jsx', () => ({ default: () => null }));
vi.mock('./components/FilesPanel.jsx', () => ({ default: () => null }));
vi.mock('./components/ComposerBar.jsx', () => ({ default: () => null }));
vi.mock('./components/CellPanel.jsx', () => ({ default: () => null }));
vi.mock('./components/CellSwitcher.jsx', () => ({ default: () => null }));
vi.mock('./components/SessionList.jsx', () => ({ default: () => null }));
vi.mock('./components/Sidebar.jsx', () => ({ default: () => null }));
vi.mock('./components/SettingsPanel.jsx', () => ({ default: () => null }));
vi.mock('./components/Wizard.jsx', () => ({ default: () => null }));
vi.mock('./components/NotifyCenter.jsx', () => ({ default: () => null }));
vi.mock('./components/VlSessionView.jsx', () => ({ default: () => null }));
vi.mock('./components/Sidebar.jsx', () => ({ default: (props) => (
  <div>
    <button data-testid="open-power"
      onClick={() => props.onPower({ cell: 'TestCell', tmuxSession: 'cloud-TestCell' })} />
  </div>
) }));
vi.mock('./components/GridView.jsx', () => ({ default: (props) => (
  <div>
    <button data-testid="change-layout"
      onClick={() => props.onLayoutChange({ columns: [{ tiles: [{ i: 's1', session: 'cloud-TestCell', x: 0, y: 0, w: 12, h: 6 }] }] })} />
  </div>
) }));

import App from './App.jsx';
import { t } from './lib/i18n.js';

const NODE_ID = 'a'.repeat(32);
const ERRORE_VERO = Object.assign(
  new Error('engine managed non configurato (codex-vl.opencode-go): credential OPENCODE_API_KEY missing — set it on this device'),
  { status: 400, data: { code: 'ENGINE_UNCONFIGURED' } },
);

beforeEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  localStorage.setItem('nc_token', 't');
  try {
    Object.defineProperty(window.location, 'reload', { configurable: true, value: vi.fn() });
  } catch (_) { /* location non ridefinibile in questo jsdom */ }
  // Workspace desktop: è lì che vive la barra dei deck.
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  mocks.getRouteConfig.mockResolvedValue({ instanceId: NODE_ID });
  mocks.getDecks.mockResolvedValue({ decks: [{ id: 'd-main', name: 'main', revision: 1, layout: { columns: [{ tiles: [] }] } }] });
  mocks.getRouteTopology.mockResolvedValue({ nodes: [] });
  mocks.fleetStatus.mockResolvedValue({ available: true, cells: [] });
  mocks.getNodes.mockResolvedValue({ nodes: [] });
  mocks.getTopology.mockResolvedValue({ nodes: [] });
  mocks.getNodeAliases.mockResolvedValue({});
  mocks.getRouteSessions.mockResolvedValue({ sessions: [] });
  mocks.getVlNodes.mockResolvedValue({ nodes: [] });
  mocks.getSettings.mockResolvedValue({});
  mocks.apiFetch.mockRejectedValue(new Error('no network in test'));
});

afterEach(() => { vi.useRealTimers(); });

const apriFoglioEInvia = async () => {
  fireEvent.click(await screen.findByTestId('open-power'));
  const foglio = await waitFor(() => document.querySelector('form.nc-power-sheet'));
  expect(foglio).toBeTruthy();
  fireEvent.submit(foglio);
};

describe('esito delle azioni cella nel workspace desktop', () => {
  it('esito benigno: notice a scadenza su riga sua, fuori dalla barra; deckStore.error resta vuoto', async () => {
    // fake timers DALL'INIZIO: l'auto-clear della notice deve essere lui a
    // scattare quando si avanza di 10 s.
    vi.useFakeTimers();
    try {
      mocks.fleetUp.mockRejectedValue(Object.assign(new Error('the operation was aborted'), { name: 'TimeoutError' }));
      render(<App />);
      await vi.advanceTimersByTimeAsync(0);

      fireEvent.click(screen.getByTestId('open-power'));
      const foglio = await vi.waitFor(() => document.querySelector('form.nc-power-sheet'), { timeout: 1000 });
      expect(foglio).toBeTruthy();
      fireEvent.submit(foglio);
      await vi.advanceTimersByTimeAsync(0);

      const notice = screen.getByRole('status');
      expect(notice.className).toContain('nc-deck-notice');
      expect(notice.textContent).toBe(t('fleet-up-slow'));
      expect(notice.getAttribute('title')).toBe(t('fleet-up-slow'));
      // NON dentro la barra dei deck, e nessun errore di deck in barra
      expect(notice.closest('.nc-deckbar')).toBeNull();
      expect(document.querySelector('.nc-deck-error')).toBeNull();

      // scade da solo dopo i 10 s dell'azione
      await vi.advanceTimersByTimeAsync(10001);
      expect(screen.queryByRole('status')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('errore vero: nel foglio, persiste finché lo chiudi, MAI nella barra', async () => {
    mocks.fleetUp.mockRejectedValue(ERRORE_VERO);
    render(<App />);
    await apriFoglioEInvia();

    // l'errore è visibile NEL FOGLIO (testo intero), e la barra resta pulita
    await screen.findByText(/engine managed non configurato \(codex-vl\.opencode-go\)/);
    expect(document.querySelector('.nc-deck-error')).toBeNull();
    expect(document.querySelector('form.nc-power-sheet')).toBeTruthy();

    // persiste finché l'utente non chiude il foglio
    await waitFor(() => { expect(screen.getByText(/engine managed non configurato/)).toBeTruthy(); });
    fireEvent.click(document.querySelector('.nc-sheet-overlay'));
    await waitFor(() => { expect(document.querySelector('form.nc-power-sheet')).toBeNull(); });
    expect(screen.queryByText(/engine managed non configurato/)).toBeNull();
    expect(document.querySelector('.nc-deck-error')).toBeNull();
  });

  it('errore di deck: comportamento di oggi — in .nc-deck-error, dentro la barra', async () => {
    vi.useFakeTimers();
    try {
      render(<App />);
      await vi.advanceTimersByTimeAsync(0);          // carimento deck ok
      mocks.saveDeck.mockRejectedValue(new Error('scrittura deck non riuscita'));
      fireEvent.click(screen.getByTestId('change-layout'));
      await vi.advanceTimersByTimeAsync(700);        // il debounce del salvataggio scatta
    } finally {
      vi.useRealTimers();
    }
    const errore = await screen.findByText(/scrittura deck non riuscita/);
    expect(errore.closest('.nc-deckbar')).toBeTruthy();
    expect(errore.className).toContain('nc-deck-error');
  });
});
