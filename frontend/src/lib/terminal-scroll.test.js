import { describe, expect, it } from 'vitest';
import { PGDN, PGUP, LINE_STEP, PAGE_STEP, scrollPlan } from './terminal-scroll.js';

describe('terminal-scroll plan', () => {
  it('alt-screen + writable: sends PageUp/PageDown to the pty (TUI scrolls its own transcript)', () => {
    const plan = scrollPlan({ bufferType: 'alternate', readonly: false });
    expect(plan).toEqual({ kind: 'send', up: PGUP, down: PGDN, step: PAGE_STEP });
    expect(plan.up).toBe('\x1b[5~');
    expect(plan.down).toBe('\x1b[6~');
    expect(plan.step).toBeGreaterThan(LINE_STEP);
  });

  it('normal-screen: uses tmux copy-mode scrollback actions with the line step', () => {
    const plan = scrollPlan({ bufferType: 'normal', readonly: false });
    expect(plan).toEqual({ kind: 'action', up: 'scroll-up', down: 'scroll-down', step: LINE_STEP });
  });

  it('readonly alt-screen: falls back to tmux copy-mode (never sends input to a readonly pane)', () => {
    const plan = scrollPlan({ bufferType: 'alternate', readonly: true });
    expect(plan.kind).toBe('action');
    expect(plan.up).toBe('scroll-up');
  });

  it('readonly normal-screen: tmux copy-mode', () => {
    const plan = scrollPlan({ bufferType: 'normal', readonly: true });
    expect(plan.kind).toBe('action');
  });
});