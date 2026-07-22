import { describe, expect, it, vi } from 'vitest';
import {
  dismissVirtualKeyboard, setTerminalInputMode, showTerminalVirtualKeyboard,
  terminalTapDecision,
} from './virtual-keyboard.js';

describe('virtual keyboard policy', () => {
  it('dismisses through VirtualKeyboard when available and blurs an editable', () => {
    const blur = vi.fn(); const hide = vi.fn();
    const result = dismissVirtualKeyboard({
      documentRef: { activeElement: { tagName: 'TEXTAREA', blur } },
      navigatorRef: { virtualKeyboard: { hide } },
    });
    expect(result).toEqual({ blurred: true, apiRequested: true });
    expect(hide).toHaveBeenCalledOnce(); expect(blur).toHaveBeenCalledOnce();
  });

  it('maps never/double lock to inputmode none and unlocks only explicitly', () => {
    const textarea = document.createElement('textarea'); const term = { textarea };
    expect(setTerminalInputMode(term, 'double-tap')).toBe('none');
    expect(textarea.getAttribute('inputmode')).toBe('none');
    expect(setTerminalInputMode(term, 'double-tap', true)).toBe('text');
    expect(setTerminalInputMode(term, 'never', true)).toBe('none');
  });

  it('opens xterm only after the configured terminal gesture', () => {
    const first = { at: 1000, x: 20, y: 20 };
    expect(terminalTapDecision('double-tap', null, first)).toEqual({ open: false, next: first });
    expect(terminalTapDecision('double-tap', first, { at: 1300, x: 30, y: 25 }).open).toBe(true);
    expect(terminalTapDecision('double-tap', first, { at: 1600, x: 30, y: 25 }).open).toBe(false);
    expect(terminalTapDecision('single-tap', null, first).open).toBe(true);
    expect(terminalTapDecision('never', first, first).open).toBe(false);
  });

  it('focuses xterm and requests the optional API after inputmode is unlocked', () => {
    const textarea = document.createElement('textarea');
    const focus = vi.fn(); const show = vi.fn();
    expect(showTerminalVirtualKeyboard({ textarea, focus }, { virtualKeyboard: { show } })).toBe(true);
    expect(textarea.inputMode).toBe('text'); expect(focus).toHaveBeenCalledOnce(); expect(show).toHaveBeenCalledOnce();
  });
});
