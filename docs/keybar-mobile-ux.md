# KeyBar mobile UX — technical notes for review

This document describes the changes in the `keybar-mobile-ux` branch for the
mobile (touch) experience of the on-screen KeyBar. Written for whoever (human
or AI) reviews the PR.

## Problem

On mobile (PWA via xterm.js over a PTY) two things were painful:

1. **Confirming TUI multi-choice selections** (e.g. Claude Code's
   `AskUserQuestion`, `y/n` menus, `select`): the KeyBar had arrow keys to
   navigate options but no Enter, and the soft-keyboard Enter is often **not
   captured by xterm** (IME/soft-keyboard quirk).
2. **The soft keyboard covered the answers**: while scrolling choices with the
   KeyBar arrows, the ComposerBar textarea kept focus, so the soft keyboard
   stayed open and hid the TUI choice screen.
3. The default KeyBar showed two full rows of rarely-used commands
   (ESC/HOME/END/PGUP/TAB/CTRL/ALT/PGDN…), crowding the area above the composer.

## What changed (files)

- `frontend/src/components/KeyBar.jsx`
- `frontend/src/components/KeyBar.css`
- `frontend/src/components/KeyBar.test.jsx` (new)
- `frontend/dist/*` (rebuilt; `dist` is tracked in this repo, so it is part of
  the PR)

No backend, `encode`, audio, or timing changes. `KeyBar` copy-mode layout is
unchanged.

## Behaviour

### Reduced bar (default, `expanded=false`)

A single row, left to right:

```
[⊞ expand] [⌨ keyboard] [☰ menu]   ………   [↑] [↓] [←] [→]
```

- `⊞` toggles the full two-row command layout ("as before": ESC/HOME/END/PGUP/
  TAB/CTRL/ALT/PGDN…). `aria-label` swaps between "espandi comandi" /
  "restringi comandi"; `armed` (green) when expanded.
- `⌨` is the existing composer toggle (`onKeyboard` -> `setShowComposer`),
  hoisted here from the expanded view so it's always reachable.
- `☰` is the existing tmux actions menu (unchanged).
- Arrows are grouped on the right in a `.nc-keybar-arrows` element with
  `margin-left:auto` (auto-margin absorbs free space before flex-grow, so the
  group is pushed right and separated from the toggle/menu on the left).

### Expanded bar (`expanded=true`)

The previous full two-row layout, with `⊞` at the start of row 1 (it now
retracts). The `⌨` is no longer duplicated here (it lives in the reduced bar).

### Soft-keyboard handling

Every KeyBar button that acts on the terminal via `send(seq)` (arrows, ESC,
TAB, etc. — i.e. `Bk(...)` and `Ba(...)`) now calls `blurActive()` before
sending: it blurs `document.activeElement` (unless it's `document.body`). On
mobile this closes the soft keyboard so the TUI answer screen stays visible
while scrolling. Buttons that are **local UI** do **not** blur:

- `⊞` toggle, `☰` menu, `⌨` composer toggle, `CTRL`/`ALT` sticky (they don't
  send to the pty).

`blurActive`:
```js
const blurActive = () => {
  const el = document.activeElement;
  if (el && typeof el.blur === 'function' && el !== document.body) el.blur();
};
```

## What was tried and dropped

A dedicated green-square **Enter** button that sent a raw `CR` (`\r`) via
`send(CR)` was added and then removed. Reason: in the TUIs tested (Claude Code
`AskUserQuestion`) it did not confirm the selection — it behaved like the left
arrow (no effect). The arrows work (the escape sequences reach the pty and move
the selection), but a plain `CR` did not register as Enter for those TUIs.
Rather than ship a non-working button, it was removed. Confirming a selection
on mobile currently relies on the soft keyboard / composer. Investigating
whether those TUIs want `LF` (`\n`) instead of `CR` is left as follow-up.

## Tests

`frontend/src/components/KeyBar.test.jsx` (vitest + @testing-library/react),
4 tests:

1. reduced bar default contents: `[⊞, ⌨, ☰]` left + `[↑, ↓, ←, →]` right; no
   `ESC`/`HOME`; no `button.enter`.
2. toggle expands (shows `ESC`, 2 rows) and retracts (1 row).
3. arrow keys send the right escape sequences (`\x1b[A/B/D/C`).
4. a send-key blurs the active element (soft-keyboard-hide behaviour).

Full frontend suite: 74/74 passing (`npm --prefix frontend test`).

## Manual verification

Verified on a real mobile PWA client (loopback via SSH tunnel):
- arrows move the selection in a TUI multi-choice and the **soft keyboard does
  not open / cover the answers**;
- `⊞` expands/retracts the full command rows;
- `⌨` toggles the composer.

## Build / deploy (for reference)

```sh
cd frontend && npm ci && npm run build          # produces frontend/dist
# dist is copied into the installed package and the service restarted:
cp -a frontend/dist/. <global_pkg>/frontend/dist/
systemctl --user restart nexuscrew
```

## Compatibility / risks

- The reduced bar is the default for **all** clients (not only mobile). On
  desktop the `⊞` toggle still gives access to the full set, so no capability
  is lost — only one extra tap away.
- `blurActive()` runs on every send-key tap; it's a no-op when the active
  element is `document.body` or a non-focusable element, so desktop is
  unaffected.
- `⌨` moving out of the expanded view: the composer toggle is still available
  via the header keyboard button and via `⌨` in the reduced bar; the expanded
  view no longer repeats it.