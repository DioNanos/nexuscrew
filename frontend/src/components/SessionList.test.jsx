import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const fixture = vi.hoisted(() => ({ sessions: [], cells: [], nodes: [] }));

vi.mock('../lib/api.js', () => ({
  apiFetch: vi.fn(async (path) => ({
    json: async () => path === '/api/config'
      ? { version: '0.8.14', bind: '127.0.0.1', port: 41820, instanceId: 'c'.repeat(32) }
      : { sessions: fixture.sessions },
  })),
  seenKey: (session) => `nc_seen_${session}`,
  fleetStatus: vi.fn(async () => ({ available: true, capabilities: ['up', 'down', 'boot'], cells: fixture.cells })),
  fleetDefinitions: vi.fn(async () => ({ engines: [] })),
  fleetUp: vi.fn(async () => ({})),
  fleetDown: vi.fn(async () => ({})),
  fleetBoot: vi.fn(async () => ({})),
  killSession: vi.fn(async () => ({})),
  nodeAction: vi.fn(async () => ({})),
  renameNodeLabel: vi.fn(async () => ({})),
  setSessionTechnical: vi.fn(async () => ({})),
  // Il comando Live vive in live-host-command.js e legge/scrive per revisione:
  // qui il mock è la sua controparte server (CAS: la revisione cambia a ogni scrittura).
  getLiveHost: vi.fn(async () => ({ revision: 3, hostCell: null, threadStatus: null })),
  designateHostCell: vi.fn(async () => ({ revision: 4, hostCell: 'Live Cell' })),
  clearHostCell: vi.fn(async () => ({ revision: 5, hostCell: null })),
}));

vi.mock('../hooks/useNodes.js', () => ({ useNodes: () => fixture.nodes }));
vi.mock('../hooks/useLang.js', () => ({ useLang: () => ['en', vi.fn()] }));
// Le sorgenti pesanti della finestra di anteprima fanno rete (ws, ticket del
// pannello): stub con traccia delle props, stesso pattern di CellSwitcher.
vi.mock('./Terminal.jsx', () => ({ default: (props) => <div data-testid="peek-term" data-session={props.session} data-node={props.node || ''} /> }));
vi.mock('./CellPanel.jsx', () => ({ default: (props) => <div data-testid="peek-panel" data-cell={props.cellId} /> }));

import SessionList from './SessionList.jsx';
import { designateHostCell, fleetBoot, fleetDown, fleetStatus, fleetUp, getLiveHost, renameNodeLabel, setSessionTechnical } from '../lib/api.js';
import { readCellSwitcherSnapshot } from '../lib/cell-switcher-cache.js';

function cell(cell, tmuxSession, live, engine = 'claude.native') {
  return { cell, tmuxSession, tmux: live, active: live, engine, key: '', degraded: false };
}

function session(name, activity = 1, extra = {}) {
  return { name, activity, windows: 1, attached: false, preview: `${name} preview`, ...extra };
}

function renderRoster(onPick = vi.fn()) {
  return render(<SessionList token="test-token" onPick={onPick} onSettings={vi.fn()} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  fixture.sessions = [session('local-live', 20), session('scratch', 10)];
  fixture.cells = [cell('Live Cell', 'local-live', true), cell('Off Cell', 'local-off', false)];
  fixture.nodes = [{
    name: 'relay', label: 'Relay', route: ['relay'], status: 'up', direct: true,
    instanceId: 'd'.repeat(32),
    tunnelStatus: 'up', health: { status: 'healthy', managed: true },
    capabilities: ['up', 'down'], engines: [],
    sessions: [session('remote-live', 30), session('remote-shell', 15)],
    cells: [cell('Relay Live', 'remote-live', true), cell('Relay Off', 'remote-off', false)],
    unmanaged: [session('remote-shell', 15, { node: 'relay', key: 'relay:remote-shell' })],
  }];
});

