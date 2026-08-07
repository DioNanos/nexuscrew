import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// La sezione modelli deve agire sul nodo che si sta GUARDANDO. Finche' la prova
// chiamava sempre `/api/fleet/model-test`, aprire il nodo remoto e provare un
// modello rispondeva a una domanda diversa da quella posta: «funziona QUI»
// invece di «funziona LA'», e la risposta sembrava valida.
const api = vi.hoisted(() => ({
  fleetStatus: vi.fn(), fleetDefinitions: vi.fn(), fleetDefineEngine: vi.fn(), fleetEditEngine: vi.fn(),
  fleetRemoveEngine: vi.fn(), fleetDefineCell: vi.fn(), fleetEditCell: vi.fn(), fleetRemoveCell: vi.fn(),
  fleetRestart: vi.fn(), fleetUp: vi.fn(), fleetDown: vi.fn(), fleetImportCell: vi.fn(),
  fleetRestoreCells: vi.fn(), fleetRestoreEngines: vi.fn(), fleetCredentialStatus: vi.fn(),
  fleetSetCredential: vi.fn(), fleetRemoveCredential: vi.fn(), getRouteConfig: vi.fn(),
  fleetDefineModel: vi.fn(), fleetRemoveModel: vi.fn(), fleetModelTest: vi.fn(),
}));

vi.mock('../lib/api.js', () => api);

import FleetTab from './FleetTab.jsx';

const MODELLO = { id: 'deepseek-v4-flash:0731', engine: 'claude.ollama-cloud' };

function definitions() {
  return {
    engines: [{ id: 'claude.ollama-cloud', label: 'Ollama', managed: { client: 'claude', provider: 'ollama-cloud', model: '', permissionPolicy: 'unsafe' }, managedInfo: { configured: true } }],
    cells: [], models: [MODELLO], managedCatalog: [],
  };
}

function modelRow() {
  const head = [...document.querySelectorAll('.nc-fleet-section-head')]
    .find((h) => /Declared models/.test(h.textContent || ''));
  expect(head).toBeTruthy();
  let node = head.nextElementSibling;
  while (node && !node.textContent.includes(MODELLO.id)) node = node.nextElementSibling;
  expect(node).toBeTruthy();
  return node;
}

describe('sezione modelli su un nodo remoto', () => {
  beforeEach(() => {
    localStorage.setItem('nc_lang', 'en');
    HTMLElement.prototype.scrollIntoView = vi.fn();
    for (const mock of Object.values(api)) mock.mockReset();
    api.fleetStatus.mockResolvedValue({
      provider: 'builtin',
      capabilities: ['definitions', 'edit', 'define', 'remove', 'model-test'],
      engines: [], cells: [],
    });
    api.fleetDefinitions.mockImplementation(async () => definitions());
    api.fleetCredentialStatus.mockResolvedValue({ credentials: [] });
    api.getRouteConfig.mockResolvedValue({ readonlyDefault: false });
    api.fleetModelTest.mockResolvedValue({ outcome: 'ok', latencyMs: 12 });
    api.fleetRemoveModel.mockResolvedValue({ ok: true });
  });

  it('prova il modello sul nodo guardato, non sul proprio', async () => {
    const user = userEvent.setup();
    render(<FleetTab token="tok" readonly={false} initialLocation="peer-b"
      targets={[{ route: ['peer-b'], label: 'peer-b', status: 'up' }]} />);
    await screen.findByText('Declared models');
    await user.click(within(modelRow()).getByRole('button', { name: 'Test against the API' }));
    await waitFor(() => expect(api.fleetModelTest).toHaveBeenCalled());
    // La route e' l'ultimo argomento: e' cio' che decide su QUALE nodo parte la
    // richiesta e con quale credenziale.
    expect(api.fleetModelTest).toHaveBeenCalledWith('tok', MODELLO.engine, MODELLO.id, ['peer-b']);
    expect(await within(modelRow()).findByText(/responds/)).toBeTruthy();
  });

  it('rimuove il modello sul nodo guardato', async () => {
    const user = userEvent.setup();
    render(<FleetTab token="tok" readonly={false} initialLocation="peer-b"
      targets={[{ route: ['peer-b'], label: 'peer-b', status: 'up' }]} />);
    await screen.findByText('Declared models');
    await user.click(within(modelRow()).getByRole('button', { name: '×' }));
    await waitFor(() => expect(api.fleetRemoveModel).toHaveBeenCalledWith('tok', MODELLO.id, MODELLO.engine, ['peer-b']));
  });

  it('in locale la route resta vuota', async () => {
    const user = userEvent.setup();
    render(<FleetTab token="tok" readonly={false} />);
    await screen.findByText('Declared models');
    await user.click(within(modelRow()).getByRole('button', { name: 'Test against the API' }));
    await waitFor(() => expect(api.fleetModelTest).toHaveBeenCalledWith('tok', MODELLO.engine, MODELLO.id, []));
  });

  it('un nodo remoto in sola lettura spegne la prova invece di offrire un 403', async () => {
    // La federazione rifiuta `model-test` sotto READONLY: un bottone acceso che
    // torna sempre un errore e' peggio di un bottone assente.
    api.getRouteConfig.mockResolvedValue({ readonlyDefault: true });
    render(<FleetTab token="tok" readonly={false} initialLocation="peer-b"
      targets={[{ route: ['peer-b'], label: 'peer-b', status: 'up' }]} />);
    await screen.findByText('Declared models');
    await waitFor(() => expect(within(modelRow()).getByRole('button', { name: 'Test against the API' }).disabled).toBe(true));
  });

  it('in LOCALE la sola lettura non tocca la prova: e\' una diagnosi', async () => {
    // Il gate READONLY vive sulla via federata. Spegnere il bottone anche in
    // locale toglierebbe una capacita' che il server concede.
    render(<FleetTab token="tok" readonly />);
    await screen.findByText('Declared models');
    expect(within(modelRow()).getByRole('button', { name: 'Test against the API' }).disabled).toBe(false);
  });

  it('un nodo che non espone la capability non mostra affatto la prova', async () => {
    api.fleetStatus.mockResolvedValue({
      provider: 'builtin', capabilities: ['definitions', 'edit', 'define', 'remove'], engines: [], cells: [],
    });
    render(<FleetTab token="tok" readonly={false} initialLocation="peer-b"
      targets={[{ route: ['peer-b'], label: 'peer-b', status: 'up' }]} />);
    await screen.findByText('Declared models');
    expect(within(modelRow()).queryByRole('button', { name: 'Test against the API' })).toBeNull();
    // La riga resta, e con essa la rimozione: non vedere la prova non significa
    // non poter amministrare il modello.
    expect(within(modelRow()).getByRole('button', { name: '×' })).toBeTruthy();
  });
});
