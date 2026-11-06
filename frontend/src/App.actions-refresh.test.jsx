import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

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
// L'owner di una route arriva da qui: il test del contesto deve poterlo
// cambiare mentre il POST è in volo, come succede quando il roster si aggiorna.
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
  hookNodes.list = [];
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

// Il 409 «sessione già in esecuzione» è un esito NOTO, non una risposta persa:
// la lettura immediata basta e non deve partire anche una differita.
describe('esito noto: nessuna lettura differita', () => {
  const duplicate = () => {
    const e = new Error('already running');
    e.status = 409;
    e.data = { error: 'already running', code: 'SESSION_DUPLICATE' };
    return e;
  };

  it('un 409 di sessione duplicata non arma una lettura differita', async () => {
    mocks.fleetUp.mockRejectedValue(duplicate());
    render(<App />);
    fireEvent.click(await screen.findByTestId('open-power'));
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByTestId('act-confirm')); await Promise.resolve(); await Promise.resolve(); });
    const prima = mocks.refreshFleetRoute.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(1501); });
    vi.useRealTimers();
    expect(mocks.refreshFleetRoute.mock.calls.length, 'an outcome that is known is not a lost response').toBe(prima);
  });
});

// La differita non deve nascere dopo la chiusura della vista, e non deve
// sopravvivere a un contesto che non è più quello che l'ha chiesta: un'altra
// credenziale, un altro owner della stessa route, una ragione terminale già
// arrivata. Sono i casi in cui la lettura non riguarda più questa vista.
describe('contesto cambiato: la lettura differita non parte', () => {
  const peerTimeout = () => {
    const e = new Error('peer non risponde entro il timeout');
    e.status = 504;
    e.data = { error: 'peer non risponde entro il timeout', reason: 'federation-peer-timeout' };
    return e;
  };

  it('una risposta arrivata dopo la chiusura della vista non arma nulla', async () => {
    let rigetta;
    mocks.fleetUp.mockImplementation(() => new Promise((resolve, reject) => { rigetta = reject; }));
    const vista = render(<App />);
    fireEvent.click(await screen.findByTestId('open-power'));
    fireEvent.click(screen.getByTestId('act-confirm'));
    await waitFor(() => expect(mocks.fleetUp).toHaveBeenCalledTimes(1));
    vi.useFakeTimers();
    vista.unmount();
    await act(async () => {
      rigetta(peerTimeout());
      await Promise.resolve();
      await Promise.resolve();
    });
    const prima = mocks.refreshFleetRoute.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(1501); });
    vi.useRealTimers();
    expect(mocks.refreshFleetRoute.mock.calls.length, 'a deferred read survived the closed view').toBe(prima);
  });

  // Lo snapshot che readFleetRoute emette davvero: le celle stanno in `fs`,
  // sotto il risultato di fleetStatus, non alla radice dell'oggetto.
  const snapshotVero = (celle, extra = {}) => ({
    at: 1, sessionsJson: { sessions: [] }, sessionsError: null,
    fs: { available: true, cells: celle }, fleetError: null, ...extra,
  });


  it('un owner cambiato mentre il POST è in volo non autorizza la differita', async () => {
    let rigetta;
    mocks.fleetUp.mockImplementation(() => new Promise((resolve, reject) => { rigetta = reject; }));
    hookNodes.list = [{ name: 'hub', label: 'Hub', route: HUB, instanceId: 'a'.repeat(32), status: 'up', sessions: [], cells: [] }];
    const vista = render(<App />);
    fireEvent.click(await screen.findByTestId('open-power'));
    fireEvent.click(screen.getByTestId('act-confirm'));
    await waitFor(() => expect(mocks.fleetUp).toHaveBeenCalledTimes(1));
    // l'owner della stessa route cambia mentre il POST è ancora pendente
    hookNodes.list = [{ name: 'hub', label: 'Hub', route: HUB, instanceId: 'b'.repeat(32), status: 'up', sessions: [], cells: [] }];
    vista.rerender(<App />);
    vi.useFakeTimers();
    await act(async () => { rigetta(peerTimeout()); await Promise.resolve(); await Promise.resolve(); });
    const prima = mocks.refreshFleetRoute.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(1501); });
    vi.useRealTimers();
    expect(mocks.refreshFleetRoute.mock.calls.length, 'old action scheduled a read for the replacement owner').toBe(prima);
  });

  it('dopo la sostituzione, un azione nuova sulla stessa route legge una volta sola', async () => {
    mocks.fleetUp.mockRejectedValue(peerTimeout());
    hookNodes.list = [{ name: 'hub', label: 'Hub', route: HUB, instanceId: 'a'.repeat(32), status: 'up', sessions: [], cells: [] }];
    const vista = render(<App />);
    fireEvent.click(await screen.findByTestId('open-power'));
    await screen.findByTestId('act-confirm');
    mocks.refreshFleetRoute.mockClear();
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByTestId('act-confirm')); await Promise.resolve(); await Promise.resolve(); });
    // l'owner cambia, e poi arriva un'azione NUOVA su quel contesto
    hookNodes.list = [{ name: 'hub', label: 'Hub', route: HUB, instanceId: 'b'.repeat(32), status: 'up', sessions: [], cells: [] }];
    vista.rerender(<App />);
    await act(async () => { fireEvent.click(screen.getByTestId('act-confirm')); await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1501); });
    vi.useRealTimers();
    // due letture immediate (una per azione) e UNA differita, quella dell'azione
    // nuova: la vecchia non le ruba il posto con la chiave della tupla
    expect(mocks.refreshFleetRoute).toHaveBeenCalledTimes(3);
  });

  it('una ragione terminale già arrivata toglie senso alla lettura', async () => {
    mocks.fleetUp.mockRejectedValue(peerTimeout());
    mocks.readFleetRoute.mockReturnValue(snapshotVero([
      { cell: 'TestCell', tmuxSession: 'cloud-TestCell', terminal: { reason: 'lease-lost', ts: 1 } },
    ]));
    render(<App />);
    fireEvent.click(await screen.findByTestId('open-power'));
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(screen.getByTestId('act-confirm')); await Promise.resolve(); await Promise.resolve(); });
    const prima = mocks.refreshFleetRoute.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(1501); });
    vi.useRealTimers();
    expect(mocks.refreshFleetRoute.mock.calls.length, 'a cell with a terminal reason needed no reread').toBe(prima);
  });
});