describe('mobile roster parity', () => {
  it('writes the local and routed inventory to the switcher cache without treating it as fresh drawer data', async () => {
    renderRoster();
    await screen.findByText('Relay Live');
    await waitFor(() => expect(readCellSwitcherSnapshot()).toMatchObject({
      sessions: fixture.sessions,
      cells: fixture.cells,
      nodeGroups: fixture.nodes,
      localFresh: false,
    }));
  });

  it('counts live Fleet cells across local and remote inventory even when tmux session lists are empty', async () => {
    fixture.sessions = [];
    fixture.cells = [
      cell('Local One', 'local-one', true),
      cell('Local Two', 'local-two', true),
      cell('Local Off', 'local-off', false),
    ];
    fixture.nodes[0].sessions = [];
    fixture.nodes[0].unmanaged = [];
    fixture.nodes[0].cells = [cell('Remote One', 'remote-one', true), cell('Remote Off', 'remote-off', false)];
    renderRoster();

    expect(await screen.findByText('tmux fleet · 3 sessions')).toBeTruthy();
  });

  it('mantiene il roster remoto e rende il ramo non verificabile come stale', async () => {
    fixture.nodes[0].fleetState = 'stale';
    fixture.nodes[0].fleetAvailable = false;
    renderRoster();

    expect(await screen.findByText('Relay Live')).toBeTruthy();
    expect(screen.getByText('Fleet read failed: the cell list may not be up to date.')).toBeTruthy();
    const relay = document.querySelector('[data-position="relay"]');
    expect(relay.querySelector('.dot').classList.contains('warn')).toBe(true);
  });

  it('never reports more attached sessions than the normalized live inventory during cache convergence', async () => {
    fixture.sessions = [session('local-live', 20, { attached: true })];
    fixture.cells = [cell('Live Cell', 'local-live', false)];
    fixture.nodes = [];
    renderRoster();

    expect(await screen.findByText('tmux fleet · 0 sessions')).toBeTruthy();
    expect(document.querySelector('.nc-home-sub').textContent).not.toContain('1 attached');
  });

  it('toggles boot from the actions sheet without invoking power and supports routed cells', async () => {
    const user = userEvent.setup();
    fixture.cells[0].boot = false;
    fixture.nodes[0].capabilities = ['up', 'down', 'boot'];
    fixture.nodes[0].cells[0].boot = true;
    renderRoster();

    // L'avvio al boot NON è un tondo in riga: la voce vive nel foglio, ed è lì
    // che si legge anche il suo stato (aria-checked).
    await screen.findByText('Live Cell');
    expect(screen.queryByRole('button', { name: /at boot .*Live Cell/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Cell actions: Live Cell' }));
    const primo = await screen.findByTestId('cell-actions-sheet');
    expect(within(primo).getByRole('menuitemcheckbox', { name: 'Boot at startup' })
      .getAttribute('aria-checked')).toBe('false');
    await user.click(within(primo).getByRole('menuitemcheckbox', { name: 'Boot at startup' }));
    expect(fleetBoot).toHaveBeenCalledWith('test-token', { cell: 'Live Cell', enabled: true }, []);
    expect(fleetUp).not.toHaveBeenCalled();
    expect(fleetDown).not.toHaveBeenCalled();

    // Riga remota: la preferenza è route-qualificata, e lo stato letto è il suo.
    await user.click(screen.getByRole('button', { name: 'Cell actions: Relay Live' }));
    const secondo = await screen.findByTestId('cell-actions-sheet');
    expect(within(secondo).getByRole('menuitemcheckbox', { name: 'Boot at startup' })
      .getAttribute('aria-checked')).toBe('true');
    await user.click(within(secondo).getByRole('menuitemcheckbox', { name: 'Boot at startup' }));
    expect(fleetBoot).toHaveBeenCalledWith('test-token', { cell: 'Relay Live', enabled: false }, ['relay']);
    expect(fleetUp).not.toHaveBeenCalled();
    expect(fleetDown).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'power off Relay Live' }));
    expect(screen.getByRole('checkbox', { name: 'also remove from boot' }).checked).toBe(false);
  });

  it('blips working cells and switches the one-line subtitle between work, idle and startup model', async () => {
    const user = userEvent.setup();
    fixture.sessions[0] = session('local-live', 20, {
      working: true, status: 'Implement activity UI', paneTitle: '⠐ Implement activity UI',
    });
    fixture.nodes[0].sessions[0] = session('remote-live', 30, {
      working: true, status: 'Review remote diff', paneTitle: '⠙ Review remote diff',
    });
    fixture.cells[1].model = 'claude-opus-4-1';
    renderRoster();

    const workingLabel = await screen.findByText(/Implement activity UI/);
    const workingRow = workingLabel.closest('.nc-mcard');
    expect(workingRow.querySelector('.dot').classList.contains('working')).toBe(true);
    const offRow = screen.getByText('Off Cell').closest('.nc-mcard');
    expect(within(offRow).getByText('claude.native · claude-opus-4-1')).toBeTruthy();
    expect(offRow.querySelector('.dot').classList.contains('on')).toBe(false);
    const remoteRow = screen.getByText(/Review remote diff/).closest('.nc-mcard');
    expect(remoteRow.querySelector('.dot').classList.contains('working')).toBe(true);

    fixture.sessions = [
      session('local-live', 21, { working: false, status: '', paneTitle: 'Dev' }),
      ...fixture.sessions.slice(1),
    ];
    await user.click(screen.getByTitle('refresh'));
    // Senza il canale degli hook il titolo non prova lo stato fermo, e
    // la riga lo dice incerto invece di affermare «idle».
    await waitFor(() => expect(within(workingRow).getByText('unverified')).toBeTruthy());
    expect(within(workingRow).queryByText('idle')).toBeNull();
    expect(workingRow.querySelector('.dot').classList.contains('working')).toBe(false);
    expect(workingRow.querySelector('.dot').classList.contains('on')).toBe(true);
  });

  it('filters local and remote positions with the shared active/off model', async () => {
    const user = userEvent.setup();
    renderRoster();
    await screen.findByText('Live Cell');

    await user.selectOptions(screen.getByLabelText('Local · filter sessions…'), 'off');
    expect(screen.getByText('Off Cell')).toBeTruthy();
    expect(screen.queryByText('Live Cell')).toBeNull();
    expect(screen.queryByText('scratch')).toBeNull();

    await user.selectOptions(screen.getByLabelText('Relay · filter sessions…'), 'active');
    expect(screen.getByText('Relay Live')).toBeTruthy();
    expect(screen.getByText('remote-shell')).toBeTruthy();
    expect(screen.queryByText('Relay Off')).toBeNull();
  });

  it('persists collapse/filter state under the desktop key and keeps remote pins route-qualified', async () => {
    const user = userEvent.setup();
    renderRoster();
    await screen.findByText('Relay Live');
    const relay = document.querySelector('[data-position="relay"]');

    // Il pin non è più un tondo in riga: si pinna dal foglio, e la chiave
    // resta route-qualificata.
    await user.click(within(relay).getByRole('button', { name: 'Cell actions: Relay Off' }));
    await user.click(within(await screen.findByTestId('cell-actions-sheet'))
      .getByRole('menuitem', { name: 'Pin to top' }));
    expect(JSON.parse(localStorage.getItem('nc_pins'))).toContain('relay:remote-off');
    const ordered = [...relay.querySelectorAll('[data-roster-key]')].map((node) => node.dataset.rosterKey);
    expect(ordered[0]).toBe('relay:remote-off');

    await user.selectOptions(screen.getByLabelText('Relay · filter sessions…'), 'pinned');
    await user.click(within(relay).getByRole('button', { name: /Relay · 1 sessions/ }));
    expect(within(relay).queryByText('Relay Off')).toBeNull();
    expect(JSON.parse(localStorage.getItem('nc_sidebar_views_v1')).relay).toEqual({ open: false, filter: 'pinned' });
  });

  it('shows search from the total multi-node roster and searches cells, engines and remote sessions', async () => {
    const user = userEvent.setup();
    fixture.nodes[0].unmanaged.push(
      ...Array.from({ length: 5 }, (_, index) => session(`remote-extra-${index}`, index + 1, { node: 'relay' })),
    );
    renderRoster();
    const search = await screen.findByRole('searchbox', { name: 'filter sessions…' });
    await user.type(search, 'Relay Off');
    expect(screen.getByText('Relay Off')).toBeTruthy();
    expect(screen.queryByText('Live Cell')).toBeNull();
    expect(screen.queryByText('remote-extra-0')).toBeNull();
  });

  it('uses accessible 44px controls and exposes expanded state per position', async () => {
    renderRoster();
    const local = await screen.findByRole('button', { name: /Local · 3 sessions/ });
    const relay = screen.getByRole('button', { name: /Relay · 3 sessions/ });
    expect(local.getAttribute('aria-expanded')).toBe('true');
    expect(relay.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText('Relay · filter sessions…').tagName).toBe('SELECT');
  });

  it('opens local and remote sessions with stable owner-qualified identities', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();
    renderRoster(onPick);
    await waitFor(() => expect(document.body.textContent).toContain('v0.8.14'));

    await user.click(screen.getByText('Live Cell').closest('button'));
    expect(onPick).toHaveBeenLastCalledWith({
      session: 'local-live', ownerId: 'c'.repeat(32), cellName: 'Live Cell',
    });

    await user.click(screen.getByText('Relay Live').closest('button'));
    expect(onPick).toHaveBeenLastCalledWith({
      session: 'remote-live', node: 'relay', ownerId: 'd'.repeat(32), cellName: 'Relay Live',
    });
  });

  it('reorders with the accessible keyboard handle and persists one shared order', async () => {
    const user = userEvent.setup();
    renderRoster();
    await screen.findByText('Off Cell');
    const local = document.querySelector('[data-position="local"]');
    const before = [...local.querySelectorAll(':scope > [data-roster-key], :scope > * > [data-roster-key]')]
      .map((node) => node.dataset.rosterKey);
    // Il riordino si accende dall'intestazione (modalità). Il gesto e la
    // persistenza sono gli stessi di prima: cambia solo quando la maniglia c'è.
    await user.click(screen.getByRole('button', { name: 'reorder' }));
    const handle = screen.getByRole('button', { name: 'reorder Off Cell' });
    handle.focus();
    await user.keyboard('{ArrowUp}');
    const stored = JSON.parse(localStorage.getItem('nc_sidebar_order_v1'));
    expect(stored.local).toContain('local-off');
    const after = [...local.querySelectorAll('[data-roster-key]')].map((node) => node.dataset.rosterKey);
    expect(after).not.toEqual(before);
    expect(handle.getAttribute('aria-keyshortcuts')).toBe('ArrowUp ArrowDown');
  });

  it('hides technical tmux sessions by default, counts displayed rows and can restore them', async () => {
    const user = userEvent.setup();
    fixture.sessions.push(session('runtime-helper', 40, { technical: true }));
    renderRoster();
    const local = await screen.findByRole('button', { name: /Local · 3 sessions/ });
    expect(local).toBeTruthy();
    expect(screen.queryByText('runtime-helper')).toBeNull();
    await user.selectOptions(screen.getByLabelText('Local · filter sessions…'), 'technical');
    expect(await screen.findByText('runtime-helper')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'show as normal session runtime-helper' }));
    expect(setSessionTechnical).toHaveBeenCalledWith('test-token', 'runtime-helper', false, []);
  });

  it.each(['mouse', 'touch'])('reorders from the dedicated handle with a %s pointer', async (pointerType) => {
    renderRoster();
    await screen.findByText('Off Cell');
    fireEvent.click(screen.getByRole('button', { name: 'reorder' }));
    const source = screen.getByRole('button', { name: 'reorder Off Cell' });
    const target = screen.getByText('Live Cell').closest('[data-roster-key]');
    const previous = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => target) });
    fireEvent.pointerDown(source, { pointerId: 7, pointerType, button: 0, clientX: 10, clientY: 20 });
    fireEvent.pointerMove(source, { pointerId: 7, pointerType, clientX: 10, clientY: 40 });
    fireEvent.pointerUp(source, { pointerId: 7, pointerType, clientX: 10, clientY: 40 });
    await waitFor(() => expect(JSON.parse(localStorage.getItem('nc_sidebar_order_v1'))?.local).toContain('local-off'));
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: previous });
  });

  it('renames a direct mobile node on the server and keeps node order local', async () => {
    const user = userEvent.setup();
    fixture.nodes.push({
      name: 'pixel', label: 'Pixel', route: ['relay', 'pixel'], status: 'up', direct: false,
      instanceId: 'e'.repeat(32), tunnelStatus: null, health: { status: 'healthy', managed: false },
      capabilities: [], engines: [], sessions: [], cells: [], unmanaged: [],
    });
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('Hub personale');
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    renderRoster();
    await screen.findByText('Relay');

    await user.click(screen.getByRole('button', { name: 'rename node Relay' }));
    await waitFor(() => expect(renameNodeLabel).toHaveBeenCalledWith('test-token', 'relay', 'Hub personale'));
    expect(localStorage.getItem('nc_node_aliases_v1')).toBeNull();

    // Anche l'ordine dei NODI passa dalla stessa modalità (una sola maniglia
    // armata per volta, non due modelli di riordino diversi).
    await user.click(screen.getByRole('button', { name: 'reorder' }));
    const pixelHandle = screen.getByRole('button', { name: 'reorder Pixel' });
    pixelHandle.focus();
    await user.keyboard('{ArrowUp}');
    expect(JSON.parse(localStorage.getItem('nc_node_order_v1'))[0]).toBe(`id:${'e'.repeat(32)}`);
    expect(alert).not.toHaveBeenCalled();
    prompt.mockRestore(); alert.mockRestore();
  });
});

