import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

// i18n pass-through: i test verificano chiavi/contenuto, non traduzioni.
vi.mock('../../lib/i18n.js', () => ({ t: (k) => k }));

// API mock minimale per FleetTab: refresh() chiama fleetStatus, getRouteConfig,
// fleetDefinitions, fleetCredentialStatus al mount. Una cella needsRepair con
// una cwd foreign viene restituita da definitions().
const fixture = vi.hoisted(() => ({
  status: { available: true, provider: 'builtin', capabilities: ['status', 'up', 'down', 'restart', 'edit', 'define', 'remove', 'definitions', 'credentials'], cells: [], engines: [] },
  defs: {
    engines: [{ id: 'claude', label: 'Claude' }],
    cells: [{ id: 'Orphan', engine: 'claude', cwd: '/home/foreign/secret/device/path', needsRepair: true }],
  },
}));

vi.mock('../../lib/api.js', () => ({
  fleetStatus: vi.fn(async () => fixture.status),
  fleetDefinitions: vi.fn(async () => fixture.defs),
  fleetDefineEngine: vi.fn(async () => ({})),
  fleetEditEngine: vi.fn(async () => ({})),
  fleetRemoveEngine: vi.fn(async () => ({})),
  fleetDefineCell: vi.fn(async () => ({})),
  fleetEditCell: vi.fn(async () => ({})),
  fleetRemoveCell: vi.fn(async () => ({})),
  fleetRestart: vi.fn(async () => ({})),
  fleetUp: vi.fn(async () => ({})),
  fleetDown: vi.fn(async () => ({})),
  fleetImportCell: vi.fn(async () => ({})),
  fleetRestoreCells: vi.fn(async () => ({})),
  fleetRestoreEngines: vi.fn(async () => ({})),
  fleetCredentialStatus: vi.fn(async () => ({ credentials: [] })),
  fleetSetCredential: vi.fn(async () => ({ credentials: [] })),
  fleetRemoveCredential: vi.fn(async () => ({ credentials: [] })),
  getRouteConfig: vi.fn(async () => ({ readonlyDefault: false })),
}));

import FleetTab from '../FleetTab.jsx';

const FOREIGN = '/home/foreign/secret/device/path';

function renderTab(over = {}) {
  return render(<FleetTab token="tok" targets={[]} {...over} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.defs.cells = [{ id: 'Orphan', engine: 'claude', cwd: FOREIGN, needsRepair: true }];
});

afterEach(() => { vi.restoreAllMocks(); });

describe('FleetTab — needsRepair badge', () => {
  it('shows a repair badge and NOT the source-device absolute cwd', async () => {
    renderTab();
    // il badge (chiave i18n) compare dopo il refresh
    await waitFor(() => expect(screen.getByText('fleet-cwd-needs-repair')).toBeTruthy());
    // la cwd assoluta foreign del device sorgente NON e' renderizzata
    expect(screen.queryByText(FOREIGN)).toBeNull();
    expect(document.body.textContent).not.toContain(FOREIGN);
  });

  it('shows a Repair button (not Edit) for a needsRepair cell', async () => {
    renderTab();
    const badge = await screen.findByText('fleet-cwd-needs-repair');
    // scope alla riga della cella (il section engines ha comunque un proprio Edit)
    const row = badge.closest('.nc-fleet-item');
    const inRow = within(row);
    expect(inRow.getByRole('button', { name: 'fleet-cwd-repair' })).toBeTruthy();
    // Edit non compare per la cella needsRepair (la repair e' l'azione owner-authorized)
    expect(inRow.queryByRole('button', { name: 'edit' })).toBeNull();
  });

  it('opening repair renders CwdRepairDialog; the foreign cwd stays hidden', async () => {
    renderTab();
    await waitFor(() => expect(screen.getByText('fleet-cwd-needs-repair')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'fleet-cwd-repair' }));
    // il dialog e' montato (help visibile)
    await waitFor(() => expect(screen.getByText('fleet-cwd-repair-help')).toBeTruthy());
    // il path foreign resta assente anche dentro il dialog
    expect(document.body.textContent).not.toContain(FOREIGN);
  });

  it('a healthy cell still shows its cwd and Edit (no regression)', async () => {
    fixture.defs.cells = [{ id: 'Dev', engine: 'claude', cwd: '/home/u/Dev', cwdRel: 'Dev' }];
    renderTab();
    const name = await screen.findByText('Dev');
    expect(name.tagName).toBe('B');
    // la cwd appare nel testo della riga (interpolata nello <small>)
    expect(document.body.textContent).toContain('/home/u/Dev');
    const row = name.closest('.nc-fleet-item');
    expect(within(row).getByRole('button', { name: 'edit' })).toBeTruthy();
    expect(screen.queryByText('fleet-cwd-needs-repair')).toBeNull();
  });
});
