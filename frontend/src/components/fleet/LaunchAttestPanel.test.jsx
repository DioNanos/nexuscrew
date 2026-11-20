import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import LaunchAttestPanel from './LaunchAttestPanel.jsx';
import PowerSheet from '../PowerSheet.jsx';
import { fleetDefinitions, fleetLaunchState, fleetReconcile, fleetStatus } from '../../lib/api.js';

vi.mock('../../hooks/useLang.js', () => ({ useLang: () => 'en' }));
vi.mock('../../lib/api.js', () => ({
  fleetStatus: vi.fn(),
  fleetDefinitions: vi.fn(),
  fleetLaunchState: vi.fn(),
  fleetReconcile: vi.fn(),
}));

const CELL = 'CloudCella';
const LID = 'cdcdcdcdcdcdcdcd';
const OWNER = 'ab'.repeat(16);
const SHA = 'e'.repeat(64);
const BOOT = '11111111-1111-4111-8111-111111111111';

function anteprimaIdonea(over = {}) {
  return {
    ok: true, cell: CELL, launchId: LID, outcome: 'anteprima', classification: 'proven-dead',
    recordSha256: SHA, family: 'other', ownerInstanceId: OWNER, bootId: BOOT, pidNs: '4026531836',
    previewToken: 'cHJldmlldw.0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    evidenze: { omonima: 'absent', lease: 'none', supervisore: 'assente' },
    eligibleAttestation: {
      variante: 'archivia-identita-incerta', version: 1, phase: null, family: 'other',
      sessione: 'cloud-Cella', ora: '2026-11-18T15:00:00.000Z',
      atteso: { hostAssente: false },
      evidenze: {
        server: { pidNominato: false, nascita: 'assente', prova: 'unknown' },
        supervisore: 'dead-by-identity', lease: 'none', host: 'not-vl',
        sonda: { esito: 'assente', oggetto: null }, idOriginali: null,
      },
      avvertenza: ['an absent session on the CURRENT listener proves nothing about the recorded server'],
    },
    ...over,
  };
}

const statoConLancio = { ok: true, cell: CELL, launchId: LID, classification: 'proven-dead', inFlight: false };

function celle(over = {}) {
  return {
    cell: CELL, active: false, engine: 'client', model: '', models: {},
    permissionPolicy: 'standard', permissionPolicies: {}, boot: false,
    tmuxSession: 'cloud-Cella', launchId: LID, ...over,
  };
}

