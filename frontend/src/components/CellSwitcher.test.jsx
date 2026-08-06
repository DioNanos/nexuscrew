import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), fleetStatus: vi.fn(), getRouteSessions: vi.fn() }));
vi.mock('../lib/api.js', () => ({
  apiFetch: mocks.apiFetch, fleetStatus: mocks.fleetStatus, getRouteSessions: mocks.getRouteSessions,
}));

import CellSwitcher from './CellSwitcher.jsx';
import { writeCellSwitcherSnapshot } from '../lib/cell-switcher-cache.js';

const active = (cell, tmuxSession) => ({ cell, tmuxSession, active: true, tmux: true, engine: 'claude.native' });
const off = (cell, tmuxSession) => ({ cell, tmuxSession, active: false, tmux: false, engine: 'agy.native' });

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  writeCellSwitcherSnapshot({
    sessions: [{ name: 'cloud-Dev', activity: 10, working: true }],
    cells: [active('Dev', 'cloud-Dev'), off('Research', 'cloud-Research')],
    nodeGroups: [
      {
        route: ['hub'], label: 'Hub', sessions: [{ name: 'cloud-Remote', activity: 5 }],
        cells: [active('Remote', 'cloud-Remote')],
      },
      {
        route: ['stale'], label: 'Stale', sessions: [{ name: 'cloud-Stale', activity: 8 }],
        cells: [active('Stale Cell', 'cloud-Stale')],
      },
      {
        route: ['alerts'], label: 'Alerts', sessions: [],
        cells: [{ cell: 'Degraded', tmuxSession: 'cloud-Degraded', active: true, tmux: false, degraded: true, engine: 'shell.local' }],
      },
    ],
  });
  mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({ sessions: [{ name: 'cloud-Dev', activity: 10, working: true }] }) });
  mocks.getRouteSessions.mockImplementation(async (_token, route) => {
    if (route.join('/') === 'hub') return { sessions: [{ name: 'cloud-Remote', activity: 5 }] };
    return { sessions: [] };
  });
  mocks.fleetStatus.mockImplementation(async (_token, route = []) => {
    if (!route.length) return { available: true, cells: [active('Dev', 'cloud-Dev'), off('Research', 'cloud-Research')] };
    if (route.join('/') === 'hub') return { available: true, cells: [active('Remote', 'cloud-Remote')] };
    if (route.join('/') === 'stale') return { available: true, cells: [off('Stale Cell', 'cloud-Stale')] };
    return {
      available: true,
      cells: [{ cell: 'Degraded', tmuxSession: 'cloud-Degraded', active: true, tmux: false, degraded: true, engine: 'shell.local' }],
    };
  });
});

