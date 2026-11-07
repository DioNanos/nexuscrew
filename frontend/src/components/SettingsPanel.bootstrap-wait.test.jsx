import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  setNodeShare: vi.fn(),
  getAudioSettings: vi.fn(),
  setAudioConsent: vi.fn(),
  testLocalAudio: vi.fn(),
  stopLocalAudio: vi.fn(),
  getAudioGroups: vi.fn(),
  saveAudioGroup: vi.fn(),
  deleteAudioGroup: vi.fn(),
  getSettings: vi.fn(),
  getPeers: vi.fn(),
  getVlNodes: vi.fn(),
  getTopology: vi.fn(),
  saveConfig: vi.fn(),
  apiFetch: vi.fn(),
  getRouteConfig: vi.fn(),
  getDiagnosticsStatus: vi.fn(),
  getDiagnosticsLogs: vi.fn(),
  getAiDesktop: vi.fn(),
  setAiDesktop: vi.fn(),
}));

vi.mock('../lib/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  setNodeShare: mocks.setNodeShare,
  getAudioSettings: mocks.getAudioSettings,
  setAudioConsent: mocks.setAudioConsent,
  testLocalAudio: mocks.testLocalAudio,
  stopLocalAudio: mocks.stopLocalAudio,
  getAudioGroups: mocks.getAudioGroups,
  saveAudioGroup: mocks.saveAudioGroup,
  deleteAudioGroup: mocks.deleteAudioGroup,
  getSettings: mocks.getSettings,
  getPeers: mocks.getPeers,
  getVlNodes: mocks.getVlNodes,
  getTopology: mocks.getTopology,
  saveConfig: mocks.saveConfig,
  apiFetch: mocks.apiFetch,
  getRouteConfig: mocks.getRouteConfig,
  getDiagnosticsStatus: mocks.getDiagnosticsStatus,
  getDiagnosticsLogs: mocks.getDiagnosticsLogs,
  getAiDesktop: mocks.getAiDesktop,
  setAiDesktop: mocks.setAiDesktop,
}));
vi.mock('./PairingCard.jsx', () => ({ default: () => null }));
vi.mock('../hooks/useNodes.js', () => ({ useNodes: () => [] }));

import SettingsPanel from './SettingsPanel.jsx';
import { DICTS } from '../lib/i18n.js';

const base = {
  version: '0.9.80', platform: 'linux', port: 41820,
  service: { installed: true, active: true, boot: true }, alternateScreen: false,
};

const LABEL = /maximum prompt readiness wait/i;

function apri(extra = {}) {
  mocks.getSettings.mockResolvedValue({
    ...base, bootstrapReadyWaitMs: 15000, savedBootstrapReadyWaitMs: 15000,
    applyState: 'applied', restartRequired: false, ...extra,
  });
  return render(<SettingsPanel token="token" onClose={vi.fn()} initialTab="diagnostics" />);
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
  vi.clearAllMocks();
  mocks.getAudioGroups.mockResolvedValue({ groups: [] });
  mocks.getPeers.mockResolvedValue({ peers: [] });
  mocks.getVlNodes.mockResolvedValue({ nodes: [] });
  mocks.getTopology.mockResolvedValue({ nodes: [] });
  mocks.getRouteConfig.mockResolvedValue({ instanceId: 'local-id-0000000' });
  mocks.apiFetch.mockResolvedValue({
    json: vi.fn().mockResolvedValue({ readonlyDefault: false, instanceId: 'local-id-0000000' }),
  });
  mocks.getDiagnosticsStatus.mockResolvedValue({ verbose: false });
  mocks.getDiagnosticsLogs.mockResolvedValue({ events: [] });
  mocks.saveConfig.mockResolvedValue({ saved: true });
});

