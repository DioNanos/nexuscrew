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
}));

vi.mock('../hooks/useNodes.js', () => ({ useNodes: () => fixture.nodes }));
vi.mock('../hooks/useLang.js', () => ({ useLang: () => ['en', vi.fn()] }));

import SessionList from './SessionList.jsx';
import { fleetBoot, fleetDown, fleetUp, renameNodeLabel, setSessionTechnical } from '../lib/api.js';
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

  it('never reports more attached sessions than the normalized live inventory during cache convergence', async () => {
    fixture.sessions = [session('local-live', 20, { attached: true })];
    fixture.cells = [cell('Live Cell', 'local-live', false)];
    fixture.nodes = [];
    renderRoster();

    expect(await screen.findByText('tmux fleet · 0 sessions')).toBeTruthy();
    expect(document.querySelector('.nc-home-sub').textContent).not.toContain('1 attached');
  });

  it('toggles boot directly without invoking power and supports routed cells', async () => {
    const user = userEvent.setup();
    fixture.cells[0].boot = false;
    fixture.nodes[0].capabilities = ['up', 'down', 'boot'];
    fixture.nodes[0].cells[0].boot = true;
    renderRoster();

    await user.click(await screen.findByRole('button', { name: 'enable at boot Live Cell' }));
    expect(fleetBoot).toHaveBeenCalledWith('test-token', { cell: 'Live Cell', enabled: true }, []);
    expect(fleetUp).not.toHaveBeenCalled();
    expect(fleetDown).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'disable at boot Live Cell' }).classList.contains('on')).toBe(true);

    await user.click(screen.getByRole('button', { name: 'disable at boot Relay Live' }));
    expect(fleetBoot).toHaveBeenCalledWith('test-token', { cell: 'Relay Live', enabled: false }, ['relay']);
    expect(fleetUp).not.toHaveBeenCalled();
    expect(fleetDown).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'enable at boot Relay Live' }).classList.contains('on')).toBe(false);

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
    await waitFor(() => expect(within(workingRow).getByText('idle')).toBeTruthy());
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

    await user.click(within(relay).getByRole('button', { name: /^pin to top Relay Off$/ }));
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
    nodeId: 'f'.repeat(32), label: 'N900', pairedAt: 1700000000000,
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
    expect(screen.getByRole('button', { name: /N900 · 1 sessions/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'N900: ollama' }));
    expect(onOpenVlSession).toHaveBeenCalledWith(peer);
  });

  it('no declared attach means zero sessions in the header', () => {
    fixture.nodes = vlSidebarGroups([vlNodeToPeer({ ...vlApiNode, session: null })]);
    render(<SessionList token="test-token" onPick={vi.fn()} onSettings={vi.fn()} onOpenVlSession={vi.fn()} />);
    expect(screen.getByRole('button', { name: /N900 · 0 sessions/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'N900: ollama' })).toBeNull();
  });
});

// --- Live per nodo (0.9.1 seconda meta', mobile) ----------------------------
// Stessa guardia di Sidebar.test.jsx, forma mobile: prima del fix onStarClick
// bypassava tutto cio' che non e' 'local' su un togglePin semplice — la stella
// di una cella remota non designava mai nulla, solo pinnava.
describe('SessionList — cella ospite Live per nodo', () => {
  it('la stella su una cella FAVORITE remota designa con la route DI QUEL NODO (spia sulla chiamata)', async () => {
    localStorage.setItem('nc_pins', JSON.stringify(['relay:remote-live']));
    const onDesignateCell = vi.fn();
    render(<SessionList token="test-token" onPick={vi.fn()} onSettings={vi.fn()} onDesignateCell={onDesignateCell} />);
    await screen.findByText('Relay Live');
    fireEvent.click(screen.getByRole('button', { name: 'pin to top Relay Live' }));
    expect(onDesignateCell).toHaveBeenCalledWith('Relay Live', ['relay']);
    expect(onDesignateCell).not.toHaveBeenCalledWith('Relay Live');
    expect(onDesignateCell).not.toHaveBeenCalledWith('Relay Live', []);
  });

  it('la stellina remota e\' "live" SOLO quando hostByRoute[quella route] lo dice', async () => {
    render(<SessionList token="test-token" onPick={vi.fn()} onSettings={vi.fn()}
      hostByRoute={{ local: { hostCell: null }, relay: { hostCell: 'Relay Live' } }} />);
    await screen.findByText('Relay Live');
    expect(screen.getByRole('button', { name: 'live host Relay Live' })).toBeTruthy();
  });

  it('NEGATIVA: un hostCell locale con lo stesso nome non accende la stella di un nodo diverso', async () => {
    render(<SessionList token="test-token" onPick={vi.fn()} onSettings={vi.fn()}
      hostByRoute={{ local: { hostCell: 'Relay Live' } }} />);
    await screen.findByText('Relay Live');
    expect(screen.queryByRole('button', { name: 'live host Relay Live' })).toBeNull();
  });
});