// --- nodi VL nella lista mobile (VL_NODES_IN_SIDEBAR) -----------------------
// Gruppi dalla stessa strada della produzione: forma vera di /api/vl-nodes ->
// vlNodeToPeer -> vlSidebarGroups. Il conteggio dell'header DEVE venire dalla
// sessione dichiarata (items.length direbbe sempre 0 e mentirebbe).
import { vlNodeToPeer, vlSidebarGroups } from '../lib/vl-nodes-model.js';

describe('SessionList — nodi VL', () => {
  const vlApiNode = {
    nodeId: 'f'.repeat(32), label: 'VL-Node-A', pairedAt: 1700000000000,
    online: true, lastSeen: 1700000100000, version: '0.1.0',
    capabilities: ['status', 'prompt'],
    health: { state: 'running', uptimeSec: 10, rssBytes: 2_000_000, processCount: 2, brokerReachable: true },
    session: { attached: true, profile: 'ollama' },
    inflight: null, lastAck: null, canManage: true,
  };

  it('an attached VL node counts one honest session and opens the session view', () => {
    const peer = vlNodeToPeer(vlApiNode);
    fixture.nodes = vlSidebarGroups([peer]);
    const onOpenVlSession = vi.fn();
    render(<SessionList token="test-token" onPick={vi.fn()} onSettings={vi.fn()} onOpenVlSession={onOpenVlSession} />);
    expect(screen.getByRole('button', { name: /VL-Node-A · 1 sessions/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'VL-Node-A: ollama' }));
    expect(onOpenVlSession).toHaveBeenCalledWith(peer);
  });

  it('no declared attach means zero sessions in the header', () => {
    fixture.nodes = vlSidebarGroups([vlNodeToPeer({ ...vlApiNode, session: null })]);
    render(<SessionList token="test-token" onPick={vi.fn()} onSettings={vi.fn()} onOpenVlSession={vi.fn()} />);
    expect(screen.getByRole('button', { name: /VL-Node-A · 0 sessions/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'VL-Node-A: ollama' })).toBeNull();
  });
});

