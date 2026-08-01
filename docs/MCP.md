# MCP bridge

[← Documentation index](README.md)

`nexuscrew mcp` exposes the local authenticated runtime as a dependency-free
stdio MCP server. It is intended for AI sessions running inside managed tmux
cells.

## Tools

| Tool | Purpose |
|---|---|
| `nc_notify` | Send a PWA notification, optionally declaring its text language |
| `nc_ask` | Ask a non-blocking question and return the answer to the caller |
| `nc_send_file` | Place a caller-owned file in the downloadable outbox |
| `nc_status` | Read live tmux and Fleet status |
| `nc_inbox` | List files received by the caller |
| `nc_deck` | Discover owner-qualified decks containing the caller |
| `nc_cells` | List authorized Fleet cells across visible nodes |
| `nc_cell_diagnostics` | Read redacted launch state for one exact local cell |
| `nc_send_cell` | Submit bounded text to one exact active cell |
| `nc_vl_nodes` | List authorized owner-qualified VL micro-device nodes |
| `nc_vl_invite` | Create a one-time invite on one exact owner |
| `nc_vl_command` | Deliver a bounded command to one online VL node |
| `nc_vl_revoke` | Explicitly revoke one exact VL pairing |
| `nc_identity` | Diagnose caller identity without reading a token |
| `nc_speak` | Speak a bounded utterance on one exact authorized node ID |
| `nc_speak_status` | Read a caller-scoped exact-target audio receipt |
| `nc_speak_stop` | Stop a caller-owned exact-target utterance |
| `nc_speak_group` | Start a local named primary/failover or explicit fan-out group |
| `nc_speak_group_status` | Read a caller-scoped per-endpoint group receipt |
| `nc_speak_group_stop` | Stop a group and prevent untried failover candidates |

Cell delivery uses bracketed paste followed by a separate Enter. A `submitted`
receipt confirms transport to the target TUI, not acceptance or completion by
its model. There is no silent offline queue.

### Notification language

`nc_notify` accepts `title`, optional `body`, optional `urgency`, and optional
`lang`. Use `lang` whenever the text language is known so an opted-in,
visible/focused PWA can select the correct on-device speech voice:

```json
{
  "title": "Release completata",
  "body": "Correzione verificata e pubblicata con tutti i test verdi.",
  "lang": "it"
}
```

Accepted base languages are `it`, `en` and `es`; equivalent BCP-47 forms such
as `it-IT` are normalized. Omitting `lang` remains backward compatible.

## Claude Code

```json
{
  "mcpServers": {
    "nexuscrew": {
      "command": "nexuscrew",
      "args": ["mcp"]
    }
  }
}
```

## Codex and Codex-VL

These clients launch MCP stdio processes with a cleared environment. Allowlist
the identity variable names; do not copy values into the config:

```toml
[mcp_servers.nexuscrew]
command = "nexuscrew"
args = ["mcp"]
env_vars = ["NEXUSCREW_MCP_SESSION", "TMUX", "TMUX_PANE"]
```

Equivalent Codex-VL CLI form:

```text
codex-vl mcp add nexuscrew \
  --env-var NEXUSCREW_MCP_SESSION \
  --env-var TMUX \
  --env-var TMUX_PANE \
  -- nexuscrew mcp
```

## Caller identity

The caller is resolved in this order:

1. Current tmux session.
2. `NEXUSCREW_MCP_SESSION`.
3. Missing identity.

Without identity, gated tools fail closed with a stable
`NEXUSCREW_MCP_IDENTITY_*` code. `nc_notify` degrades to an unknown sender.

`nc_identity` returns only:

- resolution source (`tmux`, environment fallback or missing)
- boolean presence of identity variables
- stable status code
- remediation hint

It never calls the HTTP API or reads the bearer token.

`nc_cell_diagnostics` accepts an exact owner-qualified ID returned by
`nc_cells`, only when the target belongs to the local node and the caller is an
active local Fleet cell. Its command and failure information are bounded and
credential-redacted.

VL mutation tools likewise require an active local Fleet caller. Use
`nc_vl_nodes` immediately before mutation and the full owner-qualified target.
`nc_vl_command` receipts are transport-only until `lastAck` carries the same
ID. See [VL micro-device nodes](VL_MICRO_NODES.md).

### Audio Share

Audio tools require an active local Fleet cell and an HMAC-signed bridge
request. The target node independently enforces its own audio consent, ACL,
`READONLY`, rate limit, and native capability. A successful adapter start is
reported as `spoken`; it is not proof of physical audibility. See
[Audio Share and native TTS](AUDIO_SHARE.md) for exact-target and group
semantics.

## Optional companions

NexusCrew can work alongside separate local-first MCP servers for:

- durable structured memory
- searchable document memory
- bounded worker delegation
- mail access

They are optional projects, not hidden NexusCrew dependencies. Discover
existing tools first and ask before installing software, changing MCP
configuration or requesting credentials.

See [MCP_COMPANIONS.md](../MCP_COMPANIONS.md) and
[`mcp-companions.json`](../mcp-companions.json).

## Related guides

- [Fleet and terminals](FLEET.md)
- [Connect nodes](NODES.md)
- [Audio Share and native TTS](AUDIO_SHARE.md)
- [VL micro-device nodes](VL_MICRO_NODES.md)
- [Security](SECURITY.md)
