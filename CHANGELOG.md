# Changelog

All notable changes to NexusCrew are tracked here.

## 0.8.0 — 2026-07-11 — "Many Nodes, Many Monitors"

The multi-node + multi-monitor release: one UI for the tmux fleets of several hosts,
named multi-window decks, a real CLI, an MCP operator bridge, and a first-run wizard.

- feat(mcp): **MCP bridge** — `nexuscrew mcp` runs a minimal stdio MCP server (hand-rolled
  JSON-RPC 2.0, newline-delimited, no SDK deps) that brings NexusCrew inside AI sessions as
  the cell→human channel: `nc_notify` (UI toast + web push), `nc_ask` (question with deferred
  answer pasted back into the caller's tmux session as `[human reply · ask#<id>] …`
  by default (`NEXUSCREW_REPLY_LABEL` configures the neutral operator label),
  `nc_send_file` (copy into the session outbox with badge + notification), `nc_status` and
  `nc_inbox` (read-only). Caller identity from `$TMUX` (`display-message #S`) with
  `NEXUSCREW_MCP_SESSION` fallback; fail-closed on malformed input (garbage never crashes,
  JSON-RPC errors instead).
- feat(server): notification plumbing — `POST /api/notify` (rate limit global per token +
  per session, capped LRU buckets), SSE `GET /api/events` for live UI frames, web push
  (`web-push` dep, lazy VAPID keys in `~/.nexuscrew/vapid.json` 0600, https-only endpoints
  with private-host rejection and a subscription cap, subscriptions in `push.json` 0600
  with dead-endpoint cleanup), asks store persisted in `asks.json` 0600 (hard cap on open
  asks, rate-limited creation). Answer route is READONLY-gated (paste is a PTY write),
  claims the ask atomically (concurrent answers cannot double-paste) and only commits
  after a successful paste. READONLY is a floor: ask creation and outbox delivery are 403,
  VAPID keys are never generated in READONLY, and secret stores (`vapid/push/asks.json`)
  with unsafe mode/owner or symlinked are refused fail-closed.
- feat(ui): notification toasts + open-asks panel with reply box/option buttons and counter
  badge (all views, i18n it/en/es); push enable/disable in Settings → System; service worker
  handles `push` and `notificationclick` (deep-link `/#ask=<id>`).

- feat(cli): **unified CLI** — `nexuscrew` alone smart-ups (zero-question init → start →
  URL + QR); new subcommands `up|down`, `url [--qr]`, `token rotate`, `logs [-f]`,
  `doctor`, `update`, and an extended `status [--json]` with roles and per-node tunnel
  state. The server startup log no longer prints the token.
- feat(nodes): **multi-node foundation** — `~/.nexuscrew/nodes.json` secret store (0600,
  atomic writes, strict schema) and an SSH tunnel manager with dedicated restricted keys,
  explicit loopback binds, `ExitOnForwardFailure`, and retry with backoff. CLI commands
  cover node registration, tests, tunnel lifecycle, token setup, and reachable-node mode.
- feat(proxy): **single-origin multi-node** — the hub reverse-proxies `/node/<name>/…`
  over HTTP and WebSocket. Local auth happens before node resolution; remote tokens stay
  server-side; client credentials and hop-by-hop headers are stripped; READONLY blocks
  mutations and remote PTY attach.
- feat(deck): **multi-window decks** — named workspaces at `/deck/<name>`, with one
  remembered tile layout per browser and deck. Deck tiles attach with `ignore-size`; the
  focused tile becomes size owner so browser windows do not fight real terminals.
- feat(ui): **remote nodes, settings, and first-run wizard** — per-node groups and remote
  attach in the sidebar, grid, and decks; a three-tab settings panel for roles, nodes, and
  system actions; and a skippable three-step setup wizard. Mutations use a closed-list,
  READONLY-gated API with strict validation and token-redacted responses.
- security: proxy upgrade failures return a controlled 502; WebSocket upgrades
  pre-authenticate through the injected header; local query tokens are stripped before
  forwarding; token rotation invalidates live sessions after restart.
- i18n: all new surfaces in English, Italian, and Spanish.
- tests: suite grows from 262 to **495 tests** (494 pass / 1 skip).

## 0.7.7

- feat(composer): **attachment button** to the left of the input — a File / Camera / Gallery
  menu for quick file send. The picked file lands in the session inbox and its path is
  appended to the composer text (you send it explicitly, so you can add a message). The
  camera uses the native capture hint on mobile and falls back to a picker on desktop.
- feat(fleet): **built-in fleet** — engine/cell definitions in `~/.nexuscrew/fleet.json`
  (editable, schema-validated), provider selection `external | builtin | disabled` chosen
  once at startup, and a single boot companion service installed by `nexuscrew init` (only
  when the built-in provider is active, with a migration gate that refuses a silent double
  boot). Launch path is argv-direct (no shell), with a hard command/env/cwd trust boundary.
- feat(fleet): fleet HTTP API hardening — `READONLY` blocks every mutation at the route
  level (external providers included), capability negotiation returns `501` for unsupported
  methods, `status` exposes `provider`/`bootOwner`/`capabilities`, a `restart` capability,
  and secrets (env values, prompts) are redacted from error output.

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