// --- Live per nodo (0.9.1 seconda meta', mobile) ----------------------------
// Stessa guardia di Sidebar.test.jsx, forma mobile: prima del fix onStarClick
// bypassava tutto cio' che non e' 'local' su un togglePin semplice — la stella
// di una cella remota non designava mai nulla, solo pinnava.
describe('SessionList — cella ospite Live per nodo', () => {
  it('il pin su una cella FAVORITE remota PINNA e non designa piu', async () => {
    // La designazione non passa piu' dalla stella: e' un comando esplicito, con
    // revisione fresca ed esito visibile (il selettore compatto e il popup).
    const user = userEvent.setup();
    const onDesignateCell = vi.fn();
    render(<SessionList token="test-token" onPick={vi.fn()} onSettings={vi.fn()} onDesignateCell={onDesignateCell} />);
    await screen.findByText('Relay Live');
    await user.click(screen.getByRole('button', { name: 'Cell actions: Relay Live' }));
    await user.click(within(await screen.findByTestId('cell-actions-sheet'))
      .getByRole('menuitem', { name: 'Pin to top' }));
    expect(onDesignateCell).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('nc_pins'))).toContain('relay:remote-live');
  });

  it('la Live di un nodo remoto e\' offerta SOLO quando hostByRoute[quella route] lo dice', async () => {
    const user = userEvent.setup();
    render(<SessionList token="test-token" onPick={vi.fn()} onSettings={vi.fn()}
      hostByRoute={{ local: { hostCell: null }, relay: { hostCell: 'Relay Live', threadStatus: 'absent' } }} />);
    await screen.findByText('Relay Live');
    // E' l'ospite: il foglio offre di TOGLIERE la Live. La stessa riga letta da
    // un'altra route non lo direbbe, quindi la voce e' la prova della route.
    await user.click(screen.getByRole('button', { name: 'Cell actions: Relay Live' }));
    const foglio = await screen.findByTestId('cell-actions-sheet');
    expect(within(foglio).getByRole('menuitem', { name: 'Remove Live' })).toBeTruthy();
    expect(within(foglio).queryByRole('menuitem', { name: 'Assign Live' })).toBeNull();
  });

  it('NEGATIVA: un hostCell locale con lo stesso nome non rende ospite una cella di un nodo diverso', async () => {
    const user = userEvent.setup();
    render(<SessionList token="test-token" onPick={vi.fn()} onSettings={vi.fn()}
      hostByRoute={{ local: { hostCell: 'Relay Live' } }} />);
    // Il nome della cella va cercato NELLA RIGA: la striscia in testa nomina a
    // sua volta l'ospite designato, e con questo host i due testi coincidono.
    await screen.findByText('Relay Live', { selector: '.nc-mcard-nome b' });
    await user.click(screen.getByRole('button', { name: 'Cell actions: Relay Live' }));
    const foglio = await screen.findByTestId('cell-actions-sheet');
    expect(within(foglio).getByRole('menuitem', { name: 'Assign Live' })).toBeTruthy();
    expect(within(foglio).queryByRole('menuitem', { name: 'Remove Live' })).toBeNull();
  });
});

