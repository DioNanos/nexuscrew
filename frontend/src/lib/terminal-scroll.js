// Decide how to scroll the terminal given the active xterm buffer type.
//
// alt-screen (a full-screen TUI like Claude Code) has NO tmux scrollback: the
// app draws directly to the alternate buffer, so tmux copy-mode scroll shows
// nothing. To scroll the TUI's own transcript we send PageUp/PageDown to the
// pty (the TUI handles them). PageUp scrolls a whole page, so we use a wider
// swipe/wheel threshold.
//
// normal-screen (a plain shell) has tmux scrollback: use the server-side
// scroll-up/scroll-down action (tmux copy-mode, with -e auto-exit at bottom).

export const PGUP = '\x1b[5~';
export const PGDN = '\x1b[6~';
export const LINE_STEP = 24;   // px per tick in normal-screen (tmux copy-mode, ~3 rows)
export const PAGE_STEP = 80;   // px per page key in alt-screen (PageUp = full page)

// Returns { kind, up, down, step }:
//   kind 'send'   -> up/down are raw byte sequences to write to the pty
//   kind 'action' -> up/down are server-side tmux action names
export function scrollPlan({ bufferType, readonly }) {
  if (!readonly && bufferType === 'alternate') {
    return { kind: 'send', up: PGUP, down: PGDN, step: PAGE_STEP };
  }
  return { kind: 'action', up: 'scroll-up', down: 'scroll-down', step: LINE_STEP };
}