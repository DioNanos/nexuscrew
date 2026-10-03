import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { InputTab } from './SettingsPanel.jsx';
import { INPUT_PREFERENCES_KEY } from '../lib/input-preferences.js';

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('nc_lang', 'en');
});

describe('Settings Input tab', () => {
  it('edits every keyboard/STT/Enter behavior as a local client preference', () => {
    render(<InputTab />);
    const gesture = screen.getByRole('combobox', { name: 'Open the virtual keyboard from the terminal' });
    const keybar = screen.getByRole('checkbox', { name: /Keypad: keep the virtual keyboard closed/ });
    const voice = screen.getByRole('checkbox', { name: /STT microphone: keep the virtual keyboard closed/ });
    const enter = screen.getByRole('checkbox', { name: /Show the tall Enter keypad key/ });

    const layout = screen.getByRole('combobox', { name: 'Keypad layout' });
    expect(gesture.value).toBe('double-tap');
    expect(layout.value).toBe('full');
    expect(keybar.checked).toBe(true); expect(voice.checked).toBe(true); expect(enter.checked).toBe(true);
    fireEvent.change(gesture, { target: { value: 'never' } });
    fireEvent.change(layout, { target: { value: 'compact' } });
    fireEvent.click(keybar); fireEvent.click(voice); fireEvent.click(enter);

    expect(JSON.parse(localStorage.getItem(INPUT_PREFERENCES_KEY))).toEqual({
      terminalKeyboardGesture: 'never', keybarKeepsKeyboardClosed: false,
      voiceKeepsKeyboardClosed: false, showKeybarEnter: false, keybarLayout: 'compact',
      showComposer: false,
    });
  });

  it('la tastiera di scrittura e\' una preferenza locale persistita, non un interruttore di sessione', () => {
    render(<InputTab />);
    const composer = screen.getByRole('checkbox', { name: /On-screen keyboard/ });
    // Nei test il pointer e' fine: il default e' chiusa, come il comportamento
    // di prima reso persistibile.
    expect(composer.checked).toBe(false);
    fireEvent.click(composer);
    // Lo stato mostrato viene dal valore scritto (saveInputPreferences): si
    // osserva dal DOM, non dal localStorage, che in questa suite gira su un
    // file condiviso fra worker e puo' essere azzerato da un altro file.
    expect(composer.checked).toBe(true);
  });

  it('restores the recommended double-tap, IME locks and full KeyBar layout', () => {
    render(<InputTab />);
    const gesture = screen.getByRole('combobox', { name: 'Open the virtual keyboard from the terminal' });
    const layout = screen.getByRole('combobox', { name: 'Keypad layout' });
    fireEvent.change(gesture, { target: { value: 'single-tap' } });
    fireEvent.change(layout, { target: { value: 'compact' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Show the tall Enter keypad key/ }));
    fireEvent.click(screen.getByRole('button', { name: 'restore input defaults' }));
    expect(gesture.value).toBe('double-tap');
    expect(layout.value).toBe('full');
    expect(screen.getByRole('checkbox', { name: /Show the tall Enter keypad key/ }).checked).toBe(true);
  });

  // I tre tasti diretti della barra (decisione dell'operatore sulla PR #7): cartella e
  // tastiera ACCESI di default, AI Desktop SPENTO. Ognuno scrive la sua
  // chiave per dispositivo.
  it('i tasti diretti della barra: default acceso/acceso/spento, e il click commuta', () => {
    render(<InputTab />);
    const files = screen.getByRole('checkbox', { name: /Cell files/ });
    const tastiera = screen.getByRole('checkbox', { name: /Keyboard button in the bar/ });
    const pannello = screen.getByRole('checkbox', { name: /AI Desktop button in the bar/ });
    expect(files.checked).toBe(true);
    expect(tastiera.checked).toBe(true);
    expect(pannello.checked).toBe(false);
    fireEvent.click(files);
    fireEvent.click(pannello);
    // Lo stato mostrato viene dal valore scritto: si osserva dal DOM, non dal
    // localStorage, che in questa suite gira su un file condiviso fra worker.
    expect(files.checked).toBe(false);
    expect(pannello.checked).toBe(true);
    expect(tastiera.checked).toBe(true);
  });

  it('un valore gia\' salvato vince sul default nuovo, in entrambi i sensi', () => {
    localStorage.setItem('nc_bar_files_button', 'off');
    localStorage.setItem('nc_bar_panel_button', 'on');
    render(<InputTab />);
    expect(screen.getByRole('checkbox', { name: /Cell files/ }).checked).toBe(false);
    expect(screen.getByRole('checkbox', { name: /AI Desktop button in the bar/ }).checked).toBe(true);
    expect(screen.getByRole('checkbox', { name: /Keyboard button in the bar/ }).checked).toBe(true);
  });
});
