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
export const MOUSE_WHEEL_UP_BUTTON = 64;   // SGR button code for wheel up
export const MOUSE_WHEEL_DOWN_BUTTON = 65; // SGR button code for wheel down

// SGR (DECSET 1006) wheel report: `CSI < Cb ; Cx ; Cy M`. Coordinates are
// 1-based and viewport-relative. The wheel has no release event, so a single
// press report per notch is the whole contract.
export function sgrWheelSequence(direction, col, row) {
  const button = direction === 'up' ? MOUSE_WHEEL_UP_BUTTON : MOUSE_WHEEL_DOWN_BUTTON;
  const coord = (value) => Math.max(1, Math.min(9999, Number.isFinite(value) ? Math.round(value) : 1));
  return `\x1b[<${button};${coord(col)};${coord(row)}M`;
}

// Three-way choice.
//   mouse mode -> the application enabled mouse tracking with SGR encoding: it
//                 owns its own scrolling and expects the wheel events itself.
//                 Stealing them for tmux copy-mode shows a scrollback the app
//                 never populated as a log (repaint frames, not a transcript).
//   page mode  -> writable alternate-screen TUI without mouse tracking.
//   scroll mode-> everything else, and ALWAYS when readonly: a readonly
//                 terminal must never send PTY input, so it can reach neither
//                 mouse nor page mode.
// `mouseTracking` is true only when tracking AND SGR encoding are both active:
// emitting SGR to an application that negotiated a legacy encoding would send
// it bytes it cannot decode.
export function chooseScrollMode({ alternateScreen = false, readonly = false, mouseTracking = false } = {}) {
  if (readonly) return 'scroll';
  if (mouseTracking) return 'mouse';
  return alternateScreen ? 'page' : 'scroll';
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

// Map a plan to the concrete actions for the three integration points.
//   mouse mode -> SGR wheel reports as PTY bytes (sendInput), at `position`
//   page mode  -> raw PageUp/PageDown PTY bytes (sendInput)
//   scroll mode-> server-side scroll-up/scroll-down (action)
// Readonly never reaches mouse or page mode (chooseScrollMode guards it), so
// this never emits PTY input for a readonly terminal.
export function describeScrollActions(plan, position = null) {
  const actions = [];
  const col = position && Number.isFinite(position.col) ? position.col : 1;
  const row = position && Number.isFinite(position.row) ? position.row : 1;
  const boundedCount = (value) => Math.min(MAX_SCROLL_STEPS,
    Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);
  const step = (direction) => {
    if (plan.mode === 'mouse') return { kind: 'input', seq: sgrWheelSequence(direction, col, row) };
    if (plan.mode === 'page') return { kind: 'input', seq: direction === 'up' ? PAGE_INPUT_UP : PAGE_INPUT_DOWN };
    return { kind: 'action', name: direction === 'up' ? 'scroll-up' : 'scroll-down' };
  };
  for (let i = 0; i < boundedCount(plan.up); i += 1) actions.push(step('up'));
  for (let i = 0; i < boundedCount(plan.down); i += 1) actions.push(step('down'));
  return actions;
}