// R27: il fleet che non risponde non deve far SPARIRE le celle in silenzio.
// Riproduce l'incidente reale: solo celle Fleet locali, nessuna sessione
// unmanaged — un guasto della lettura svuotava la home e sembrava «tutto
// offline» mentre server e celle erano vivi. Il refresh manuale (bottone in
// header) forza il secondo poll senza aspettare l'intervallo da 4s.
// R27 rev3 (audit): available:false NON e' un fallimento di lettura — e' il
// server che parla. TRE esiti: reject → stale (resta l'ultima lista);
// available:false + reason di config esplicita → DATO: lista vuota e
// indicatore «fleet non disponibile» (niente celle fantasma di un fleet
// spento per scelta); available:false + fleet.json illeggibile → stale.
describe('R27 — tre esiti: non letto, spento per scelta, dato vivo', () => {
  const STALE_EN = 'Fleet read failed: the cell list may not be up to date.';
  const OFF_EN = 'Fleet unavailable: no cells.';

  function localOnly() {
    fixture.sessions = [];
    fixture.nodes = [];
    fixture.cells = [cell('Live Cell', 'local-live', true)];
  }

  it('CONTROLLO NEGATIVO: fleet che respinge (rete/401/5xx) — la cella resta e appare lo stale', async () => {
    localOnly();
    renderRoster();
    expect(await screen.findByText('Live Cell')).toBeTruthy();
    fleetStatus.mockRejectedValueOnce(new Error('fetch failed'));
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
    expect(await screen.findByText(STALE_EN)).toBeTruthy();
    expect(screen.getByText('Live Cell')).toBeTruthy(); // la cella NON e' sparita
  });

  it('CONTROLLO NEGATIVO rev3: fleet SPENTO PER SCELTA (fleetEnabled=false) — lista vuota e indicatore «non disponibile», NON stale e NON celle fantasma', async () => {
    localOnly();
    renderRoster();
    expect(await screen.findByText('Live Cell')).toBeTruthy();
    fleetStatus.mockResolvedValueOnce({
      available: false, provider: 'disabled',
      reason: 'fleet disabilitata (fleetEnabled=false)',
    });
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
    // zero celle e' LA VERITA' di un fleet spento: la card sparisce
    await waitFor(() => expect(screen.queryByText('Live Cell')).toBeNull());
    // e l'indicatore dice che cosa e' successo — distinto dallo stale
    await waitFor(() => expect(document.body.textContent).toContain(OFF_EN));
    expect(document.body.textContent).toContain('fleetEnabled=false'); // il reason del server arriva
    expect(document.body.textContent).not.toContain(STALE_EN); // la lettura NON e' fallita
  });

  it('available:false per fleet.json illeggibile → resta l\'ultima lista nota con stale', async () => {
    localOnly();
    renderRoster();
    expect(await screen.findByText('Live Cell')).toBeTruthy();
    fleetStatus.mockResolvedValueOnce({
      available: false, provider: 'disabled',
      reason: 'fleet.json mancante o invalido (fail-closed)',
    });
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
    expect(await screen.findByText(STALE_EN)).toBeTruthy();
    expect(screen.getByText('Live Cell')).toBeTruthy();
    expect(document.body.textContent).not.toContain(OFF_EN);
  });

  it('zero celle con lettura RIUSCITA resta un dato vero: lista vuota, NESSUN indicatore', async () => {
    localOnly();
    renderRoster();
    expect(await screen.findByText('Live Cell')).toBeTruthy();
    fleetStatus.mockResolvedValueOnce({ available: true, capabilities: [], cells: [] });
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
    await waitFor(() => expect(screen.queryByText('Live Cell')).toBeNull());
    expect(screen.queryByText(STALE_EN)).toBeNull();
    expect(document.body.textContent).not.toContain(OFF_EN);
  });

  it('un fleet che torna a rispondere riporta la lettura viva: stale via, lista aggiornata', async () => {
    localOnly();
    renderRoster();
    expect(await screen.findByText('Live Cell')).toBeTruthy();
    fleetStatus.mockRejectedValueOnce(new Error('fetch failed'));
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
    expect(await screen.findByText(STALE_EN)).toBeTruthy();
    // recupero: la prossima lettura riuscita (con una cella in piu') aggiorna e spegne lo stale
    fixture.cells = [cell('Live Cell', 'local-live', true), cell('New Cell', 'local-new', true)];
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
    await screen.findByText('New Cell');
    expect(screen.queryByText(STALE_EN)).toBeNull();
  });
});

