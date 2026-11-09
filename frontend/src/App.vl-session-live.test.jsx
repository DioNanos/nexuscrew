import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// La vista di un nodo VL deve seguire la LISTA VIVA, non il peer catturato al
// click: se il device cambia generazione (o sessione) mentre la vista è
// aperta, la conversazione riparte — un cursore vecchio mostrerebbe eventi di
// un'altra sessione. Qui la catena è quella vera: App, VlSessionView e
// VlNodeEvents reali; solo l'hook e il trasporto sono controllati.

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(), fleetStatus: vi.fn(), fleetBoot: vi.fn(), killSession: vi.fn(),
  getSettings: vi.fn(), nodeAction: vi.fn(), renameNodeLabel: vi.fn(), setSessionTechnical: vi.fn(),
  getLiveHost: vi.fn(), designateHostCell: vi.fn(), clearHostCell: vi.fn(),
  fleetUp: vi.fn(), fleetDown: vi.fn(),
  getDecks: vi.fn(), createDeck: vi.fn(), saveDeck: vi.fn(), saveDeckKeepalive: vi.fn(),
  renameDeck: vi.fn(), deleteDeck: vi.fn(), getRouteConfig: vi.fn(), getRouteTopology: vi.fn(),
  getNodes: vi.fn(), getTopology: vi.fn(), getNodeAliases: vi.fn(), getRouteSessions: vi.fn(),
  getVlNodes: vi.fn(), refreshFleetRoute: vi.fn(), subscribeFleetRoute: vi.fn(), readFleetRoute: vi.fn(),
  getVlNodeEvents: vi.fn(),
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
  getVlNodeEvents: mocks.getVlNodeEvents,
}));
vi.mock('./lib/fleet-poll.js', () => ({
  subscribeFleetRoute: mocks.subscribeFleetRoute, readFleetRoute: mocks.readFleetRoute,
  refreshFleetRoute: mocks.refreshFleetRoute,
}));
const hookNodes = vi.hoisted(() => ({ list: [], chiamate: [] }));
// L'hook VERO si spegne con `enabled === false` e restituisce una lista vuota
// senza pollare (`useNodes.js:106`): il test lo rispetta, altrimenti misura un
// mondo che non esiste.
vi.mock('./hooks/useNodes.js', () => ({
  useNodes: (_token, enabled = true) => {
    hookNodes.chiamate.push(enabled);
    return enabled === false ? [] : hookNodes.list;
  },
}));
vi.mock('./lib/sw-update.js', () => ({ reportServerVersions: vi.fn() }));
vi.mock('./components/Terminal.jsx', () => ({ default: () => null }));
vi.mock('./components/KeyBar.jsx', () => ({ default: () => null }));
vi.mock('./components/FilesPanel.jsx', () => ({ default: () => null }));
vi.mock('./components/ComposerBar.jsx', () => ({ default: () => null }));
vi.mock('./components/CellPanel.jsx', () => ({ default: () => null }));
vi.mock('./components/CellSwitcher.jsx', () => ({ default: () => null }));
vi.mock('./components/SessionList.jsx', () => ({
  default: (props) => (
    <div>
      <button data-testid="open-vl-mobile" onClick={() => {
        const gruppo = hookNodes.list[0];
        if (gruppo && gruppo.peer) props.onOpenVlSession(gruppo.peer);
      }} />
    </div>
  ),
}));
vi.mock('./components/SettingsPanel.jsx', () => ({ default: () => null }));
vi.mock('./components/Wizard.jsx', () => ({ default: () => null }));
vi.mock('./components/NotifyCenter.jsx', () => ({ default: () => null }));
vi.mock('./components/VlSessionView.jsx', async (importOriginal) => (await importOriginal()));
vi.mock('./components/GridView.jsx', () => ({ default: () => <div /> }));

// La sidebar vera è troppo larga per questo test: qui espone solo il gesto che
// apre la sessione del nodo VL.
vi.mock('./components/Sidebar.jsx', () => ({
  default: (props) => (
    <div>
      <button data-testid="open-vl" onClick={() => {
        const gruppo = hookNodes.list[0];
        if (gruppo && gruppo.peer) props.onOpenVlSession(gruppo.peer);
      }} />
    </div>
  ),
}));

import App from './App.jsx';

const NODE = 'c'.repeat(32);
const OWNER = 'a'.repeat(32);
const gruppo = (generation, profile) => ({
  kind: 'vl', name: 'vl-nodo', label: 'Nodo VL', route: [], instanceId: null,
  status: 'up', sessions: [], cells: [], unmanaged: [], capabilities: [], engines: [],
  health: { status: 'healthy', detail: 'ok' },
  peer: {
    kind: 'vl', nodeId: NODE, name: NODE, label: 'Nodo VL', route: [],
    online: true, lastSeen: Date.now(), generation,
    ownerInstanceId: OWNER, session: { attached: true, profile }, capabilities: [],
  },
});

