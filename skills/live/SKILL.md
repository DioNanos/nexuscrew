---
name: live
description: Use when a user wants to know or change which cell is the Live host on a node, asks why a Live host designation was rejected, or needs to grant or revoke another node's permission to designate a Live host cell on this one (liveHostAccess, via nexuscrew nodes live-host).
---

# Live host cell

Live is the phone-facing quick-open flow: a single **host cell**, designated
per node, is what a Live session lands on. See
[Fleet and terminals](../../docs/FLEET.md) for what Live is; this skill covers
designating it, clearing it, and permitting it across nodes.

## One host cell per node, guarded by a revision

Each node keeps exactly one `hostCell` (or none). Changing it is a
compare-and-swap on a `revision` number, never an unconditional write:

1. `GET .../live-host` returns `{ hostCell, revision, eligible, host: { lease } }`.
2. `POST .../live-host/designate { cellId, expectedRevision }` — `expectedRevision`
   must be the value just read. A stale revision (someone else changed the
   designation meanwhile) is rejected with 409, not silently overwritten.
3. `POST .../live-host/clear { expectedRevision }` — same rule, removes the
   designation.

Always re-read the revision immediately before writing; never reuse one from
an earlier render. This is what keeps two people (or two tabs) racing to star
a cell from leaving the store in a mixed state — one write wins, the other
gets a 409 and re-reads.

The designation survives the cell going inactive; it is never dropped just
because tmux is not attached right now. `eligible` is computed fresh on every
read from the roster and the designated cell's lease state
(`live`/`grace`/`expired`/`none`/`unavailable`) — a designated-but-not-eligible
host is a distinct, readable state, not an error to explain away.

## Command the node that owns the cell, not the one serving the page

This is the point of the feature: **the request must reach the node whose
roster contains the cell**, not whichever node happens to be rendering the
current page. Route it exactly like a federated deck — an empty route for a
local cell, that node's route array for a remote one:

```js
getLiveHost(token, route)                                   // route: [] or [...hops]
designateHostCell(token, cellId, expectedRevision, route)
clearHostCell(token, expectedRevision, route)
```

Before 0.9.1 these calls took no `route`, so starring a cell shown from a
remote node either did nothing or silently changed the wrong node's
designation. That mismatch — not a missing capability — was the defect: a
parameter nobody passed does not exist.

## Federated permission: liveHostAccess

A peer may designate or read another node's Live host only if that node has
granted it. The permission is per peer, **denied by default**, and granted by
the node that **owns** the cell — never by the one asking:

```bash
nexuscrew nodes live-host <node> on
nexuscrew nodes live-host <node> off
```

Without it, the request gets a **named** rejection, not a timeout or a star
that quietly does nothing: HTTP 403 with `reason: "live-host-not-granted"`.
Surface this distinctly from a generic failure — the fix is a grant on the
owning node, not a retry from the requester.

## Common mistakes

- **Reusing a stale `revision`.** `GET` immediately before every
  `designate`/`clear`; a revision read earlier in the session is stale by
  definition once anything else has changed the designation.
- **Designating a cell that belongs to a different node than the route
  targets.** The route selects which node's roster is searched; a `cellId`
  absent from that node's local roster is rejected with 404, never forwarded
  further to guess where it might live.
- **Reading a `live-host-not-granted` rejection as a bug.** It means exactly
  what it says: run `nexuscrew nodes live-host <node> on` on the node that
  owns the cell, not on the node making the request.
- **Assuming Live host state is global.** It is one value **per node**; a node
  with nothing designated still answers `GET` with `hostCell: null` — a valid
  state, distinct from "not permitted to ask".

## The per-cell voice prompt

Once a session lands on a host cell, a native Live (engine `codex-vl*`)
always sends `thread/start` an identity header naming the designated cell
and its exact tmux session, and appends a per-cell prompt file's text after
it when one exists. See [The Live per-cell prompt](../../docs/LIVE_PROMPT.md)
for where the file goes and the ready-to-copy IT/EN/ES templates.

## Dependencies

**Bundled:** this is a NexusCrew core feature. No external MCP companion or
separate service is required — only a running NexusCrew node on each side of
the designation.
