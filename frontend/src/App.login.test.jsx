import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

// T1/T2 a livello di App:
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
  AUTH_INVALID_EVENT: 'nc:auth-invalid', isLocalApiPath: () => true,
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

beforeEach(() => {
  vi.useRealTimers();
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
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
});
afterEach(() => { vi.useRealTimers(); sessionStorage.clear(); });

const campo = () => screen.getByPlaceholderText('token');

describe('login manuale a livello di App (T1)', () => {
  it('senza token compare il campo e digitare NON lo fa sparire', async () => {
    render(<App />);
    fireEvent.change(campo(), { target: { value: 'a' } });
    expect(screen.queryByPlaceholderText('token')).not.toBeNull();   // oggi: l\'input sparisce al primo carattere
    fireEvent.change(campo(), { target: { value: 'abcdef' } });
    expect(campo().value).toBe('abcdef');
  });

  it('il token si salva SOLO su ok, in localStorage se «ricorda», e la copia di sessione sparisce', async () => {
    render(<App />);
    sessionStorage.setItem('nc_token', 'vecchio-di-sessione');       // copia vecchia rimasta nella scheda
    fireEvent.change(campo(), { target: { value: 'nuovo-token' } });
    expect(localStorage.getItem('nc_token')).toBeNull();            // digitare non salva
    const box = screen.getByRole('checkbox');
    if (!box.checked) fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: /ok/i }));
    expect(localStorage.getItem('nc_token')).toBe('nuovo-token');
    expect(sessionStorage.getItem('nc_token')).toBeNull();
  });

  it('senza «ricorda» il token va in sessionStorage e non in localStorage', async () => {
    render(<App />);
    fireEvent.change(campo(), { target: { value: 'tok-sessione' } });
    const box = screen.getByRole('checkbox');
    if (box.checked) fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: /ok/i }));
    expect(sessionStorage.getItem('nc_token')).toBe('tok-sessione');
    expect(localStorage.getItem('nc_token')).toBeNull();
  });
});

describe('token rifiutato dal nodo locale (T2)', () => {
  const inviaEvento = (token) => window.dispatchEvent(new CustomEvent('nc:auth-invalid', { detail: { token, path: '/api/sessions' } }));

  it('401 locale col token corrente: si riapre il prompt, le preferenze restano', async () => {
    localStorage.setItem('nc_token', 'scaduto');
    localStorage.setItem('nc_pins', '["a","b"]');
    localStorage.setItem('nc_sidebar_order_v1', '{"local":["b","a"]}');
    render(<App />);
    expect(screen.queryByPlaceholderText('token')).toBeNull();      // entrato col token salvato
    act(() => inviaEvento('scaduto'));
    expect(await screen.findByPlaceholderText('token')).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(localStorage.getItem('nc_pins')).toBe('["a","b"]');
    expect(localStorage.getItem('nc_sidebar_order_v1')).toBe('{"local":["b","a"]}');
  });

  it('un evento per un token DIVERSO da quello in uso (risposta tardiva) non riapre il prompt', async () => {
    localStorage.setItem('nc_token', 'corrente');
    render(<App />);
    act(() => inviaEvento('un-altro'));
    expect(screen.queryByPlaceholderText('token')).toBeNull();
  });

  it('dopo aver reinserito il token nuovo si torna dentro e lo storage ha il nuovo', async () => {
    localStorage.setItem('nc_token', 'scaduto');
    render(<App />);
    act(() => inviaEvento('scaduto'));
    fireEvent.change(await screen.findByPlaceholderText('token'), { target: { value: 'nuovo' } });
    const box = screen.getByRole('checkbox');
    if (!box.checked) fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: /ok/i }));
    expect(localStorage.getItem('nc_token')).toBe('nuovo');
    await waitFor(() => expect(screen.queryByPlaceholderText('token')).toBeNull());
  });
});
