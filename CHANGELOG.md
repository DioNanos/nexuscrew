# Changelog

All notable changes to NexusCrew are tracked here.

## 0.8.34 — 2026-07-23 — "Local Forms"

- Adds the portable `fill-forms` skill for locally inspecting, filling and
  visually validating PDF and DOCX forms. It supports named AcroForm fields,
  coordinate overlays, checkboxes, character boxes, optional user-provided
  fonts and explicitly authorised signature images.
- Ships bounded Python helpers for PDF inspection, atomic PDF output, DOCX
  placeholder replacement and signature-background cleanup. They preserve the
  blank source, refuse silent field omissions and existing-output replacement,
  install no dependency automatically and make no network request.
- Keeps canonical instructions in English while selecting the user-facing
  language from the explicit preference, current request or reliable locale.
  Document wording and field values remain unchanged unless translation is
  explicitly requested. Filling never implies authorisation to sign, send or
  submit.

## 0.8.33 — 2026-07-23 — "Cold Boot"

- Restores Fleet on a true cold boot where no tmux server or default socket
  exists yet. The expected `error connecting to … (No such file or directory)`
  response is now treated as an empty tmux inventory, allowing the boot
  companion to create the shared server and start every `boot:true` cell. The
  migration inventory command uses the POSIX `C` message locale while
  preserving UTF-8 character handling, so this classification remains
  deterministic on localized Linux, macOS and Termux hosts.
- Keeps migration fail-closed for unexpected tmux failures such as permission
  errors, malformed output, ambiguous legacy sessions and rename collisions.
  The regression reproduces the exact stderr observed after reboot and verifies
  both provider availability and safe persistence of dotted cell identities.
- Adds an optional MCP companion guide and machine-readable catalog for
  structured Memory, searchable MSA knowledge, bounded Crew delegation and
  Mail. Agents discover existing tools first, recommend a companion only for a
  requested missing capability and never install or configure it without
  consent.
- Ships generic public `memory`, `vl-msa`, `crew` and `mail-assistant` skills.
  Their canonical instructions are in English and user-facing output follows
  the user's explicit preference or request language; Mail reply drafts follow
  the thread language unless overridden. No account, identity, folder,
  credential or machine-specific path is bundled.

## 0.8.32 — 2026-07-22 — "Touch History"

- Restores continuous mobile finger-drag navigation of tmux history in every
  terminal buffer, including alternate-screen AI clients such as Codex, Claude
  and Agy. Each 24 px of vertical travel again enters/advances tmux copy-mode by
  three lines, so a normal phone swipe is no longer discarded at touch end.
- Keeps desktop-wheel ownership unchanged: writable alternate-screen programs
  still receive bounded Page Up/Page Down input, while normal and readonly
  terminals use server-side tmux scrolling. Double tap, long-press selection,
  multi-touch cancellation, KeyBar and virtual-keyboard controls are unchanged.
- Stops composer controls from refocusing the textarea after dictated or typed
  input. Send hides/blurs the virtual keyboard best-effort, while history
  selection and input-size controls remain unfocused; only a direct textarea
  tap (or the configured terminal double tap) opens it.
- Adds a realistic regression using a 120 px swipe inside a 300 px terminal;
  the test fails on 0.8.31 with zero actions and passes only when five tmux
  scroll actions are emitted.

## 0.8.31 — 2026-07-22 — "Safe Identity"

