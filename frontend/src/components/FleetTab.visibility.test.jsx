import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';

// Il foglio Fleet interroga tre route ogni 5 s. Con il documento nascosto
// (finestra in secondo piano) quel ciclo deve FERMARSI — l'operatore non sta
// guardando — e ripartire con un giro immediato alla riapparsa, cosi' chi
// torna trova lo stato fresco e non l'ultimo scatto di prima.
const api = vi.hoisted(() => ({
  fleetStatus: vi.fn(), fleetDefinitions: vi.fn(), fleetCredentialStatus: vi.fn(),
  getRouteConfig: vi.fn(),
  fleetDefineEngine: vi.fn(), fleetEditEngine: vi.fn(), fleetRemoveEngine: vi.fn(),
  fleetDefineCell: vi.fn(), fleetEditCell: vi.fn(), fleetRemoveCell: vi.fn(),
  fleetRestart: vi.fn(), fleetUp: vi.fn(), fleetDown: vi.fn(), fleetImportCell: vi.fn(),
  fleetRestoreCells: vi.fn(), fleetRestoreEngines: vi.fn(),
  fleetSetCredential: vi.fn(), fleetRemoveCredential: vi.fn(),
  fleetDefineModel: vi.fn(), fleetRemoveModel: vi.fn(), fleetModelTest: vi.fn(),
}));

vi.mock('../lib/api.js', () => api);

import FleetTab from './FleetTab.jsx';

const setVis = (stato) => {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: stato });
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeEach(() => {
  localStorage.setItem('nc_lang', 'en');
  HTMLElement.prototype.scrollIntoView = vi.fn();
  for (const mock of Object.values(api)) mock.mockReset();
  api.fleetStatus.mockResolvedValue({
    provider: 'builtin', capabilities: ['definitions', 'credentials'],
    engines: [], cells: [],
  });
  api.getRouteConfig.mockResolvedValue({ readonlyDefault: false });
  api.fleetDefinitions.mockResolvedValue({ engines: [], cells: [], models: [], managedCatalog: [] });
  api.fleetCredentialStatus.mockResolvedValue({ credentials: [] });
});

afterEach(() => { setVis('visible'); vi.useRealTimers(); });

describe('cadenza adattiva del foglio Fleet', () => {
  it('documento nascosto: il ciclo dei 5 s si ferma; alla riapertura un giro subito', async () => {
    vi.useFakeTimers();
    render(<FleetTab token="t" readonly={false} />);
    // Il primo giro parte al mount (documento non nascosto).
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.fleetStatus).toHaveBeenCalled();
    const prima = api.fleetStatus.mock.calls.length;

    setVis('hidden');
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(api.fleetStatus.mock.calls.length).toBe(prima);

    setVis('visible');
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.fleetStatus.mock.calls.length).toBe(prima + 1);
  });
});
