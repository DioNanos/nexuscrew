import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ setNodeShare: vi.fn() }));

vi.mock('../lib/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  setNodeShare: mocks.setNodeShare,
}));
vi.mock('./PairingCard.jsx', () => ({ default: () => null }));

import { NodesTab } from './SettingsPanel.jsx';

const hub = {
  name: 'hub', label: 'Hub', ssh: 'hub', direction: 'outbound',
  shared: true, kind: 'direct', tunnel: { status: 'up' }, actions: {},
};

function renderNodes(refresh = vi.fn().mockResolvedValue(undefined)) {
  const view = render(<NodesTab
    token="token" nodes={[hub]} roster={[]} settings={{ deviceName: 'Phone' }}
    readonly={false} refresh={refresh} refreshAliases={vi.fn()}
  />);
  return { ...view, refresh, share: view.container.querySelector('.nc-node-share input') };
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  vi.clearAllMocks();
});

describe('Settings Share partial OFF convergence', () => {
  it.each([
    [
      { shared: false, revoked: false, reconcilePending: true },
      'Private state saved; hub revocation is still pending.',
    ],
    [
      { shared: false, revoked: true, localReconcilePending: true },
      'Hub revocation confirmed; the local tunnel still needs reconciliation.',
    ],
  ])('refreshes on bounded HTTP 502 state and preserves its pending cause', async (data, explanation) => {
    mocks.setNodeShare.mockRejectedValue(Object.assign(new Error('Share partial failure'), { data }));
    const { refresh, share } = renderNodes();
    expect(share).toBeTruthy();
    fireEvent.click(share);
    await waitFor(() => expect(mocks.setNodeShare).toHaveBeenCalledWith('token', 'hub', false));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(await screen.findByText((text) => text.includes(explanation))).toBeTruthy();
    expect(screen.getByText((text) => text.includes('Share partial failure'))).toBeTruthy();
  });

  it('does not refresh a generic failure without the authoritative shared:false body', async () => {
    mocks.setNodeShare.mockRejectedValue(Object.assign(new Error('transport failed'), { data: { error: 'transport failed' } }));
    const { refresh, share } = renderNodes();
    fireEvent.click(share);
    expect(await screen.findByText((text) => text.includes('transport failed'))).toBeTruthy();
    expect(refresh).not.toHaveBeenCalled();
  });
});

import { InputTab } from './SettingsPanel.jsx';

describe('Settings Input KeyBar layout', () => {
  it('renders the KeyBar layout select defaulting to full and writes compact', () => {
    render(<InputTab />);
    const select = screen.getByLabelText('Keypad layout');
    expect(select.value).toBe('full');
    fireEvent.change(select, { target: { value: 'compact' } });
    expect(JSON.parse(localStorage.getItem('nc_input_preferences_v1')).keybarLayout).toBe('compact');
  });

  it('restore input defaults resets the layout to full', () => {
    localStorage.setItem('nc_input_preferences_v1', JSON.stringify({
      terminalKeyboardGesture: 'single-tap', keybarKeepsKeyboardClosed: false,
      voiceKeepsKeyboardClosed: false, showKeybarEnter: false, keybarLayout: 'compact',
    }));
    render(<InputTab />);
    expect(screen.getByLabelText('Keypad layout').value).toBe('compact');
    fireEvent.click(screen.getByRole('button', { name: 'restore input defaults' }));
    const stored = JSON.parse(localStorage.getItem('nc_input_preferences_v1'));
    expect(stored.keybarLayout).toBe('full');
    expect(stored.showKeybarEnter).toBe(true);
  });

  it('stays editable regardless of server READONLY (InputTab is client-only)', () => {
    render(<InputTab />);
    expect(screen.getByLabelText('Keypad layout').disabled).toBe(false);
  });
});