describe('CellSwitcher', () => {
  it('uses fresh local and route-qualified fleet data, keeps degraded visible and requires explicit opening', async () => {
    const onPick = vi.fn(); const onClose = vi.fn();
    render(<CellSwitcher token="token" current={{ session: 'cloud-Dev' }} onPick={onPick} onClose={onClose} />);

    const dialog = await screen.findByRole('dialog', { name: 'Cells / cloud sessions' });
    expect(dialog.getAttribute('aria-modal')).toBeNull();
    expect(screen.getByRole('button', { name: /^Dev / }).getAttribute('aria-current')).toBe('true');
    const remote = screen.getByRole('button', { name: /^Remote / });
    expect(remote).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Degraded / }).getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByRole('button', { name: /^Research / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Stale Cell / })).toBeNull();
    expect(screen.getByRole('button', { name: 'close cell switcher' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'select a cell' }).disabled).toBe(true);
    await waitFor(() => {
      expect(mocks.fleetStatus).toHaveBeenCalledWith('token', ['hub']);
      expect(mocks.fleetStatus).toHaveBeenCalledWith('token', ['stale']);
      expect(mocks.getRouteSessions).toHaveBeenCalledWith('token', ['alerts']);
    });

    fireEvent.click(remote);
    expect(remote.getAttribute('aria-pressed')).toBe('true');
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'open cell: Remote' }));
    await waitFor(() => expect(onPick).toHaveBeenCalledWith({ session: 'cloud-Remote', node: 'hub', cellName: 'Remote' }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('exposes the full inventory deliberately and refuses an off target with an explicit status', async () => {
    const onPick = vi.fn();
    render(<CellSwitcher token="token" current={{}} onPick={onPick} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^Dev / });
    fireEvent.click(screen.getByRole('button', { name: 'all' }));
    const research = screen.getByRole('button', { name: /^Research / });
    expect(research.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(research);
    expect(await screen.findByText('this cell is no longer active')).toBeTruthy();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('keeps deactivated cells out of active mode even when marked degraded', async () => {
    writeCellSwitcherSnapshot({
      sessions: [{ name: 'cloud-Dev', activity: 10, working: true }],
      cells: [active('Dev', 'cloud-Dev')],
      nodeGroups: [
        {
          route: ['hub'], label: 'Hub', sessions: [],
          cells: [{ cell: 'Ghost Off', tmuxSession: 'cloud-GhostOff', active: false, tmux: false, degraded: true, engine: 'shell.local' }],
        },
      ],
    });
    mocks.fleetStatus.mockImplementation(async (_token, route = []) => {
      if (!route.length) return { available: true, cells: [active('Dev', 'cloud-Dev')] };
      return {
        available: true,
        cells: [{ cell: 'Ghost Off', tmuxSession: 'cloud-GhostOff', active: false, tmux: false, degraded: true, engine: 'shell.local' }],
      };
    });
    mocks.getRouteSessions.mockResolvedValue({ sessions: [] });
    render(<CellSwitcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^Dev / });
    await waitFor(() => expect(mocks.fleetStatus).toHaveBeenCalledWith('token', ['hub']));
    expect(screen.queryByRole('button', { name: /^Ghost Off / })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'all' }));
    expect(screen.getByRole('button', { name: /^Ghost Off / }).getAttribute('aria-disabled')).toBe('true');
  });

  it('renders each distinct local cell exactly once (no client-side doubling)', async () => {
    const localCells = [
      active('Dev', 'cloud-Dev'), active('DevAuditor', 'cloud-DevAuditor'),
      off('Fork', 'cloud-Fork'), off('ForkAuditor', 'cloud-ForkAuditor'),
      active('Personal', 'cloud-Personal'), active('Research', 'cloud-Research'),
      off('Trading', 'cloud-Trading'), off('GameDev', 'cloud-GameDev'),
      off('GameAuditor', 'cloud-GameAuditor'), active('SysAdmin', 'cloud-SysAdmin'),
      off('DesignCreator', 'cloud-DesignCreator'), off('WarMaster', 'cloud-WarMaster'),
      active('DevWorker', 'cloud-DevWorker'), active('Shell', 'cloud-Shell'),
    ];
    writeCellSwitcherSnapshot({
      sessions: localCells.filter((c) => c.active).map((c) => ({ name: c.tmuxSession, activity: 1 })),
      cells: localCells,
      nodeGroups: [],
    });
    mocks.fleetStatus.mockResolvedValue({ available: true, cells: localCells });
    mocks.apiFetch.mockResolvedValue({
      json: vi.fn().mockResolvedValue({
        sessions: localCells.filter((c) => c.active).map((c) => ({ name: c.tmuxSession, activity: 1 })),
      }),
    });
    render(<CellSwitcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^Dev / });
    fireEvent.click(screen.getByRole('button', { name: 'all' }));
    for (const cell of localCells) {
      expect(screen.getAllByRole('button', { name: new RegExp(`^${cell.cell} `) })).toHaveLength(1);
    }
  });

  // Forma REALE misurata il 2026-08-06 su un client federato (Pixel): il nodo
  // VL vive su VPS3, quindi `vlNodeToPeer` gli assegna la route dell'OWNER —
  // la stessa route del gruppo Fleet di VPS3. Due gruppi, una sola posizione.
  // Il test precedente ('no client-side doubling') usa nodeGroups: [] e non
  // puo' vedere questo caso: il difetto vive esattamente nei gruppi.
  it('never doubles a fleet position when a VL node shares its route', async () => {
    const route = ['cloud-alpacalibre-com'];
    const vpsCells = [
      active('Dev', 'cloud-Dev'), active('Personal', 'cloud-Personal'),
      active('Research', 'cloud-Research'), active('SysAdmin', 'cloud-SysAdmin'),
    ];
    const vpsSessions = vpsCells.map((c) => ({ name: c.tmuxSession, activity: 1 }));
    writeCellSwitcherSnapshot({
      // Il Pixel non ha celle proprie attive: tutto cio' che si vede arriva
      // dalla posizione remota.
      sessions: [],
      cells: [],
      nodeGroups: [
        { route, label: 'VPS_Cloud', sessions: vpsSessions, cells: vpsCells },
        // Come lo produce vlSidebarGroups: cells vuote, e concatenato DOPO i
        // gruppi Fleet (useNodes.js) — per questo, a chiave uguale, vince lui.
        { kind: 'vl', name: 'vl-82dffb30', route, label: 'N900', sessions: [], cells: [] },
      ],
    });
    mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({ sessions: [] }) });
    mocks.getRouteSessions.mockResolvedValue({ sessions: vpsSessions });
    mocks.fleetStatus.mockImplementation(async (_token, r = []) => (r.length
      ? { available: true, cells: vpsCells }
      : { available: true, cells: [] }));

    render(<CellSwitcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^Dev / });
    for (const cell of vpsCells) {
      expect(screen.getAllByRole('button', { name: new RegExp(`^${cell.cell} `) })).toHaveLength(1);
    }
    // Un nodo VL non e' una posizione Fleet: non deve prestare la sua etichetta
    // alle celle di VPS3. Se questa riga passa mentre quella sopra fallisce, la
    // duplicazione e' solo mascherata.
    expect(screen.queryByText(/N900/)).toBeNull();
  });

  it('closes on Escape without trapping focus', () => {
    const onClose = vi.fn();
    render(<CellSwitcher token="token" current={{}} onPick={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('preserves unmanaged sessions in the shared order and keeps an off cell in place when it returns', async () => {
    const localSessions = [
      { name: 'cloud-Dev', activity: 10, working: true },
      { name: 'my-build-watch', activity: 5, preview: 'watching build' },
    ];
    localStorage.setItem('nc_sidebar_order_v1', JSON.stringify({
      local: ['cloud-Dev', 'my-build-watch', 'cloud-Research'],
    }));
    writeCellSwitcherSnapshot({
      sessions: localSessions,
      cells: [active('Dev', 'cloud-Dev'), off('Research', 'cloud-Research')],
      nodeGroups: [],
    });
    mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({ sessions: localSessions }) });
    mocks.fleetStatus.mockResolvedValue({
      available: true, cells: [active('Dev', 'cloud-Dev'), off('Research', 'cloud-Research')],
    });
    const first = render(<CellSwitcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^Dev / });
    fireEvent.click(screen.getByRole('button', { name: 'all' }));
    const researchHandle = screen.getByRole('button', { name: 'reorder Research' });
    const devRow = screen.getByRole('button', { name: /^Dev / }).closest('[data-roster-key]');
    const previous = document.elementFromPoint;
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => devRow) });
    fireEvent.pointerDown(researchHandle, { pointerId: 7, pointerType: 'touch', clientX: 10, clientY: 20 });
    fireEvent.pointerMove(researchHandle, { pointerId: 7, pointerType: 'touch', clientX: 10, clientY: 40 });
    fireEvent.pointerUp(researchHandle, { pointerId: 7, pointerType: 'touch', clientX: 10, clientY: 40 });
    await waitFor(() => expect(JSON.parse(localStorage.getItem('nc_sidebar_order_v1'))?.local)
      .toEqual(['cloud-Research', 'cloud-Dev', 'my-build-watch']));
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: previous });
    expect(researchHandle.getAttribute('aria-keyshortcuts')).toBe('ArrowUp ArrowDown');

    first.unmount();
    writeCellSwitcherSnapshot({
      sessions: [
        { name: 'cloud-Dev', activity: 10, working: true },
        { name: 'cloud-Research', activity: 2, working: false },
      ],
      cells: [active('Dev', 'cloud-Dev'), active('Research', 'cloud-Research')],
      nodeGroups: [],
    });
    mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({
      sessions: [
        { name: 'cloud-Dev', activity: 10, working: true },
        { name: 'cloud-Research', activity: 2, working: false },
      ],
    }) });
    mocks.fleetStatus.mockResolvedValue({
      available: true, cells: [active('Dev', 'cloud-Dev'), active('Research', 'cloud-Research')],
    });
    render(<CellSwitcher token="token" current={{}} onPick={vi.fn()} onClose={vi.fn()} />);
    await screen.findByRole('button', { name: /^Research / });
    expect([...document.querySelectorAll('.nc-cell-switcher-row[data-position="local"]')]
      .map((row) => row.dataset.rosterKey)).toEqual(['cloud-Research', 'cloud-Dev']);
  });
});