// Badge, rel e stato di una riga REMOTA: da dove vengono?
// L'audit della parte desktop ha trovato che la sidebar leggeva le sessioni
// LOCALI per nome, quindi un'omonima locale dava il conteggio sbagliato a una
// riga di un altro nodo. Qui si fissa il contratto opposto: i tre dati di una
// riga remota vengono dalle sessioni di QUELLA route, e l'omonima locale — che
// esiste davvero, con numeri suoi — non li tocca.
describe('righe remote route-qualified: mai dall\'omonima locale', () => {
  it('badge, rel e stato vengono dalle sessioni della route', async () => {
    const adesso = Math.floor(Date.now() / 1000);
    // La riga LOCALE 'remote-live' è un tmux non gestito (nessuna cella la
    // rivendica): esiste, si chiama come la remota, e ha numeri tutti suoi.
    fixture.sessions = [
      session('local-live', 20),
      session('remote-live', 1, { outbox: { count: 77, latest: 1 }, preview: 'anteprima LOCALE' }),
    ];
    fixture.nodes[0].sessions = [
      session('remote-live', adesso, { outbox: { count: 2, latest: adesso }, preview: 'anteprima REMOTA' }),
      session('remote-shell', 15),
    ];
    renderRoster();
    await screen.findByText('anteprima REMOTA');

    const remota = screen.getByText('anteprima REMOTA').closest('.nc-mcard');
    // badge outbox: il conteggio della sessione di quella route
    expect(within(remota).getByText('2', { selector: '.nc-badge' })).toBeTruthy();
    expect(within(remota).queryByText('77')).toBeNull();
    // rel attività: quella della route (adesso → «ora»), non quella dell'omonima (1 → anni)
    expect(within(remota).getByText('ora', { selector: '.nc-rel' })).toBeTruthy();
    // stato: il sottotitolo della route
    expect(within(remota).queryByText(/LOCALE/)).toBeNull();
  });

  it('NEGATIVO dell\'omonima locale: la riga locale porta i SUOI numeri, e restano tali', async () => {
    const adesso = Math.floor(Date.now() / 1000);
    fixture.sessions = [
      session('local-live', 20),
      session('remote-live', 1, { outbox: { count: 77, latest: 1 }, preview: 'anteprima LOCALE' }),
    ];
    fixture.nodes[0].sessions = [
      session('remote-live', adesso, { outbox: { count: 2, latest: adesso }, preview: 'anteprima REMOTA' }),
      session('remote-shell', 15),
    ];
    renderRoster();
    await screen.findByText('anteprima LOCALE');

    // La riga omonima LOCALE mostra il suo 77 e non il 2 della remota: i due
    // conteggi convivono senza incrociarsi, che è esattamente ciò che il difetto
    // della sidebar non faceva.
    const locale = screen.getByText('anteprima LOCALE').closest('.nc-mcard');
    expect(within(locale).getByText('77', { selector: '.nc-badge' })).toBeTruthy();
    expect(within(locale).queryByText('2', { selector: '.nc-badge' })).toBeNull();
  });
});

