import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

// Il nome del dispositivo quando l'hostname non dice
// niente (Termux/Android: «localhost»): lo chiede la UI, lo salva la config.
// Niente più fallback silenzioso «NexusCrew»: il campo vuoto resta vuoto e
// l'utente decide.
const mocks = vi.hoisted(() => ({ saveConfig: vi.fn(), pairNode: vi.fn() }));

vi.mock('../lib/api.js', () => ({ saveConfig: mocks.saveConfig, pairNode: mocks.pairNode }));
vi.mock('./PairingCard.jsx', () => ({
  default: ({ deviceDefault }) => <div data-testid="pair-card" data-device-default={deviceDefault || ''} />,
}));
vi.mock('./QrScanModal.jsx', () => ({ default: () => null }));

import DeviceNameAsk from './DeviceNameAsk.jsx';
import Wizard from './Wizard.jsx';

beforeEach(() => {
  localStorage.setItem('nc_lang', 'en');
  mocks.saveConfig.mockReset().mockResolvedValue({});
});

describe('DeviceNameAsk — il foglio che chiede il nome', () => {
  it('precompila col suggerimento e salva il nome scelto', async () => {
    const onSaved = vi.fn();
    render(<DeviceNameAsk token="t" suggestion="Pixel 9 Pro" onSaved={onSaved} onLater={vi.fn()} />);
    const campo = screen.getByLabelText('Device name');
    expect(campo.value).toBe('Pixel 9 Pro');
    fireEvent.change(campo, { target: { value: 'Il mio Pixel' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save name' }));
    await waitFor(() => expect(mocks.saveConfig).toHaveBeenCalledWith('t', { deviceName: 'Il mio Pixel' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith('Il mio Pixel'));
  });

  it('«più tardi» non salva niente e chiude', () => {
    const onLater = vi.fn();
    render(<DeviceNameAsk token="t" suggestion="" onSaved={vi.fn()} onLater={onLater} />);
    fireEvent.click(screen.getByRole('button', { name: 'Later' }));
    expect(mocks.saveConfig).not.toHaveBeenCalled();
    expect(onLater).toHaveBeenCalledTimes(1);
  });

  it('non manda mai il vuoto: il salva resta disabilitato finché il campo è vuoto', () => {
    render(<DeviceNameAsk token="t" suggestion="" onSaved={vi.fn()} onLater={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Save name' }).disabled).toBe(true);
  });
});

describe('Wizard — il nome del dispositivo nel setup', () => {
  it('setup senza nome (hostname localhost): chiede il nome e lo salva col wizardDone', async () => {
    render(<Wizard token="t" deviceNameNeeded deviceNameSuggestion="Pixel 9 Pro" />);
    const campo = screen.getByLabelText('Device name');
    expect(campo.value).toBe('Pixel 9 Pro');
    fireEvent.change(campo, { target: { value: 'Il mio Pixel' } });
    fireEvent.click(screen.getByRole('button', { name: 'local only' }));
    await waitFor(() => expect(mocks.saveConfig).toHaveBeenCalledWith('t', { wizardDone: true, deviceName: 'Il mio Pixel' }));
  });

  it('hostname già significativo: nessun campo nome, finish salva solo wizardDone', async () => {
    render(<Wizard token="t" />);
    expect(screen.queryByLabelText('Device name')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'local only' }));
    await waitFor(() => expect(mocks.saveConfig).toHaveBeenCalledWith('t', { wizardDone: true }));
    expect(mocks.saveConfig.mock.calls[0][1].deviceName).toBeUndefined();
  });

  it('il nome scelto alimenta il default locale della PairingCard', () => {
    render(<Wizard token="t" deviceNameNeeded deviceNameSuggestion="" />);
    fireEvent.change(screen.getByLabelText('Device name'), { target: { value: 'Il mio Pixel' } });
    fireEvent.click(screen.getByRole('button', { name: 'add node' }));
    expect(screen.getByTestId('pair-card').getAttribute('data-device-default')).toBe('Il mio Pixel');
  });
});
