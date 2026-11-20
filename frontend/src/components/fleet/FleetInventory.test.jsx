import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// i18n pass-through: le asserzioni usano le chiavi, non le traduzioni.
vi.mock('../../lib/i18n.js', () => ({ t: (k) => k }));

// Componente REALE, API mockata: qui si verifica quante volte il componente
// invoca il POST, non cosa risponde il server.
const api = vi.hoisted(() => ({
  fleetStatus: vi.fn(),
  getRouteConfig: vi.fn(),
  getRouteSessions: vi.fn(),
  fleetRestart: vi.fn(),
  fleetRemoveCell: vi.fn(),
  killSession: vi.fn(),
}));

vi.mock('../../lib/api.js', () => api);

import FleetInventory from './FleetInventory.jsx';

const cells = [
  { cell: 'C1', engine: 'claude', active: true, tmuxSession: 'cloud-C1' },
  { cell: 'C2', engine: 'claude', active: true, tmuxSession: 'cloud-C2' },
];

// Identità stabile: il default `targets = []` del componente è un array NUOVO a
// ogni render e l'effetto di poll lo ha fra le dipendenze, quindi senza questa
// costante il test entra nel ciclo infinito di poll (vedi il referto).
const NO_TARGETS = [];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Un solo POST tenuto pendente: il click successivo cade mentre il primo pende.
function renderPending() {
  const first = deferred();
  api.fleetStatus.mockResolvedValue({
    available: true,
    provider: 'builtin',
    capabilities: ['status', 'restart'],
    cells,
  });
  api.getRouteConfig.mockResolvedValue({ readonlyDefault: false });
  api.getRouteSessions.mockResolvedValue({ sessions: [] });
  api.fleetRestart.mockReturnValueOnce(first.promise);
  render(<FleetInventory token="tok" targets={NO_TARGETS} />);
  return { first };
}

async function restartButtons() {
  return waitFor(() => {
    const btns = screen.getAllByRole('button', { name: 'restart' });
    expect(btns).toHaveLength(2);
    return btns;
  });
}

describe('FleetInventory — Restart non manda due POST', () => {
  it('un doppio clic manda un solo fleetRestart e il pulsante si riabilita al settlement', async () => {
    const { first } = renderPending();
    const [c1] = await restartButtons();

    // due click sullo stesso pulsante prima che il primo POST sia concluso
    fireEvent.click(c1);
    fireEvent.click(c1);

    expect(api.fleetRestart).toHaveBeenCalledTimes(1);

    // il pulsante resta disabilitato finché il POST pende
    await waitFor(() => expect(c1.disabled).toBe(true));

    first.resolve({ ok: true });

    await waitFor(() => expect(c1.disabled).toBe(false));
    expect(api.fleetRestart).toHaveBeenCalledTimes(1);
  });

  it('un errore del POST rilascia il latch e il click successivo riparte', async () => {
    const { first } = renderPending();
    const [c1] = await restartButtons();

    fireEvent.click(c1);
    await waitFor(() => expect(c1.disabled).toBe(true));

    first.reject(new Error('restart failed'));

    await waitFor(() => expect(c1.disabled).toBe(false));

    api.fleetRestart.mockResolvedValueOnce({ ok: true });
    fireEvent.click(c1);
    await waitFor(() => expect(api.fleetRestart).toHaveBeenCalledTimes(2));
  });

  it('il latch è per coppia route/cella: una cella pendente non blocca la sorella', async () => {
    renderPending();
    const [c1, c2] = await restartButtons();

    api.fleetRestart.mockResolvedValueOnce({ ok: true });
    fireEvent.click(c1);
    fireEvent.click(c2);

    await waitFor(() => expect(api.fleetRestart).toHaveBeenCalledTimes(2));
    expect(api.fleetRestart.mock.calls[0][1]).toBe('C1');
    expect(api.fleetRestart.mock.calls[1][1]).toBe('C2');
  });
});