describe('attesa di prontezza: il campo nella sezione Terminale', () => {
  it('parte dal valore salvato, in secondi', async () => {
    apri({ savedBootstrapReadyWaitMs: 60000, bootstrapReadyWaitMs: 60000 });
    const campo = await screen.findByLabelText(LABEL);
    // il GET arriva dopo il primo render: il campo si riallinea quando c'e'
    await waitFor(() => expect(campo.value).toBe('60'));
    expect(campo.disabled).toBe(false);
  });

  it('mostra i millisecondi non tondi senza perdere il millisecondo', async () => {
    apri({ savedBootstrapReadyWaitMs: 1234, bootstrapReadyWaitMs: 1234 });
    const campo = await screen.findByLabelText(LABEL);
    await waitFor(() => expect(campo.value).toBe('1.234'));
  });

  it('in italiano usa la virgola, e il parser rilegge lo stesso valore', async () => {
    localStorage.setItem('nc_lang', 'it');
    apri({ savedBootstrapReadyWaitMs: 1234, bootstrapReadyWaitMs: 1234 });
    const campo = await screen.findByLabelText(/tempo massimo di attesa della prontezza/i);
    await waitFor(() => expect(campo.value).toBe('1,234'));
    fireEvent.click(screen.getByRole('button', { name: /^salva$/i }));
    await waitFor(() => expect(mocks.saveConfig).toHaveBeenCalledWith('token', { bootstrapReadyWaitMs: 1234 }));
  });

  it('senza valore salvato valido parte dal valore in uso e lo dichiara', async () => {
    apri({ savedBootstrapReadyWaitMs: null, bootstrapReadyWaitMs: 30000 });
    const campo = await screen.findByLabelText(LABEL);
    await waitFor(() => expect(campo.value).toBe('30'));
    expect(screen.getByText(/no valid saved value/i)).toBeTruthy();
  });

  it('con il nodo che non espone il valore: sola lettura e «non disponibile»', async () => {
    mocks.getSettings.mockResolvedValue({ ...base });
    render(<SettingsPanel token="token" onClose={vi.fn()} initialTab="diagnostics" />);
    const campo = await screen.findByLabelText(LABEL);
    expect(campo.disabled).toBe(true);
    expect(screen.getByText(/not available/i)).toBeTruthy();
  });

  it('in sola lettura il campo e il salvataggio sono disabilitati', async () => {
    mocks.apiFetch.mockResolvedValue({
      json: vi.fn().mockResolvedValue({ readonlyDefault: true, instanceId: 'local-id-0000000' }),
    });
    apri();
    const campo = await screen.findByLabelText(LABEL);
    expect(campo.disabled).toBe(true);
    expect(screen.getByRole('button', { name: /^save$/i }).disabled).toBe(true);
  });

  it('salva in millisecondi interi, leggendo virgola o punto', async () => {
    apri();
    const campo = await screen.findByLabelText(LABEL);
    fireEvent.change(campo, { target: { value: '1,234' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await waitFor(() => expect(mocks.saveConfig).toHaveBeenCalledWith('token', { bootstrapReadyWaitMs: 1234 }));
  });

  it('un valore fuori contratto non arriva al POST e dice perche', async () => {
    apri();
    const campo = await screen.findByLabelText(LABEL);
    for (const [testo, motivo] of [
      ['1e3', /not a number/i],
      ['1,2345', /three decimals/i],
      ['1.234,5', /single decimal separator/i],
      ['500', /1 to 120 seconds/i],
      ['', /empty/i],
    ]) {
      fireEvent.change(campo, { target: { value: testo } });
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
      await screen.findByText(motivo);
    }
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });

  it('dice «applicato» solo quando la risposta lo conferma', async () => {
    apri();
    mocks.saveConfig.mockResolvedValue({
      saved: true,
      applied: { bootstrapReadyWaitMs: 15000 },
      applyState: 'applied',
      restartRequired: false,
    });
    const campo = await screen.findByLabelText(LABEL);
    fireEvent.change(campo, { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await screen.findByText(/applied to the running node/i);
  });

  it('un 200 senza applicazione dice «salvato, non applicato», mai «applicato»', async () => {
    apri();
    mocks.saveConfig.mockResolvedValue({
      saved: true,
      applied: { bootstrapReadyWaitMs: null },
      applyState: 'restart-required',
      restartRequired: true,
    });
    const campo = await screen.findByLabelText(LABEL);
    fireEvent.change(campo, { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    await screen.findByText(/saved, not applied/i);
    expect(screen.queryByText(/applied to the running node/i)).toBeNull();
  });

  it('un salvataggio in corso non manda un secondo POST', async () => {
    apri();
    let rilascia;
    mocks.saveConfig.mockImplementation(() => new Promise((resolve) => { rilascia = resolve; }));
    const campo = await screen.findByLabelText(LABEL);
    fireEvent.change(campo, { target: { value: '60' } });
    const bottone = screen.getByRole('button', { name: /^save$/i });
    fireEvent.click(bottone);
    fireEvent.click(bottone);
    await waitFor(() => expect(mocks.saveConfig).toHaveBeenCalledTimes(1));
    rilascia({ saved: true, applied: { bootstrapReadyWaitMs: 60000 }, applyState: 'applied', restartRequired: false });
    await waitFor(() => expect(bottone.disabled).toBe(false));
    expect(mocks.saveConfig).toHaveBeenCalledTimes(1);
  });

  it('ha le sue frasi in tutte e tre le lingue', () => {
    const chiavi = [
      'bootstrap-wait-label', 'bootstrap-wait-help', 'bootstrap-wait-save',
      'bootstrap-wait-state-applied', 'bootstrap-wait-state-restart', 'bootstrap-wait-state-notapplied',
      'bootstrap-wait-unavailable', 'bootstrap-wait-notsaved-default', 'bootstrap-wait-notsaved-effective',
      'bootstrap-wait-effective', 'bootstrap-wait-invalid', 'bootstrap-wait-stale',
      'bootstrap-wait-reason-empty', 'bootstrap-wait-reason-text', 'bootstrap-wait-reason-separators',
      'bootstrap-wait-reason-precision', 'bootstrap-wait-reason-range',
    ];
    for (const lang of Object.keys(DICTS)) {
      for (const chiave of chiavi) {
        expect(DICTS[lang][chiave], `${lang}:${chiave}`).toBeTruthy();
      }
    }
    expect(DICTS.it['bootstrap-wait-effective']).toContain('{value}');
    expect(DICTS.en['bootstrap-wait-invalid']).toContain('{reason}');
    expect(DICTS.es['bootstrap-wait-invalid']).toContain('{reason}');
  });
});

// La freschezza è della LETTURA, non dell'oggetto conservato: se la GET dei
// settings fallisce dopo una riuscita, il valore che si vede è l'ultimo noto e
// non si scrive. Un guasto della GET peer non c'entra: sono esiti indipendenti.
describe('freschezza della lettura settings', () => {
  it('una GET fallita dopo una valida disabilita campo e salvataggio', async () => {
    vi.useFakeTimers();
    apri();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const campo = screen.getByLabelText(LABEL);
    expect(campo.value).toBe('15');
    expect(campo.disabled).toBe(false);
    mocks.getSettings.mockRejectedValue(new Error('settings unavailable'));
    await act(async () => { await vi.advanceTimersByTimeAsync(5001); });
    vi.useRealTimers();
    expect(screen.getByText('settings unavailable')).toBeTruthy();
    expect(campo.disabled, 'stale settings must not remain writable').toBe(true);
    expect(screen.getByRole('button', { name: /^save$/i }).disabled).toBe(true);
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });

  it('al ritorno della lettura il campo torna scrivibile e si riallinea', async () => {
    vi.useFakeTimers();
    apri();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    const campo = screen.getByLabelText(LABEL);
    mocks.getSettings.mockRejectedValue(new Error('settings unavailable'));
    await act(async () => { await vi.advanceTimersByTimeAsync(5001); });
    expect(campo.disabled).toBe(true);
    mocks.getSettings.mockResolvedValue({
      ...base, bootstrapReadyWaitMs: 30000, savedBootstrapReadyWaitMs: 30000,
      applyState: 'applied', restartRequired: false,
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(5001); });
    vi.useRealTimers();
    expect(campo.disabled).toBe(false);
    expect(campo.value).toBe('30');
  });
});
