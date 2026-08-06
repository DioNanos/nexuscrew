import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// Comportamento dell'invito, non forma del sorgente. Sostituisce la guardia
// testuale di tests/ui-fleet-controls.test.js (NC-N), che fissava con una
// regex un ramo morto: la delega federata risponde 404 dal 2026-08-04, quindi
// su un'installazione accoppiata a un hub il bottone non poteva mai riuscire,
// e nessuna lettura del sorgente poteva accorgersene.
const mocks = vi.hoisted(() => ({
  createPeerInvite: vi.fn(),
  getSettings: vi.fn(), getPeers: vi.fn(), getTopology: vi.fn(), getVlNodes: vi.fn(),
}));

vi.mock('../lib/api.js', async () => {
  const actual = await vi.importActual('../lib/api.js');
  return { ...actual, createPeerInvite: mocks.createPeerInvite };
});

import { NodesTab } from './SettingsPanel.jsx';

// Un peer outbound: e' esattamente la condizione in cui il bottone era rotto.
const outboundHub = {
  name: 'cloud-alpacalibre-com', label: 'VPS_Cloud', direction: 'outbound',
  ssh: 'dag@cloud.example', nodeId: 'aaaa1111', kind: 'direct', tunnel: { status: 'up' },
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  mocks.createPeerInvite.mockReset();
  mocks.createPeerInvite.mockResolvedValue({ pairingUrl: 'http://127.0.0.1:41777/#pair=abc' });
});

const renderTab = (nodes) => render(
  <NodesTab token="token" nodes={nodes} roster={[]} readonly={false}
    settings={{ deviceName: 'Pixel', nodeId: 'bbbb2222', localName: 'pixel' }}
    refresh={vi.fn()} refreshAliases={vi.fn()} />,
);

describe('invito di peering', () => {
  it('conia sempre per l\'installazione locale, anche con un hub outbound collegato', async () => {
    renderTab([outboundHub]);

    // Il campo dell'indirizzo deve esserci: prima, con un hub outbound, il form
    // locale spariva del tutto e restava solo la delega.
    const ssh = await screen.findByPlaceholderText('user@host');
    fireEvent.change(ssh, { target: { value: 'dag@pixel.example' } });
    fireEvent.click(screen.getByRole('button', { name: /create link/i }));

    await waitFor(() => expect(mocks.createPeerInvite).toHaveBeenCalledTimes(1));
    const [, body, route] = mocks.createPeerInvite.mock.calls[0];
    // Nessuna route = nessuna federazione = l'unico percorso che il backend accetta.
    expect(route).toBeUndefined();
    expect(body.ssh).toBe('dag@pixel.example');
  });

  it('dice in quale installazione entrera\' il dispositivo', async () => {
    renderTab([outboundHub]);
    expect(await screen.findByText(/The new device will join/i)).toBeTruthy();
    expect(screen.getByText('Pixel')).toBeTruthy();
  });

  it('rinvia all\'hub invece di lasciar fallire chi cerca l\'invito remoto', async () => {
    renderTab([outboundHub]);
    // Il rinvio si vede PRIMA di tentare, non come errore dopo un 404.
    expect(await screen.findByText(/minted on the hub/i)).toBeTruthy();
    expect(mocks.createPeerInvite).not.toHaveBeenCalled();
  });

  it('senza indirizzo SSH non si conia nulla', async () => {
    renderTab([outboundHub]);
    const button = await screen.findByRole('button', { name: /create link/i });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(mocks.createPeerInvite).not.toHaveBeenCalled();
  });

  it('senza hub outbound il pannello si comporta allo stesso modo', async () => {
    renderTab([]);
    const ssh = await screen.findByPlaceholderText('user@host');
    fireEvent.change(ssh, { target: { value: 'dag@solo.example' } });
    fireEvent.click(screen.getByRole('button', { name: /create link/i }));
    await waitFor(() => expect(mocks.createPeerInvite).toHaveBeenCalledTimes(1));
    expect(mocks.createPeerInvite.mock.calls[0][2]).toBeUndefined();
  });
});
