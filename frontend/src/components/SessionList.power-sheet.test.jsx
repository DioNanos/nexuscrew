import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Il foglio di alimentazione dal roster mobile: ogni esito del
// `save and start` deve comportarsi come previsto — ok e benigni chiudono,
// gli errori veri restano nel foglio, cancel è sempre praticabile e lo
// stato della cella arriva dall'inventario vivo, non dalla copia d'apertura.

const fixture = vi.hoisted(() => ({ sessions: [], cells: [], nodes: [] }));

vi.mock('../lib/api.js', () => ({
  apiFetch: vi.fn(async (path) => ({
    json: async () => path === '/api/config'
      ? { version: '0.9.44', bind: '127.0.0.1', port: 41820, instanceId: 'c'.repeat(32) }
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
  getLiveHost: vi.fn(async () => ({ revision: 3, hostCell: null, threadStatus: null })),
  designateHostCell: vi.fn(async () => ({ revision: 4, hostCell: 'Live Cell' })),
  clearHostCell: vi.fn(async () => ({ revision: 5, hostCell: null })),
}));

vi.mock('../hooks/useNodes.js', () => ({ useNodes: () => fixture.nodes }));
vi.mock('../hooks/useLang.js', () => ({ useLang: () => ['en', vi.fn()] }));
vi.mock('./Terminal.jsx', () => ({ default: (props) => <div data-testid="peek-term" data-session={props.session} /> }));
vi.mock('./CellPanel.jsx', () => ({ default: (props) => <div data-testid="peek-panel" data-cell={props.cellId} /> }));

import SessionList from './SessionList.jsx';
import { fleetStatus, fleetUp } from '../lib/api.js';

function cell(cell, tmuxSession, live, engine = 'claude.native') {
  return { cell, tmuxSession, tmux: live, active: live, engine, key: '', degraded: false };
}

function session(name, activity = 1, extra = {}) {
  return { name, activity, windows: 1, attached: false, preview: `${name} preview`, ...extra };
}

function timeoutError() {
  return new DOMException('timeout', 'TimeoutError');
}

function duplicateError() {
  const e = new Error('sessione già in esecuzione');
  e.status = 409;
  e.data = { error: 'sessione già in esecuzione', code: 'SESSION_DUPLICATE', phase: 'preflight' };
  return e;
}

async function apriFoglioOffCell() {
  const user = userEvent.setup();
  render(<SessionList token="test-token" onPick={vi.fn()} onSettings={vi.fn()} />);
  await screen.findByText('Off Cell');
  await user.click(screen.getByRole('button', { name: 'power on Off Cell' }));
  const submit = await screen.findByRole('button', { name: 'save and start' });
  return { user, submit };
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
    sessions: [session('remote-live', 30)],
    cells: [cell('Relay Live', 'remote-live', true)],
    unmanaged: [],
  }];
});

describe('power sheet outcomes', () => {
  it('ok: il foglio si chiude e resta chiuso, senza notice', async () => {
    const { user, submit } = await apriFoglioOffCell();
    await user.click(submit);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'save and start' })).toBeNull());
    expect(document.querySelector('.nc-notice')).toBeNull();
    expect(fleetUp).toHaveBeenCalledWith('test-token', expect.objectContaining({ cell: 'Off Cell' }), []);
  });

  it('timeout: il foglio si chiude e la notice di avvio in corso appare sul roster', async () => {
    fleetUp.mockRejectedValueOnce(timeoutError());
    const { user, submit } = await apriFoglioOffCell();
    await user.click(submit);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'save and start' })).toBeNull());
    expect(document.querySelector('.nc-notice').textContent)
      .toBe('start still in progress: check the cell state');
  });

  it('409 SESSION_DUPLICATE: esito benigno, foglio chiuso e notice «already running»', async () => {
    fleetUp.mockRejectedValueOnce(duplicateError());
    const { user, submit } = await apriFoglioOffCell();
    await user.click(submit);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'save and start' })).toBeNull());
    expect(document.querySelector('.nc-notice').textContent).toBe('already running');
  });

  it('errore vero 500: il foglio resta aperto con il messaggio e i pulsanti riabilitati', async () => {
    const boom = new Error('boom'); boom.status = 500;
    fleetUp.mockRejectedValueOnce(boom);
    const { user, submit } = await apriFoglioOffCell();
    await user.click(submit);
    const foglio = () => document.querySelector('form.nc-power-sheet');
    await waitFor(() => expect(within(foglio()).getByText('boom')).toBeTruthy());
    const ancora = within(foglio()).getByRole('button', { name: 'save and start' });
    expect(ancora.disabled).toBe(false);
    expect(within(foglio()).getByRole('button', { name: 'cancel' }).disabled).toBe(false);
  });

  it('cancel durante il lavoro: chiude il foglio, l\'azione continua senza errori', async () => {
    let resolveUp = null;
    fleetUp.mockImplementationOnce(() => new Promise((res) => { resolveUp = res; }));
    const { user, submit } = await apriFoglioOffCell();
    await user.click(submit);
    // Lavoro in corso: il primario dice cosa sta facendo e cancel resta attivo.
    expect(screen.getByRole('button', { name: 'starting…' }).disabled).toBe(true);
    const cancel = screen.getByRole('button', { name: 'cancel' });
    expect(cancel.disabled).toBe(false);
    await user.click(cancel);
    expect(screen.queryByRole('button', { name: 'starting…' })).toBeNull();
    // L'azione prosegue in background: l'esito arriva senza errori.
    await act(async () => { resolveUp({}); });
    expect(screen.queryByRole('button', { name: 'starting…' })).toBeNull();
  });

  it('stato fresco: la cella che parte mentre il foglio è aperto diventa «running»', async () => {
    const user = userEvent.setup();
    render(<SessionList token="test-token" onPick={vi.fn()} onSettings={vi.fn()} />);
    await screen.findByText('Off Cell');
    await user.click(screen.getByRole('button', { name: 'power on Off Cell' }));
    await screen.findByRole('button', { name: 'save and start' });
    const foglio = () => document.querySelector('form.nc-power-sheet');
    expect(within(foglio()).getByText('stopped')).toBeTruthy();

    // La cella si accende nell'inventario (il poll la rileva entro il ciclo).
    fixture.cells = fixture.cells.map((c) => (c.cell === 'Off Cell' ? cell('Off Cell', 'local-off', true) : c));
    await waitFor(() => {
      expect(within(foglio()).getByRole('button', { name: 'power off' }).disabled).toBe(false);
    }, { timeout: 7000 });
    expect(within(foglio()).getByText('running')).toBeTruthy();
  });

  it('la notice sopravvive al refresh successivo e sparisce solo col suo timer', async () => {
    fleetUp.mockRejectedValueOnce(timeoutError());
    const { user, submit } = await apriFoglioOffCell();
    await user.click(submit);
    await waitFor(() => expect(document.querySelector('.nc-notice')).toBeTruthy());
    const letturePrima = fleetStatus.mock.calls.length;

    // Un ciclo intero di refresh (4 s) passa e riesce: la notice deve restare.
    await new Promise((r) => { setTimeout(r, 4300); });
    expect(fleetStatus.mock.calls.length).toBeGreaterThan(letturePrima);
    expect(document.querySelector('.nc-notice').textContent)
      .toBe('start still in progress: check the cell state');

    // Poi se ne va da sola, senza che nessun refresh la cancelli prima.
    await waitFor(() => expect(document.querySelector('.nc-notice')).toBeNull(), { timeout: 8000 });
  });
});
