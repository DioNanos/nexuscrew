# Mobile UX — technical notes for review (KeyBar + composer submit)

This document describes the changes in the `keybar-mobile-ux` branch for the
mobile (touch) experience of NexusCrew's PWA. It covers two independent
mobile-UX fixes that ride the same branch:

- **KeyBar redesign** — reduced default bar + soft-keyboard handling for TUI
  multi-choice navigation.
- **Composer submit (IME)** — the ➤ send button now reliably delivers the
  typed prompt even when the mobile IME has not committed the text to React
  state.

Written for whoever (human or AI) reviews the PR.

## Problem

On mobile (PWA via xterm.js over a PTY) three things were painful:

1. **Confirming TUI multi-choice selections** (e.g. Claude Code's
   `AskUserQuestion`, `y/n` menus, `select`): the KeyBar had arrow keys to
   navigate options but no Enter, and the soft-keyboard Enter is often **not
   captured by xterm** (IME/soft-keyboard quirk).
2. **The soft keyboard covered the answers**: while scrolling choices with the
   KeyBar arrows, the ComposerBar textarea kept focus, so the soft keyboard
   stayed open and hid the TUI choice screen.
3. The default KeyBar showed two full rows of rarely-used commands
   (ESC/HOME/END/PGUP/TAB/CTRL/ALT/PGDN…), crowding the area above the composer.
4. **The ➤ send button silently dropped the prompt**: typing a prompt with a
   mobile IME (SwiftKey etc.) and tapping ➤ often sent nothing — the prompt
   stayed in the field as if the tap had no effect. See the dedicated
   "Composer: mobile submit (IME)" section.

## What changed (files)

- `frontend/src/components/KeyBar.jsx`
- `frontend/src/components/KeyBar.css`
- `frontend/src/components/KeyBar.test.jsx` (new)
- `frontend/src/components/ComposerBar.jsx` (submit reads live DOM value)
- `frontend/src/components/ComposerBar.test.jsx` (new "mobile IME submit" case)
- `frontend/dist/*` (rebuilt; `dist` is tracked in this repo, so it is part of
  the PR)

No backend, `encode`, audio, or timing changes. `KeyBar` copy-mode layout is
unchanged. `ComposerBar` Enter behaviour is unchanged (Enter is still a
newline by design — the fix is only about reading the live DOM value on
submit).

## Behaviour

### Reduced bar (default, `expanded=false`)

A single row, left to right:

```
[⊞ expand] [⌨ keyboard] [☰ menu]   ………   [↑] [↓] [←] [→] [PGUP] [PGDN]
```

- `⊞` toggles the full two-row command layout ("as before": ESC/HOME/END/
  TAB/CTRL/ALT…). `aria-label` swaps between "espandi comandi" /
  "restringi comandi"; `armed` (green) when expanded.
- `⌨` is the existing composer toggle (`onKeyboard` -> `setShowComposer`),
  hoisted here from the expanded view so it's always reachable.
- `☰` is the existing tmux actions menu (unchanged).
- Arrows are grouped on the right in a `.nc-keybar-arrows` element with
  `margin-left:auto` (auto-margin absorbs free space before flex-grow, so the
  group is pushed right and separated from the toggle/menu on the left).
- `PGUP`/`PGDN` live in the arrow group (not behind `⊞`) because on mobile
  there is no physical PageUp key and they are how a TUI scrolls its own
  transcript (e.g. Claude Code receives `\x1b[5~` / `\x1b[6~` as PageUp/Down).
  The rarely-used command keys (ESC/HOME/END/TAB/CTRL/ALT) stay behind `⊞`;
  only page keys were promoted back to the reduced bar so one-tap transcript
  scroll is restored (the first redesign had moved them out of the default
  view, which regressed scrolling on mobile).

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

## Composer: mobile submit (IME)

### Problem

On mobile, typing a prompt into the ComposerBar and tapping ➤ (send) often
sent nothing: the prompt stayed visible in the field and the terminal received
no input. It happened specifically when the IME had not yet "committed" the
typed text (e.g. tapping send right after typing, without an intervening
space / accepted suggestion).

### Root cause

`ComposerBar.submit()` read the React `text` state to decide what to send:

```js
async function submit() {
  const draft = text;                       // React state
  const value = stripTrailingNewlines(draft);
  if (!value || sending) return;            // silent no-op when empty
  ...
}
```

Two facts combine to make `text` stale on mobile:

1. **React 18 defers `onChange` during IME composition** — the synthetic
   `onChange` of the controlled textarea does not fire until `compositionend`.
   While the soft keyboard is composing (all predictive mobile typing), the
   `text` state is not updated with the visible text.
2. The ➤ button has `onPointerDown={(e) => e.preventDefault()}` — kept on
   purpose so the textarea does not lose focus and the soft keyboard stays
   open after a send. Side effect: tapping ➤ does **not blur** the textarea, so
   **`compositionend` never fires** and the composition never commits to state.

Result: `text` is empty/stale → `if (!value) return` → the submit is a silent
no-op. The DOM textarea still shows the prompt (the IME wrote it to the DOM;
React just does not know), so to the user it looks like "I typed it, I pressed
send, nothing happened."

On desktop this never bites: there is no IME composition, each keydown fires
`onChange` immediately, and `text` is always fresh.

