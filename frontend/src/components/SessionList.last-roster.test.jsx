import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const fixture = vi.hoisted(() => ({ sessions: [], cells: [] }));

vi.mock('../lib/api.js', () => ({
  apiFetch: vi.fn(async (path) => ({ json: async () => (path === '/api/config' ? { version: '0.9.53', instanceId: 'c'.repeat(32) } : { sessions: fixture.sessions }) })),
  seenKey: (s) => `nc_seen_${s}`,
  fleetStatus: vi.fn(async () => ({ available: true, capabilities: [], cells: fixture.cells })),
  fleetDefinitions: vi.fn(async () => ({ engines: [] })),
  fleetUp: vi.fn(), fleetDown: vi.fn(), fleetBoot: vi.fn(), killSession: vi.fn(), nodeAction: vi.fn(),
  renameNodeLabel: vi.fn(), setSessionTechnical: vi.fn(),
  getLiveHost: vi.fn(async () => ({ revision: 1, hostCell: null, threadStatus: null })),
  designateHostCell: vi.fn(), clearHostCell: vi.fn(),
}));
vi.mock('../hooks/useNodes.js', () => ({ useNodes: () => [] }));
vi.mock('../hooks/useLang.js', () => ({ useLang: () => ['en', vi.fn()] }));

import SessionList from './SessionList.jsx';
import { fleetStatus } from '../lib/api.js';

const cell = (name, tmux, live) => ({ cell: name, tmuxSession: tmux, tmux: live, active: live, engine: 'claude.native', key: '', degraded: false });

beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); localStorage.setItem('nc_lang', 'en');
  fixture.sessions = [{ name: 'cloud-Dev', activity: 5, windows: 1, attached: false, preview: 'x' }];
  fixture.cells = [cell('Dev', 'cloud-Dev', true), cell('Fork', 'cloud-Fork', false)];
  fleetStatus.mockImplementation(async () => ({ available: true, capabilities: [], cells: fixture.cells }));
});

describe('ultimo roster buono (O1: PWA riaperta con il fleet in errore)', () => {
  it('con il fleet in errore all\'apertura, le celle spente dell\'ultima lettura buona restano in lista', async () => {
    const first = render(<SessionList token="t" onPick={vi.fn()} onSettings={vi.fn()} />);
    expect(await screen.findByText('Fork')).toBeTruthy();
    first.unmount();
    // «PWA riaperta»: stato in memoria perso, il fleet non risponde.
    fleetStatus.mockRejectedValue(new Error('fetch failed'));
    render(<SessionList token="t" onPick={vi.fn()} onSettings={vi.fn()} />);
    expect(await screen.findByText('Fork')).toBeTruthy();
    expect(screen.getByText('Fleet read failed: the cell list may not be up to date.')).toBeTruthy();
  });

  it('senza un roster buono salvato il fleet in errore resta una lista senza celle (nessuna invenzione)', async () => {
    fleetStatus.mockRejectedValue(new Error('fetch failed'));
    render(<SessionList token="t" onPick={vi.fn()} onSettings={vi.fn()} />);
    expect(await screen.findByText('Fleet read failed: the cell list may not be up to date.')).toBeTruthy();
    expect(screen.queryByText('Fork')).toBeNull();
  });

  it('un fleet spento per scelta svuota davvero la lista e cancella il roster salvato', async () => {
    const first = render(<SessionList token="t" onPick={vi.fn()} onSettings={vi.fn()} />);
    await screen.findByText('Fork');
    fleetStatus.mockResolvedValue({ available: false, reason: 'fleet disabilitata (fleetEnabled=false)', provider: 'disabled' });
    fireEvent.click(screen.getByRole('button', { name: 'refresh' }));
    await waitFor(() => expect(screen.queryByText('Fork')).toBeNull());
    first.unmount();
    fleetStatus.mockRejectedValue(new Error('fetch failed'));
    render(<SessionList token="t" onPick={vi.fn()} onSettings={vi.fn()} />);
    await screen.findByText('Fleet read failed: the cell list may not be up to date.');
    expect(screen.queryByText('Fork')).toBeNull();
  });
});
