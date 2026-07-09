# Changelog

All notable changes to NexusCrew are tracked here.

## 0.7.2

- fix(grid): fleet cell cards in the desktop sidebar are now clickable (add tile) and
  draggable into the grid when their tmux session is alive — they only exposed the
  power button before, so on fleet-only hosts nothing could be dragged. Verified
  end-to-end in a real browser (click → live tile, drag → new column).

## 0.7.6

- docs: README "License" section said MIT — corrected to Apache-2.0 (badge and LICENSE
  file were already correct since 0.7.1). No code changes.

## 0.7.5

- feat(grid): **open tiles are movable** — drag a tile by its header and drop it anywhere
  (same directional zones as sidebar drags: side-by-side, stack, new column).

## 0.7.4

- fix(desktop): **black screen** on desktop in 0.7.3 — the stale-bundle banner was declared
  inside the mobile branch but referenced by the desktop tree (TDZ ReferenceError).
  Hoisted before both branches; the banner now also covers the mobile single view.
- fix(keybar): 8+8 keys — ↑ aligned exactly above ↓ (added ⌨ composer toggle in row 2,
  matching the reference layout).

## 0.7.3 — "Window Management"

- feat(grid): directional drop zones (VS Code-style) — hover quadrant decides: left/right
  edges place side-by-side, top/bottom stack, with live preview overlay. Balanced click
  placement (grid-like growth, no endless narrow columns).
- feat(size): sessions follow the focus — `window-size latest`, web clients participate:
  going back to a bigger client and typing restores its size (real-tmux gated).
- feat(ui): collapsible + resizable sidebar (mini 48px with instant tooltips), pin sessions
  and cells to top (persisted) + activity-based auto-sort, Termux-style two-row KeyBar
  (ESC ☰ / — HOME ↑ END PGUP | ⇥ CTRL ALT ← ↓ → PGDN) with sticky ALT.
- fix(grid): xterm refits when its tile is resized (ResizeObserver) — adding tiles or
  dragging dividers adapts live terminals; resize listeners cleaned on cancel/blur/unmount;
  aborted drags clear the preview; tile cap enforced fail-safe.
- fix(mobile): high-visibility round action buttons (power/pin), SVG power icon
  (U+23FB was tofu on Android), stale-bundle update banner (tap to reload).
- Two security review passes on the cycle (all findings addressed); 155-test suite.

## 0.7.1

- License corrected to **Apache-2.0** (0.7.0 was published with MIT metadata by mistake;
  0.7.0 is deprecated on npm). Added NOTICE. No code changes.

## 0.7.0 — "Fleet Deck"

- feat(grid): desktop multi-session grid — drag from the sidebar,
  tiling a colonne con auto-reflow, divisori trascinabili, focus singolo, composer
  per-tile a scomparsa, layout persistito (`nc_grid_v1`). Tile con `takeSize:false`
  (mai resize delle sessioni vive). Zero dipendenze nuove.
- feat(fleet): logica flotta nella UI — sidebar/home unificate: celle fleet anche da
  spente (⏻ up/down, engine picker, key A/P, boot persist, stato degraded) + sessioni
  tmux generiche. Server: `lib/fleet/` shell serializzato sul binario `fleet`
  (feature-detected con trust check: no symlink, no world-writable, schema
  `kind:"ai-fleet"` obbligatorio) + `GET/POST /api/fleet/*` dietro Bearer.
- feat(sessions): lifecycle dalla UI — `POST /api/sessions` (preset allowlistati,
  cwd realpath sotto home) e `DELETE /api/sessions/:name` (409 SEMPRE su `cloud-*`,
  anche con fleet assente). Card ricche: activity, comando corrente, preview ultima
  riga (cap 240, strip ANSI, cache 3s, best-effort).
- feat(ui): mobile restyle — home grouped by Fleet/Other sessions,
  card con preview e tempo relativo, FAB nuova sessione, vista singola rifinita.
- feat(i18n): UI multilingua IT/EN/ES, picker persistito, zero deps.
- Optional fleet integration contract: `fleet status --json` (schemaVersion 1); the host
  binary is trust-checked and schema-validated, feature-detected (absent → hidden UI).
- Suite: 150 tests (149 pass + 1 skip); two independent security review passes on design
  and implementation (all findings addressed).

## 0.4.3

- fix(mobile): adapt the layout to the soft keyboard. The app now uses `100dvh` and
  `interactive-widget=resizes-content`, so when the keyboard opens the view shrinks and the
  KeyBar stays visible above it (previously the bottom KeyBar was pushed behind the keyboard
  and looked missing). The terminal also refits on `visualViewport` changes.

## 0.4.2

- fix(attach): smart resize default. When no other client is attached to the session, the
  browser now drives the size (so a small phone gets a usable, non-clipped view and clean line
  editing instead of a session frozen at a larger width). When a real terminal is already
  attached, it still defaults to `ignore-size` to avoid shrinking that terminal's window.
- feat(keybar): add the keys mobile keyboards lack — `tab`, always-available arrows (← ↑ ↓ →),
  and a sticky `ctrl` modifier that folds the next typed character into its control code.

## 0.4.1

- fix(install): make `node-pty` an optional dependency. On Termux/Android it has no prebuild
  and `node-gyp rebuild` fails (`Undefined variable android_ndk_path`), which previously aborted
  the whole global install and left the `nexuscrew` bin unlinked. As optional, its build failure
  is non-fatal: the install completes and the runtime falls back to the platform PTY provider
  (`@mmmbuto/node-pty-android-arm64` on Termux, `@lydell/node-pty-linux-x64` on Linux x64).

## 0.4.0 — "pty-core"

Core rewrite from screenshot-and-poll to a faithful tmux client.

- replaced screenshotting with a **real PTY**: each attach runs `tmux attach` and bridges its
  bytes to xterm.js over a WebSocket — full color, copy-mode scroll, special keys, panes, windows
- **stateless**: tmux is the persistence; no database, no accounts
- **localhost-only**: binds `127.0.0.1` and refuses any non-loopback bind
- non-destructive default: attaches with `-f ignore-size` so a small client never resizes a
  session a real terminal is holding (`takeSize` to opt in)
- window/pane navigation moved to **server-side, allowlisted tmux commands** instead of fragile
  client-side prefix keys
- WebSocket hardening: close on protocol violation, no second attach, clamped geometry,
  backpressure cutoff, JSON errors with codes
- token delivered via URL fragment (never logged), 0600 file, constant-time compare

## 0.2.4

- added host-scoped tmux/session discovery so active session truth comes from the selected host
- bucketed launcher discovery into runnable, detected-only, and internal/plumbing entries
- improved send/interrupt flow with explicit host context and remote pane polling fallback
- added regression tests for host-scoped routes and launcher classification

## 0.2.3

- fixed npm CLI `bin` metadata so the published package exposes `nexuscrew` correctly
- kept the corrected stable line on the main npm dist-tags

## 0.2.2

- moved runtime to standalone tmux sessions instead of an implicit master tmux session
- made active tmux sessions the only valid chat targets
- added explicit tmux creation from detected launchers
- switched launcher discovery to runtime/shell-driven detection
- gated shell-file-only detections so they are not treated as runnable automatically
- aligned workspace defaults to the runtime user home

## 0.2.1

- older release line, now deprecated in favor of the current stable line
