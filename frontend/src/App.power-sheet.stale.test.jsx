import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';

// Il chiamante DESKTOP del foglio di alimentazione: Sidebar (rail) → App →
// PowerSheet, tutti VERI — l'oggetto della prova è il tragitto. Un gruppo
// nodo remoto dichiarato fermo (fleetState 'stale') consegna al foglio un
// inventario conservato: il foglio non può presentare l'attestazione NC né
// la consegna del prompt come CORRENTI. Con lettura viva l'attestazione si
// vede: il positivo accompagna il negativo, il degrado non si ottiene
// nascondendo tutto.

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
// Il treno condiviso resta fermo in test: la freschezza del gruppo remoto
// arriva dall'hook dei nodi, non dal poll locale.
vi.mock('./lib/fleet-poll.js', () => ({
  subscribeFleetRoute: mocks.subscribeFleetRoute, readFleetRoute: mocks.readFleetRoute,
  refreshFleetRoute: mocks.refreshFleetRoute,
}));
const hookNodes = vi.hoisted(() => ({ list: [] }));
vi.mock('./hooks/useNodes.js', () => ({ useNodes: () => hookNodes.list }));
vi.mock('./lib/sw-update.js', () => ({ reportServerVersions: vi.fn() }));
vi.mock('./components/Terminal.jsx', () => ({ default: () => null }));
vi.mock('./components/KeyBar.jsx', () => ({ default: () => null }));
vi.mock('./components/FilesPanel.jsx', () => ({ default: () => null }));
vi.mock('./components/ComposerBar.jsx', () => ({ default: () => null }));
vi.mock('./components/CellPanel.jsx', () => ({ default: () => null }));
vi.mock('./components/CellSwitcher.jsx', () => ({ default: () => null }));
vi.mock('./components/SessionList.jsx', () => ({ default: () => null }));
vi.mock('./components/SettingsPanel.jsx', () => ({ default: () => null }));
vi.mock('./components/Wizard.jsx', () => ({ default: () => null }));
vi.mock('./components/NotifyCenter.jsx', () => ({ default: () => null }));
vi.mock('./components/VlSessionView.jsx', () => ({ default: () => null }));
vi.mock('./components/GridView.jsx', () => ({ default: () => <div /> }));

import App from './App.jsx';

function cell(name, tmuxSession, live) {
  return { cell: name, tmuxSession, tmux: live, active: live, engine: 'claude.native', key: '', degraded: false };
}

// Gruppo nodo remoto con l'ultimo inventario buono: cella viva, controllo NC
// attestato e consegna consegnata NEL RECORD — è la lettura a essere ferma.
function gruppoRemoto(extra = {}) {
  const remota = Object.assign(cell('Relay Live', 'remote-live', true), {
    ncControl: 'attested', launchId: 'aaaaaaaaaaaaaaaa',
    promptDelivery: { state: 'submitted', launchId: 'aaaaaaaaaaaaaaaa', ts: 1700000000000 },
  });
  return {
    name: 'relay', label: 'Relay', route: ['relay'], status: 'up', direct: true,
    instanceId: 'd'.repeat(32), tunnelStatus: 'up', health: { status: 'healthy', managed: true },
    capabilities: ['up', 'down'], engines: [],
    sessions: [{ name: 'remote-live', activity: 30, windows: 1, attached: false, preview: 'relay' }],
    cells: [remota],
    unmanaged: [],
    ...extra,
  };
}

beforeEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  localStorage.setItem('nc_token', 't');
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  mocks.getRouteConfig.mockResolvedValue({ instanceId: 'a'.repeat(32) });
  mocks.getDecks.mockResolvedValue({ decks: [{ id: 'd-main', name: 'main', revision: 1, layout: { columns: [{ tiles: [] }] } }] });
  mocks.getRouteTopology.mockResolvedValue({ nodes: [] });
  mocks.getTopology.mockResolvedValue({ nodes: [] });
  mocks.getNodes.mockResolvedValue({ nodes: [] });
  mocks.getNodeAliases.mockResolvedValue({});
  mocks.getRouteSessions.mockResolvedValue({ sessions: [] });
  mocks.getVlNodes.mockResolvedValue({ nodes: [] });
  mocks.getSettings.mockResolvedValue({});
  mocks.getLiveHost.mockResolvedValue({ revision: 3, hostCell: null, threadStatus: null });
  mocks.apiFetch.mockRejectedValue(new Error('no network in test'));
  mocks.fleetStatus.mockResolvedValue({ available: true, cells: [] });
  mocks.subscribeFleetRoute.mockReturnValue(() => {});
  mocks.readFleetRoute.mockReturnValue(null);
  hookNodes.list = [];
});

async function apriFoglio() {
  const card = (await screen.findByText('Relay Live')).closest('.nc-side-card');
  fireEvent.click(within(card).getByTitle('power off'));
  return (await screen.findByText('Initial prompt')).closest('div');
}

describe('workspace desktop — foglio power su inventario remoto', () => {
  it('controllo positivo: gruppo vivo → il foglio mostra «NC control attested» e «sent»', async () => {
    hookNodes.list = [gruppoRemoto()];
    render(<App />);
    const section = await apriFoglio();
    expect(section.textContent).toContain('NC control attested');
    expect(section.textContent).toContain('sent');
  });

  it('gruppo remoto fermo (fleetState stale): il foglio degrada a «not verifiable», mai attestazione corrente', async () => {
    hookNodes.list = [gruppoRemoto({ fleetState: 'stale', fleetAvailable: false })];
    render(<App />);
    const section = await apriFoglio();
    expect(section.textContent).not.toContain('NC control attested');
    expect(section.textContent).toContain('not verifiable');
  });
});