// La forma che `/api/vl-nodes` restituisce davvero (stessi campi del vero
// adapter): niente owner qui — l'owner lo porta la richiesta, non il payload.
const nodoMobile = (extra = {}) => ({
  nodeId: NODE, label: 'Nodo VL', online: true, lastSeen: Date.now(), generation: 2,
  session: { attached: true, profile: 'ollama' }, capabilities: [], ...extra,
});

beforeEach(() => {
  vi.useRealTimers();
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  localStorage.setItem('nc_token', 't');
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
  mocks.getVlNodeEvents.mockResolvedValue({ events: [{ seq: 1, kind: 'text', text: 'primo' }], cursor: 1 });
});

describe('la vista VL segue la lista viva', () => {
  it('un cambio di generazione nella lista azzera il cursore della vista aperta', async () => {
    hookNodes.list = [gruppo(1, 'ollama')];
    const vista = render(<App />);
    fireEvent.click(await screen.findByTestId('open-vl'));
    await waitFor(() => expect(mocks.getVlNodeEvents).toHaveBeenCalled());
    const primo = mocks.getVlNodeEvents.mock.calls[0];
    expect(primo[2], 'il primo giro parte da zero').toBe(0);

    // il device cambia generazione e profilo mentre la vista è aperta
    hookNodes.list = [gruppo(2, 'nuovo-profilo')];
    mocks.getVlNodeEvents.mockClear();
    vista.rerender(<App />);
    await waitFor(() => expect(mocks.getVlNodeEvents).toHaveBeenCalled(), { timeout: 6000 });
    expect(mocks.getVlNodeEvents.mock.calls[0][2],
      'la generazione cambiata deve azzerare il cursore, non ereditare quello vecchio').toBe(0);
  }, 15000);
});

// Su mobile la lista di gruppi non esiste, quindi la vista ha una fonte viva
// dedicata (`useVlNodeLive`): una GET dei nodi VL dell'owner ogni 4 s, solo
// mentre una vista è aperta. Senza, la regola «polling sospeso verso un peer
// non corrente» la lascerebbe muta per sempre — peggio della base.
describe('la vista VL su mobile, con la fonte dedicata', () => {
  const nodoVl = (extra = {}) => ({
    nodeId: NODE, label: 'Nodo VL', online: true, lastSeen: Date.now(), generation: 2,
    session: { attached: true, profile: 'ollama' }, capabilities: [], ...extra,
  });

  it('con il nodo corrente la vista polla davvero gli eventi', async () => {
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    hookNodes.list = [gruppo(2, 'ollama')];
    mocks.getVlNodes.mockResolvedValue({ instanceId: OWNER, nodes: [nodoVl()] });
    render(<App />);
    fireEvent.click(await screen.findByTestId('open-vl-mobile'));
    await waitFor(() => expect(mocks.getVlNodeEvents).toHaveBeenCalled(), { timeout: 6000 });
    expect(screen.queryByTestId('vl-session-stale')).toBeNull();
  }, 20000);

  it('con un nodo stale il poll si sospende e la vista lo dichiara', async () => {
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    hookNodes.list = [gruppo(2, 'ollama')];
    mocks.getVlNodes.mockResolvedValue({ instanceId: OWNER, nodes: [nodoVl()], stale: true });
    render(<App />);
    fireEvent.click(await screen.findByTestId('open-vl-mobile'));
    await waitFor(() => expect(screen.getByTestId('vl-session-stale')).toBeTruthy(), { timeout: 6000 });
    await waitFor(() => expect(mocks.getVlNodeEvents).toHaveBeenCalled(), { timeout: 6000 });
    // «sospeso» vuol dire NESSUN poll periodico: l'assestamento può costare
    // una lettura quando il peer arriva dalla fonte, ma oltre la finestra il
    // conteggio non cresce.
    await new Promise((r) => setTimeout(r, 200));
    const assestato = mocks.getVlNodeEvents.mock.calls.length;
    await new Promise((r) => setTimeout(r, 5000));
    expect(mocks.getVlNodeEvents.mock.calls.length, 'nessuna lettura periodica con il peer non corrente').toBe(assestato);
  }, 20000);

  it('alla sparizione del nodo la vista si chiude', async () => {
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    hookNodes.list = [gruppo(2, 'ollama')];
    mocks.getVlNodes.mockResolvedValue({ instanceId: OWNER, nodes: [nodoVl()] });
    const vista = render(<App />);
    fireEvent.click(await screen.findByTestId('open-vl-mobile'));
    await waitFor(() => expect(mocks.getVlNodeEvents).toHaveBeenCalled(), { timeout: 6000 });
    // la fonte risponde e non lo contiene più
    mocks.getVlNodes.mockResolvedValue({ instanceId: OWNER, nodes: [] });
    vista.rerender(<App />);
    await waitFor(() => expect(document.querySelector('.nc-vl-session-view')).toBeNull(), { timeout: 8000 });
  }, 25000);
});

