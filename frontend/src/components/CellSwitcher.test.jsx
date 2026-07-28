import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), fleetStatus: vi.fn() }));
vi.mock('../lib/api.js', () => ({ apiFetch: mocks.apiFetch, fleetStatus: mocks.fleetStatus }));

import CellSwitcher from './CellSwitcher.jsx';
import { writeCellSwitcherSnapshot } from '../lib/cell-switcher-cache.js';

beforeEach(() => {
  localStorage.setItem('nc_lang', 'en');
  writeCellSwitcherSnapshot({
    sessions: [{ name: 'cloud-Dev', activity: 10, working: true }],
    cells: [
      { cell: 'Dev', tmuxSession: 'cloud-Dev', tmux: true, engine: 'claude.native' },
      { cell: 'Research', tmuxSession: 'cloud-Research', tmux: false, engine: 'agy.native' },
    ],
    nodeGroups: [{
      route: ['hub'], label: 'Hub', sessions: [{ name: 'cloud-Remote', activity: 5 }],
      cells: [{ cell: 'Remote', tmuxSession: 'cloud-Remote', tmux: true, engine: 'codex.native' }],
    }],
  });
  mocks.apiFetch.mockResolvedValue({ json: vi.fn().mockResolvedValue({ sessions: [] }) });
  mocks.fleetStatus.mockResolvedValue({ available: false });
});

describe('CellSwitcher', () => {
  it('opens from the cache, sorts live cells first and switches in place', async () => {
    const onPick = vi.fn(); const onClose = vi.fn();
    render(<CellSwitcher token="token" current={{ session: 'cloud-Dev' }} onPick={onPick} onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'Cells / cloud sessions' });
    const rows = [...dialog.querySelectorAll('.nc-cell-switcher-row')];
    expect(rows.map((row) => row.textContent)).toEqual(expect.arrayContaining(['Devworking', 'RemoteHub · tmux alive', 'Researchagy.native']));
    expect(rows.at(-1).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Remote/ }));
    expect(onPick).toHaveBeenCalledWith({ session: 'cloud-Remote', node: 'hub', cellName: 'Remote' });
    expect(onClose).toHaveBeenCalledOnce();
    await waitFor(() => expect(mocks.fleetStatus).toHaveBeenCalledWith('token'));
  });

  it('closes on Escape without trapping focus', () => {
    const onClose = vi.fn();
    render(<CellSwitcher token="token" current={{}} onPick={vi.fn()} onClose={onClose} />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
