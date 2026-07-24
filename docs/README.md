# NexusCrew documentation

[← Main README](../README.md)

NexusCrew is designed around a small public entry point and focused technical
guides. Start with installation, then open only the area you need.

| Guide | Use it for |
|---|---|
| [Installation](INSTALLATION.md) | Platform prerequisites, first run, verification and upgrades |
| [Fleet and terminals](FLEET.md) | Cells, engines, providers, decks, terminal input and mobile behavior |
| [Connect nodes](NODES.md) | Pairing, SSH routes, private/share state and routed aliases |
| [Notifications](NOTIFICATIONS.md) | In-app toasts, Web Push and on-device spoken alerts |
| [MCP bridge](MCP.md) | Operator tools, client configuration and cell-to-cell delivery |
| [Configuration](CONFIGURATION.md) | Local paths, environment overrides and browser-local settings |
| [Operations](OPERATIONS.md) | CLI, boot, backups, updates, diagnostics and development |
| [Security](SECURITY.md) | Network, token, credential, file and federation boundaries |
| [Alibaba Token Plan](ALIBABA_TOKEN_PLAN.md) | Managed Claude Code, Codex-VL and Pi profiles |

Additional public references:

- [MCP companions](../MCP_COMPANIONS.md)
- [Machine-readable companion catalog](../mcp-companions.json)
- [Changelog](../CHANGELOG.md)
- [License](../LICENSE)

## Fast paths

### I want to use NexusCrew on this machine

Read [Installation](INSTALLATION.md), run `nexuscrew doctor`, then open the PWA
with `nexuscrew show`.

### I want to reach another machine

Read [Connect nodes](NODES.md). NexusCrew supervises OpenSSH; it does not
replace your SSH configuration or create SSH keys.

### I want to run AI CLI workers

Read [Fleet and terminals](FLEET.md), then configure cells and provider
presence in **Settings → Fleet**.

### I want an AI session to contact the operator

Read [MCP bridge](MCP.md) and register `nexuscrew mcp` in the client.

### I want to expose NexusCrew publicly

Do not. Read [Security](SECURITY.md): the supported model is loopback plus an
SSH tunnel or VPN you control.
