import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ pairNode: vi.fn() }));

vi.mock('../lib/api.js', () => ({ pairNode: mocks.pairNode }));
vi.mock('./QrScanModal.jsx', () => ({ default: () => null }));

import PairingCard from './PairingCard.jsx';

function pairingUrl() {
  const payload = {
    v: 2,
    instanceId: 'a'.repeat(32),
    port: 41820,
    label: 'Relay',
    invite: 'i'.repeat(43),
    name: 'home-relay',
    ssh: 'dag@relay.example',
    sshPort: 41822,
  };
  return `http://127.0.0.1:41820/#pair=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

describe('pairing SSH locale', () => {
  beforeEach(() => {
    localStorage.setItem('nc_lang', 'en');
    mocks.pairNode.mockReset();
  });

  it('apre automaticamente i campi locali dopo auth failure e conserva host e porta modificabili', async () => {
    const error = new Error('HTTP 502');
    error.data = {
      stage: 'ssh-ready',
      code: 'ssh-auth-failed',
      detail: 'SSH authentication rejected',
      hint: 'use the alias that works on this device',
      retryable: true,
    };
    mocks.pairNode.mockRejectedValueOnce(error);

    render(<PairingCard token="token" initial={pairingUrl()} autoStart />);

    await waitFor(() => expect(mocks.pairNode).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('SSH host or alias on this device')).toBeTruthy();
    expect(screen.getByText(/Aliases, agents and private keys stay local/)).toBeTruthy();
    expect(screen.getByDisplayValue('dag@relay.example').disabled).toBe(false);
    expect(screen.getByDisplayValue('41822').disabled).toBe(false);
  });
});
