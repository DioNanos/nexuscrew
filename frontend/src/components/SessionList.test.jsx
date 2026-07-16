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
  fleetStatus: vi.fn(async () => ({ available: true, cells: fixture.cells })),
  fleetDefinitions: vi.fn(async () => ({ engines: [] })),
  fleetUp: vi.fn(async () => ({})),
  fleetDown: vi.fn(async () => ({})),
  killSession: vi.fn(async () => ({})),
  nodeAction: vi.fn(async () => ({})),
  setSessionTechnical: vi.fn(async () => ({})),
}));

vi.mock('../hooks/useNodes.js', () => ({ useNodes: () => fixture.nodes }));
vi.mock('../hooks/useLang.js', () => ({ useLang: () => ['en', vi.fn()] }));

import SessionList from './SessionList.jsx';
import { setSessionTechnical } from '../lib/api.js';

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
      session: 'local-live', ownerId: 'c'.repeat(32),
    });

    await user.click(screen.getByText('Relay Live').closest('button'));
    expect(onPick).toHaveBeenLastCalledWith({
      session: 'remote-live', node: 'relay', ownerId: 'd'.repeat(32),
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
});
