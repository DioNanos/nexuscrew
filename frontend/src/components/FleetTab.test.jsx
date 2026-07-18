import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({
  fleetStatus: vi.fn(), fleetDefinitions: vi.fn(), fleetDefineEngine: vi.fn(), fleetEditEngine: vi.fn(),
  fleetRemoveEngine: vi.fn(), fleetDefineCell: vi.fn(), fleetEditCell: vi.fn(), fleetRemoveCell: vi.fn(),
  fleetRestart: vi.fn(), fleetUp: vi.fn(), fleetDown: vi.fn(), fleetImportCell: vi.fn(),
  fleetRestoreCells: vi.fn(), fleetRestoreEngines: vi.fn(), fleetCredentialStatus: vi.fn(),
  fleetSetCredential: vi.fn(), fleetRemoveCredential: vi.fn(), getRouteConfig: vi.fn(),
}));

vi.mock('../lib/api.js', () => api);

import FleetTab from './FleetTab.jsx';

const catalog = [
  { id: 'claude.native', client: 'claude', clientLabel: 'Claude Code', provider: 'native', label: 'Anthropic', default: true, protocol: 'anthropic_messages', permissionPolicyDefault: 'unsafe', supportsUnsafe: true, rc: true },
  { id: 'claude.openrouter', client: 'claude', clientLabel: 'Claude Code', provider: 'openrouter', label: 'OpenRouter', protocol: 'anthropic_messages', permissionPolicyDefault: 'unsafe', supportsUnsafe: true, requiresModel: true, credentialEnv: 'OPENROUTER_API_KEY', authConfigured: false, credentialSource: 'missing', credentialUsedBy: [], notice: 'claude-openrouter' },
];

function definitions() {
  return {
    engines: [{ id: 'claude.native', label: 'Claude Code', rc: true, managed: { client: 'claude', provider: 'native', model: '', permissionPolicy: 'unsafe' }, managedInfo: { configured: true } }],
    cells: [], managedCatalog: catalog,
  };
}

describe('FleetTab engine + KEY save ordering', () => {
  beforeEach(() => {
    localStorage.setItem('nc_lang', 'en');
    HTMLElement.prototype.scrollIntoView = vi.fn();
    for (const mock of Object.values(api)) mock.mockReset();
    api.fleetStatus.mockResolvedValue({ provider: 'builtin', capabilities: ['definitions', 'edit', 'credentials', 'restore'], engines: [], cells: [] });
    api.fleetDefinitions.mockImplementation(async () => definitions());
    api.fleetCredentialStatus.mockResolvedValue({ credentials: [] });
    api.getRouteConfig.mockResolvedValue({ readonlyDefault: false });
    api.fleetDefineEngine.mockResolvedValue({ ok: true, activeCells: [] });
    api.fleetEditEngine.mockResolvedValue({ ok: true, activeCells: [] });
  });

  it('defines first, preserves a recoverable editor on key failure, and retries without duplicate creation', async () => {
    const user = userEvent.setup();
    api.fleetSetCredential
      .mockRejectedValueOnce(new Error('synthetic write failure'))
      .mockResolvedValueOnce({ credentials: [] });
    render(<FleetTab token="token" readonly={false} />);
    await screen.findByText('Engines');
    const addButtons = screen.getAllByRole('button', { name: '+ add' });
    await user.click(addButtons[addButtons.length - 1]);
    const dialog = screen.getByRole('dialog');
    const providerSelect = dialog.querySelectorAll('.nc-fleet-pair select')[1];
    fireEvent.change(providerSelect, { target: { value: 'claude.openrouter' } });
    fireEvent.change(within(dialog).getByPlaceholderText('model (required)'), { target: { value: 'test/model' } });
    await user.type(within(dialog).getByLabelText('Value for OPENROUTER_API_KEY'), 'synthetic-ui-key');
    await user.click(within(dialog).getByRole('button', { name: 'save' }));

    expect((await within(dialog).findByRole('alert')).textContent).toContain('Engine created; the key was not saved.');
    expect(api.fleetDefineEngine).toHaveBeenCalledTimes(1);
    expect(api.fleetSetCredential).toHaveBeenCalledTimes(1);
    expect(api.fleetDefineEngine.mock.calls[0][1]).not.toHaveProperty('credentialValue');
    expect(JSON.stringify(api.fleetDefineEngine.mock.calls[0][1])).not.toContain('synthetic-ui-key');
    expect(within(dialog).getByText(/edit claude\.openrouter/i)).toBeTruthy();

    await user.click(within(dialog).getByRole('button', { name: 'save' }));
    await waitFor(() => expect(api.fleetEditEngine).toHaveBeenCalledTimes(1));
    expect(api.fleetDefineEngine).toHaveBeenCalledTimes(1);
    expect(api.fleetSetCredential).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('shows an honest loading state before fleet status resolves', async () => {
    let resolveStatus;
    api.fleetStatus.mockReturnValueOnce(new Promise((resolve) => { resolveStatus = resolve; }));
    render(<FleetTab token="token" readonly={false} />);
    expect(screen.getByText('Loading the Fleet editor…')).toBeTruthy();
    expect(screen.queryByText('The Fleet editor is unavailable at this location.')).toBeNull();
    resolveStatus({ provider: 'builtin', capabilities: ['definitions', 'edit'], engines: [], cells: [] });
    await screen.findByText('Engines');
  });

  it('distinguishes a status fetch failure from a disabled provider', async () => {
    api.fleetStatus.mockRejectedValue(new Error('synthetic status failure'));
    render(<FleetTab token="token" readonly={false} />);
    await screen.findByText('Unable to load the Fleet editor.');
    expect(screen.getByText('synthetic status failure')).toBeTruthy();
    expect(screen.queryByText('The Fleet editor is unavailable at this location.')).toBeNull();
  });

  it('shows the backend reason when the provider is intentionally unavailable', async () => {
    api.fleetStatus.mockResolvedValue({
      available: false, provider: 'disabled', capabilities: [],
      reason: 'fleet.json missing or invalid (fail-closed)',
    });
    render(<FleetTab token="token" readonly={false} />);
    await screen.findByText(/fleet\.json missing or invalid/);
    expect(screen.getByText(/The Fleet editor is unavailable at this location/)).toBeTruthy();
    expect(screen.queryByText('Unable to load the Fleet editor.')).toBeNull();
  });
});
