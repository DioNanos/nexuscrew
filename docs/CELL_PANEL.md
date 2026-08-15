# The cell panel

A cell can carry a **panel**: a web interface of its own that NexusCrew serves
inside the app, next to the terminal. A remote desktop, a notebook, a dashboard
— anything that speaks HTTP.

The panel is opt-in and off by default. A cell without `panelUrl` simply has no
panel button.

## Configuring it

Add `panelUrl` to a cell (or to an engine, where it becomes the default for the
cells that use it):

```json
{
  "cells": [
    { "id": "Design", "tmuxSession": "cloud-Design", "engine": "claude.native",
      "panelUrl": "http://127.0.0.1:6080/vnc.html" }
  ]
}
```

The value must be an `http:` or `https:` URL pointing at **loopback** —
`127.0.0.1`, `[::1]` or `localhost`. Anything else is rejected when the
definition is read, and the cell keeps working without a panel.

## Why loopback only

This is the constraint that shapes everything else, so it is worth stating
plainly: **the panel forwarder is not a port-forward.**

The caller picks *which cell* to open, never *where to connect*. The
destination is resolved from that cell's own `panelUrl`, on the machine that
runs the node. Without this rule, a route that opens "a panel" would be a way
to reach any address the node can reach — including services that trust the
network they sit on.

The panel is also a service that already holds sessions: behind a remote
desktop there is usually a browser with accounts logged in. That kind of access
is not revoked by rotating a key, which is why access is granted per peer and
denied by default.

## Where it runs

| Platform | State |
|---|---|
| Linux server / VPS | **In use.** Any loopback service works; the common case is a container exposing noVNC on `127.0.0.1`. |
| Termux / Android | **Expected to work, not verified.** The forwarder needs nothing but a loopback HTTP service — no container runtime, no specific desktop. It has not been tried, and until it is, treat it as untested rather than supported. |

Nothing in the forwarder is platform-specific: it proxies HTTP and WebSocket to
a URL. If a platform can run a web service on loopback, it can host a panel.

## How the browser gets in

Worth knowing, because it explains a design that would otherwise look odd.

An `<iframe src>` is a browser navigation: it carries no application headers.
So the panel cannot sit behind the usual bearer-token gate — the one consumer
it exists for would be locked out. Putting the token in the query string does
not help either: the panel's own pages request their sub-resources with
relative URLs and no query, so everything after the first request would fail
and the frame would stay blank.

Instead:

1. the authenticated app asks for a **ticket** — opaque, one-use, valid for
   seconds, bound to one cell;
2. the frame's first request spends it, and the answer sets a **viewing
   cookie**: `HttpOnly`, `SameSite=Strict`, scoped by `Path` to that cell's
   panel subtree;
3. the relative sub-resources travel on that cookie, and nothing else does.

The node's token never reaches the browser, a log, or a `Referer` header, and
no credential of ours is forwarded to the panel itself.

## Panels on another machine

A panel can be opened toward a node you have paired, but **only if that node
granted it**:

```
nexuscrew nodes panel <node> on
```

The default is off, and it is off deliberately: in the pairing model a peer is
otherwise treated much like the operator, and that is a coherent choice for
everything except a panel, for the reason given above.

The decision is always made by the node that **owns** the panel, never by the
one asking. When it says no, the interface says so by name — you get "panel not
granted", not a blank rectangle you have to guess about.
