import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// Le azioni cella del workspace desktop (kill, visibilità, boot, conferma
// power) devono chiedere il refresh della ROUTE toccata dopo l'azione: il
// gestore una volta chiamava una funzione di polling rimossa, e ogni azione
// riuscita si chiudeva con un ReferenceError lasciando la lista ferma.

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(), fleetStatus: vi.fn(), fleetBoot: vi.fn(), killSession: vi.fn(),
  getSettings: vi.fn(), nodeAction: vi.fn(), renameNodeLabel: vi.fn(), setSessionTechnical: vi.fn(),
  getLiveHost: vi.fn(), designateHostCell: vi.fn(), clearHostCell: vi.fn(),
  fleetUp: vi.fn(), fleetDown: vi.fn(),
  getDecks: vi.fn(), createDeck: vi.fn(), saveDeck: vi.fn(), saveDeckKeepalive: vi.fn(),
  renameDeck: vi.fn(), deleteDeck: vi.fn(), getRouteConfig: vi.fn(), getRouteTopology: vi.fn(),
  getNodes: vi.fn(), getTopology: vi.fn(), getNodeAliases: vi.fn(), getRouteSessions: vi.fn(),
  getVlNodes: vi.fn(), refreshFleetRoute: vi.fn(), subscribeFleetRoute: vi.fn(), readFleetRoute: vi.fn(),
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
// Il refresh dell'azione passa dal treno condiviso: qui lo intercettiamo.
vi.mock('./lib/fleet-poll.js', () => ({
  subscribeFleetRoute: mocks.subscribeFleetRoute, readFleetRoute: mocks.readFleetRoute,
  refreshFleetRoute: mocks.refreshFleetRoute,
}));
vi.mock('./lib/sw-update.js', () => ({ reportServerVersions: vi.fn() }));
vi.mock('./components/Terminal.jsx', () => ({ default: () => null }));
vi.mock('./components/KeyBar.jsx', () => ({ default: () => null }));
vi.mock('./components/FilesPanel.jsx', () => ({ default: () => null }));
vi.mock('./components/ComposerBar.jsx', () => ({ default: () => null }));
vi.mock('./components/CellPanel.jsx', () => ({ default: () => null }));
vi.mock('./components/CellSwitcher.jsx', () => ({ default: () => null }));
vi.mock('./components/SessionList.jsx', () => ({ default: () => null }));
vi.mock('./components/Sidebar.jsx', () => ({ default: (props) => (
  <div>
    <button data-testid="open-power"
      onClick={() => props.onPower({ cell: 'TestCell', tmuxSession: 'cloud-TestCell', route: ['hub'] })} />
    <button data-testid="act-kill" onClick={() => props.onKill('TestCell', ['hub'])} />
    <button data-testid="act-visibility" onClick={() => props.onVisibility('TestCell', true, ['hub'])} />
    <button data-testid="act-boot" onClick={() => props.onBoot('TestCell', true, ['hub'])} />
  </div>
) }));
vi.mock('./components/PowerSheet.jsx', () => ({ default: (props) => (
  <div>
    <button data-testid="act-confirm" onClick={() => props.onConfirm({ action: 'up', boot: true })} />
  </div>
) }));
vi.mock('./components/SettingsPanel.jsx', () => ({ default: () => null }));
vi.mock('./components/Wizard.jsx', () => ({ default: () => null }));
vi.mock('./components/NotifyCenter.jsx', () => ({ default: () => null }));
vi.mock('./components/VlSessionView.jsx', () => ({ default: () => null }));
vi.mock('./components/GridView.jsx', () => ({ default: () => <div /> }));

import App from './App.jsx';

const HUB = ['hub'];

beforeEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  localStorage.setItem('nc_token', 't');
  try {
    Object.defineProperty(window.location, 'reload', { configurable: true, value: vi.fn() });
  } catch (_) { /* location non ridefinibile in questo jsdom */ }
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  mocks.getRouteConfig.mockResolvedValue({ instanceId: 'a'.repeat(32) });
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
  mocks.killSession.mockResolvedValue({ killed: true });
  mocks.setSessionTechnical.mockResolvedValue({ ok: true });
  mocks.fleetBoot.mockResolvedValue({ ok: true });
  mocks.fleetUp.mockResolvedValue({ committed: true });
  mocks.refreshFleetRoute.mockClear();
});

const agisci = async (testid) => {
  fireEvent.click(await screen.findByTestId(testid));
  await waitFor(() => expect(mocks.refreshFleetRoute).toHaveBeenCalledWith(HUB, 't'));
};

describe('le azioni cella chiedono il refresh della route toccata', () => {
  it('kill: nessun errore e refresh della route', async () => {
    render(<App />);
    await agisci('act-kill');
  });

  it('visibilità: nessun errore e refresh della route', async () => {
    render(<App />);
    await agisci('act-visibility');
  });

  it('boot: nessun errore e refresh della route', async () => {
    render(<App />);
    await agisci('act-boot');
  });

  it('conferma power: nessun errore e refresh della route della cella in foglio', async () => {
    render(<App />);
    // Il foglio power porta la SUA route: prima si apre, poi si conferma.
    fireEvent.click(await screen.findByTestId('open-power'));
    await agisci('act-confirm');
  });
});

// Con la risposta persa l'azione può essere passata comunque. Il roster si
// rilegge UNA volta, in differita, per la tupla toccata: non si ripete il POST
// (sarebbe una seconda azione, non una riprova) e due richieste ravvicinate non
// raddoppiano la lettura.
describe('risposta persa: una rilettura differita per tupla, nessun replay', () => {
  const peerTimeout = () => {
    const e = new Error('peer non risponde entro il timeout');
    e.status = 504;
    e.data = { error: 'peer non risponde entro il timeout', reason: 'federation-peer-timeout' };
    return e;
  };

  const conferma = async () => {
    fireEvent.click(await screen.findByTestId('open-power'));
    await screen.findByTestId('act-confirm');
    mocks.refreshFleetRoute.mockClear();
    fireEvent.click(screen.getByTestId('act-confirm'));
  };

  it('dopo un 504 il POST non si ripete e la rilettura arriva una volta', async () => {
    mocks.fleetUp.mockRejectedValue(peerTimeout());
    render(<App />);
    await conferma();
    await waitFor(() => expect(mocks.refreshFleetRoute).toHaveBeenCalledWith(HUB, 't'));
    expect(mocks.refreshFleetRoute).toHaveBeenCalledTimes(1);
    // la differita arriva dopo la finestra, e solo una volta
    await waitFor(() => expect(mocks.refreshFleetRoute).toHaveBeenCalledTimes(2), { timeout: 4000 });
    expect(mocks.fleetUp).toHaveBeenCalledTimes(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(mocks.refreshFleetRoute).toHaveBeenCalledTimes(2);
  });

  it('due richieste ravvicinate sulla stessa tupla: una sola rilettura differita', async () => {
    mocks.fleetUp.mockRejectedValue(peerTimeout());
    render(<App />);
    await conferma();
    fireEvent.click(screen.getByTestId('act-confirm'));
    await waitFor(() => expect(mocks.fleetUp).toHaveBeenCalledTimes(2));
    // due letture immediate (una per azione) e UNA SOLA differita: la seconda
    // richiesta cade nella stessa finestra e viene coalesciuta, non raddoppiata
    await waitFor(() => expect(mocks.refreshFleetRoute).toHaveBeenCalledTimes(3), { timeout: 4000 });
    await new Promise((r) => setTimeout(r, 200));
    expect(mocks.refreshFleetRoute).toHaveBeenCalledTimes(3);
  });
});
