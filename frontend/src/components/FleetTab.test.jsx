import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { t } from '../lib/i18n.js';

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
    // Il bottone si sceglie dalla SUA sezione, non per posizione nell'elenco:
    // prendere «l'ultimo + add» ha smesso di funzionare appena e' comparsa una
    // sezione sotto quella degli engine, e il test si e' rotto per una ragione
    // che non c'entrava con cio' che prova.
    const engineHead = [...document.querySelectorAll('.nc-fleet-section-head')]
      .find((head) => /Engines/.test(head.textContent || ''));
    await user.click(engineHead.querySelector('button'));
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

// --- panelUrl: la guardia che conta (0.9.1 punto 3) -------------------------
// Non "il campo esiste": scrivendo un panelUrl valido nel form, la cella lo
// RICEVE davvero — misurato sulla chiamata alla API di salvataggio, non
// dedotto dal fatto che il form non esplode.
describe('FleetTab panelUrl reaches the save call', () => {
  beforeEach(() => {
    localStorage.setItem('nc_lang', 'en');
    HTMLElement.prototype.scrollIntoView = vi.fn();
    for (const mock of Object.values(api)) mock.mockReset();
    api.fleetStatus.mockResolvedValue({ provider: 'builtin', capabilities: ['definitions', 'edit', 'credentials', 'restore'], engines: [], cells: [] });
    api.fleetDefinitions.mockImplementation(async () => definitions());
    api.fleetCredentialStatus.mockResolvedValue({ credentials: [] });
    api.getRouteConfig.mockResolvedValue({ readonlyDefault: false });
    api.fleetDefineCell.mockResolvedValue({ ok: true, id: 'Panel' });
  });

  it('creating a cell with a valid loopback panelUrl sends it to fleetDefineCell', async () => {
    render(<FleetTab token="token" readonly={false} />);
    await screen.findByText('Engines');
    const cellsHead = [...document.querySelectorAll('.nc-fleet-section-head')]
      .find((head) => /Cells/.test(head.textContent || ''));
    fireEvent.click(cellsHead.querySelector('button'));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByPlaceholderText('id'), { target: { value: 'Panel' } });
    fireEvent.change(within(dialog).getByPlaceholderText(t('cwd')), { target: { value: '/home/user/work' } });
    fireEvent.change(within(dialog).getByPlaceholderText(t('fleet-panel-url')), { target: { value: 'https://127.0.0.1:6901' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'save' }));
    await waitFor(() => expect(api.fleetDefineCell).toHaveBeenCalledTimes(1));
    expect(api.fleetDefineCell.mock.calls[0][1]).toMatchObject({ panelUrl: 'https://127.0.0.1:6901' });
  });

  it('creating a cell with panelUrl left blank never sends the field (no invented intent)', async () => {
    render(<FleetTab token="token" readonly={false} />);
    await screen.findByText('Engines');
    const cellsHead = [...document.querySelectorAll('.nc-fleet-section-head')]
      .find((head) => /Cells/.test(head.textContent || ''));
    fireEvent.click(cellsHead.querySelector('button'));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByPlaceholderText('id'), { target: { value: 'Panel' } });
    fireEvent.change(within(dialog).getByPlaceholderText(t('cwd')), { target: { value: '/home/user/work' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'save' }));
    await waitFor(() => expect(api.fleetDefineCell).toHaveBeenCalledTimes(1));
    expect(api.fleetDefineCell.mock.calls[0][1]).not.toHaveProperty('panelUrl');
  });
});
