// Pure bounded scroll plan for the terminal surface.
//
// Writable alternate-screen TUIs (vim/less/htop in the alt buffer) own their
// own viewport: a vertical gesture must reach them as raw PageUp/PageDown PTY
// input, not as a tmux copy-mode scroll action. Normal-screen and any readonly
// terminal keep the existing server-side scroll-up/scroll-down actions.
//
// The helper is deliberately pure: given the terminal mode, a signed
// accumulated pixel delta and a threshold, it returns how many up/down steps
// to emit and the residual accumulator. Convention: a positive accumulated
// value means "scroll up" (older history), a negative one means "scroll down"
// (newer). Each caller maps its own device delta onto that convention.

export const SCROLL_LINE_THRESHOLD = 24;   // px per line tick (matches the legacy STEP)
export const PAGE_SCROLL_MIN_THRESHOLD = 80; // safe page fallback for hidden/zero-sized hosts
export const MAX_SCROLL_STEPS = 8;         // bound work and PTY/server bursts per browser event
export const PAGE_INPUT_UP = '\x1b[5~';     // raw PageUp sent to the PTY
export const PAGE_INPUT_DOWN = '\x1b[6~';  // raw PageDown sent to the PTY

// Page mode is only for a writable alternate-screen terminal: readonly must
// never send PTY input, and normal-screen scroll stays server-side.
export function chooseScrollMode({ alternateScreen = false, readonly = false } = {}) {
  return alternateScreen && !readonly ? 'page' : 'scroll';
}

// Resolve the active threshold for a mode. Callers pass an explicit threshold
// (the live viewport height for page mode, the line step for scroll mode); the
// fallback keeps the helper usable in isolation for tests.
export function resolveThreshold(mode, threshold) {
  if (mode === 'page') {
    if (Number.isFinite(threshold) && threshold > 0) {
      return Math.max(PAGE_SCROLL_MIN_THRESHOLD, threshold);
    }
    return PAGE_SCROLL_MIN_THRESHOLD;
  }
  if (Number.isFinite(threshold) && threshold > 0) return threshold;
  return SCROLL_LINE_THRESHOLD;
}

// Pure plan: { mode, up, down, remainder }.
//   up/down = number of steps to emit in each direction (never both non-zero).
//   remainder = the bounded residual accumulator (|remainder| < threshold),
//   preserving the caller's sign convention so the accumulator is reusable.
export function planTerminalScroll({ mode = 'scroll', accumulated = 0, threshold = 0 } = {}) {
  const thr = resolveThreshold(mode, threshold);
  if (!Number.isFinite(accumulated)) return { mode, up: 0, down: 0, remainder: 0 };
  const abs = Math.abs(accumulated);
  if (abs < thr) return { mode, up: 0, down: 0, remainder: accumulated };
  const rawCount = Math.floor(abs / thr);
  const count = Math.min(rawCount, MAX_SCROLL_STEPS);
  // Deliberately drop steps beyond the per-event cap. Keeping only the modulo
  // remainder prevents one synthetic/accelerated wheel event from scheduling
  // another burst on every subsequent event.
  const remainder = (accumulated >= 0 ? 1 : -1) * (abs % thr);
  return {
    mode,
    up: accumulated > 0 ? count : 0,
    down: accumulated < 0 ? count : 0,
    remainder,
  };
}

// Map a plan to the concrete actions for the two integration points.
//   page mode  -> raw PageUp/PageDown PTY bytes (sendInput)
//   scroll mode-> server-side scroll-up/scroll-down (action)
// Readonly never reaches page mode (chooseScrollMode guards it), so this never
// emits PTY input for a readonly terminal.
export function describeScrollActions(plan) {
  const actions = [];
  const boundedCount = (value) => Math.min(MAX_SCROLL_STEPS,
    Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);
  for (let i = 0; i < boundedCount(plan.up); i += 1) {
    actions.push(plan.mode === 'page' ? { kind: 'input', seq: PAGE_INPUT_UP } : { kind: 'action', name: 'scroll-up' });
  }
  for (let i = 0; i < boundedCount(plan.down); i += 1) {
    actions.push(plan.mode === 'page' ? { kind: 'input', seq: PAGE_INPUT_DOWN } : { kind: 'action', name: 'scroll-down' });
  }
  return actions;
}
