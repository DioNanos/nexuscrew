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

## What it is (v0.7 "Fleet Deck")

- Runs a small server on the host where your tmux sessions live.
- Each attach spawns a real PTY running `tmux attach` and bridges its bytes over a WebSocket
  to [xterm.js](https://xtermjs.org) in the browser. **No screenshots, no polling.**
- **Desktop grid** (≥1024px): drag sessions from the sidebar into a tiling column layout —
  live terminals side by side, draggable dividers, per-tile composer, layout remembered.
  Tiles attach with `ignore-size` so they never resize your real terminals.
- **Session lifecycle from the UI**: create sessions (name + cwd + an allowlisted preset)
  and terminate generic ones with confirmation. Protected session names are always refused.
- **Rich cards**: last activity, current command, a sanitized one-line preview per session.
- **Optional fleet integration**: if a `fleet` CLI implementing the small JSON contract below
  is present on the host, the UI gains a fleet panel (cells on/off, engine picker, boot
  persistence). Without it, that whole section simply disappears.
- **i18n**: English, Italian, Spanish — follows your browser language, switchable in the UI.
- **localhost-only**: the server binds `127.0.0.1` and refuses any non-loopback bind.
- **Stateless**: tmux *is* the persistence. No database, no accounts.
- **Universal**: a PTY is a PTY — a coding agent, a REPL, a plain shell, anything tmux holds.

## Screenshots

| Fleet Deck — mobile home | Attached session |
|:---:|:---:|
| <img src="docs/img/fleet-deck.gif" width="300" alt="NexusCrew mobile home: the tmux fleet with live cards, cursor blinking"> | <img src="docs/img/session-window.png" width="300" alt="A tmux session attached in the browser over a real PTY"> |

The mobile home lists your tmux fleet with live cards; tapping a session attaches it
over a real PTY. On the right, a `codex-vl` session running inside the browser client.

<!-- desktop grid (≥1024px) — coming next -->
<!-- ![Fleet Deck desktop grid](docs/img/fleet-deck-desktop.png) -->

## Optional fleet integration

NexusCrew can act as a control panel for a *fleet manager* you already have: any executable
(default `~/.local/bin/fleet`, configurable via `fleet.bin` in `~/.nexuscrew/config.json`)
that answers `fleet status --json` with:

```json
{"schemaVersion":1,"kind":"ai-fleet","cells":[
  {"cell":"Dev","tmuxSession":"cloud-Dev","engine":"native",
   "active":true,"boot":true,"tmux":true,"rc":"","key":""}]}
```

and accepts `up <Cell> [--engine E] [--boot]`, `down <Cell> [--boot]`, `engine <Cell> <E>`,
`boot|noboot <Cell>`. The binary is trust-checked (regular file, not a symlink, not
world-writable) and the schema is validated strictly — anything else and the feature stays
off. Set `NEXUSCREW_FLEET=0` to disable it entirely.

## Requirements

- **Node.js ≥ 18**
- **tmux** on the host (3.4+; the non-destructive `ignore-size` attach is honored on 3.4 and
  later)
- A PTY backend is resolved automatically per platform: `node-pty` (Linux/macOS),
  `@lydell/node-pty-linux-x64` (prebuilt Linux x64), and the native arm64 provider on Android/Termux.

## Access model — read this

NexusCrew binds **only to `127.0.0.1`**. There is no built-in network exposure, no public
tunnel, no TLS, no login server. You reach it by **bringing the loopback port to you over a
channel you control**:

```bash
# from your laptop/phone, tunnel the loopback port over SSH
ssh -L 41820:127.0.0.1:41820 user@your-host
# then open http://localhost:41820/#token=<token printed by the server>
```

autossh reverse tunnels or a VPN work the same way. A short-lived **local token** (0600 file,
auto-generated, printed once at startup) is a second factor on top of your SSH/VPN gate. The
token travels in the URL **fragment** (`#token=…`), so it never reaches the server logs.

> **Exposing the app publicly (reverse proxy, network bind, port forward to the internet) is
> unsupported and unsafe.** The whole security model is "localhost + a tunnel you control".

## Install & run

```bash
npm install -g @mmmbuto/nexuscrew

nexuscrew                 # prints the URL + token, binds 127.0.0.1:41820
```

Then tunnel in (see above) and open the printed URL with `#token=…`.

Env knobs: `NEXUSCREW_PORT` (default 41820), `NEXUSCREW_TOKEN_FILE`, `NEXUSCREW_TMUX`,
`NEXUSCREW_READONLY=1`. Set `NEXUSCREW_DEBUG=1` to log the resolved PTY provider at startup.

## Mobile KeyBar

The awkward tmux gestures, as buttons: **scroll** (enters copy-mode; then PgUp/↑/↓, `q` to
exit), **window** prev/next, **pane** left/right, **esc**, **Ctrl-C**, **detach**.

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
npm test            # node --test (config, tmux list, pty attach smoke, ws bridge, token)
npm run build       # builds the frontend into frontend/dist
node bin/nexuscrew.js
```

## Status

v0.4 "pty-core" is published on the **`next`** dist-tag for install-and-try on real devices
(Android/Termux included). The `latest` tag is reserved for a verified stable release.

## License

Apache-2.0 © 2026 Davide A. Guglielmi (DioNanos)

*Per aspera ad astra.*
