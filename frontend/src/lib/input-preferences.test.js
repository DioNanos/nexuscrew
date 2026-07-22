import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_INPUT_PREFERENCES, INPUT_PREFERENCES_KEY,
  loadInputPreferences, normalizeInputPreferences, saveInputPreferences,
} from './input-preferences.js';

beforeEach(() => localStorage.clear());

describe('input preferences', () => {
  it('defaults to double-tap + closed IME + visible Enter', () => {
    expect(loadInputPreferences()).toEqual(DEFAULT_INPUT_PREFERENCES);
  });

  it('round-trips every Settings control', () => {
    const next = saveInputPreferences({
      terminalKeyboardGesture: 'single-tap', keybarKeepsKeyboardClosed: false,
      voiceKeepsKeyboardClosed: false, showKeybarEnter: false,
    });
    expect(loadInputPreferences()).toEqual(next);
    expect(JSON.parse(localStorage.getItem(INPUT_PREFERENCES_KEY))).toEqual(next);
  });

  it('repairs corrupt, partial and unknown values fail-closed', () => {
    expect(normalizeInputPreferences({ terminalKeyboardGesture: 'triple', showKeybarEnter: 'yes' }))
      .toEqual(DEFAULT_INPUT_PREFERENCES);
    localStorage.setItem(INPUT_PREFERENCES_KEY, '{bad');
    expect(loadInputPreferences()).toEqual(DEFAULT_INPUT_PREFERENCES);
  });
});
