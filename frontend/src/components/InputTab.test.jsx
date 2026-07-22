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

    expect(gesture.value).toBe('double-tap');
    expect(keybar.checked).toBe(true); expect(voice.checked).toBe(true); expect(enter.checked).toBe(true);
    fireEvent.change(gesture, { target: { value: 'never' } });
    fireEvent.click(keybar); fireEvent.click(voice); fireEvent.click(enter);

    expect(JSON.parse(localStorage.getItem(INPUT_PREFERENCES_KEY))).toEqual({
      terminalKeyboardGesture: 'never', keybarKeepsKeyboardClosed: false,
      voiceKeepsKeyboardClosed: false, showKeybarEnter: false,
    });
  });

  it('restores the recommended double-tap and IME locks', () => {
    render(<InputTab />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'single-tap' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Show the tall Enter keypad key/ }));
    fireEvent.click(screen.getByRole('button', { name: 'restore input defaults' }));
    expect(screen.getByRole('combobox').value).toBe('double-tap');
    expect(screen.getByRole('checkbox', { name: /Show the tall Enter keypad key/ }).checked).toBe(true);
  });
});