// La politica è «ultimo dato noto», e ha quattro regole: una riga per ognuna.
describe('politica dell ultimo dato noto', () => {
  it('un publish intermedio della lista non chiude la vista', async () => {
    window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
    hookNodes.list = [gruppo(1, 'ollama')];
    const vista = render(<App />);
    fireEvent.click(await screen.findByTestId('open-vl'));
    await waitFor(() => expect(mocks.getVlNodeEvents).toHaveBeenCalled());
    // la lista si ripubblica con un oggetto nuovo, stesso nodo: la vista resta
    for (const profilo of ['ollama', 'ollama-2', 'ollama']) {
      hookNodes.list = [gruppo(1, profilo)];
      vista.rerender(<App />);
      await waitFor(() => expect(screen.queryByTestId('vl-session-stale') || true).toBeTruthy());
    }
    expect(screen.queryByText(/primo/)).toBeTruthy();
  }, 20000);

  it('si chiude quando il peer non è più nella lista viva', async () => {
    window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
    hookNodes.list = [gruppo(1, 'ollama')];
    const vista = render(<App />);
    fireEvent.click(await screen.findByTestId('open-vl'));
    await waitFor(() => expect(mocks.getVlNodeEvents).toHaveBeenCalled());
    // la lista c'è, ma quel nodo non c'è più (nemmeno come stale)
    hookNodes.list = [{ ...gruppo(1, 'altro'), peer: { ...gruppo(1, 'altro').peer, nodeId: 'd'.repeat(32) } }];
    vista.rerender(<App />);
    await waitFor(() => expect(document.querySelector('.nc-vl-session-view')).toBeNull(), { timeout: 4000 });
    expect(screen.queryByText(/primo/)).toBeNull();
  }, 20000);

  it('con il peer tornato corrente il polling riprende da zero su generazione nuova', async () => {
    window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
    const g = gruppo(1, 'ollama');
    hookNodes.list = [{ ...g, stale: true, fleetState: 'stale' }];
    const vista = render(<App />);
    fireEvent.click(await screen.findByTestId('open-vl'));
    await waitFor(() => expect(screen.getByTestId('vl-session-stale')).toBeTruthy());
    // sospeso: una sola lettura, nessun poll
    expect(mocks.getVlNodeEvents).toHaveBeenCalledTimes(1);
    // torna corrente, con una generazione nuova
    hookNodes.list = [gruppo(2, 'nuovo')];
    mocks.getVlNodeEvents.mockClear();
    vista.rerender(<App />);
    await waitFor(() => expect(mocks.getVlNodeEvents).toHaveBeenCalled(), { timeout: 6000 });
    expect(mocks.getVlNodeEvents.mock.calls[0][2], 'generazione nuova: cursore da zero').toBe(0);
  }, 20000);
});

// Il caso mobile alla catena vera (App → VlSessionView → VlNodeEvents, con la
// fonte dedicata reale): la selezione ha un owner — come sempre quando arriva
// dalla lista vera — e la GET restituisce il nodo. La vista deve restare
// aperta: prima si chiudeva perché il peer della fonte nasceva con owner nullo
// e il confronto dell'identità non tornava mai.
it('la vista mobile resta aperta su un peer owner-qualified presente', async () => {
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  const g = gruppo(2, 'ollama');
  g.peer.ownerInstanceId = OWNER;
  g.peer.route = ['owner-a'];
  hookNodes.list = [g];
  mocks.getVlNodes.mockResolvedValue({ instanceId: OWNER, nodes: [nodoMobile()] });
  render(<App />);
  fireEvent.click(await screen.findByTestId('open-vl-mobile'));
  await waitFor(() => expect(mocks.getVlNodes).toHaveBeenCalledWith('t', ['owner-a']));
  await new Promise((r) => setTimeout(r, 100));
  expect(document.querySelector('.nc-vl-session-view'), 'peer presente: la vista resta aperta').not.toBeNull();
  expect(screen.queryByTestId('vl-session-stale')).toBeNull();
}, 20000);

// Alla catena vera, la sessione resta la stessa e cambia solo la freschezza:
// se la fonte eventi non risponde, il testo già letto resta visibile accanto
// alla riga «non aggiornato».
it('passando a stale conserva il testo già letto se la fonte eventi non risponde', async () => {
  hookNodes.list = [gruppo(1, 'ollama')];
  const vista = render(<App />);
  fireEvent.click(await screen.findByTestId('open-vl'));
  await screen.findByText('primo');
  mocks.getVlNodeEvents.mockRejectedValue(new Error('fonte non disponibile'));
  const g = gruppo(1, 'ollama');
  hookNodes.list = [{ ...g, stale: true, fleetState: 'stale', peer: { ...g.peer, stale: true } }];
  vista.rerender(<App />);
  await screen.findByTestId('vl-session-stale');
  await waitFor(() => expect(document.querySelector('.nc-vl-events-stale')).not.toBeNull(), { timeout: 4000 });
  expect(screen.queryByText('primo'), 'ultimo dato noto: il testo già letto rimane visibile').not.toBeNull();
}, 20000);
