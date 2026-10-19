import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Il percorso reale della conferma: FleetTab (possiede la scrittura) +
// EngineEditor (possiede il dialogo), con l'API finta. Quello che si prova qui
// e' il contratto che il solo componente non puo' mostrare: un valore fuori
// scala non parte, una scrittura rifiutata non chiude il dialogo, e i valori
// inseriti restano li' per essere corretti.
const api = vi.hoisted(() => ({
  fleetStatus: vi.fn(), fleetDefinitions: vi.fn(), fleetDefineEngine: vi.fn(), fleetEditEngine: vi.fn(),
  fleetRemoveEngine: vi.fn(), fleetDefineCell: vi.fn(), fleetEditCell: vi.fn(), fleetRemoveCell: vi.fn(),
  fleetRestart: vi.fn(), fleetDown: vi.fn(), fleetImportCell: vi.fn(),
  fleetRestoreCells: vi.fn(), fleetRestoreEngines: vi.fn(), fleetCredentialStatus: vi.fn(),
  fleetSetCredential: vi.fn(), fleetRemoveCredential: vi.fn(), getRouteConfig: vi.fn(),
  fleetDefineModel: vi.fn(), fleetEditModel: vi.fn(), fleetRemoveModel: vi.fn(),
  fleetModelTest: vi.fn(), fleetEngineModels: vi.fn(),
}));
vi.mock('../lib/api.js', () => api);

import FleetTab from './FleetTab.jsx';

const ENGINE = {
  id: 'e1', label: 'Engine one',
  managed: { client: 'claude', provider: 'native', model: 'm1', permissionPolicy: 'unsafe' },
  managedInfo: { configured: true },
};
const DISCOVERY = {
  engine: 'e1', supported: true, source: 'api', status: 'api', stale: false, error: '',
  fetchedAt: 1, cap: 128,
  models: [{
    id: 'm1', contextWindow: 8192, maxTokens: 4096,
    fieldSources: { contextWindow: 'public', maxTokens: 'public' }, inApi: true,
  }],
};

function definitions() {
  return { engines: [ENGINE], cells: [], models: [], managedCatalog: [] };
}

async function openMakeItMine() {
  const user = userEvent.setup();
  const view = render(<FleetTab token="tok" readonly={false} />);
  const label = await screen.findByText('Engine one');
  const row = label.closest('.nc-fleet-item');
  await user.click(within(row).getByRole('button', { name: 'edit' }));
  await screen.findByRole('region', { name: 'Models' });
  await user.click(await screen.findByRole('button', { name: 'Make it mine: m1' }));
  const dialog = await screen.findByRole('dialog', { name: 'Confirm the values of m1' });
  return { view, user, dialog };
}

function writes() {
  return api.fleetDefineModel.mock.calls.length + api.fleetEditModel.mock.calls.length;
}

describe('make it mine — il percorso reale', () => {
  beforeEach(() => {
    localStorage.setItem('nc_lang', 'en');
    HTMLElement.prototype.scrollIntoView = vi.fn();
    for (const mock of Object.values(api)) mock.mockReset();
    api.fleetStatus.mockResolvedValue({
      provider: 'builtin', engines: [], cells: [],
      capabilities: ['definitions', 'edit', 'define', 'remove', 'model-discovery', 'edit-model'],
    });
    api.fleetDefinitions.mockImplementation(async () => definitions());
    api.fleetCredentialStatus.mockResolvedValue({ credentials: [] });
    api.getRouteConfig.mockResolvedValue({ readonlyDefault: false });
    api.fleetEngineModels.mockResolvedValue(DISCOVERY);
    api.fleetDefineModel.mockResolvedValue({ ok: true });
    api.fleetEditModel.mockResolvedValue({ ok: true });
  });

  it('a single field at 512 shows the error, keeps Confirm disabled and writes nothing', async () => {
    const { user, dialog } = await openMakeItMine();
    const input = within(dialog).getByLabelText('context');
    await user.clear(input);
    await user.type(input, '512');
    expect(within(dialog).getByText(/between 1024 and 100000000/)).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Confirm' }).disabled).toBe(true);
    expect(writes()).toBe(0);
    expect(screen.getByRole('dialog', { name: 'Confirm the values of m1' })).toBeTruthy();
  });

  it('a row with context 512 and output 4096 sends no partial request', async () => {
    const { user, dialog } = await openMakeItMine();
    const input = within(dialog).getByLabelText('context');
    await user.clear(input);
    await user.type(input, '512');
    expect(within(dialog).getByRole('button', { name: 'Confirm' }).disabled).toBe(true);
    expect(writes()).toBe(0);
  });

  it('a rejected write keeps the dialog open, the values typed and the error visible, past a refresh', async () => {
    api.fleetDefineModel.mockRejectedValueOnce(new Error('write refused'));
    const { user, dialog } = await openMakeItMine();
    const input = within(dialog).getByLabelText('context');
    await user.clear(input);
    await user.type(input, '9000');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(api.fleetDefineModel).toHaveBeenCalledTimes(1));
    const still = await screen.findByRole('dialog', { name: 'Confirm the values of m1' });
    expect(within(still).getByLabelText('context').value).toBe('9000');
    expect(within(still).getByText('write refused')).toBeTruthy();
    // Il refresh periodico di FleetTab azzera il SUO errore: quello del
    // dialogo e la bozza devono restare.
    await new Promise((resolve) => { setTimeout(resolve, 5300); });
    const later = screen.getByRole('dialog', { name: 'Confirm the values of m1' });
    expect(within(later).getByLabelText('context').value).toBe('9000');
    expect(within(later).getByText('write refused')).toBeTruthy();
  }, 15000);

  it('a valid value writes once, closes the dialog and reloads the view', async () => {
    const { user, dialog } = await openMakeItMine();
    const input = within(dialog).getByLabelText('context');
    await user.clear(input);
    await user.type(input, '9000');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(api.fleetDefineModel).toHaveBeenCalledTimes(1));
    expect(api.fleetDefineModel).toHaveBeenCalledWith('tok', { id: 'm1', engine: 'e1', contextWindow: 9000, maxTokens: 4096 }, []);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Confirm the values of m1' })).toBeNull());
    expect(api.fleetEngineModels.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
