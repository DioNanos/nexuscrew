import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_INPUT_PREFERENCES, INPUT_PREFERENCES_KEY, KEYBAR_LAYOUTS,
  loadInputPreferences, normalizeInputPreferences, saveInputPreferences,
} from './input-preferences.js';

beforeEach(() => localStorage.clear());

describe('input preferences', () => {
  it('defaults to double-tap + closed IME + visible Enter + full KeyBar', () => {
    expect(loadInputPreferences()).toEqual(DEFAULT_INPUT_PREFERENCES);
    expect(DEFAULT_INPUT_PREFERENCES.keybarLayout).toBe('full');
  });

  it('round-trips every Settings control', () => {
    const next = saveInputPreferences({
      terminalKeyboardGesture: 'single-tap', keybarKeepsKeyboardClosed: false,
      voiceKeepsKeyboardClosed: false, showKeybarEnter: false,
      keybarLayout: 'compact',
    });
    expect(loadInputPreferences()).toEqual(next);
    expect(JSON.parse(localStorage.getItem(INPUT_PREFERENCES_KEY))).toEqual(next);
  });

  it('repairs corrupt, partial and unknown values fail-closed', () => {
    expect(normalizeInputPreferences({ terminalKeyboardGesture: 'triple', showKeybarEnter: 'yes', keybarLayout: 'tiny' }))
      .toEqual(DEFAULT_INPUT_PREFERENCES);
    localStorage.setItem(INPUT_PREFERENCES_KEY, '{bad');
    expect(loadInputPreferences()).toEqual(DEFAULT_INPUT_PREFERENCES);
  });

  it('keeps the keybarLayout enum closed and defaults unknowns to full', () => {
    expect(KEYBAR_LAYOUTS).toEqual(['full', 'compact']);
    expect(normalizeInputPreferences({ keybarLayout: 'compact' }).keybarLayout).toBe('compact');
    expect(normalizeInputPreferences({ keybarLayout: 'weird' }).keybarLayout).toBe('full');
    expect(normalizeInputPreferences({}).keybarLayout).toBe('full');
  });
});
