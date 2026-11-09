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
        id: 'agy.native', label: 'agy', standard: true,
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

// ---------------------------------------------------------------------------
// P3-3 — Il foglio della cella nomina la consegna del PROMPT INIZIALE per
// esteso: stato, ORA LOCALE del record e MOTIVO leggibile — i dettagli che la
// card non porta più. Sotto, la riga «NC control» con l'etichetta intera
// della supervisione, quella che in card resta solo per «expired».
// ---------------------------------------------------------------------------
describe('PowerSheet: sezione Prompt iniziale (P3-3)', () => {
  const ts = Date.UTC(2026, 10, 8, 10, 16, 11);
  const oraLocale = () => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  beforeEach(() => {
    localStorage.setItem('nc_lang', 'en');
    vi.clearAllMocks();
    fleetStatus.mockResolvedValue({ provider: 'builtin', capabilities: [], engines: [] });
    fleetDefinitions.mockResolvedValue({ engines: [] });
  });

  function sezione() {
    return screen.getByText('Initial prompt').closest('div');
  }

  it('skipped not-ready: stato «not sent», ora locale e motivo visibili', async () => {
    render(<PowerSheet
      cell={{
        cell: 'Alpha', active: true, tmux: true, engine: 'claude.zai-a',
        launchId: 'c7d29a2b8f23fdca',
        promptDelivery: {
          state: 'skipped', reason: 'not-ready', notReady: 'busy',
          ts, launchId: 'c7d29a2b8f23fdca', generation: 0,
        },
        ncControl: 'attested',
      }}
      token="test-token" onConfirm={vi.fn()} onClose={vi.fn()}
    />);
    expect(await screen.findByText('Initial prompt')).toBeTruthy();
    const testo = sezione().textContent;
    expect(testo).toContain('not sent');
    expect(testo).toContain(oraLocale());
    expect(testo).toContain('readiness not verified');
    // La riga della supervisione NC porta l'etichetta INTERA del foglio.
    expect(testo).toContain('NC control attested');
  });

  it('submitted: «sent» con l\'ora del record, senza motivo', async () => {
    render(<PowerSheet
      cell={{
        cell: 'Beta', active: true, tmux: true, engine: 'claude.native',
        launchId: 'aaaaaaaaaaaaaaaa',
        promptDelivery: { state: 'submitted', ts, launchId: 'aaaaaaaaaaaaaaaa', generation: 1 },
      }}
      token="test-token" onConfirm={vi.fn()} onClose={vi.fn()}
    />);
    const testo = (await screen.findByText('Initial prompt')).closest('div').textContent;
    expect(testo).toContain('sent');
    expect(testo).toContain(oraLocale());
    expect(testo).not.toContain('other reason');
  });

  it('prompt rifiutato: il motivo dice «prompt rejected», non solo «not sent»', async () => {
    render(<PowerSheet
      cell={{
        cell: 'Alpha', active: true, tmux: true, engine: 'claude.zai-a',
        launchId: 'c7d29a2b8f23fdca',
        promptDelivery: { state: 'skipped', reason: 'prompt-rejected', ts, launchId: 'c7d29a2b8f23fdca', generation: 0 },
      }}
      token="test-token" onConfirm={vi.fn()} onClose={vi.fn()}
    />);
    const testo = (await screen.findByText('Initial prompt')).closest('div').textContent;
    expect(testo).toContain('prompt rejected');
  });

  it('cella viva senza campo NC: la riga di controllo dice «unverifiable»', async () => {
    render(<PowerSheet
      cell={{
        cell: 'Dev', active: true, tmux: true, engine: 'claude.native',
        promptDelivery: { state: 'skipped', reason: 'deadline-exceeded', ts, launchId: 'x', generation: 0 },
      }}
      token="test-token" onConfirm={vi.fn()} onClose={vi.fn()}
    />);
    const testo = (await screen.findByText('Initial prompt')).closest('div').textContent;
    expect(testo).toContain('wait time expired');
    expect(testo).toContain('NC supervision unverifiable');
  });

  it('cella spenta senza record: «not applicable», senza ora né riga NC', async () => {
    render(<PowerSheet
      cell={{ cell: 'Off Cell', active: false, tmux: false, engine: 'claude.native' }}
      token="test-token" onConfirm={vi.fn()} onClose={vi.fn()}
    />);
    const testo = (await screen.findByText('Initial prompt')).closest('div').textContent;
    expect(testo).toContain('not applicable');
    expect(testo).not.toContain(oraLocale());
    expect(testo).not.toContain('NC control');
    expect(testo).not.toContain('NC supervision');
  });
});