describe('pratica di lancio: ingresso solo locale e anteprima', () => {
  beforeEach(() => {
    localStorage.setItem('nc_lang', 'en');
    vi.clearAllMocks();
    fleetStatus.mockResolvedValue({ provider: 'builtin', capabilities: [], engines: [] });
    fleetDefinitions.mockResolvedValue({ engines: [] });
    fleetLaunchState.mockResolvedValue(statoConLancio);
    fleetReconcile.mockResolvedValue(anteprimaIdonea());
  });

  it('il foglio offre l\'azione solo sulla route locale', async () => {
    const { unmount } = render(<PowerSheet cell={celle()} token="tok" route={[]} onConfirm={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'check launch record' })).toBeTruthy();
    unmount();
    render(<PowerSheet cell={celle()} token="tok" route={['peer']} onConfirm={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'check launch record' })).toBeNull();
  });

  it('aprendo legge lo stato e mostra le evidenze distinte; la conferma resta chiusa senza nome e motivo', async () => {
    render(<LaunchAttestPanel cell={celle()} token="tok" />);
    fireEvent.click(screen.getByRole('button', { name: 'check launch record' }));
    await screen.findByText('launch record still open');
    expect(fleetLaunchState).toHaveBeenCalledWith('tok', CELL);
    expect(fleetReconcile).toHaveBeenCalledWith('tok', { cell: CELL, launchId: LID, attest: { azione: 'anteprima' } });
    await screen.findByText('proven-dead');
    expect(screen.getByText(/same name on the current listener: absent on the current listener/)).toBeTruthy();
    expect(screen.getByText(/original ids on the current listener: absent on the current listener/)).toBeTruthy();
    expect(screen.getByText(/original server: not verifiable/)).toBeTruthy();
    expect(screen.getByText(/recorded supervisor: dead-by-identity/)).toBeTruthy();
    // niente default: nome e motivo vanno scritti
    const conferma = screen.getByRole('button', { name: 'archive the record' });
    expect(conferma.disabled).toBe(true);
    const nome = screen.getByPlaceholderText(CELL);
    fireEvent.change(nome, { target: { value: 'altra' } });
    const motivo = screen.getAllByRole('textbox')[1];
    fireEvent.change(motivo, { target: { value: 'verificata' } });
    expect(screen.getByRole('button', { name: 'archive the record' }).disabled).toBe(true);
    fireEvent.change(nome, { target: { value: CELL } });
    expect(screen.getByRole('button', { name: 'archive the record' }).disabled).toBe(false);
  });

  it('conferma una volta sola e mostra l\'esito archiviato senza altri invii', async () => {
    fleetReconcile
      .mockResolvedValueOnce(anteprimaIdonea())
      .mockResolvedValueOnce({ ok: true, outcome: 'reconciled', provaOperatore: 'f'.repeat(64) });
    render(<LaunchAttestPanel cell={celle()} token="tok" />);
    fireEvent.click(screen.getByRole('button', { name: 'check launch record' }));
    await screen.findByText('proven-dead');
    fireEvent.change(screen.getByPlaceholderText(CELL), { target: { value: CELL } });
    fireEvent.change(screen.getAllByRole('textbox')[1], { target: { value: '  verificata sul nodo  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'archive the record' }));
    await screen.findByText(/record archived/);
    const chiamate = fleetReconcile.mock.calls.filter((c) => c[1] && c[1].attest && c[1].attest.azione === 'archivia-identita-incerta');
    expect(chiamate).toHaveLength(1);
    expect(chiamate[0][1]).toMatchObject({
      cell: CELL, launchId: LID,
      attest: {
        azione: 'archivia-identita-incerta',
        conferma: {
          recordSha256: SHA, bootId: BOOT, ownerInstanceId: OWNER, hostAssente: false,
          motivo: 'verificata sul nodo', previewToken: anteprimaIdonea().previewToken,
        },
      },
    });
    expect(screen.queryByRole('button', { name: 'archive the record' })).toBeNull();
  });

  it('una pratica non idonea mostra i motivi e non offre la conferma', async () => {
    fleetReconcile.mockResolvedValue(anteprimaIdonea({
      eligibleAttestation: null, motiviRifiuto: ['SESSION_PRESENT'],
    }));
    render(<LaunchAttestPanel cell={celle()} token="tok" />);
    fireEvent.click(screen.getByRole('button', { name: 'check launch record' }));
    const motivi = await screen.findByTestId('nc-attest-reasons');
    expect(motivi.textContent).toContain('SESSION_PRESENT');
    expect(screen.queryByRole('button', { name: 'archive the record' })).toBeNull();
  });

  it('una POST senza risposta non si ripete: chiede di rileggere lo stato', async () => {
    const incerta = new Error('timeout');
    fleetReconcile
      .mockResolvedValueOnce(anteprimaIdonea())
      .mockRejectedValueOnce(incerta)
      .mockResolvedValueOnce(anteprimaIdonea());
    render(<LaunchAttestPanel cell={celle()} token="tok" />);
    fireEvent.click(screen.getByRole('button', { name: 'check launch record' }));
    await screen.findByText('proven-dead');
    fireEvent.change(screen.getByPlaceholderText(CELL), { target: { value: CELL } });
    fireEvent.change(screen.getAllByRole('textbox')[1], { target: { value: 'verificata' } });
    fireEvent.click(screen.getByRole('button', { name: 'archive the record' }));
    await screen.findByText(/outcome uncertain/);
    expect(screen.queryByRole('button', { name: 'archive the record' })).toBeNull();
    const conferme = fleetReconcile.mock.calls.filter((c) => c[1] && c[1].attest && c[1].attest.azione === 'archivia-identita-incerta');
    expect(conferme).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'read the state again' }));
    await waitFor(() => expect(fleetLaunchState).toHaveBeenCalledTimes(2));
  });

  it('una risposta tardiva di un altro contesto (token cambiato) non entra', async () => {
    let liberaA;
    let liberaB;
    fleetLaunchState
      .mockReturnValueOnce(new Promise((r) => { liberaA = r; }))
      .mockReturnValueOnce(new Promise((r) => { liberaB = r; }));
    const { rerender } = render(<LaunchAttestPanel cell={celle()} token="tok" />);
    fireEvent.click(screen.getByRole('button', { name: 'check launch record' }));
    rerender(<LaunchAttestPanel cell={celle()} token="altro-tok" />);
    // La risposta della conversazione VECCHIA arriva adesso: non entra.
    liberaA(statoConLancio);
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByText('proven-dead')).toBeNull();
    expect(fleetReconcile).not.toHaveBeenCalled();
    // La lettura del contesto NUOVO invece vale.
    liberaB(statoConLancio);
    await screen.findByText('proven-dead');
  });

  it('un nodo con la via attestata spenta mostra l\'esito, non il silenzio', async () => {
    fleetReconcile.mockResolvedValue({ ok: true, cell: CELL, launchId: LID, outcome: 'not-enabled' });
    render(<LaunchAttestPanel cell={celle()} token="tok" />);
    fireEvent.click(screen.getByRole('button', { name: 'check launch record' }));
    await screen.findByText('outcome: not-enabled');
    expect(screen.queryByRole('button', { name: 'archive the record' })).toBeNull();
  });

  it('chiudendo e riaprendo il pannello l\'anteprima torna raggiungibile', async () => {
    render(<LaunchAttestPanel cell={celle()} token="tok" />);
    fireEvent.click(screen.getByRole('button', { name: 'check launch record' }));
    await screen.findByText('proven-dead');
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'check launch record' }));
    await waitFor(() => expect(fleetLaunchState).toHaveBeenCalledTimes(2));
  });

  it('A5: un 5xx dopo l\'invio è un esito incerto — niente ritorno a ready, si rilegge', async () => {
    const errore = Object.assign(new Error('gateway'), { status: 502 });
    fleetReconcile
      .mockResolvedValueOnce(anteprimaIdonea())
      .mockRejectedValueOnce(errore)
      .mockResolvedValueOnce(anteprimaIdonea());
    render(<LaunchAttestPanel cell={celle()} token="tok" />);
    fireEvent.click(screen.getByRole('button', { name: 'check launch record' }));
    await screen.findByText('proven-dead');
    fireEvent.change(screen.getByPlaceholderText(CELL), { target: { value: CELL } });
    fireEvent.change(screen.getAllByRole('textbox')[1], { target: { value: 'verificata' } });
    fireEvent.click(screen.getByRole('button', { name: 'archive the record' }));
    // Notifica visibile, nessun ritorno a `ready`: il pulsante di conferma
    // non torna disponibile e non si può reinviare.
    await screen.findByText(/outcome uncertain/);
    expect(screen.queryByRole('button', { name: 'archive the record' })).toBeNull();
    expect(screen.queryByText(/record archived/)).toBeNull();
    const conferme = fleetReconcile.mock.calls
      .filter((c) => c[1] && c[1].attest && c[1].attest.azione === 'archivia-identita-incerta');
    expect(conferme).toHaveLength(1);
    // L'unica azione proposta è la rilettura.
    fireEvent.click(screen.getByRole('button', { name: 'read the state again' }));
    await waitFor(() => expect(fleetLaunchState).toHaveBeenCalledTimes(2));
  });

  it('A5: chiudere durante l\'invio invalida subito la sequenza — la risposta tardiva non entra', async () => {
    let liberaConferma;
    fleetReconcile
      .mockResolvedValueOnce(anteprimaIdonea())
      .mockReturnValueOnce(new Promise((r) => { liberaConferma = r; }));
    render(<LaunchAttestPanel cell={celle()} token="tok" />);
    fireEvent.click(screen.getByRole('button', { name: 'check launch record' }));
    await screen.findByText('proven-dead');
    fireEvent.change(screen.getByPlaceholderText(CELL), { target: { value: CELL } });
    fireEvent.change(screen.getAllByRole('textbox')[1], { target: { value: 'verificata' } });
    fireEvent.click(screen.getByRole('button', { name: 'archive the record' }));
    await screen.findByRole('button', { name: 'confirming…' });
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    liberaConferma({ ok: true, outcome: 'reconciled', provaOperatore: 'f'.repeat(64) });
    await new Promise((r) => setTimeout(r, 10));
    // Il pannello è chiuso e l'esito della vista chiusa non è stato applicato.
    expect(screen.queryByText(/record archived/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'check launch record' })).not.toBeNull();
  });

  it('C2: un 408 dopo l\'invio è un esito incerto — niente ritorno a ready', async () => {
    const errore = Object.assign(new Error('request timeout'), { status: 408 });
    fleetReconcile
      .mockResolvedValueOnce(anteprimaIdonea())
      .mockRejectedValueOnce(errore);
    render(<LaunchAttestPanel cell={celle()} token="tok" />);
    fireEvent.click(screen.getByRole('button', { name: 'check launch record' }));
    await screen.findByText('proven-dead');
    fireEvent.change(screen.getByPlaceholderText(CELL), { target: { value: CELL } });
    fireEvent.change(screen.getAllByRole('textbox')[1], { target: { value: 'verificata' } });
    fireEvent.click(screen.getByRole('button', { name: 'archive the record' }));
    await screen.findByText(/outcome uncertain/);
    expect(screen.queryByRole('button', { name: 'archive the record' })).toBeNull();
    const conferme = fleetReconcile.mock.calls
      .filter((c) => c[1] && c[1].attest && c[1].attest.azione === 'archivia-identita-incerta');
    expect(conferme).toHaveLength(1);
  });

  it('C2: un 409 è un rifiuto definitivo VISIBILE, senza ritorno silenzioso a ready', async () => {
    const errore = Object.assign(new Error('conflict: record changed'), { status: 409 });
    fleetReconcile
      .mockResolvedValueOnce(anteprimaIdonea())
      .mockRejectedValueOnce(errore);
    render(<LaunchAttestPanel cell={celle()} token="tok" />);
    fireEvent.click(screen.getByRole('button', { name: 'check launch record' }));
    await screen.findByText('proven-dead');
    fireEvent.change(screen.getByPlaceholderText(CELL), { target: { value: CELL } });
    fireEvent.change(screen.getAllByRole('textbox')[1], { target: { value: 'verificata' } });
    fireEvent.click(screen.getByRole('button', { name: 'archive the record' }));
    // Il motivo del rifiuto definitivo resta SULLO SCHERMO, e il pulsante
    // torna disponibile perché la lettura è stata completata dal server.
    await screen.findByText(/conflict: record changed/);
    expect(screen.getByRole('button', { name: 'archive the record' })).toBeTruthy();
  });

  it('A6: un\'anteprima scaduta non si ripete — il pannello chiede di rileggere', async () => {
    fleetReconcile
      .mockResolvedValueOnce(anteprimaIdonea())
      .mockResolvedValueOnce({ ok: true, outcome: 'blocked', code: 'PREVIEW_STALE' });
    render(<LaunchAttestPanel cell={celle()} token="tok" />);
    fireEvent.click(screen.getByRole('button', { name: 'check launch record' }));
    await screen.findByText('proven-dead');
    fireEvent.change(screen.getByPlaceholderText(CELL), { target: { value: CELL } });
    fireEvent.change(screen.getAllByRole('textbox')[1], { target: { value: 'verificata' } });
    fireEvent.click(screen.getByRole('button', { name: 'archive the record' }));
    await screen.findByText(/preview expired/);
    expect(screen.queryByRole('button', { name: 'archive the record' })).toBeNull();
  });
});