### Fix

`submit()` now reads the **live DOM value** (`textareaRef.current.value`,
which contains the in-flight composition text) and syncs it into state before
sending, so both the send and `confirmSubmitted` (which clears the field) see
the real draft:

```js
async function submit() {
  const live = textareaRef.current ? textareaRef.current.value : text;
  if (live !== text) setText(live);         // sync stale state (mobile IME)
  const draft = live;
  const value = stripTrailingNewlines(draft);
  if (!value || sending) return;
  ...
}
```

- `setText(live)` updates `textRef.current` synchronously, so
  `confirmSubmitted`'s clearing branch (`textRef.current === submittedDraft`)
  matches and the field clears on success.
- **No regression on desktop**: when nothing is composing, `live === text` and
  no extra `setText` runs — behaviour is identical.
- The `preventDefault` on the send button is **kept** (the soft keyboard still
  stays open after a send). `onComposerKeyDown`, `confirmSubmitted`, and
  `composer-input.js` are untouched.

### Out of scope (by design, not changed)

The soft-keyboard **Enter** key still inserts a newline (it does not submit).
This is intentional — "l'Invio è esplicito (bottone ➤)" — and is the same on
desktop. Making Enter submit is a separate UX decision, deliberately not part
of this fix.

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

1. reduced bar default contents: `[⊞, ⌨, ☰]` left + `[↑, ↓, ←, →, PGUP, PGDN]`
   right; no `ESC`/`HOME`; no `button.enter`.
2. toggle expands (shows `ESC`, 2 rows) and retracts (1 row).
3. arrow + page keys send the right escape sequences (`\x1b[A/B/D/C` and
   `\x1b[5~` / `\x1b[6~` for PGUP/PGDN).
4. a send-key blurs the active element (soft-keyboard-hide behaviour).

`frontend/src/components/ComposerBar.test.jsx` adds one case for the IME fix:

5. "submits the live textarea value when the IME has not committed to React
   state" — simulates a mobile IME composition (DOM textarea value set, React
   `text` state deliberately left stale, no `change` event fired), clicks ➤,
   and asserts `submitText` is called with the visible prompt and the field
   clears. This test is **red before the fix** (submit no-ops on stale state)
   and **green after**.

Full frontend suite: **75/75 passing** (`npm --prefix frontend test`).

## Manual verification

Verified on a real mobile PWA client (loopback via SSH tunnel):
- arrows move the selection in a TUI multi-choice and the **soft keyboard does
  not open / cover the answers**;
- `⊞` expands/retracts the full command rows;
- `⌨` toggles the composer;
- after the composer fix, typing a prompt with the mobile IME and tapping ➤
  **sends it reliably**, including when send is tapped immediately after typing
  (the case that previously dropped the prompt).

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
- The composer submit fix is a **no-op when the live DOM value equals the
  React state** (no IME composition), so desktop behaviour is unchanged. It
  only reads the textarea's current `.value` and syncs state when they diverge.
- The soft-keyboard Enter key still inserts a newline (by design); this fix
  does not change Enter handling.

## Commits on this branch

In chronological order, on top of `origin/main` (`0.8.27`, `ec243e9`):

1. `1eb589a` feat(keybar): reduced default view + dedicated Enter button
2. `ab146dd` build: regenerate frontend dist after KeyBar changes
3. `423355f` fix(keybar): blur active element on send-keys so soft keyboard hides
4. `a2b1e57` refactor(keybar): drop dedicated Enter button, group arrows on the right
5. `db69649` refactor(keybar): hoist keyboard button into the reduced bar
6. `e5ff4f3` docs: technical notes for KeyBar mobile UX PR
7. `d7ed2ef` fix(composer): submit live DOM value when mobile IME hasn't committed to state
8. `3fa66bd` fix(keybar): restore PGUP/PGDN to the reduced bar for mobile transcript scroll

## Suggested PR description

> Mobile UX: KeyBar reduced view + soft-keyboard handling, and composer IME
> submit fix.
>
> KeyBar:
> - Default reduced bar: expand-toggle + keyboard toggle + hamburger menu on
>   the left, arrow keys + PGUP/PGDN grouped on the right. The toggle expands
>   the previous full two-row command layout. PGUP/PGDN are kept on the reduced
>   bar (not behind the toggle) so one-tap transcript scrolling works on mobile
>   (no physical PageUp key; a TUI like Claude Code receives them as PageUp/Down).
> - send(seq) keys blur the active element so the mobile soft keyboard hides
>   while scrolling TUI multi-choice selections (the answers stay visible).
> - Hoist the composer (keyboard) toggle into the reduced bar so it's always
>   reachable without expanding.
>
> Composer:
> - submit() reads the live textarea DOM value and syncs it into React state
>   before sending, so the ➤ send button reliably delivers a prompt even when
>   the mobile IME has not committed the text to state (React 18 defers
>   onChange during composition, and the send button suppresses blur to keep
>   the keyboard open). No-op when the DOM value already matches state, so
>   desktop is unchanged. Enter remains a newline by design.
>
> Tests: KeyBar.test.jsx (4) + a new ComposerBar IME-submit case; full suite
> 75/75. Verified on a real mobile PWA client. Full notes in
> `docs/keybar-mobile-ux.md`.