# MCP bridge

[← Documentation index](README.md)

`nexuscrew mcp` exposes the local authenticated runtime as a dependency-free
stdio MCP server. It is intended for AI sessions running inside managed tmux
cells.

## Tools

| Tool | Purpose |
|---|---|
| `nc_notify` | Send a PWA notification to the operator |
| `nc_ask` | Ask a non-blocking question and return the answer to the caller |
| `nc_send_file` | Place a caller-owned file in the downloadable outbox |
| `nc_status` | Read live tmux and Fleet status |
| `nc_inbox` | List files received by the caller |
| `nc_deck` | Discover owner-qualified decks containing the caller |
| `nc_cells` | List authorized Fleet cells across visible nodes |
| `nc_cell_diagnostics` | Read redacted launch state for one exact local cell |
| `nc_send_cell` | Submit bounded text to one exact active cell |
| `nc_identity` | Diagnose caller identity without reading a token |

Cell delivery uses bracketed paste followed by a separate Enter. A `submitted`
receipt confirms transport to the target TUI, not acceptance or completion by
its model. There is no silent offline queue.

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
- [Security](SECURITY.md)
