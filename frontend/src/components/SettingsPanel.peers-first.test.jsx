import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';

// Il pannello impostazioni non deve far pagare la lista dei peer alle fonti
// lente: settings e peer partono in parallelo, i peer si pubblicano al loro
// arrivo, e l'arricchimento VL (4 s per owner) resta un arricchimento. La
// guardia di refresh non avvia un secondo giro mentre uno e' in volo.
const mocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getPeers: vi.fn(),
  getTopology: vi.fn(),
  getVlNodes: vi.fn(),
  apiFetch: vi.fn(),
}));

vi.mock('../lib/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getSettings: mocks.getSettings,
  getPeers: mocks.getPeers,
  getTopology: mocks.getTopology,
  getVlNodes: mocks.getVlNodes,
  apiFetch: mocks.apiFetch,
}));
vi.mock('../hooks/useNodes.js', () => ({ useNodes: () => [] }));

import SettingsPanel from './SettingsPanel.jsx';

const flushMicrotask = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  vi.clearAllMocks();
  // Config locale per la scoperta VL: solo l'owner locale (nessun federato).
  mocks.apiFetch.mockImplementation((_path, _token) => Promise.resolve({
    ok: true, status: 200, json: async () => ({ instanceId: 'local-instance', readonlyDefault: false }),
  }));
  mocks.getTopology.mockResolvedValue({ nodes: [] });
  mocks.getSettings.mockResolvedValue({
    version: '0.9.55', platform: 'linux', port: 41820,
    service: { installed: true, active: true, boot: true }, autoUpdate: true, alternateScreen: false,
  });
  mocks.getPeers.mockResolvedValue({
    peers: [{ name: 'peer-a', label: 'Peer A', host: 'a', kind: 'direct' }],
    accessRevision: 7,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

const renderPanel = () => render(
  <SettingsPanel token="token" onClose={vi.fn()} initialTab="nodes" />,
);

describe('lista nodi: i peer non aspettano le fonti lente', () => {
  it('un owner VL che non risponde non trattiene la pubblicazione dei peer', async () => {
    // Owner VL appeso: la promessa non si risolve (il tetto di 4 s del fix
    // la chiuderebbe, ma la prova qui e' che i peer esistono GIA' prima).
    let rilasciaVl;
    mocks.getVlNodes.mockImplementation(() => new Promise((resolve) => { rilasciaVl = resolve; }));
    renderPanel();
    await act(async () => { await flushMicrotask(); });
    // I peer sono pubblicati AL LORO ARRIVO, senza attendere il VL.
    expect(screen.getByText('Peer A')).toBeTruthy();
    // E il VL e' ancora pendente: nessun avanzamento di tempo o rilascio.
    expect(typeof rilasciaVl).toBe('function');
    rilasciaVl({ nodes: [] });
    await act(async () => { await flushMicrotask(); });
    expect(screen.getByText('Peer A')).toBeTruthy();
  });

  it('getPeers parte in parallelo a getSettings: settings appesa non blocca i peer', async () => {
    let rilasciaSettings;
    mocks.getSettings.mockImplementation(() => new Promise((resolve) => { rilasciaSettings = resolve; }));
    mocks.getVlNodes.mockResolvedValue({ nodes: [] });
    renderPanel();
    await act(async () => { await flushMicrotask(); });
    // I peer sono pubblicati anche con settings ancora pendente.
    expect(screen.getByText('Peer A')).toBeTruthy();
    rilasciaSettings({
      version: '0.9.55', platform: 'linux', port: 41820,
      service: { installed: true, active: true, boot: true }, autoUpdate: true, alternateScreen: false,
    });
    await act(async () => { await flushMicrotask(); });
    expect(screen.getByText('Peer A')).toBeTruthy();
  });

  it('la guardia di refresh: un tick su un giro occupato non apre un secondo giro', async () => {
    vi.useFakeTimers();
    let rilasciaVl;
    mocks.getVlNodes.mockImplementation(() => new Promise((resolve) => { rilasciaVl = resolve; }));
    renderPanel();
    // Flusso del primo giro (appeso sul VL).
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    const chiamateAlPrimoGiro = mocks.getPeers.mock.calls.length;
    expect(chiamateAlPrimoGiro).toBeGreaterThan(0);
    // Tick del poll a 5 s con il giro ancora in volo: nessun secondo giro.
    await act(async () => { vi.advanceTimersByTime(5000); await flushMicrotask(); });
    expect(mocks.getPeers.mock.calls.length).toBe(chiamateAlPrimoGiro);
    // Chiusura del giro (tutte le letture terminano): il tick successivo riparte.
    rilasciaVl({ nodes: [] });
    await act(async () => { await flushMicrotask(); });
    await act(async () => { vi.advanceTimersByTime(5000); await flushMicrotask(); });
    expect(mocks.getPeers.mock.calls.length).toBeGreaterThan(chiamateAlPrimoGiro);
  });
});