// Le azioni della cella in un foglio dal basso, il bollino LIVE, la striscia in
// testa e il riordino come MODALITA'. La riga della cella resta un bersaglio
// d'apertura con due comandi diretti soli, ⋯ e power: il foglio RACCOGLIE le
// altre — Live, pin, avvio al boot — e aggiunge quella che in fila non ci sta.
describe('foglio azioni, bollino LIVE, striscia, riordino a modalità', () => {
  function renderConHost(hostByRoute = {}) {
    return render(<SessionList token="test-token" onPick={vi.fn()} onSettings={vi.fn()} hostByRoute={hostByRoute} />);
  }

  it('il ⋯ apre il foglio della cella e da lì «fissa in cima» pinna e chiude', async () => {
    const user = userEvent.setup();
    renderRoster();
    await screen.findByText('Off Cell');
    expect(screen.queryByTestId('cell-actions-sheet')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Cell actions: Off Cell' }));
    const foglio = await screen.findByTestId('cell-actions-sheet');
    expect(within(foglio).getByText('Actions for Off Cell')).toBeTruthy();

    await user.click(within(foglio).getByRole('menuitem', { name: 'Pin to top' }));
    await waitFor(() => expect(JSON.parse(localStorage.getItem('nc_pins'))).toContain('local-off'));
    expect(screen.queryByTestId('cell-actions-sheet')).toBeNull();
  });

  it('l\'avvio al boot dal foglio resta un INTERRUTTORE: preferenza, mai un power', async () => {
    const user = userEvent.setup();
    renderRoster();
    await screen.findByText('Live Cell');
    await user.click(screen.getByRole('button', { name: 'Cell actions: Live Cell' }));
    const foglio = await screen.findByTestId('cell-actions-sheet');
    await user.click(within(foglio).getByRole('menuitemcheckbox', { name: 'Boot at startup' }));

    await waitFor(() => expect(fleetBoot).toHaveBeenCalledWith('test-token', { cell: 'Live Cell', enabled: true }, []));
    expect(fleetUp).not.toHaveBeenCalled();
    expect(fleetDown).not.toHaveBeenCalled();
  });

  it('«assegna la Live» dal foglio scrive per revisione e l\'esito arriva nella striscia', async () => {
    const user = userEvent.setup();
    renderRoster();
    await screen.findByText('Live Cell');
    await user.click(screen.getByRole('button', { name: 'Cell actions: Live Cell' }));
    const foglio = await screen.findByTestId('cell-actions-sheet');
    await user.click(within(foglio).getByRole('menuitem', { name: 'Assign Live' }));

    // La revisione si legge E si scrive con quella: un GET prima non è cortesia,
    // è il contratto dello store (compare-and-swap). Il token è il primo argomento
    // di ogni chiamata API, quindi entra nell'assert.
    await waitFor(() => expect(designateHostCell).toHaveBeenCalledWith('test-token', 'Live Cell', 3, []));
    expect(getLiveHost).toHaveBeenCalledWith('test-token', []);
    const notice = await waitFor(() => document.querySelector('.nc-m-live-notice'));
    expect(notice.classList.contains('ok')).toBe(true);
    expect(notice.textContent).toContain('Live Cell');
  });

  it('la riga ha SOLO ⋯ e power: pin e avvio al boot vivono nel foglio', async () => {
    renderRoster();
    await screen.findByText('Live Cell');
    const riga = screen.getByText('Live Cell').closest('.nc-mcard');
    const etichette = [...riga.querySelectorAll('.nc-act')].map((n) => n.getAttribute('aria-label'));
    // CONTROLLO NEGATIVO: stella e tondo del boot non sono bersagli di riga —
    // se uno dei due tornasse in fila, questo assert cade e nient'altro.
    expect(etichette.filter((l) => /pin to top|favorite|designated|at boot/i.test(l || ''))).toEqual([]);
    expect(riga.querySelectorAll('.nc-act')).toHaveLength(2);
    expect(riga.querySelector('.nc-act.cellmenu')).toBeTruthy();
    expect(riga.querySelector('.nc-act.power')).toBeTruthy();
  });

  it('«Guarda dal vivo» apre la finestra della cella sulla sorgente Flusso', async () => {
    const user = userEvent.setup();
    renderRoster();
    await screen.findByText('Live Cell');
    await user.click(screen.getByRole('button', { name: 'Cell actions: Live Cell' }));
    await user.click(within(await screen.findByTestId('cell-actions-sheet'))
      .getByRole('menuitem', { name: 'Watch live' }));

    // Il foglio si chiude, la finestra si apre sulla cella scelta e si entra
    // dal Flusso: e' la sorgente che su telefono non ha alternative.
    expect(screen.queryByTestId('cell-actions-sheet')).toBeNull();
    const term = await screen.findByTestId('peek-term');
    expect(term.getAttribute('data-session')).toBe('local-live');
    expect(term.getAttribute('data-node')).toBe('');
    expect(screen.getByRole('tab', { name: 'Stream' }).getAttribute('aria-selected')).toBe('true');
  });

  it('la finestra di una riga REMOTA guarda la sessione di QUELLA route, mai l\'omonima locale', async () => {
    const user = userEvent.setup();
    // Una sessione locale con lo STESSO nome di quella remota, ma un'altra
    // anteprima: se la riga leggesse la tabella locale, mostrerebbe quella.
    fixture.sessions = [...fixture.sessions,
      session('remote-live', 99, { preview: 'anteprima della locale omonima' })];
    fixture.nodes[0].sessions = [
      session('remote-live', 30, { preview: 'anteprima del nodo relay' }),
      session('remote-shell', 15),
    ];
    renderRoster();
    await screen.findByText('Relay Live');
    await user.click(screen.getByRole('button', { name: 'Cell actions: Relay Live' }));
    await user.click(within(await screen.findByTestId('cell-actions-sheet'))
      .getByRole('menuitem', { name: 'Watch live' }));

    const term = await screen.findByTestId('peek-term');
    expect(term.getAttribute('data-session')).toBe('remote-live');
    expect(term.getAttribute('data-node')).toBe('relay');
    // La riga della finestra è costruita dalle sessioni DEL NODO: la sorgente
    // Anteprima — stessa riga, altro tab — lo dice senza ambiguità.
    await user.click(screen.getByRole('tab', { name: 'Preview' }));
    expect(document.querySelector('.nc-peek-testo').textContent).toBe('anteprima del nodo relay');
    expect(document.querySelector('.nc-peek-testo').textContent)
      .not.toBe('anteprima della locale omonima');
  });

  it('CONTROLLO NEGATIVO: su una cella SPENTA «Guarda dal vivo» non compare', async () => {
    // Non c'e' niente da guardare: un handler assente e' una voce ASSENTE, non
    // una voce morta. E le voci che hanno un gesto ci sono: la lista non e'
    // vuota per caso.
    const user = userEvent.setup();
    renderRoster();
    await screen.findByText('Off Cell');
    await user.click(screen.getByRole('button', { name: 'Cell actions: Off Cell' }));
    const foglio = await screen.findByTestId('cell-actions-sheet');
    expect(within(foglio).queryByRole('menuitem', { name: 'Watch live' })).toBeNull();
    expect(within(foglio).getByRole('menuitem', { name: 'Pin to top' })).toBeTruthy();
    expect(screen.queryByTestId('peek-term')).toBeNull();
  });

  it('bollino LIVE solo dove la cella È l\'ospite di quella route', async () => {
    renderConHost({ relay: { hostCell: 'Relay Live', threadStatus: 'absent' } });
    await screen.findByText('Relay Live');
    const ospite = screen.getByText('Relay Live').closest('.nc-mcard');
    expect(within(ospite).getByText('LIVE')).toBeTruthy();
    // CONTROLLO NEGATIVO: nessun'altra cella lo prende. E il nome della cella
    // resta il testo ESATTO del suo elemento (il bollino è un fratello, non un
    // figlio): se fosse annidato dentro <b>, questo findByText non troverebbe.
    const altra = screen.getByText('Live Cell').closest('.nc-mcard');
    expect(within(altra).queryByText('LIVE')).toBeNull();
  });

  it('la striscia in testa dice chi è l\'ospite del nodo, e lo dice quando non c\'è', async () => {
    const { unmount } = renderConHost({ local: { hostCell: 'Live Cell', threadStatus: 'absent' } });
    await screen.findByText('Live Cell');
    const strip = document.querySelector('.nc-m-live-strip');
    expect(strip.textContent).toContain('Live Cell');
    expect(strip.getAttribute('data-state')).toBe('designated');
    unmount();

    renderConHost();
    await screen.findByText('Live Cell');
    const vuota = document.querySelector('.nc-m-live-strip');
    expect(vuota.textContent).toContain('Live host: no cell designated');
    expect(vuota.getAttribute('data-state')).toBe('none');
  });

  it('il riordino è una MODALITA\': spenta non ci sono maniglie, accesa compaiono', async () => {
    const user = userEvent.setup();
    renderRoster();
    await screen.findByText('Off Cell');
    expect(screen.queryByRole('button', { name: 'reorder Off Cell' })).toBeNull();

    const toggle = screen.getByRole('button', { name: 'reorder' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'reorder Off Cell' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'reorder' }).getAttribute('aria-pressed')).toBe('true');

    await user.click(screen.getByRole('button', { name: 'reorder' }));
    expect(screen.queryByRole('button', { name: 'reorder Off Cell' })).toBeNull();
  });
});