- **tmux session naming for dotted cell ids.** tmux silently normalizes `.` to `_`
  in session names, so a cell whose id contains a dot (e.g. `agy.native`) could no
  longer be targeted by its nominal `cloud-<id>` name. Dotted ids now map
  deterministically to a dot-free, collision-free session name (`cloud-v2-…`, 55
  chars); ids without a dot keep the historical `cloud-<id>` name, so the existing
  sessions are never renamed. The real `tmuxSession` for any cell is always
  available from `nc_cells` and the Fleet UI — use that rather than guessing
  `cloud-<Cell>` for dotted ids. Cell launches are now staged (inert placeholder →
  window-local `remain-on-exit` on `@N` → `respawn-pane` on `%N`) so setup and
  early-exit diagnostics use stable tmux object IDs. Any pre-existing legacy
  session is migrated in place via `rename-session -t $N`
  (preserving the session id and the operator's attach).
- **Agy as a managed primary client** on Linux and macOS (non-Termux), with auth
  delegated to Agy's own local login (no credential store read or copied),
  `standard`/`unsafe` permission policies (`unsafe` adds
  `--dangerously-skip-permissions`, consistent with the other clients),
  free-text model selection, and an optional `--prompt-interactive` prompt passed
  as the last argument. Termux and Windows keep using Agy through `shell.local`
  with a per-cell `agy` command. Added to existing installs by an idempotent,
  non-destructive, platform-aware backfill.
- **Share revocation now converges as authorization, not availability.** Turning
  Share off persists private intent, withdraws the node from its hub over the
  still-live private forward, and only then replaces the local tunnel without
  its reverse channel. Authorized operational discovery (topology, decks and
  MCP cell directories) removes the owner after the hub acknowledgement, while
  a merely unreachable node remains visible as stale/offline. Partial failures
  remain explicit and are retried with bounded, structured boot diagnostics.

- **Selective mobile-UX PR #1 (UI only).** Three client-only behaviours ported
  onto the 0.8.31 candidate, no merge of PR #1:
  - **Optional compact KeyBar.** A new `keybarLayout: "full" | "compact"`
    preference (default `full`) renders a one-row compact bar with an expand
    toggle that temporarily reveals the exact full key set without rewriting
    the stored preference; the tall Enter and `showKeybarEnter=false` (no gap)
    apply to both layouts. Editable in Settings → Input (IT/EN/ES), reset-safe
    and synced across windows; a layout change never remounts xterm or
    reconnects its WebSocket.
  - **Live-DOM composer submit during IME.** Explicit submit reads
    `textareaRef.current.value`, syncs the React draft and sends the visible
    text after newline normalization — preserving the empty no-op, the
    failed-send draft, history, STT and the focus policy.
  - **Alternate-screen scroll as PageUp/PageDown.** A pure bounded plan routes
    writable alternate-screen (vim/less/htop) vertical gestures to raw
    `ESC[5~`/`ESC[6~` PTY input with a page-sized threshold; normal-screen and
    any readonly terminal keep the server-side `scroll-up`/`scroll-down`
    actions. Integrated into both wheel and touch paths without weakening
    double-tap unlock, long-press selection, multi-touch or VirtualKeyboard.

## 0.8.30 — 2026-07-22 — "Focused Control"

- Makes every owner/node name in the top deck bar an explicit expand/collapse control. Newly seen
  nodes start collapsed, each deck shows a compact live activity dot, and browser-local choices
  synchronize across open NexusCrew windows without exposing topology or presence to other nodes.
- Adds a full-height mobile Enter key beside Page Up/Page Down and a dedicated **Settings → Input**
  panel. Key-bar and speech-to-text actions keep the software keyboard closed by default, terminal
  input requires a nearby double tap, and every behavior can be changed or reset per browser.
- Hardens the mobile gesture state machine for movement, long press, cancel, blur, VirtualKeyboard
  geometry changes, visual-viewport recovery and sequential two-finger releases. Preference changes
  do not remount xterm or reconnect the terminal WebSocket.
- Runs configured Shell commands through an interactive login invocation on known POSIX shells so
  user PATH entries such as `agy` resolve while retaining the private launch broker. Immediate
  non-zero exits now surface a bounded `SHELL_COMMAND_FAILED` cause; successful one-shot completion
  and commands that remain active are reported distinctly.
- Adds the read-only `nc_cell_diagnostics` MCP tool for one exact local Fleet cell. It returns the
  configured Shell command with bounded credential redaction and the latest closed spawn/start
  failure cause, rejects remote targets, and preserves the existing local active-caller ACL.
- Extends regression coverage for cross-window input preferences, listener cleanup, IME relocking,
  multi-touch cancellation, redaction of generic uppercase environment assignments and the complete
  DeckBar/mobile-input/Shell/MCP integration.
- Gate: **998 isolated Node tests** (997 pass / 1 platform skip), **192/192 frontend tests**,
  production PWA build and zero production dependency vulnerabilities in both dependency trees.

## 0.8.29 — 2026-07-21 — "Stable Fleet Boot"

- Keeps the optional Fleet boot companion rooted at the stable user home on Linux, macOS and
  Termux. It can no longer create the shared tmux server from a replaceable npm package directory
  and leave later cells with an orphaned working directory after an update.
- Makes smart startup inspect and migrate both the main service and the Fleet companion. Startup
  fails closed unless regeneration, service activation and an explicit runtime restart all succeed,
  so an already-active unit cannot keep the old working directory. A private durable marker retries
  interrupted or failed migrations on the next start; a missing optional companion remains a
  non-blocking doctor warning.
- Validates imported Fleet working directories before persistence and redacts the active Shell
  command together with the existing prompt and environment secret values.
- Extends source-side diagnostic redaction to macOS `/Users/<name>/...` paths in addition to Linux
  and Android home paths.
- Gate: **987 isolated Node tests** (986 pass / 1 platform skip), **93/93 frontend component
  tests**, production PWA build and zero production dependency vulnerabilities in both dependency
  trees.

## 0.8.28 — 2026-07-21 — "Portable Workspaces"

- Makes Fleet backups portable across devices. Version 3 archives store a validated home-relative
  `cwdRel` instead of an absolute working directory; legacy v1/v2 archives remain readable, while
  foreign or missing paths fail closed and can be repaired explicitly from Settings.
- Adds **Shell** as a standard device-local Fleet engine. NexusCrew resolves the interactive shell
  at launch time, so no device-specific executable path is persisted. An optional per-cell command
  runs through the same shell as one opaque `-lc` string, disables restart supervision and returns
  the cell to the stopped state when complete.
- Keeps Shell commands bounded and private to cell definitions and portable backups. They are never
  exposed through status, topology, node inventory or diagnostics; prompt, model and unsafe policy
  controls do not apply to Shell.
- Preserves bounded Fleet launch causes as closed `code`/`phase` metadata. Preflight, launch-broker,
  tmux creation, readiness and spawn failures remain distinguishable without recording raw paths,
  arguments, environment values, prompts or credentials.
- Roots generated Linux services and Termux:Boot scripts at the stable user home, matching the
  macOS fix from 0.8.27. Smart startup repairs legacy service definitions, and `nexuscrew doctor`
  detects orphaned tmux working directories and stale or untrusted Termux server preloads without
  killing user sessions automatically.
- Gate: **980 isolated Node tests** (979 pass / 1 platform skip), **93/93 frontend component
  tests**, production PWA build and zero production dependency vulnerabilities in both dependency
  trees.

## 0.8.27 — 2026-07-21 — "Portable Control"

- Restores Fleet and shell launches on current Android/Termux builds by preserving only a
  validated, owner-safe `libtermux-exec` preload under the active Termux prefix. The related
  Node-shebang workaround now detects the Termux runtime layout even when Node reports Linux.
- Surfaces stable, sanitized `ENOENT`/`EACCES` client-spawn diagnostics without exposing command
  paths, arguments, environment values or credentials, and adds an actionable `nexuscrew doctor`
  check for the Termux execution bridge.
- Keeps macOS LaunchAgents rooted at the stable user home rather than the replaceable runtime
  directory, with a blocking doctor check for stale launchd working directories.
- Adds viewer-local aliases for routed nodes, keyed by stable instance identity and stored in a
  private local file. Aliases change display text only; remote labels, routes, owners and topology
  remain untouched and the mutation is never federated.
- Adds **Settings → Diagnostics** with bounded, structured, source-redacted records, temporary
  5/15/30/60-minute verbose windows, filtering, pause, export, clear and routed read access.
  Warning and error records remain available while verbose mode is off.
- Uses the logical Fleet cell name as the visible cell title on mobile, desktop overlays and grid
  tiles, while retaining technical route context only as non-primary metadata.
- Updates the production lock to `body-parser@1.20.6`.
- Gate: **931 isolated Node tests** (930 pass / 1 platform skip), **70/70 frontend component
  tests**, production PWA build and zero production dependency vulnerabilities in both dependency
  trees.

## 0.8.26 — 2026-07-20 — "MCP Identity"

- Makes MCP caller resolution directly diagnosable through the read-only `nc_identity` tool.
  The diagnostic works without a token or resolved session, reports only non-sensitive source
  and presence metadata, and returns stable missing/invalid identity codes with remediation.
- Keeps identity-gated tools fail-closed while improving their error contract. A missing or
  invalid tmux identity can no longer be mistaken for a transport failure, and `nc_notify`
  continues to degrade safely to an unknown sender.
- Documents the explicit `env_vars` name allowlist required by clients that clear the MCP stdio
  environment, including the matching repeatable `codex-vl mcp add --env-var NAME` form. Values
  remain outside command arguments and configuration files.
- Extends `nexuscrew doctor` with a non-failing MCP identity check: PWA-only users receive at
  most an informational warning, while MCP users can see whether `TMUX` or
  `NEXUSCREW_MCP_SESSION` is observable in the current process.
- Stabilizes the writable-provider-file security fixture across differing CI umasks without
  weakening the production permission check.
- Gate: **888 isolated Node tests** (887 pass / 1 platform skip), **39/39 frontend component
  tests**, production PWA build and zero production dependency vulnerabilities in both the root
  and frontend dependency trees.

## 0.8.25 — 2026-07-19 — "Token Plan"

- Adds Alibaba Token Plan Personal as a first-class managed provider for Claude Code,
  Codex-VL and Pi, with `qwen3.8-max-preview` as the default and one fixed local credential
  reference, `ALIBABA_CODE_API_KEY`. Credential values stay in the existing write-only
  credential layer and selected child environment; they never enter engine definitions,
  generated extensions, argv, status responses, logs or the package.
- Configures Claude Code against the plan's Anthropic-compatible base with isolated private
  state, a 983,616-token context and explicit Qwen aliases for model, Sonnet, Opus, Haiku,
  subagents and Fable. The API-key variable remains empty while the resolved value is supplied
  only through the authentication-token variable expected by the client. Selecting a non-default
  plan model keeps every alias aligned with that model and omits qwen3.8-only context and effort
  overrides.
- Configures Codex-VL through the Responses wire API with a Qwen-only plan allowlist and a
  packaged qwen3.8 catalog: 95% effective context, `xhigh` default reasoning, text and image
  input, original image detail and parallel tool calls disabled. The profile has no OpenAI or
  pay-as-you-go fallback.
- Gives Pi a private, value-free provider extension. Response-capable Qwen models use Pi's
  Responses adapter; GLM and DeepSeek use Chat Completions with `reasoning_content` preserved
  across assistant and tool replay. Standard permissions remain the only supported policy.
- Packages the portable `alibaba-token-media` skill for Claude Code, Codex, Codex-VL and Pi.
  Its dependency-free CLI provides dry-run-first Wan 2.7 image/edit and HappyHorse video
  workflows with fixed Token Plan endpoints, one concurrent submit, explicit Credit/high-cost
  consent, private file handling and safe unique downloads under the user's Downloads folder.
- Keeps the existing public Z.AI surface unchanged: `claude.zai` remains the only generic
  Claude profile, while the historical A/P names stay hidden compatibility aliases.
- Makes the mobile Fleet header count live cells and unmanaged tmux sessions across local and
  routed inventories, so an inventory-only or Hydra view can no longer report zero while cells
  are active.
- Adds a direct per-cell boot toggle to the mobile and desktop rosters. It changes only the next
  reboot preference, never the current power state, and stays synchronized with the same boot
  setting used by the existing power sheet; desktop settlements are acknowledged once so a
  sidebar remount cannot replay stale state.
- Keeps Python bytecode outside the npm package even when skill compilation runs before packing,
  with an isolated compile-before-pack regression test for the exact `files[]` behaviour.
- Gate: **878 isolated Node tests** (877 pass / 1 platform skip), **39/39 frontend component
  tests**, production PWA build, zero production dependency vulnerabilities, sanitized package
  inspection and an offline install smoke. Provider calls and Token Plan credit consumption are
  intentionally outside the release build gate.
- Known debt: the minified PWA main chunk is 806.50 kB (231.11 kB gzip), so Vite's 500 kB
  advisory remains visible and code splitting stays on the performance backlog.

## 0.8.24 — 2026-07-18 — "Safe Pairing"

- Gives every joining installation an explicit, editable local route handle that is separate
  from its display label. The default is deterministic and readable, combines the label or
  hostname with a stable node-ID suffix, stays within 32 characters and never sends bare
  `localhost` from Termux devices.
- Keeps `nodeId` as the peer identity while treating the route slug only as a unique handle.
  Older clients that omit `localName` receive the same safe server-side derivation, so two
  phones whose operating system hostname is `localhost` can join the same hub independently.
- Returns a deterministic replacement handle when a committed or pending peer already owns the
  requested name. The PWA applies that suggestion, preserves the freely editable display label
  and retries with the same unconsumed invitation; headless pairing exposes matching
  `--local-name` and `--local-label` options.
- Restores `nexuscrew init` as a public, idempotent command with validated `--port` and
  side-effect-free `--dry-run` support, so first-run recovery instructions always name a command
  that the dispatcher actually accepts.
- Gate: **861 isolated Node tests** (860 pass / 1 platform skip), **34/34 frontend component
  tests**, production PWA build and zero production dependency vulnerabilities.

## 0.8.23 — 2026-07-18 — "Fleet Ready"

- Repairs partial or migrated installations that have NexusCrew configuration and a token but no
  `fleet.json`. Runtime startup now creates the built-in Fleet defaults only when the file is
  absent, including service-manager and Termux:Boot paths; an existing invalid file remains
  fail-closed and is never overwritten.
- Makes smart startup restart an already-running runtime when it has just repaired the missing
  definitions, so provider selection is refreshed before the PWA is reused. `nexuscrew doctor`
  now reports missing, invalid, intentionally disabled and valid Fleet definitions explicitly.
- Separates Fleet editor loading, API failure and genuinely unavailable-provider states in the
  PWA. A disabled provider can expose a safe operational reason instead of the misleading
  “builtin provider only” message shown during initial loading or on partial Termux installs.
- Contains shared-tmux failure containment: generated Linux services require `KillMode=process`,
  lifecycle commands fail closed if that protection is absent, shared servers pin
  `exit-empty off` and guard `kill-server`, and cleanup tests require a unique private `-L`
  socket instead of ever targeting the operator's default server.
- Gate: **854 isolated Node tests** (853 pass / 1 platform skip), **33/33 frontend component
  tests**, production PWA build and zero production dependency vulnerabilities.
- Release scope at the time: npm `latest` only; 0.8.24 now carries the same changes into the
  public GitHub history.

## 0.8.22 — 2026-07-17 — "Sole Authority"

- Makes NexusCrew the only Fleet owner. The legacy executable adapter, discovery paths,
  `fleetBin` configuration and alternate boot ownership are removed; `NEXUSCREW_FLEET=0`
  remains the explicit kill switch.
- Supervises every built-in cell behind the private one-shot launch broker. A client that exits
  after readiness is restarted with bounded exponential backoff and a rapid-failure circuit
  breaker; explicit stop disarms relaunch even during backoff, while restart remains intentional.
- Adds a canonical hub peer inventory to Settings with separate direct hubs, inbound clients and
  routed inspect-only nodes. Direct peers expose direction-aware **Edit**, **Disconnect** and
  **Delete** actions, stale routed peers no longer appear healthy, and labels now have one
  server-backed source across Settings, desktop and mobile.
- Expands the headless CLI with stable `name|nodeId` lookup for list/show/doctor, edit/rename,
  visibility, connect/disconnect/reconnect, Share, revoke/remove, invite and stdin-only pair/join.
  Every mutation honors READONLY; pairing capabilities never need to appear in argv.
- Gate: **845 Node tests** (844 pass / 1 platform skip), **30 frontend component tests**, a
  production build and zero production dependency vulnerabilities.

## 0.8.21 — 2026-07-17 — "Reconciled Share"

- Reconciles the detached SSH supervisor with the persisted Share state even when the requested
  value is unchanged. A pre-upgrade process that still carries `-R` while the store says private
  is replaced through the existing verified, spec-aware pidfile lifecycle before the hub is
  notified.
- Keeps the Share checkbox usable while the tunnel is down and adds an explicit **Reconnect and
  reconcile** action that reapplies the current state without toggling consent. Desired Share
  state, verified reachability and a down private connection now have distinct UI messages.
- Reverse-forward diagnostics extract the negotiated listen port from OpenSSH and show the exact
  `permitlisten="127.0.0.1:<port>"` restriction to verify, while retaining neutral wording when a
  port collision and a key/server policy denial cannot yet be distinguished.
- Gate: **855 Node tests** (854 pass / 1 platform skip), **30 frontend component tests** and a
  production build with aligned package/UI version `0.8.21`.
- Release scope: published to npm `latest` and installed on the local runtime. GitHub commit,
  push, tag and release remain outside this maintenance rollout.

## 0.8.20 — 2026-07-17 — "Reliable Routes"

- OpenRouter is now a first-class provider for Claude Code and Codex-VL. Claude uses the
  Anthropic-compatible endpoint without guessed context limits; Codex-VL uses the beta,
  stateless Responses wire API, direct no-shell command authentication and a ten-minute stream
  idle timeout. Kimi K3 receives packaged one-million-token model metadata.
- Kimi Code is available as a non-default Claude provider with `k3[1m]`, its documented coding
  endpoint, model-specific context and effort settings, and an isolated Claude configuration
  that leaves native Anthropic account state unchanged.
- Built-in provider editors gain a write-only KEY section with value-free configured source and
  target-local “used by” impact. Credential values remain outside engine definitions, backups,
  federation payloads, argv, tmux state, logs and API responses.
- Shared-node reverse ports are reserved across pending and active pairings and bind-probed before
  use. Share desired state now fails safely, reconciles after restart, rejects duplicate peer
  names without burning invitations and returns actionable allocation conflicts.
- Remote inventory survives a missing tmux socket and partial peer failures. Topology probes are
  parallel and bounded, repeated reverse-forward failures stop retrying, and diagnostics no
  longer claim that the SSH server denied forwarding without supporting evidence.
- Desktop and mobile node groups support browser-local rename and reorder controls without
  changing node identity, routes, credentials, Share state, deck identity or cell ordering.
- Gate: **853 Node tests** (852 pass / 1 platform skip), **30 frontend component tests**,
  production build, zero dependency vulnerabilities and sanitized npm package inspection.

## 0.8.19 — 2026-07-17 — "Live Activity"

- Fleet status dots now distinguish all three cell states on mobile and desktop: gray when off,
  fixed green when powered but idle, and a pulsing green signal only while the attached AI client
  is actively working. Reduced-motion preferences disable the pulse without hiding the text state.
- Each cell keeps a single useful subtitle. Powered-off rows show the engine, credential profile
  and model when available; powered-on rows switch to a live localized status such as working,
  the current task label, or idle. The same contract covers expanded, compact and remote rosters.
- Working detection uses the tmux pane title's Braille progress frame as the primary cross-client
  signal. Pi receives a narrowly gated capture fallback, while activity timestamps and persistent
  transcript text cannot mark unrelated or stale cells as busy. The sessions API adds bounded,
  sanitized activity fields without breaking older peers.
- Gate: **830 Node tests** (829 pass / 1 platform skip), **25 frontend component tests**,
  production build and zero dependency vulnerabilities.

## 0.8.18 — 2026-07-15 — "Persistent Composer"

- The input composer now expands for long prompts and keeps a separate browser-local draft,
  size preference and bounded prompt history for each owner-qualified tmux cell. State survives
  route renames and reloads, synchronizes safely between tabs and can be cleared from System
  settings; it is never federated or included in Fleet backups.
- History can be selected from the composer menu or recalled with ArrowUp/ArrowDown only at safe
  textarea boundaries. Active IME composition is left untouched, failed sends preserve the draft,
  and a delayed successful send cannot erase newer typing or another cell's draft.
- Persistence is bounded by per-entry, per-cell and browser-wide limits with 30-day expiry and
  quota-aware eviction. Regression coverage includes long Unicode prompts above 32 KiB, async
  send races, owner/session identity changes, cross-tab ordering, hostile stored objects and
  mounted-state reset.
- Gate: **825 Node tests** (824 pass / 1 platform skip), **22 frontend component tests**,
  production build and zero dependency vulnerabilities.

## 0.8.17 — 2026-07-15 — "Modular Core"

- Termux can now start the first managed cell when no tmux server exists. NexusCrew reconstructs
  the canonical `PREFIX`, `TMPDIR` and `TMUX_TMPDIR=$PREFIX/var/run` values even when it starts
  outside an interactive shell, while generated NexusCrew and Fleet boot scripts create and
  export the same runtime paths explicitly. Existing custom `TMUX_TMPDIR` values remain
  authoritative; Linux and macOS behavior is unchanged.
- The Fleet runtime/launch layer, CLI lifecycle, MCP tool directory, pairing coordinator, shared
  roster model and Fleet settings components are split into focused modules without changing
  their public routes, commands, payloads or security boundaries. This keeps the current product
  behavior while making the next gateway and federation work reviewable in smaller units.
- Regression coverage includes a real private-socket cold start with no existing tmux server,
  profile-less Termux environment reconstruction, generated boot scripts and the extracted module
  boundaries. Gate: **819 Node tests** (818 pass / 1 platform skip), **12 frontend component
  tests**, production build and zero production dependency vulnerabilities.

## 0.8.16 — 2026-07-14 — "Honest Tunnel"

- One-link pairing now treats its embedded SSH endpoint as portable routing rather than a
  transferable identity. Authentication and SSH-stage failures automatically expose the local
  override, where a device can use the same Host alias that already selects its own key, agent,
  port or ProxyJump. The override is saved only in that node's local routing configuration;
  private keys never enter the link, NexusCrew configuration, logs or federation payloads.
- A supervised `ssh` process is no longer reported ready merely because it remains alive.
  After the stability window NexusCrew probes the exact loopback `-L` port and advertises
  transport readiness only when that forward accepts TCP; unreachable connects are bounded by
  OpenSSH's 15-second timeout and remain in an explicit probing state.
- Startup, stop and restart reconcile strict NexusCrew tunnel pidfiles against the authoritative
  node store. Verified supervisors left by a removed node or interrupted older runtime are
  stopped safely, while configured nodes, unrelated processes, symlinks and invalid names are
  untouched.
- Regression coverage exercises exact SSH argv, local-alias recovery in the real pairing
  component, TCP-forward readiness versus a merely live child, generation ownership, safe
  orphan reconciliation, server startup ordering and lifecycle cleanup. Gate: **788 Node
  tests** (787 pass / 1 platform skip), **12 frontend component tests**, production build and
  zero production dependency vulnerabilities.

## 0.8.15 — 2026-07-14 — "Steady Link"

- One-link pairing now waits against a real 20-second readiness deadline with bounded retries.
  Immediate loopback refusals can no longer exhaust the probe in 3.75 seconds and tear down a
  valid SSH session just as key negotiation completes on Termux, Linux, or macOS.
- Per-tunnel diagnostics are never empty by design: NexusCrew writes safe supervisor lifecycle
  markers and forces SSH error-level diagnostics even when a user Host stanza requests quiet
  logging. The 0600 log omits synthetic argv dumps, key contents, tokens and credentials;
  OpenSSH's own error text may identify the failed target.
- Local and federated deck tabs can be reordered inside their owner group with a dedicated
  Pointer Events handle on mouse, touch, or pen, plus keyboard left/right controls. The
  owner-qualified order autosaves per browser, survives polling/reload, and follows rename and
  deletion without changing deck ownership.
- Regression coverage includes delayed SSH readiness at eight seconds, bounded permanent
  failure, safe tunnel logging, owner-isolated deck ordering, pointer input, keyboard input,
  and cross-owner rejection. Gate: **785 Node tests** (784 pass / 1 platform skip), **11
  frontend component tests**, production build, and zero production dependency vulnerabilities.

## 0.8.14 — 2026-07-14 — "Private Launch"

- Managed provider credentials can now be supplied per node from the PWA when they are absent
  from that device's runtime environment or compatible user-owned provider files. The local
  store is write-only through the API, owner-only on disk, never federated or backed up, and the
  UI reports only configured/source state plus the exact active cells affected by a change.
- Secret-bearing launches use a private one-shot Unix-socket broker. The tmux command receives
  only the helper path, socket path and a short-lived random nonce; provider values never enter
  process arguments, `tmux -e`, tmux global/session environment, temporary files or logs. The
  helper validates the bounded payload and directly spawns the configured CLI without a shell.
- Credential lookup is deterministic across Linux, macOS and Termux: service environment,
  node-local store, `providers.zsh`, canonical `ai.env`/secure files, then the legacy store.
  Mixed-case environment names are accepted, unsafe files/symlinks are rejected, and unresolved
  shell expansion is never interpreted as a credential.
- Unmanaged tmux sessions can be explicitly marked technical. They stay hidden from normal
  all/pinned/active/off views, appear in a dedicated technical view, and every Local/Hydra count
  reflects only the rows currently displayed; managed cells remain protected from relabeling.
- Fleet reorder handles now use one Pointer Events implementation for mouse, touch and pen.
  Destination highlighting, pointer capture, edge auto-scroll, release-only commit and
  Escape/cancel rollback preserve the same owner-qualified order on mobile, expanded desktop
  and compact desktop while keeping native card-to-deck drag separate.
- Tests: **781 total** (780 pass / 1 platform-dependent skip) in the isolated Node harness plus
  8 passing frontend component tests; production build and dependency audit required before
  publication. Real cross-device drag and provider launches remain operator field tests.

## 0.8.13 — 2026-07-14 — "Fleet Network"

- The MCP bridge now exposes `nc_cells` and `nc_send_cell`. An active managed cell can discover
  the owner-qualified Fleet directory allowed by the current Hydra topology and submit bounded
  text to one exact active destination. Remote ingress is bound to the authenticated route,
  inactive cells are never silently queued, and `submitted` means only verified paste plus
  Enter—not model acceptance or task completion.
- Cell submission uses an exact Fleet-cell/tmux match, bracketed paste, pane revalidation and a
  separate submit. Codex and Codex-VL receive a paced burst flush before Enter to avoid long
  composer input loss; the printable envelope prevents Pi from treating a trailing newline as
  a second submit.
- The desktop and mobile Fleet rosters now persist the same owner-qualified manual order.
  Dedicated mouse/touch handles and keyboard move controls avoid accidental power actions,
  preserve pin priority and keep compact and expanded desktop views consistent.
- Selective backup schema v2 exports cells and reusable engines independently, accepts legacy
  cell-only v1 files, previews conflicts and confirms every overwrite before mutation. Archives
  contain environment-variable names only; secret values, tokens, live tmux IDs and provider
  credentials remain local.
- Provider variables can be resolved by name from the service environment or a user-owned
  `~/.config/ai-shell/providers.zsh` parsed strictly as data. The file is never sourced or
  executed, and values are never copied into NexusCrew config, services or backups.
- Share is now a property of the local device and uses one selected, existing hub connection.
  Outbound target cards no longer imply that the hub itself is being shared; inbound shared
  clients retain hub-controlled network/relay/selected visibility, and publication waits for a
  bounded authenticated readiness acknowledgement.
- Every Local or remote deck owner has its own inline `+ new` action, with no fallback to a
  different owner. Deck tile layout and Fleet roster order continue to autosave independently.
- npm update checks and generated services use a stable NexusCrew working directory, parse npm
  JSON-scalar and plain-semver output, and preserve a deterministic UTF-8 environment. Local
  PTYs inherit only reviewed cross-platform variables; loader injection remains stripped.
- Real Termux launches npm-installed Codex and Codex-VL scripts through the active Node binary
  when `/usr/bin/env` is unavailable, while native clients such as Pi stay direct. Immediate
  managed-client exits produce bounded, redacted diagnostics and zero-window tmux phantoms are
  removed from both session discovery and Fleet state.
- The packaged and canonical NexusCrew/tmux messaging skills plus shared AGENTS/CLAUDE guidance
  document the eight-tool contract and prefer authenticated cell delivery over direct tmux
  injection. Persistent offline queues, attachments and delegated capability workers remain
  explicitly deferred rather than being represented as implemented.
- Tests: **770 total** (769 pass / 1 platform-dependent skip) in the isolated Node harness plus
  5 passing frontend component tests; production build PASS. Real Mac–hub–Pixel end-to-end
  pairing and delivery remain an operator field test and are not represented as automated.

## 0.8.12 — 2026-07-13 — "Mobile Roster"

- The mobile Fleet home now uses the same per-location roster contract as the desktop sidebar.
  Local and every Hydra route can be collapsed independently and filtered by all, pinned,
  active, or off; state persists under one shared key.
- Mobile pins are route-qualified, remote cells are pinnable, and both surfaces use the same
  deterministic order: pinned, live, fresh output, recent activity, then label. Search counts
  and scans the complete multi-node roster instead of only local sessions.
- New jsdom component tests exercise real filter, collapse, persistence, pin and multi-node
  search interactions. The official Node harness also gives every test worker its own private
  tmux socket, eliminating cross-file server-exit races without touching operator sessions.
- The SSH supervisor continuously proves ownership of its pidfile generation. Losing ownership
  or failing a state write now terminates the child SSH process and supervisor instead of
  leaving an invisible retry loop.
- Explicit Share fails closed unless its local NexusCrew port is present; reverse forwarding
  can no longer substitute the hub's remote port. macOS shutdown detects zombie supervisors
  through argv-safe `ps` when `/proc` is unavailable.
- Generated Linux user units now pull in `network-online.target`. Doctor warns when user linger
  is disabled and explains that a Termux boot script still requires the Termux:Boot app to be
  installed and launched once.
- Tests: **749 total** (748 pass / 1 platform-dependent skip), production build PASS, root and
  frontend dependency audits clean. Mac–Pixel–hub end-to-end pairing was not executed in this
  release gate.

## 0.8.11 — 2026-07-13 — "Tmux Survival"

- Linux service lifecycle is now tmux-safe. Generated units use `KillMode=process`, and an
  existing installation receives a narrow atomic systemd drop-in plus `daemon-reload` before
  `nexuscrew stop` or `nexuscrew restart`. If that protection cannot be installed, lifecycle
  commands fail closed without touching the service or its tunnels.
- Managed SSH supervisors are closed before a service restart and restored only through the
  normal autostart path. The npm updater now rejects an unverified restart result instead of
  continuing to health checks or reporting a successful update.
- Token rotation verifies the tmux-safety guard before changing credentials and reports an
  incomplete operation if the runtime cannot be restarted; the direct update helper likewise
  returns failure instead of claiming that the new code is active.
- `nexuscrew doctor` treats an unsafe Linux `KillMode` as a blocking failure and explains that
  restarting the HTTP service could terminate the shared tmux server.
- The official test harness removes inherited `TMUX` identity and places every real tmux smoke
  test on a private socket below its disposable test root. Tests can no longer attach to,
  resize, or terminate an operator session.
- The mobile roster footer now keeps endpoint/version metadata and the IT/EN/ES language
  controls aligned at narrow widths, with bounded ellipsis instead of overlap.
- Tests: **739 total** (738 pass / 1 platform-dependent skip), targeted lifecycle isolation and
  full-suite before/after tmux inventory checks, production build PASS, dependency audit clean.

## 0.8.10 — 2026-07-13 — "Hydra Federation"

- Hydra pairing now creates one supervised OpenSSH connection per hub: the private `-L`
  channel is automatic, while `-R` exists only after an explicit Share toggle and a real
  authenticated readiness probe. The retired rendezvous/node-role runtime can no longer
  start a second hidden tunnel, and pairing cannot self-escalate to shared.
- Tunnel liveness no longer mistakes a surviving `autossh` wrapper for a healthy SSH child.
  `ssh` is the single runtime transport and a blocking doctor requirement; `autossh` is
  reported separately as optional and unused. PWA failures no longer recommend private or
  nonexistent CLI commands.
- The read-only MCP bridge adds owner-aware `nc_deck`: a cell can discover every local or
  authorized shared-owner deck containing its tmux session and read visually ordered members
  with stable owner IDs, Fleet cell names, exact tmux sessions, viewer-valid Hydra routes and
  self identity. The packaged NexusCrew skill documents discovery without direct state access.
- Decks are owner-qualified and resolve their tiles from the viewer's route, so identically
  named sessions on different nodes never collapse or fall back to a local session. Shared
  owner decks are read through the existing scoped Hydra channel and remain visibly unavailable
  when their owner is offline.
- The Fleet roster keeps its desktop chrome fixed and groups every local or remote location
  behind independent collapse and all/pinned/active/off controls. Pins use route-qualified
  identities and deterministic ordering; the mobile header now remains fixed while its roster
  scrolls naturally without hiding the last card under the create button.
- Fleet Settings separates location management from the whole-network overview. Managed-cell
  power opens the shared launch editor, while delete/import and engine definitions remain in
  Settings and preserve the selected Hydra route.
- A stopped managed session can restart inside its existing deck tile: only the terminal
  generation is replaced, and transient WebSocket reconnects are bounded without reviving a
  deliberately exited terminal.
- Public `status`, `stop`, and `restart` now reconcile service-managed and portable runtimes,
  clean stale PID ownership safely, stop NexusCrew-managed SSH supervisors, and refuse a silent
  HTTP-port move when paired peers depend on the configured endpoint.
- Tests: **726 total** (725 pass / 1 platform-dependent skip), frontend production build PASS,
  dependency audit clean, isolated HOME clean, and package/public-tree verification required
  before publication. Real Mac–Pixel–hub interoperability remains an external follow-up and is
  not represented as an automated test.

## 0.8.9 — 2026-07-12 — "Hydra Workspaces"

- Remote Fleet tiles now attach to their real `tmuxSession`, including an idempotent migration
  for persisted 0.8.8 deck references. Automatic grid growth preserves visual row order,
  widths, tile heights and zoom; deck switches and renames flush dirty state before moving.
- Named decks switch inside the current PWA by default; only `↗` detaches a browser window.
  Fleet dialogs are viewport-owned with Escape, focus trapping/restoration and visible errors,
  while long sidebar names stay within their cards without covering actions.
- Pairing link creation reuses the configured rendezvous without confusing its published
  NexusCrew HTTP port with the SSH transport port. Peers exchange roles, so intermittent
  inbound clients become neutral `passive` entries while real node/auth failures remain errors.
- Clipboard images and OS-dropped files upload directly to the receiving terminal session,
  including federated routes, with progress and per-file errors. Saved paths are pasted without
  Enter; normal text paste and private session-card drag/drop are unchanged.
- Settings → Fleet adds selective, schema-closed cell/system-prompt backup and restore with
  engine mapping, overwrite confirmation, atomic writes, secret exclusion and explicit
  `needsRestart` reporting for active cells.
- Global npm installs gain stable-only automatic updates with no downgrade, a per-home
  interprocess lock, exact CLI/runtime verification, same-port restart, one exact-version
  rollback and blocked retry after an unhealthy update. Errors and logs are bounded/redacted.
- Tests: **693 total** (692 pass / 1 platform-dependent skip), with production build and
  package/audit verification performed before local installation.

## 0.8.8 — 2026-07-12 — "Reliable Composer"

- The PWA composer now sends long and multiline drafts through xterm's explicit paste path,
  preserving the terminal application's bracketed-paste mode. Enter travels as a separate
  input only after the complete paste was accepted, so agent TUIs no longer absorb submission
  into a non-bracketed paste burst.
- WebSocket input delivery is observable instead of silently dropping writes while reconnecting.
  If the terminal is not ready or disconnects during paste, the composer keeps the full draft
  and shows a localized retry message; successful sends continue to keep the mobile keyboard
  focused.
- The README mobile Fleet image is now one metadata-free animated GIF built from the two current
  phone captures, with a compact cursor-only second frame to avoid full-screen flicker.
- Tests: **664 total** (663 pass / 1 platform-dependent skip), production dependency audit
  clean, plus a real xterm smoke proving an exact 3,000-character bracketed payload.

## 0.8.7 — 2026-07-12 — "One-Link Pairing"

- Settings → Nodes and the first-run wizard now share one prominent **Connect with one link**
  card. Deliberate paste, the clipboard button, QR scan and deep links use the same controller;
  a complete v2 link connects automatically, while old or incomplete links reveal only the
  routing details still required.
- The QR flow now opens a live rear-camera scanner with distinct permission, no-camera and
  unsupported-browser errors plus a photo fallback. Its scan region covers the QR instead of
  cropping a code that fills the phone preview, and every success, cancel or unmount releases
  the camera immediately.
- Pairing reports structured validation, SSH start/readiness, invite exchange, final tunnel,
  confirmation and health stages. Transport and protocol requests are bounded, ambiguous
  one-time joins are never replayed, provisional state is rolled back, and success requires
  authenticated federation health plus an identity match with the original link.
- Retry controls now follow the server's actual retryability, manual Enter applies embedded v2
  fields before submission, and the wizard cannot be dismissed while a pairing request is in
  flight.
- Tests: **660 total** (659 pass / 1 platform-dependent skip), production dependency audit
  clean, plus a real Chrome camera smoke that reads a generated pairing QR, enters the shared
  card and verifies MediaStream cleanup.

## 0.8.6 — 2026-07-12 — "Connected Fleet"

- Cell power now opens one shared launch editor from Home, the sidebar and Settings. When a
  cell is off, engine, model, permission policy and boot can be reviewed before every start;
  choices are remembered per cell and per engine. Provider and credential definitions remain
  in Settings → Fleet, while Pi is always constrained to Standard permissions.
- Settings → Fleet now inventories managed and unmanaged tmux sessions across Local and every
  reachable Hydra route. A live unmanaged session can be explicitly adopted as a managed cell;
  legacy `cloud-X` sessions become cell `X`, and the operator must choose an already declared
  engine so no provider or model is inferred.
- Pairing links now support a strict v2 payload containing the display label, route slug,
  OpenSSH target or Host alias, and optional SSH port. Paste, QR scan and first-run deep links
  pre-fill the same form before **Test and connect**; v1 links remain compatible. No SSH key,
  API key or PWA token is added to the link.
- Fleet inventory actions now follow the selected Hydra route and its real capabilities,
  including READONLY. Power, restart, import and removal are shown only where the remote
  provider actually permits them.
- External Fleet discovery is portable across Linux, macOS and Termux: configured paths,
  `$PREFIX/bin/fleet` and `~/.local/bin/fleet` use the same runtime and boot-owner resolver.
  Explicit external pins fail closed instead of falling through to another executable.
- Claude-compatible managed launches set matching context and auto-compaction windows,
  including one-million-token profiles where declared. Permission overrides cannot bypass
  Pi's Standard-only policy.
- Tests: **636 total** (635 pass / 1 platform-dependent skip), plus a clean production build
  and zero production dependency vulnerabilities.

## 0.8.5 — 2026-07-12 — "Clean Fleet"

- The primary `+` now creates a managed Fleet cell on Local or a selected reachable Hydra
  node. Cell IDs accept uppercase characters, and every configured node remains visible in
  the Fleet inventory while unreachable destinations are clearly disabled for creation.
- Managed cell cards expose direct power and Settings buttons. Start, stop, restart and edit
  are explicit in Settings → Fleet; deletion is confined to that settings surface, removing
  the ambiguous three-dot/delete-only lifecycle.
- The power sheet is lifecycle-only and responsive: it no longer mixes engine/provider/model
  selection into start/stop, and boot changes are persisted without resetting an existing
  boot choice on quick start.
- Fresh fleets provide four clean CLI adapters: Claude Code, Codex, Codex-VL and Pi. Provider
  choices are scoped to the selected CLI, with documented native/cloud/local options and a
  renameable custom fallback. Legacy Z.AI A/P credential profiles remain runtime-compatible
  but are absent from the new-provider catalog.
- Claude enterprise providers launch through their dedicated Bedrock, Vertex or Foundry
  environment selectors; Codex OpenAI API uses `OPENAI_API_KEY`; Pi can use its own configured
  default without NexusCrew forcing a provider or model.
- Node pairing now focuses and explains missing fields and makes explicit that the loopback
  address in a pairing link is intentional and transported through the user's SSH Host.
- Tests: **602 total** (601 pass / 1 platform-dependent skip), plus a clean production build
  and zero production dependency vulnerabilities.

## 0.8.4 — 2026-07-12 — "Hydra Everywhere"

- The fleet roster is global rather than active-only: local, direct and transitive sessions
  remain visible with route/location labels, stable slugs and offline last-seen state.
- Session creation and Fleet engine/cell management can target Local or any reachable Hydra
  route. Remote lifecycle controls use route-qualified identity and inbound peer health is
  verified instead of trusting a running tunnel process alone.
- Node cards restore explicit tunnel power controls and expose label rename independently of
  the stable route slug; pairing and capabilities remain relay-policy scoped.
- macOS terminal copying now supports Shift-drag / Shift-Control-drag local selection and
  mobile terminals support long-press then drag selection without sending mouse events to tmux.
- The composer send button writes text plus a real carriage return and preserves textarea
  focus, keeping the mobile software keyboard open between messages.
- Linux x64/ARM64, macOS x64/ARM64 and Termux Android ARM64 now resolve scriptless platform
  PTY prebuilds only. Global installs no longer require native install-script approval.

## 0.8.3 — 2026-07-12 — "Simple and Clean"

- `nexuscrew` starts or reuses the loopback server in the background, prints a compact
  status/guide, and exits. Only the first run opens the PWA wizard. `nexuscrew show` opens
  the PWA, while `nexuscrew show token` prints the clickable authenticated fragment URL.
- Startup persistence is explicit: `nexuscrew boot` installs/enables the native user service
  on Linux/macOS or the Termux:Boot script; `boot off|status` controls and reports it. A normal
  first run no longer silently opts the host into boot persistence.
- The Hydra roster retains transitive peers as offline entries with last-seen information
  while a relay is unavailable, then reconciles them when the relay returns or is removed.
- Node tunnel power is restored as a direct action in both mobile and desktop lists. Session
  menus remain session-only, avoiding ambiguity between killing a session and controlling its link.
- Settings → Fleet now selects Local or any reachable Hydra route for engine and cell
  management. Federated Fleet requests use the scoped, hop-bounded allowlist and honor READONLY.
- Managed engines expose an explicit permission policy. New Claude engines, including Z.AI,
  default to `--dangerously-skip-permissions` with a Standard opt-out; Codex and Codex-VL
  default to Standard with an opt-in for `--dangerously-bypass-approvals-and-sandbox`.
- The Nodes UI describes pairing as connecting an existing NexusCrew installation: every
  installation remains local and peer-capable, with no artificial client/server role.
- Tests: **538 total** (537 pass / 1 platform-dependent skip), including first-run PWA,
  multi-hop Fleet routing, stale roster reconciliation, boot opt-in and contaminated env runs.

## 0.8.2 — 2026-07-11 — "Simple Federated Hydra"

- Replaces client/node roles in first-run UX with one local node plus a single **Nodes**
  surface for reciprocal PWA pairing.
- One-time ten-minute link/QR pairing creates scoped per-peer credentials; the main PWA
  token is never exchanged. Invites and peer state remain local 0600 stores.
- Uses an existing OpenSSH Host alias without creating keys or editing `authorized_keys`;
  auto-selects autossh or supervised SSH and restores outbound links at boot.
- Adds bounded four-hop topology discovery and a separate capability-allowlisted federation
  ingress for HTTP and WebSocket routing. Relay visibility is enforced symmetrically.
- Session list, creation, terminal, files and termination are location-aware across Local and
  federated routes. Fleet remains local to its node.
- Reads legacy nodes schema v1 while writing the extended v2 peer schema; legacy rendezvous
  runtime behavior remains available during migration.
- Tests: **528 total** (527 pass / 1 platform-dependent skip).

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
