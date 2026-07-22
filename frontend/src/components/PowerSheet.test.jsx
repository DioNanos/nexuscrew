import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import PowerSheet from './PowerSheet.jsx';
import { fleetDefinitions, fleetStatus } from '../lib/api.js';

vi.mock('../hooks/useLang.js', () => ({ useLang: () => 'en' }));
vi.mock('../lib/api.js', () => ({
  fleetStatus: vi.fn(),
  fleetDefinitions: vi.fn(),
}));

describe('PowerSheet Agy primary', () => {
  beforeEach(() => {
    localStorage.setItem('nc_lang', 'en');
    vi.clearAllMocks();
    fleetStatus.mockResolvedValue({
      provider: 'builtin',
      capabilities: ['edit', 'definitions'],
      engines: [{ id: 'agy.native', models: [] }],
    });
    fleetDefinitions.mockResolvedValue({
      engines: [{
        id: 'agy.native', label: 'Agy',
        managed: { client: 'agy', provider: 'native', model: '', permissionPolicy: 'standard' },
        managedInfo: { configured: true, models: [] },
      }],
    });
  });

  it('offers model and standard/unsafe and submits the selected policy', async () => {
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<PowerSheet
      cell={{
        cell: 'agy.native', active: false, engine: 'agy.native', model: '', models: {},
        permissionPolicy: 'standard', permissionPolicies: { 'agy.native': 'standard' }, boot: false,
      }}
      token="test-token" onConfirm={onConfirm} onClose={onClose}
    />);

    const permissions = await screen.findByLabelText('Permissions');
    expect(screen.getByRole('option', { name: 'unsafe · bypass approvals/sandbox' })).toBeTruthy();
    fireEvent.change(permissions, { target: { value: 'unsafe' } });
    fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'model-x' } });
    fireEvent.click(screen.getByRole('button', { name: 'save and start' }));

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith({
      action: 'up', engine: 'agy.native', model: 'model-x', permissionPolicy: 'unsafe', boot: false,
    }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
