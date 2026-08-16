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
`localStorage`. As of 0.9.1, the panel is served from a **second loopback
port** — the browser's Same-Origin Policy treats a different port as a
different origin, so a document in that frame has nothing of the control
plane's to read or write. The app also sends
`Content-Security-Policy: frame-ancestors` on its own page, which is a
separate, orthogonal protection: it stops the app itself from being embedded
as someone else's iframe.

This covers **remote** cells too, not just local ones. Two paired nodes
negotiate a second port pair the same way they already negotiate the control
plane's own tunnel: when the hub side has a panel server running, it
announces its panel port at join time, the joining side reserves a local port
for it, and the supervisor forwards both destinations over the same SSH
connection — one `-L` for control, one for the panel, never sharing a port.
`GET /api/config` exposes the result as `nodePanelPorts` (node name → the
locally forwarded port), and the app resolves the right one per cell from its
route before ever opening the frame.

A node with no port pair on record — paired **before** this existed, or
paired since but with the local port reservation having failed at the time
(pairing still succeeds; the port pair is treated as an extension, never a
reason to fail the bond) — is not treated as an error either way: its cells
fall back to the old federated path (same origin as the control plane)
exactly as before, and a cell never borrows another node's port to paper over
the gap — the absence stays visible as the old behavior, not a silent, wrong
origin. The pair is only established at pairing time, not by reconnecting an
existing tunnel; re-pair the node to pick one up.

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

### The two additions, and why each exists

- **`socat`** — modern Chrome ignores `--remote-debugging-address` and binds
  its DevTools/CDP port to `127.0.0.1` *inside* the container, so a Docker
  port mapping alone never reaches it. `socat` relays
  `0.0.0.0:9223 -> 127.0.0.1:9222` inside the container's own network
  namespace; the published host port still only opens on `127.0.0.1`, so the
  loopback-only rule is unchanged — nothing new is exposed, only bridged.
- **the init script** also clears `Singleton{Lock,Cookie,Socket}` files an
  unclean shutdown leaves behind, which otherwise stop Chromium from starting
  again with no visible error.

Notably absent: anything that tries to sandbox the browser. That is the next
section, and it is the part worth reading before you adapt this recipe.

### Where the boundary is

**The browser in this container runs with `--no-sandbox`, and this recipe
keeps it that way.** That is a trade, made deliberately, and you should
understand it before deciding whether it fits your situation.

The base image launches Chromium through `/usr/local/bin/wrapped-chromium`,
which hardcodes the flag:

```
${BIN} --password-store=basic --no-sandbox --test-type "$@"
```

Installing Chromium's setuid helper does not change this, and overriding the
wrapper to drop the flag does not produce a sandbox either. Measured inside a
running container, launching the browser without it aborts:

```
The setuid sandbox is not running as root. Common causes:
  * A parent process set prctl(PR_SET_NO_NEW_PRIVS, ...)
Failed to move to new namespace: PID namespaces supported,
Network namespace supported, but failed: errno = Operation not permitted
```

Both routes are closed, and for opposite reasons. The **setuid** sandbox needs
its helper to elevate, which `no-new-privileges` exists to prevent. The
**namespace** sandbox needs unprivileged user namespaces, which the container
denies. Opening either one means handing the container `CAP_SYS_ADMIN` or
`seccomp=unconfined`.

That is the trade: **you would weaken the boundary that is actually holding in
order to build one inside it.** For a desktop reachable only over loopback,
the container is the stronger of the two — so the recipe keeps the container
hard and accepts the browser soft. `no-new-privileges` stays on.

**What this costs you, stated plainly:** a renderer exploit lands in the
container. Everything the browser can reach is in the blast radius — its
profile, its logged-in sessions, and anything you mount. Mount as little as
possible, keep the published ports on loopback, and do not treat this desktop
as isolation between *sites*: it is isolation between the desktop and the
host.

**If your situation differs** — an untrusted desktop, or a host where the
container boundary matters less than the browser one — the inverse trade is
legitimate: grant `seccomp=unconfined`, override the wrapper, and verify you
actually got a sandbox rather than assuming it. Check the running process, not
the launch log:

- open `chrome://sandbox` inside the desktop and read what it reports, or
- confirm the zygote no longer carries `--no-sandbox` (`ps -eo args | grep zygote`).

Until one of those confirms it, assume the browser is unsandboxed — which,
with this recipe as shipped, it is.
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
