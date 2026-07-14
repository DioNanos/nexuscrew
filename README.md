# NexusCrew

[![npm](https://img.shields.io/npm/v/@mmmbuto/nexuscrew?style=flat-square&logo=npm&color=cb3837)](https://www.npmjs.com/package/@mmmbuto/nexuscrew)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue?style=flat-square)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![platforms](https://img.shields.io/badge/platforms-linux%20%C2%B7%20macos%20%C2%B7%20android-555?style=flat-square)](#requirements)
[![bind](https://img.shields.io/badge/bind-127.0.0.1%20only-success?style=flat-square)](#access-model--read-this)

A faithful **browser tmux client**. It attaches to your live tmux sessions over a **real PTY**
and streams them to a mobile-friendly web UI — full color, copy-mode scroll, special keys,
panes, windows. tmux does the work; the browser is just a faithful client.

> **tmux owns your sessions — NexusCrew attaches.** Since v0.7 it can also *create* new
> sessions and *terminate* generic ones from the UI (protected names are always refused),
> but recovery and persistence remain tmux's job.

---

## What it is (v0.8.16 "Honest Tunnel")

- Runs a small server on the host where your tmux sessions live.
- Each attach spawns a real PTY running `tmux attach` and bridges its bytes over a WebSocket
  to [xterm.js](https://xtermjs.org) in the browser. **No screenshots, no polling.**
- **Desktop grid** (≥1024px): drag sessions from the sidebar into a tiling column layout —
  live terminals side by side, draggable dividers, per-tile composer, layout remembered.
  Tiles attach with `ignore-size` so they never resize your real terminals.
- **Ordered Fleet roster**: desktop and mobile share the same per-location model. Local and
  every Hydra route are independently collapsible and filterable by all, pinned, active, off,
  or technical. Technical tmux sessions stay out of the normal roster until explicitly shown,
  and every location count reflects the rows actually displayed. Route-qualified pins keep
  priority, while cells can be reordered from the dedicated handle with Pointer Events on
  mouse, touch, or pen, or with keyboard move controls. Reorder highlights the destination,
  scrolls at list edges, commits only on release and can be cancelled without changing the
  saved order. The owner-qualified order survives reloads and is shared by compact and expanded
  views. Desktop chrome and the mobile header stay fixed while their lists scroll, and the
  compact version/endpoint/language footer remains readable on narrow screens.
- **Attached decks by default**: named workspaces switch as tabs inside the same PWA without
  reloading terminals or losing a pending layout save. Use `↗` only when you want to detach a
  deck into another browser window or monitor. Every Local or remote owner group ends with its
  own compact `+ new`, so the creation destination is explicit and never falls back elsewhere.
  A dedicated handle reorders owner-qualified deck tabs with mouse, touch, pen, or keyboard;
  the order autosaves locally and survives polling, reloads, rename, and deletion.
- **Federated Hydra inventory**: connect existing NexusCrew installations through the SSH
  configuration you already control and see local, direct, and relayed tmux fleets in one UI.
  Route labels show where every session lives; creation, attach, files, lifecycle and Fleet
  management use the selected location through a scoped single-origin route.
- **One-link node pairing**: paste a link or scan its QR in Settings → Nodes. A complete
  link tests SSH, exchanges the one-time invitation, confirms both directions and verifies
  the peer automatically; failures identify the exact connection stage. A device already
  connected to a hub creates invitations through that hub; a standalone hub asks only for
  the SSH address by which the receiving device can reach it. Readiness uses a real bounded
  deadline and a live TCP-forward probe instead of treating a merely running `ssh` process as
  connected. When a portable address cannot select this device's key, the failure opens the
  local fields so it can be replaced with the same SSH alias that works in the terminal.
  Per-tunnel logs contain safe supervisor lifecycle markers and actionable SSH errors, never
  synthetic argv dumps, key contents, tokens, or credentials. OpenSSH may name the failed
  target in this owner-only 0600 diagnostic. Startup and lifecycle commands also recover
  verified orphan supervisors left by removed nodes or interrupted older runtimes.
- **Settings and wizard**: manage roles, nodes, token rotation, and service regeneration
  from the UI; the first-run wizard uses the same pairing flow as Settings.
- **Cell lifecycle from the UI**: the primary `+` creates a managed Fleet cell at Local or
  any reachable node. Power opens one shared launch sheet where engine, model, permission
  policy and boot can be reviewed before every start; deletion lives in Settings → Fleet.
  An immediately exiting client reports bounded, redacted diagnostics and cannot leave a
  zero-window phantom beside the configured cell.
- **Legacy session adoption**: Settings → Fleet lists managed and unmanaged tmux sessions on
  every route. A live unmanaged session can be explicitly imported as a managed cell without
  inventing its engine, provider or model.
- **Selective cell and engine backup**: export chosen cells, reusable engine definitions,
  engine mapping and system prompts, then select exactly what to restore. Archives contain
  credential-variable names but never their values, provider keys or runtime session state;
  conflicts and active cells that need a restart are reported explicitly.
- **Private provider credentials**: each node resolves a required key from its runtime
  environment, compatible user-owned provider files, or an optional local write-only store.
  The PWA can set, replace, or forget a missing key on that exact node without displaying it.
  Values never enter Fleet definitions, backups, API responses, tmux state, process arguments,
  temporary files, or logs.
- **Rich cards**: last activity, current command, a sanitized one-line preview per session.
- **Fleet control**: a built-in schema-driven fleet manager handles cells, engines, model
  selection, and boot persistence; an existing external `fleet` CLI can take ownership through
  the documented JSON contract.
- **i18n**: English, Italian, Spanish — follows your browser language, switchable in the UI.
- **localhost-only**: the server binds `127.0.0.1` and refuses any non-loopback bind.
- **Stateless**: tmux *is* the persistence. No database, no accounts.
- **Mobile terminal controls**: long-press begins local text selection, drag extends it, and
  the composer sends long or multiline drafts through the terminal's real bracketed-paste
  mode while keeping both failed drafts and the software keyboard ready.
- **Desktop file paste/drop**: paste a clipboard image or drop files directly on the target
  terminal. NexusCrew uploads them to that session's inbox—locally or through Hydra—and
  inserts the saved paths without submitting Enter; ordinary text paste is unchanged.
- **Safe npm auto-update**: global installs follow stable npm `latest` without downgrades,
  serialize installation across processes, verify the restarted runtime and roll back once
  to the exact previous version if the new server does not become healthy. On Linux, stopping
  or restarting the HTTP service preserves the independent shared tmux server and every session.
  Registry checks and service processes use a stable NexusCrew working directory, so deleting
  the directory from which NexusCrew was originally launched cannot break future updates.
- **Authenticated cell network**: AI cells can discover the owner-qualified Fleet directory
  visible through the authorized Hydra topology and submit bounded text to one exact active
  destination. Inactive cells remain visible but are never presented as queued recipients;
  a `submitted` receipt confirms only paste plus Enter in the target TUI, not that its model
  accepted, processed or completed the task.
- **Universal**: a PTY is a PTY — a coding agent, a REPL, a plain shell, anything tmux holds.

## Screenshots

<p align="center">
  <img src="docs/img/fleet-deck-desktop.png" width="900" alt="NexusCrew desktop: the Fleet Deck grid with three live tmux sessions tiled side by side">
</p>

The **Fleet Deck** desktop grid (≥1024px): drag sessions into a tiling layout — live
terminals side by side, each a real PTY streamed to the browser.

<p align="center">
  <img src="docs/img/fleet-mobile.gif" width="420" alt="Animated NexusCrew mobile Fleet overview with managed AI cells and direct power controls">
</p>

The mobile Fleet overview keeps managed cells, current engines, activity and direct power
controls in one place. Tapping a live session still attaches through a real PTY.

## Fleet integration

A clean install includes the built-in, schema-driven fleet manager. Its safe defaults contain
four CLI adapters — **Claude Code**, **Codex**, **Codex-VL**, and **Pi** — and no cells,
prompts, API keys, or machine-specific paths. Provider, credential-variable name and reusable
engine definitions live in Settings → Fleet. When a cell is off, its shared launch sheet lets
you choose the engine, model, permission policy and boot state before starting it; the last
model and permission choice is remembered separately for each cell and engine.

The concise provider catalog is scoped per CLI:

- **Claude Code:** Anthropic account, Amazon Bedrock, Google Vertex AI, Microsoft Foundry,
  Ollama Cloud, local Ollama, Z.AI, and a renameable Anthropic-compatible endpoint.
- **Codex / Codex-VL:** OpenAI/ChatGPT account, OpenAI API, Ollama Cloud, local Ollama,
  LM Studio, and a renameable custom endpoint using the real Responses wire API only.
- **Pi:** its configured default, Anthropic, OpenAI API, OpenAI Codex OAuth, Google Gemini,
  GitHub Copilot, OpenRouter, local Ollama, DeepSeek, Z.AI, and a custom provider.

Provider credentials are resolved from the selected CLI's native login or from an environment
variable named in the PWA. A named variable is read first from the service environment, then
from the optional node-local NexusCrew store, then—when present—from the user-owned
`~/.config/ai-shell/providers.zsh`, `~/.config/keys/ai.env`, or
`~/.config/secure/.env`, parsed strictly as assignment data and never sourced or executed.
The PWA shows only whether the requested name is configured and its source category; a missing
value can be saved locally in `~/.nexuscrew/credentials.json` under a user-owned `0700`
directory and `0600` file, or removed again. The store is write-only through the API and is
never included in config, services, Fleet backups, federation payloads, logs, or responses.
At launch, secret-bearing environment data crosses a private one-shot Unix socket and reaches
the CLI by direct process spawn; it never enters tmux environment state, argv, or a temporary
file. Legacy Z.AI A/P engines remain launch-compatible for existing fleets but are not provider
choices for new engines. Model discovery is used where the CLI/provider documents it, with a
manual model field as the portable fallback.

Managed engines expose a permission selector both in their definition and in the cell launch
sheet. New Claude engines (native, Z.AI, Ollama, or custom) default to **Bypass permissions**
and launch with `--dangerously-skip-permissions`; choose **Standard permissions** to disable
it. New Codex and Codex-VL engines default to Standard and offer an explicit opt-in for
`--dangerously-bypass-approvals-and-sandbox`. Pi is always launched with its native Standard
permission behavior. Claude-compatible managed models also receive matching context and
auto-compaction window variables, including one-million-token profiles where declared.

Custom argv-based engines remain supported. Their command, environment, cwd, and prompt are
validated against a strict trust boundary and launched without a shell.

Settings → Fleet also provides a selective **Cells and engines backup** flow. The v2 JSON file
contains portable cell definitions (cwd, engine choice, model mapping, boot flag and system
prompt) plus only the selected reusable engine definitions. Custom-engine environment-variable
names are portable; their values, provider credentials, PWA tokens and live tmux identifiers
are never exported. Legacy cell-only v1 files remain importable. Restore previews conflicts,
lets you choose each section independently, confirms every overwrite before mutation, preserves
only matching values already configured on the destination, and reports which active cells need
a restart.

### External fleet manager

NexusCrew can instead act as a control panel for a *fleet manager* you already have: any
trusted executable (default `~/.local/bin/fleet`, configurable via `fleet.bin` in
`~/.nexuscrew/config.json`) that answers `fleet status --json` with:

```json
{"schemaVersion":1,"kind":"ai-fleet","cells":[
  {"cell":"Build","tmuxSession":"work-build","engine":"native",
   "active":true,"boot":true,"tmux":true,"rc":"","key":""}],
 "engines":[{"id":"native","label":"Claude","rc":true},{"id":"my-engine","label":"My Engine"}]}
```

`engines` is optional: it declares the configured engine inventory — `id` is the stable
identifier, `label` is what the UI displays, and `rc: true` marks engines that support your
remote-control path. In external mode the external CLI owns its engine list and configuration;
the NexusCrew power control starts or stops the cell without changing that configuration.

and accepts `up <Cell> [--engine E] [--boot]`, `down <Cell> [--boot]`, `engine <Cell> <E>`,
`boot|noboot <Cell>`. The binary is trust-checked (regular file, not a symlink, not
world-writable) and the schema is validated strictly — anything else and the feature stays
off. Automatic discovery checks the configured path, Termux's `$PREFIX/bin/fleet`, then
`~/.local/bin/fleet`; startup-service ownership uses the same resolver so built-in and external
boot managers cannot both take ownership. An explicitly pinned external binary fails closed
instead of silently switching to another executable. Set `NEXUSCREW_FLEET=0` to disable Fleet
entirely.

## Requirements

- **Node.js ≥ 18**
- **tmux** on the host (3.4+; the non-destructive `ignore-size` attach is honored on 3.4 and
  later)
- **OpenSSH client (`ssh`)** for Hydra nodes and a clean `nexuscrew doctor`. A local-only tmux
  session does not invoke it, but the installation is reported degraded until it is present.
  `autossh` is detected by doctor but is not required.
- A PTY backend is resolved automatically per platform: Darwin ARM64/x64 and Linux ARM64/x64
  scriptless prebuilds, including the native Android ARM64 provider on Termux.

## Access model — read this

NexusCrew binds **only to `127.0.0.1`**. There is no built-in network exposure, no public
tunnel, no TLS, no login server. You reach it by **bringing the loopback port to you over a
channel you control**:

```bash
# from your laptop/phone, tunnel the loopback port over SSH
ssh -L 41820:127.0.0.1:41820 user@your-host
# then run `nexuscrew show` on the machine where the browser is available
```

A user-managed autossh tunnel or a VPN works the same way. A local **authentication token** (0600 file,
auto-generated and passed directly to the browser by `nexuscrew show`) is a second factor on top of your SSH/VPN gate. The
token travels in the URL **fragment** (`#token=…`), so it never reaches the server logs.

> **Exposing the app publicly (reverse proxy, network bind, port forward to the internet) is
> unsupported and unsafe.** The whole security model is "localhost + a tunnel you control".

## Federated Hydra nodes (configured from the PWA)

Every installation is always the local node and can join other NexusCrew nodes. The normal
flow stays entirely in the PWA:

1. On the installation being shared, open **Settings → Nodes → Invite a node** and create the
   ten-minute link/QR. A device already connected to a hub uses that hub automatically.
   A standalone hub needs one value: the OpenSSH target or Host alias that the *other device*
   uses to reach it. This is not `127.0.0.1` and not a NexusCrew HTTP URL.
2. On the other device, open its own NexusCrew PWA (`nexuscrew show`), go to
   **Settings → Nodes**, and use the first card, **Connect with one link**. Paste the complete
   link in the prominent field or scan the QR. Do not navigate to the loopback address in the
   link: it is only a portable container for the pairing payload. The embedded host is a
   portable suggestion, not an SSH identity. If `ssh my-relay` works on this device but the raw
   address does not select the same key, open **Advanced / edit** and enter `my-relay`; aliases,
   agents and private keys always stay on this device.
3. A complete v2 link connects automatically. NexusCrew starts a provisional SSH forward,
   proves the local TCP forward rather than only the supervisor PID, consumes the one-time
   invite once, negotiates the reciprocal path, confirms it, and verifies authenticated
   federation health and peer identity. If SSH authentication or routing fails, the PWA
   preserves the link, opens the editable local SSH fields and shows the exact stage, detail
   and safe retry guidance. Older v1 links remain accepted and open only the missing fields.

The link never contains an SSH key, identity file, API key or PWA token. Its only credential is
the random, one-time pairing invite; SSH routing fields are non-secret configuration. A
successful pairing creates one supervised SSH connection to the hub. Its normal `-L` channel
is private and provides access to the hub. The optional `-R` channel is added to that same SSH
process only when the user enables **Share this device through the selected hub** in the local
device card. The hub verifies the authenticated reverse channel before advertising the device;
its inbound-node controls then decide whether authorized clients see the whole network,
relay-only or a selected set. Both sides exchange only redacted topology.

A newly paired phone or laptop is private by default: the hub keeps it in Settings without
probing it as a server or showing a false red error. Share always refers to the current local
device—not to the remote hub card—and uses its already selected hub connection; no direct
peer-to-peer SSH is required. Enabling Share makes it routable and turns authenticated
reverse-channel health into a real requirement; a shared node that stops responding, or a live
endpoint that rejects authentication, remains a real health error.

NexusCrew does not create SSH keys or edit `authorized_keys`. OpenSSH remains authoritative for
identity files, agents, host keys, ports, ProxyJump and forwarding policy. NexusCrew uses
one built-in retry supervisor around `ssh`; it never nests `autossh`. `nexuscrew doctor` reports
whether both binaries are installed and states that OpenSSH is the transport actually used.
Missing `ssh` is a blocking error; `autossh` is optional. A 15-second OpenSSH connect timeout
bounds unreachable endpoints, while readiness is advertised only after the configured local
forward accepts TCP. On startup, stop and restart, NexusCrew reconciles strict, verified tunnel
pidfiles against the node store so a removed node cannot leave a hidden retry supervisor.
Configured links return at boot.
Pair credentials are random, per-peer and scoped only to the federated session/file surface—the
PWA token never crosses a peer link.

A relay controls what its peers can see. The default is the whole network; a peer can be reduced
to relay-only or a selected set. HTTP and WebSocket routing enforce that policy at every hop,
with stable instance IDs, cycle rejection and a four-hop ceiling. Session creation, terminal,
files, termination, Fleet editing and authorized cell discovery work on Local or any reachable
route. Previously seen transitive nodes remain listed as offline with their last-seen time while
a relay is down.

## Install & run

### Linux

```bash
# Install Node.js 18+, tmux 3.4+ and OpenSSH with your package manager first.
npm install -g @mmmbuto/nexuscrew
nexuscrew
```

The first run creates a loopback-only configuration and starts a detached process. Run
`nexuscrew boot` only if you want a persistent `systemd --user` service. The generated unit
waits for `network-online.target`; `nexuscrew doctor` also warns when user lingering is disabled,
because boot without an interactive login then depends on the host's systemd policy. Linux x64
and ARM64 use platform PTY prebuilds only, so global installs do not compile native code or
require install-script approval.

### macOS (Apple Silicon or Intel)

```bash
brew install node tmux
npm install -g @mmmbuto/nexuscrew
nexuscrew
```

The first run starts a detached process. Run `nexuscrew boot` to install a user LaunchAgent
with an explicit Node/Homebrew PATH. The npm package selects the matching Darwin ARM64 or x64
PTY prebuild. NexusCrew is an npm/Node CLI, not an `.app`, `.pkg`, or standalone Mach-O
distribution, so it does not require Developer ID signing.

### Android / Termux (ARM64)

```bash
pkg update
pkg install nodejs-lts tmux openssh
npm install -g @mmmbuto/nexuscrew
nexuscrew
```

Termux uses the Android ARM64 PTY provider. The normal command starts NexusCrew in the
background and exits. `nexuscrew boot` installs the Termux:Boot script explicitly; install the
Termux:Boot app and launch it once, because Android app activation cannot be verified by the
CLI. `nexuscrew doctor` reports that limitation even when the script itself is valid. Inside
managed cells, npm-installed Codex and Codex-VL scripts are launched through the active Node
executable when their shebang depends on the unavailable `/usr/bin/env`; native executables
such as Pi remain direct launches.

On every platform the first run starts the server in the background and opens the PWA wizard.
After onboarding, the same command starts or reuses it, prints a compact status and guide, and
exits:

```bash
nexuscrew                 # background start; opens only on first run
nexuscrew show            # background start when needed + open the authenticated PWA
nexuscrew show token      # print the clickable authenticated URL; do not open a browser
nexuscrew status          # compact service, port and hub-connection state
nexuscrew stop            # stop server/tunnels; preserve every tmux session
nexuscrew restart         # restart server safely; restore autostart hub links, preserve tmux
nexuscrew boot            # opt in to startup persistence
nexuscrew boot off        # disable startup persistence, keep the current run alive
```

The preferred port is `41820`. If it is occupied by another process, NexusCrew selects the
next free loopback port and updates its configuration. If the configured port already hosts
the same authenticated NexusCrew instance, it is reused.

Env knobs: `NEXUSCREW_PORT` (default 41820), `NEXUSCREW_CONFIG_FILE`,
`NEXUSCREW_TOKEN_FILE`, `NEXUSCREW_FILES_ROOT`, `NEXUSCREW_TMUX`,
`NEXUSCREW_FLEET=0`, `NEXUSCREW_READONLY=1`, and `NEXUSCREW_AUTO_UPDATE=0` to disable
automatic stable npm updates. Set `NEXUSCREW_DEBUG=1` to log the resolved PTY provider at
startup.

### Automatic updates

A global npm installation checks `@mmmbuto/nexuscrew@latest` shortly after startup and then
periodically. A newer stable version is installed exactly once, preflighted through the CLI,
and the active service or detached runtime is restarted on the same loopback port. If the new
runtime fails its bounded health check, NexusCrew reinstalls the exact previous version and
restarts once; that failed version is then blocked from automatic retry. The updater never
accepts a prerelease from `latest`, never downgrades, and redacts registry credentials and local
paths from PWA errors. Registry commands run from a stable directory owned by NexusCrew and
accept npm's JSON scalar or plain semantic-version output. Its current state and manual
check/apply controls live in Settings → System. Set `NEXUSCREW_AUTO_UPDATE=0` (or `false`,
`no`, `off`) to disable scheduling.

On Linux, the installed service uses `KillMode=process`: service lifecycle affects NexusCrew,
not the shared tmux server. Existing units are protected by an atomic drop-in before any CLI or
auto-update restart; if systemd cannot apply that guard, the restart fails closed. `nexuscrew
doctor` reports the effective runtime `KillMode`.

## CLI

```
nexuscrew          background start; first run opens the PWA wizard
nexuscrew show     start when needed and open the authenticated PWA
nexuscrew show token  print the clickable authenticated URL without opening it
nexuscrew boot     enable startup at boot (`boot off|status` are also available)
nexuscrew doctor   local diagnostics (exit 1 when a required check fails)
nexuscrew help     concise command help
nexuscrew version  installed version
```

All configuration and lifecycle operations live in the PWA. Internal service-manager and MCP
entry points are intentionally not part of the public CLI workflow. The token is never printed
by normal startup, help, doctor, or service output.

## MCP bridge

`nexuscrew mcp` runs a minimal **stdio MCP server** (JSON-RPC 2.0, one JSON message per
line, zero SDK dependencies) that brings NexusCrew *inside* your AI sessions. An agent
running in a tmux session gets eight tools: the cell→human channel, read-only deck context,
and an authenticated active-cell network:

- `nc_notify {title, body?, urgency?}` — human notification: toast on every open UI +
  web push on subscribed devices (enable push from Settings → System).
- `nc_ask {question, options?}` — asks a question and **returns immediately**; the answer
  you type in the UI is pasted back into the caller's tmux session as
  `[human reply · ask#<id>] <text>` by default (configurable with
  `NEXUSCREW_REPLY_LABEL`; bracketed paste, never submits).
- `nc_send_file {path, caption?}` — copies a file (absolute path under HOME) into the
  session outbox: badge + notification, downloadable from the Files panel.
- `nc_deck {}` — identifies the caller's tmux session and node, then returns every local or
  authorized shared-owner deck that contains it. Deck identity is owner-qualified; members
  include stable owner ID, Fleet cell name (when managed), exact tmux session and the Hydra
  route valid from the caller. Unavailable members remain visible with `cell: null`.
- `nc_cells {}` — returns the owner-qualified Fleet directory visible through the caller's
  authorized, non-stale Hydra topology. Every entry has a stable `<instanceId>:<cell>` ID,
  exact tmux session and route, activity state and `canReceive`; duplicate cell names on
  different devices remain unambiguous.
- `nc_send_cell {to, message}` — submits bounded text to one exact ID returned by `nc_cells`.
  The caller must itself be an active local Fleet cell, the destination must still be active,
  and every remote hop rechecks identity and ACL. There is no silent offline queue. A
  `submitted` receipt means only that bracketed paste and a separate Enter reached the target
  TUI; it does not mean accepted, working or completed.
- `nc_status {}` / `nc_inbox {}` — read-only: live sessions + fleet cells / inbox files.

The caller's identity is the tmux session name (`$TMUX` → `tmux display-message`), with
`NEXUSCREW_MCP_SESSION` as fallback for non-tmux contexts. The bridge talks to the local
HTTP API (loopback + token from `~/.nexuscrew/token`). Use `nc_deck` for visual workspace
neighbours and `nc_cells` for the global authorized directory; use `nc_send_cell` for managed
cell delivery. Direct tmux injection is only a declared same-host compatibility or repair
fallback and must never bypass Fleet membership or Hydra ACLs. Never scrape `decks.json`
directly.

Register it in **Claude Code** (`.mcp.json` in your project root, or `~/.claude.json`):

```json
{ "mcpServers": { "nexuscrew": { "command": "nexuscrew", "args": ["mcp"] } } }
```

…and in **codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.nexuscrew]
command = "nexuscrew"
args = ["mcp"]
```

## Mobile KeyBar

The awkward tmux gestures, as buttons: **scroll** (enters copy-mode; then PgUp/↑/↓, `q` to
exit), **window** prev/next, **pane** left/right, **esc**, **Ctrl-C**, **detach**.

Long-press terminal text to enter local selection mode, then drag and use **Copy**. The
composer send button writes the text followed by a real Enter while retaining textarea focus,
so the mobile keyboard stays open between messages.

Window and pane navigation run as **server-side, allowlisted tmux commands** on the active
session — they are *not* emulated with client-side prefix keys, which are fragile and depend
on each host's key bindings.

## Non-destructive by default (`ignore-size`)

Multiple clients on one tmux session share the window geometry. To avoid a small phone
shrinking the window for the real terminal you also have attached, NexusCrew attaches with
`-f ignore-size` by default: **the browser never resizes a session that a real terminal is
holding.** On a screen smaller than the session you'll see a clipped view (expected). Pass
`takeSize` only when you deliberately want the browser to drive the size.

## Develop

```bash
npm test            # node --test on a private tmux socket (never the operator's server)
npm run build       # builds the frontend into frontend/dist
node bin/nexuscrew.js serve
```

## Status

The current stable release is **v0.8.16**. npm **`latest`**, the GitHub tag and the release use
the same audited package artifact.

## License

Apache-2.0 © 2026 Davide A. Guglielmi (DioNanos)

*Per aspera ad astra.*
