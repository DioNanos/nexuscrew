# Operations

[← Documentation index](README.md)

## CLI

| Command | Purpose |
|---|---|
| `nexuscrew` | Start or reuse the background runtime and print status |
| `nexuscrew show` | Open the authenticated PWA |
| `nexuscrew show token` | Print the authenticated link |
| `nexuscrew status` | Show service, port, role and node status |
| `nexuscrew stop` | Stop NexusCrew and managed tunnels, preserving tmux |
| `nexuscrew restart` | Restart NexusCrew and autostart links, preserving tmux |
| `nexuscrew boot` | Enable startup persistence |
| `nexuscrew boot off` | Disable persistence without stopping the runtime |
| `nexuscrew doctor` | Check Node, PTY, tmux, SSH, service and platform integration |
| `nexuscrew nodes ...` | Inspect and manage connected nodes |
| `nexuscrew help` | Show public command help |
| `nexuscrew version` | Show the installed version |

`init`, `serve`, `fleet-boot` and `mcp` are internal entry points rather than
the normal interactive workflow.

## Boot integration

| Platform | Integration |
|---|---|
| Linux | systemd user service |
| macOS | per-user LaunchAgent |
| Android / Termux | detached runtime and optional Termux:Boot script |

Boot starts only cells marked `boot:true`. It is startup persistence, not a
watchdog for the tmux server itself.

Linux services use `KillMode=process` so restarting NexusCrew does not stop the
shared tmux server. Lifecycle commands fail closed when this protection cannot
be verified.

Termux pidfiles include process identity data. If Android reuses a PID under
another app UID, NexusCrew removes only the stale pidfile, never signals the
foreign process, and restarts only the configured OpenSSH supervisor.

## Backup and restore

**Settings → Fleet** can export and restore selected cells, system prompts and
reusable engines.

Restore:

- previews conflicts
- supports per-item selection
- reports active cells requiring restart
- stores working directories relative to the target user's home
- requires explicit repair for legacy or foreign absolute paths

Archives contain credential variable names, never credential values, browser
tokens or live tmux state.

## Updates

Global npm installs can follow stable `latest` automatically. NexusCrew:

1. Serializes update attempts.
2. Installs the selected stable version.
3. Verifies the CLI and same-port runtime.
4. Rolls back once to the exact previous version if health checks fail.

It never installs prereleases from `latest` or silently downgrades. Use
`NEXUSCREW_AUTO_UPDATE=0` to disable the scheduler.

## Diagnostics

**Settings → Diagnostics** shows a bounded in-memory event buffer for the
local installation or an authorized routed node.

Verbose collection is explicit and expires after 5, 15, 30 or 60 minutes.
Operational warnings and errors remain available while verbose mode is off.
The view supports filtering, pause, autoscroll, copy, JSON export and clear.

Records are structured and redacted before storage. Raw terminal content,
prompts, command lines, environment values, credentials and filesystem paths
are not accepted as diagnostic metadata. Fleet launch failures expose closed
`code` and `phase` values rather than raw stderr.

## Troubleshooting

- **Node older than 18** — upgrade Node before initialization.
- **tmux missing** — install tmux and rerun `nexuscrew`.
- **OpenSSH missing** — install `ssh`; `autossh` remains optional.
- **systemd user service unavailable** — consider
  `loginctl enable-linger "$USER"`.
- **LaunchAgent failure** — inspect `nexuscrew doctor` and the user
  `~/Library/LaunchAgents` permissions.
- **Termux:Boot does not start** — install and open the Android app once.
- **Voice unavailable** — distinguish browser synthesis from optional server
  speech-to-text; see [Notifications](NOTIFICATIONS.md).

## Development

```bash
npm test
npm run build
node bin/nexuscrew.js serve
```

Tests that exercise tmux use private sockets and must never attach to or stop
the operator's tmux server.

## Related guides

- [Installation](INSTALLATION.md)
- [Configuration](CONFIGURATION.md)
- [Security](SECURITY.md)
