import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';

// La lista mobile consuma il treno condiviso: in 8 s fa le letture del treno
// (avvio + tick a 4 s + tick a 8 s) e NESSUNA in piu'. Anche il kick manuale
// dopo un'azione (qui il toggle technical) deve passare dal treno: una fetch
// propria del componente e' la ricaduta che questo test tiene chiusa.
const counts = vi.hoisted(() => ({ sessions: 0 }));

const fixture = vi.hoisted(() => ({ sessions: [], cells: [], nodes: [] }));

vi.mock('../lib/api.js', () => ({
  apiFetch: vi.fn(async (path) => {
    if (path === '/api/sessions') counts.sessions += 1;
    return {
      json: async () => path === '/api/config'
        ? { version: '0.8.14', bind: '127.0.0.1', port: 41820, instanceId: 'c'.repeat(32) }
        : { sessions: fixture.sessions },
    };
  }),
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
  getLiveHost: vi.fn(async () => ({ revision: 3, hostCell: null, threadStatus: null })),
  designateHostCell: vi.fn(async () => ({ revision: 4, hostCell: 'Live Cell' })),
  clearHostCell: vi.fn(async () => ({ revision: 5, hostCell: null })),
}));

vi.mock('../hooks/useNodes.js', () => ({ useNodes: () => fixture.nodes }));
vi.mock('../hooks/useLang.js', () => ({ useLang: () => ['en', vi.fn()] }));
vi.mock('./Terminal.jsx', () => ({ default: (props) => <div data-testid="peek-term" /> }));
vi.mock('./CellPanel.jsx', () => ({ default: () => <div data-testid="peek-panel" /> }));

import SessionList from './SessionList.jsx';

beforeEach(() => {
  counts.sessions = 0;
  fixture.sessions = [{ name: 'my-build-watch', activity: 5, windows: 1, attached: false, preview: 'watching build' }];
  fixture.cells = [];
  fixture.nodes = [];
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  vi.useFakeTimers();
});

describe('polling lista: le letture passano dal treno, anche i kick manuali', () => {
  it('mount + 8 s + kick technical: solo i cicli del treno, nessuna fetch propria', async () => {
    const token = 't';
    render(<SessionList token={token} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    // Il toggle technical e' un'azione seguita dal kick di refresh: il kick
    // chiede un ciclo al treno, NON una fetch della lista.
    const tasto = screen.getByRole('button', { name: /hide as technical session my-build-watch/i });
    await act(async () => { fireEvent.click(tasto); });
    await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
    // avvio + t4 + t8 = 3; il kick del treno puo' aggiungere AL PIU' il ciclo
    // corrente: mai una lettura in piu' dal componente.
    expect(counts.sessions).toBeLessThanOrEqual(4);
    expect(counts.sessions).toBeGreaterThanOrEqual(3);
    vi.useRealTimers();
  });
});
