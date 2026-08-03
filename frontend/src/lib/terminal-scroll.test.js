import { describe, expect, it } from 'vitest';
import {
  MAX_SCROLL_STEPS, PAGE_INPUT_DOWN, PAGE_INPUT_UP, PAGE_SCROLL_MIN_THRESHOLD, SCROLL_LINE_THRESHOLD,
  chooseScrollMode, describeScrollActions, planTerminalScroll, resolveThreshold, sgrWheelSequence,
} from './terminal-scroll.js';

describe('chooseScrollMode', () => {
  it('uses page mode only for a writable alternate-screen terminal', () => {
    expect(chooseScrollMode({ alternateScreen: true, readonly: false })).toBe('page');
  });
  it('falls back to scroll mode on the normal screen', () => {
    expect(chooseScrollMode({ alternateScreen: false, readonly: false })).toBe('scroll');
  });
  it('never sends PTY input from a readonly terminal', () => {
    expect(chooseScrollMode({ alternateScreen: true, readonly: true })).toBe('scroll');
    expect(chooseScrollMode({ alternateScreen: false, readonly: true })).toBe('scroll');
  });
});

describe('planTerminalScroll', () => {
  it('emits one line step per threshold and bounds the remainder (scroll mode)', () => {
    const plan = planTerminalScroll({ mode: 'scroll', accumulated: SCROLL_LINE_THRESHOLD, threshold: SCROLL_LINE_THRESHOLD });
    expect(plan).toEqual({ mode: 'scroll', up: 1, down: 0, remainder: 0 });
  });
  it('accumulates several down steps while keeping the residual bounded', () => {
    const plan = planTerminalScroll({ mode: 'scroll', accumulated: -2 * SCROLL_LINE_THRESHOLD - 5, threshold: SCROLL_LINE_THRESHOLD });
    expect(plan.up).toBe(0);
    expect(plan.down).toBe(2);
    expect(plan.remainder).toBe(-5);
  });
  it('does not emit below the threshold (no jitter)', () => {
    const plan = planTerminalScroll({ mode: 'scroll', accumulated: SCROLL_LINE_THRESHOLD - 1, threshold: SCROLL_LINE_THRESHOLD });
    expect(plan).toEqual({ mode: 'scroll', up: 0, down: 0, remainder: SCROLL_LINE_THRESHOLD - 1 });
  });
  it('uses the page-sized threshold in page mode', () => {
    const pageThreshold = 480;
    const plan = planTerminalScroll({ mode: 'page', accumulated: pageThreshold, threshold: pageThreshold });
    expect(plan).toEqual({ mode: 'page', up: 1, down: 0, remainder: 0 });
    const partial = planTerminalScroll({ mode: 'page', accumulated: pageThreshold - 10, threshold: pageThreshold });
    expect(partial).toEqual({ mode: 'page', up: 0, down: 0, remainder: pageThreshold - 10 });
  });
  it('treats a non-finite accumulator as a no-op', () => {
    expect(planTerminalScroll({ mode: 'scroll', accumulated: Number.NaN, threshold: SCROLL_LINE_THRESHOLD }))
      .toEqual({ mode: 'scroll', up: 0, down: 0, remainder: 0 });
  });
  it('falls back to the default threshold when none is supplied', () => {
    expect(resolveThreshold('scroll', 0)).toBe(SCROLL_LINE_THRESHOLD);
    expect(resolveThreshold('page', undefined)).toBe(PAGE_SCROLL_MIN_THRESHOLD);
    expect(resolveThreshold('page', 1)).toBe(PAGE_SCROLL_MIN_THRESHOLD);
    expect(resolveThreshold('scroll', 40)).toBe(40);
  });
  it('bounds huge finite deltas and drops excess while preserving only the modulo remainder', () => {
    const huge = SCROLL_LINE_THRESHOLD * 1_000_000 + 7;
    const plan = planTerminalScroll({ mode: 'scroll', accumulated: huge, threshold: SCROLL_LINE_THRESHOLD });
    expect(plan).toEqual({ mode: 'scroll', up: MAX_SCROLL_STEPS, down: 0, remainder: 7 });
    expect(describeScrollActions(plan)).toHaveLength(MAX_SCROLL_STEPS);
  });
});

