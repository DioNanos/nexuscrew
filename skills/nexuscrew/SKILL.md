---
name: nexuscrew
description: Read this first when working with NexusCrew for any reason — understanding what it is, what an AI agent can do through it, how cells, nodes, decks, engines, panels and Live fit together, which companion skills cover which capability, and where the trust boundaries are. This is the entry point: every other NexusCrew skill assumes what is written here.
---

# NexusCrew — what it is and what you can do through it

Read this before the other NexusCrew skills. They describe individual
capabilities; this one describes the machine they belong to, and the rules that
hold across all of them.

If the running build and this document disagree, **the build wins**. Check with
`nexuscrew status`, `nexuscrew doctor`, and the MCP tool list actually exposed
in your session.

## The shape of the system

NexusCrew turns live tmux sessions, AI CLI workers and connected machines into
one local-first control plane, reachable from a browser.

Five nouns carry almost everything:

- **Node** — one installation on one machine. Its identity is an opaque
  `instanceId`; the human-readable name is a **label**, and two nodes may
  legitimately carry the same one. **Address things by id, never by name.**
- **Cell** — one stable working identity (`Alpha`, `Beta`, …) bound to one
  tmux session and one engine. A cell is not a process: it survives restarts of
  the service, and stopping it does not end the work it was doing.
- **Engine** — what a cell runs: an AI CLI, a plain shell, a command in a
  container. Some are *managed* (the service knows how to describe and
  configure them), some are not.
- **Deck** — a relationship between cells that work together. Not a duplicate
  cell, not a group chat: an arrangement.
- **Panel** — an optional web interface a cell can carry, served next to its
  terminal. A remote desktop, a notebook, a dashboard.

Two machines that have paired are **peers**. Federation is the normal case, not
the exception: assume the human is driving from one node toward another.

## What an AI agent can actually do

Through the MCP bridge, when the tools are exposed in your session:

| You want to | Use | Covered by |
|---|---|---|
| tell the human something, or ask | `nc_notify`, `nc_ask` | `nexuscrew-agent` |
| read runtime state, identity, decks | `nc_status`, `nc_identity`, `nc_deck` | `nexuscrew-agent` |
| find and message another cell | `nc_cells` then `nc_send_cell` | `nexuscrew-agent` |
| speak on a node or audio group | `nc_speak`, `nc_speak_group` | `nexuscrew-agent` |
| hand a file to the human | `nc_send_file`, `nc_inbox` | `nexuscrew-agent` |
| find out why a cell will not start | `nc_cell_diagnostics` | `nexuscrew-agent` |
| keep state across sessions | Memory MCP | `memory` |
| index and retrieve documents | MSA MCP | `vl-msa` |
| delegate bounded work to workers | Crew MCP | `crew` |
| read, search and triage mail | Mail MCP | `mail-assistant` |

The last four are **optional companions**, listed in
[`mcp-companions.json`](../../mcp-companions.json). They are separate servers:
absent unless installed, and never installed silently.

## Four rules that will save you a wasted hour

**A receipt is not an outcome.** `submitted` from `nc_send_cell` means the text
was pasted and Enter was pressed. It does not mean the message was understood,
accepted, or acted on. If completion matters, ask for an explicit answer.

**There is no offline queue.** A cell that is not active cannot receive. A
`canReceive: false` peer is not "queued", it is unreachable.

**Discovery is not authorization.** Seeing a cell or node in a listing does not
mean you may act on it. Panels in particular are denied by default and granted
per peer, by the node that owns the cell.

**A cell that looks idle may not be.** A TUI queues incoming messages while it
works, which is healthy. Do not conclude a cell is stuck from a quiet pane.

## Trust boundaries

- Everything binds to **loopback** by default. Reaching a node from elsewhere
  means a tunnel or a pairing, deliberately.
- A **panel** must point at loopback on the machine that runs the node. This is
  not a port-forward: the caller picks *which cell*, never *where to connect*.
  Without that rule, opening "a panel" would be a way to reach anything the
  node can reach.
- Never put tokens, keys, cookies or pairing material into MCP payloads,
  messages to cells, or documents. Do not read credential files to work around
  a missing tool.
- Mutations are honoured or refused, never faked: `NEXUSCREW_READONLY=1` and
  routed-peer inspect-only limits are real, and a refusal is information.

## Where to look next

| Topic | Document |
|---|---|
| Cells, engines, decks | [Fleet](../../docs/FLEET.md) |
| Peers, pairing, visibility | [Nodes](../../docs/NODES.md) |
| The MCP bridge and client setup | [MCP](../../docs/MCP.md) |
| A cell's web panel | [Cell panel](../../docs/CELL_PANEL.md) |
| Files, environment, settings | [Configuration](../../docs/CONFIGURATION.md) |
| CLI, boot, backup, diagnostics | [Operations](../../docs/OPERATIONS.md) |
| Trust boundaries in depth | [Security](../../docs/SECURITY.md) |

## When something does not work

In this order, because each step rules out the one before:

1. `nexuscrew status` — is the service running, on which port, in which roles?
2. `nexuscrew doctor` — local diagnostics.
3. Is the tool you need **actually exposed** in this session? Do not emulate a
   missing tool by reading state files; say it is missing and degrade openly.
4. For a cell that will not start: `nc_cell_diagnostics` before anything else —
   it returns the redacted command and the last startup failure.
5. Only then look at files, and say that you are doing so and why.
