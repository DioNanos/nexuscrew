import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import Sidebar from './Sidebar.jsx';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
});

describe('Sidebar session identity', () => {
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
});
