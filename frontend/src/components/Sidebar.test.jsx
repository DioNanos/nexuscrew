import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import Sidebar from './Sidebar.jsx';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
});

describe('Sidebar session identity', () => {
  it('toggles boot from local and routed desktop rows without using power', async () => {
    const onBoot = vi.fn(async () => {}); const onPower = vi.fn();
    const onBootSettlementApplied = vi.fn();
    const props = {
      cells: [{ cell: 'Local Cell', tmuxSession: 'local-cell', tmux: true, active: true, boot: false }],
      sessions: [{ name: 'local-cell' }],
      nodeGroups: [{
        name: 'relay', label: 'Relay', route: ['relay'], status: 'up', instanceId: 'd'.repeat(32),
        sessions: [{ name: 'remote-cell' }], unmanaged: [], capabilities: ['up', 'down', 'boot'], engines: [],
        cells: [{ cell: 'Remote Cell', tmuxSession: 'remote-cell', tmux: true, active: true, boot: true, key: 'relay:remote-cell' }],
      }],
      fleetCapabilities: ['up', 'down', 'boot'],
      onBoot,
      onBootSettlementApplied,
      onPower,
      onPick: vi.fn(),
      onAddTile: vi.fn(),
      onSettings: vi.fn(),
    };
    const { rerender } = render(<Sidebar {...props} />);

    fireEvent.click(screen.getByRole('button', { name: 'enable at boot Local Cell' }));
    await waitFor(() => expect(onBoot).toHaveBeenCalledWith('Local Cell', true, []));
    expect(screen.getByRole('button', { name: 'disable at boot Local Cell' }).classList.contains('on')).toBe(true);
    fireEvent.click(screen.getAllByRole('button', { name: 'power off' })[0]);
    expect(onPower).toHaveBeenLastCalledWith(expect.objectContaining({ cell: 'Local Cell', boot: true }));

    // PowerSheet conferma il valore opposto prima del poll: l'evento del
    // genitore deve sostituire subito l'override del toggle diretto.
    rerender(<Sidebar {...props} bootSettlement={{ id: 1, cell: 'Local Cell', route: [], enabled: false }} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'enable at boot Local Cell' })).toBeTruthy());
    expect(onBootSettlementApplied).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getAllByRole('button', { name: 'power off' })[0]);
    expect(onPower).toHaveBeenLastCalledWith(expect.objectContaining({ cell: 'Local Cell', boot: false }));

    fireEvent.click(screen.getByRole('button', { name: 'disable at boot Remote Cell' }));
    await waitFor(() => expect(onBoot).toHaveBeenCalledWith('Remote Cell', false, ['relay']));
    expect(screen.getByRole('button', { name: 'enable at boot Remote Cell' }).classList.contains('on')).toBe(false);
    fireEvent.click(screen.getAllByRole('button', { name: 'power off' })[1]);
    expect(onPower).toHaveBeenLastCalledWith(expect.objectContaining({
      cell: 'Remote Cell', boot: false, route: ['relay'],
    }));
  });

  it('opens local and remote rows with ownerId + tmux session coordinates', () => {
    const onPick = vi.fn();
    render(
      <Sidebar
        localNodeId={'c'.repeat(32)}
        sessions={[{ name: 'local-shell', activity: 2, windows: 1 }]}
        nodeGroups={[{
          name: 'relay', label: 'Relay', route: ['relay'], instanceId: 'd'.repeat(32), status: 'up',
          sessions: [{ name: 'remote-shell', activity: 1, key: 'relay:remote-shell' }],
          unmanaged: [{ name: 'remote-shell', activity: 1, node: 'relay', key: 'relay:remote-shell' }],
          cells: [], capabilities: [], engines: [],
        }]}
        onPick={onPick} onAddTile={vi.fn()} onSettings={vi.fn()}
      />,
    );

    fireEvent.doubleClick(screen.getByText('local-shell').closest('[data-roster-key]'));
    expect(onPick).toHaveBeenLastCalledWith({
      session: 'local-shell', ownerId: 'c'.repeat(32),
    });

    fireEvent.doubleClick(screen.getByText('remote-shell').closest('[data-roster-key]'));
    expect(onPick).toHaveBeenLastCalledWith({
      session: 'remote-shell', node: 'relay', ownerId: 'd'.repeat(32),
    });
  });

  it('renders working, idle and off cell state from the shared runtime contract', () => {
    const baseProps = {
      localNodeId: 'c'.repeat(32),
      cells: [
        { cell: 'Working Cell', tmuxSession: 'cell-working', tmux: true, active: true, engine: 'codex.responses' },
        { cell: 'Off Cell', tmuxSession: 'cell-off', tmux: false, active: false, engine: 'claude.native', model: 'claude-opus-4-1' },
      ],
      onPick: vi.fn(), onAddTile: vi.fn(), onSettings: vi.fn(),
    };
    const { rerender } = render(
      <Sidebar {...baseProps} sessions={[{
        name: 'cell-working', activity: 2, windows: 1,
        working: true, status: 'Implement activity UI', preview: 'gpt-5.6-sol',
      }]} />,
    );

    const workingRow = screen.getByText('Working Cell').closest('[data-roster-key]');
    expect(within(workingRow).getByText(/Implement activity UI/)).toBeTruthy();
    expect(workingRow.querySelector('.nc-dot').classList.contains('working')).toBe(true);
    const offRow = screen.getByText('Off Cell').closest('[data-roster-key]');
    expect(within(offRow).getByText('claude.native · claude-opus-4-1')).toBeTruthy();
    expect(offRow.querySelector('.nc-dot').classList.contains('on')).toBe(false);

    rerender(<Sidebar {...baseProps} sessions={[{
      name: 'cell-working', activity: 3, windows: 1,
      working: false, status: '', paneTitle: 'Dev', preview: 'gpt-5.6-sol',
    }]} />);
    const idleRow = screen.getByText('Working Cell').closest('[data-roster-key]');
    expect(within(idleRow).getByText('idle')).toBeTruthy();
    expect(idleRow.querySelector('.nc-dot').classList.contains('working')).toBe(false);
    expect(idleRow.querySelector('.nc-dot').classList.contains('on')).toBe(true);
  });

  it('keeps the working signal in collapsed desktop and routed remote cells', () => {
    const common = { onPick: vi.fn(), onAddTile: vi.fn(), onSettings: vi.fn() };
    const { container, rerender } = render(<Sidebar {...common} collapsed
      cells={[{ cell: 'Local Worker', tmuxSession: 'local-worker', tmux: true, active: true, engine: 'codex.native' }]}
      sessions={[{ name: 'local-worker', working: true, status: 'Build release' }]} />);
    expect(container.querySelector('.nc-mini-dot .nc-dot').classList.contains('working')).toBe(true);

    rerender(<Sidebar {...common} cells={[]} sessions={[]} nodeGroups={[{
      name: 'relay', label: 'Relay', route: ['relay'], status: 'up', instanceId: 'd'.repeat(32),
      sessions: [{ name: 'remote-worker', working: true, status: 'Review remote diff' }],
      cells: [{
        cell: 'Remote Worker', tmuxSession: 'remote-worker', tmux: true, active: true,
        engine: 'claude.native', key: 'relay:remote-worker',
      }],
      unmanaged: [], capabilities: [], engines: [],
    }]} />);
    const remoteRow = screen.getByText('Remote Worker').closest('[data-roster-key]');
    expect(within(remoteRow).getByText(/Review remote diff/)).toBeTruthy();
    expect(remoteRow.querySelector('.nc-dot').classList.contains('working')).toBe(true);
  });

  it('renames direct nodes through the server callback and keeps local node ordering', async () => {
    const prompt = vi.spyOn(window, 'prompt').mockReturnValue('Studio Mac');
    const alert = vi.spyOn(window, 'alert').mockImplementation(() => {});
    const onNodeRename = vi.fn(async () => true);
    const nodeGroups = [
      { name: 'relay', label: 'Relay', route: ['relay'], instanceId: 'd'.repeat(32), status: 'up', direct: true, sessions: [], unmanaged: [], cells: [] },
      { name: 'pixel', label: 'Pixel', route: ['relay', 'pixel'], instanceId: 'e'.repeat(32), status: 'up', sessions: [], unmanaged: [], cells: [] },
    ];
    render(<Sidebar nodeGroups={nodeGroups} onPick={vi.fn()} onAddTile={vi.fn()}
      onNodeRename={onNodeRename} onSettings={vi.fn()} />);

    fireEvent.contextMenu(screen.getByText('Relay').closest('.nc-node-title'));
    expect(prompt).toHaveBeenCalled();
    expect(onNodeRename).toHaveBeenCalledWith(nodeGroups[0], 'Studio Mac');
    expect(localStorage.getItem('nc_node_aliases_v1')).toBeNull();

    fireEvent.keyDown(screen.getByRole('button', { name: 'reorder Pixel' }), { key: 'ArrowUp' });
    expect(JSON.parse(localStorage.getItem('nc_node_order_v1'))[0]).toBe(`id:${'e'.repeat(32)}`);
    expect(alert).not.toHaveBeenCalled();
    prompt.mockRestore(); alert.mockRestore();
  });
});
