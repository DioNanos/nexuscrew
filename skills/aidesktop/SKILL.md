---
name: aidesktop
description: Use when a user wants to give a cell a web panel via panelUrl, asks why a panel URL or panel request was rejected, wants to build the AI Desktop container recipe for an isolated browser and desktop, or needs to connect a Playwright MCP client to that desktop's Chromium through its CDP relay.
---

# AI Desktop

A desktop you can watch and a browser you can drive are two faces of the same
container: watching it is the **panel**, driving it is the **CDP relay** a
Playwright MCP client attaches to. This skill covers both together, plus the
recipe that builds the container itself.

## The panel

`panelUrl` is a **property of the cell** (or its engine, as a default for
every cell using it) — a sibling of `engine` and `cwd`, not a command and not
something the cell runs. The app's cell/engine editor has a `panelUrl` field
for this; do not write the URL into the command field, which makes the cell
try to execute it as a program and fails to start, while no panel button
appears either, since `panelUrl` was never actually set.

The value must be an `http:`/`https:` URL pointing at **loopback** —
`127.0.0.1`, `[::1]`, or `localhost`. Anything else is rejected when the
definition is read, and the cell keeps working, just without a panel button.
**A container's own address is not loopback** — publish its port to
`127.0.0.1` on the host that runs the node, and point `panelUrl` there. This
is not a nitpick: the forwarder resolves *which cell*, never *where to
connect*, so allowing a non-loopback destination would turn it into a way to
reach any address the node can reach. See
[The cell panel](../../docs/CELL_PANEL.md) for the full explanation and the
worked example.

### Origin separation (0.9.1)

The panel used to be served from the same origin as the control plane, which
meant a compromised or hostile page mounted in the panel iframe could, in
principle, read the operator's token straight out of the app's own
`localStorage`. As of 0.9.1, for a **local** cell the panel is served from a
**second loopback port** — the browser's Same-Origin Policy treats a
different port as a different origin, so a document in that frame has nothing
of the control plane's to read or write. The app also sends
`Content-Security-Policy: frame-ancestors` on its own page, which is a
separate, orthogonal protection: it stops the app itself from being embedded
as someone else's iframe.

**Declared gap:** for a cell owned by a *remote, paired* node, the panel still
travels through the federated proxy on the control plane's own origin — the
per-node negotiation of a dedicated panel port has not been extended to the
pairing protocol yet. Treat the origin-separation guarantee as covering the
local case only until that lands.

None of this changes how a request actually gets into the frame: an
authenticated call asks for a one-use ticket bound to one cell, the frame's
first request spends it and receives a viewing cookie scoped to that cell's
panel path, and the app's own token never reaches the frame. See
[How the browser gets in](../../docs/CELL_PANEL.md#how-the-browser-gets-in)
for the full mechanism — it is unchanged by the port move, only relocated.

### Panels on another node

Opening a panel that lives on a paired node needs that node's permission,
**granted there, never by the requester**:

```bash
nexuscrew nodes panel <node> on
```

Denied by default. Without it, the rejection names itself —
`panel-not-granted` — instead of leaving a blank rectangle to debug.

## The Docker recipe

**This repository ships the recipe, not an image.** The base,
`lscr.io/linuxserver/webtop`, is GPL-3.0; a `FROM` line pointing at its public
source is a recipe, not a distributed derivative, and the only thing this
project actually owns is the two added lines below and their reasons. It also
means no registry to host, nothing to keep patched on your behalf, and a
recipe you can read before you run it.

Build it yourself from [`docker/`](docker/):

```bash
cd <skill-dir>/docker
cp docker-compose.example.yml docker-compose.yml
# create ./.gui_password yourself — see the comments in the compose file
docker compose up -d --build
```

First start creates an **empty** browser profile: no logins, no history,
nothing carried over. The example compose ships no branding and no
pre-populated `/config` — you get a bare webtop desktop plus the two
additions below.

### The two lines, and why each exists

- **`chromium-sandbox`** — the upstream webtop image ships Chromium but not
  its sandbox binary, and the container denies unprivileged user namespaces,
  so Chromium refuses to start at all ("No usable sandbox"). The shortcut
  would be `--no-sandbox`; it is deliberately **not** taken, because this
  browser is meant to hold authenticated sessions and visit arbitrary sites —
  exactly the workload the renderer sandbox exists to contain. The
  consequence lands in the compose file: the setuid sandbox helper needs to
  elevate privileges, so `no-new-privileges` must not be set for this
  container. That is a deliberate trade, not an oversight — see the comments
  in `docker/Dockerfile` and `docker/docker-compose.example.yml`.
- **`socat`** — modern Chrome ignores `--remote-debugging-address` and binds
  its DevTools/CDP port to `127.0.0.1` *inside* the container, so a Docker
  port mapping alone never reaches it. `socat` relays
  `0.0.0.0:9223 -> 127.0.0.1:9222` inside the container's own network
  namespace; the published host port still only opens on `127.0.0.1`, so the
  loopback-only rule is unchanged — nothing new is exposed, only bridged. The
  same init script also clears `Singleton{Lock,Cookie,Socket}` files an
  unclean shutdown leaves behind, which otherwise stop Chromium from starting
  again with no visible error.

### Commanding the browser

The relay's published port, `127.0.0.1:9222` on the host, is the CDP
endpoint a Playwright MCP client attaches to — for example:

```bash
playwright-mcp --cdp-endpoint http://127.0.0.1:9222
```

Register that command as its own MCP server in the AI client's configuration;
NexusCrew does not bundle browser automation itself, it only gives the
container a loopback CDP port to attach one to. It is the same Chromium the
panel shows over the desktop, so it carries the same logins — treat driving
it with the same care as watching it.

## Dependencies

**Bundled:** the `docker/` recipe (`Dockerfile`, `docker-compose.example.yml`,
`custom-cont-init.d/10-cdp-relay.sh`) ships with this skill.

**External (you must provide):**

| Need | Install | Probe / failure mode |
|---|---|---|
| Docker with Compose v2 | your platform's Docker install | `docker compose version` fails → nothing in `docker/` builds or runs |
| A Playwright-capable MCP client, to drive the browser | install separately, point it at the CDP port | if no such client is registered, no `browser_*`-style tools exist in that session — the desktop and its panel still work without it |