describe('describeScrollActions', () => {
  it('maps page steps to raw PageUp/PageDown PTY input', () => {
    const plan = { mode: 'page', up: 1, down: 2, remainder: 0 };
    expect(describeScrollActions(plan)).toEqual([
      { kind: 'input', seq: PAGE_INPUT_UP },
      { kind: 'input', seq: PAGE_INPUT_DOWN },
      { kind: 'input', seq: PAGE_INPUT_DOWN },
    ]);
  });
  it('maps scroll steps to server-side actions', () => {
    const plan = { mode: 'scroll', up: 1, down: 1, remainder: 0 };
    expect(describeScrollActions(plan)).toEqual([
      { kind: 'action', name: 'scroll-up' },
      { kind: 'action', name: 'scroll-down' },
    ]);
  });
  it('emits nothing for a zero plan', () => {
    expect(describeScrollActions({ mode: 'scroll', up: 0, down: 0, remainder: 0 })).toEqual([]);
  });
  it('also bounds externally supplied plans', () => {
    expect(describeScrollActions({ mode: 'page', up: Number.MAX_SAFE_INTEGER, down: 0, remainder: 0 }))
      .toHaveLength(MAX_SCROLL_STEPS);
  });
});

// Un'applicazione che abilita il mouse tracking (Claude Code lo fa, Codex no)
// possiede il proprio scorrimento: sottrarle la rotella per il copy-mode tmux
// mostra una scrollback che non ha mai scritto come log.
describe('mouse mode', () => {
  it('gives the gesture to an application that owns the wheel', () => {
    expect(chooseScrollMode({ mouseTracking: true, alternateScreen: false, readonly: false })).toBe('mouse');
  });
  it('wins over page mode: an alternate-screen app with tracking still owns the wheel', () => {
    expect(chooseScrollMode({ mouseTracking: true, alternateScreen: true, readonly: false })).toBe('mouse');
  });
  it('never reaches a readonly terminal, which must not send PTY input', () => {
    expect(chooseScrollMode({ mouseTracking: true, alternateScreen: false, readonly: true })).toBe('scroll');
    expect(chooseScrollMode({ mouseTracking: true, alternateScreen: true, readonly: true })).toBe('scroll');
  });
  it('stays on server-side scroll when the application does not track the mouse', () => {
    expect(chooseScrollMode({ mouseTracking: false, alternateScreen: false, readonly: false })).toBe('scroll');
  });

  it('encodes SGR wheel reports at the given 1-based viewport cell', () => {
    expect(sgrWheelSequence('up', 12, 34)).toBe('\x1b[<64;12;34M');
    expect(sgrWheelSequence('down', 1, 1)).toBe('\x1b[<65;1;1M');
  });
  it('clamps out-of-range or malformed coordinates instead of emitting garbage', () => {
    expect(sgrWheelSequence('up', 0, -5)).toBe('\x1b[<64;1;1M');
    expect(sgrWheelSequence('up', NaN, undefined)).toBe('\x1b[<64;1;1M');
    expect(sgrWheelSequence('down', 99999, 99999)).toBe('\x1b[<65;9999;9999M');
  });

  it('maps mouse steps to PTY input at the pointer position', () => {
    const plan = { mode: 'mouse', up: 2, down: 0, remainder: 0 };
    expect(describeScrollActions(plan, { col: 7, row: 3 })).toEqual([
      { kind: 'input', seq: '\x1b[<64;7;3M' },
      { kind: 'input', seq: '\x1b[<64;7;3M' },
    ]);
  });
  it('falls back to the first cell when no position is supplied', () => {
    expect(describeScrollActions({ mode: 'mouse', up: 0, down: 1, remainder: 0 }))
      .toEqual([{ kind: 'input', seq: '\x1b[<65;1;1M' }]);
  });
  it('keeps the per-event step cap in mouse mode', () => {
    expect(describeScrollActions({ mode: 'mouse', up: Number.MAX_SAFE_INTEGER, down: 0, remainder: 0 }, { col: 1, row: 1 }))
      .toHaveLength(MAX_SCROLL_STEPS);
  });
});
