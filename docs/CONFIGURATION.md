# Configuration

[← Documentation index](README.md)

Most setup lives in the PWA. Runtime state is local to the current user and is
never synchronized to a hosted control service.

## Local paths

| Path | Contents |
|---|---|
| `~/.nexuscrew/config.json` | Port, Fleet mode and runtime options |
| `~/.nexuscrew/token` | Local PWA bearer token |
| `~/.nexuscrew/credentials.json` | Optional node-local write-only provider store |
| `~/.nexuscrew/tunnels/` | Managed SSH supervisor state and owner-only logs |
| `~/NexusFiles/<session>/` | Per-session inbox and outbox |

Sensitive files are created with user-only permissions. The credential store is
optional; NexusCrew can also resolve compatible provider variables from its
service environment.

## Precedence

Runtime values follow:

```text
defaults < config file < environment
```

Common overrides:

| Variable | Purpose |
|---|---|
| `NEXUSCREW_PORT` | Loopback HTTP port |
| `NEXUSCREW_CONFIG_FILE` | Alternate config file, useful for isolated tests |
| `NEXUSCREW_TOKEN_FILE` | Alternate bearer-token file |
| `NEXUSCREW_FILES_ROOT` | Alternate per-session file root |
| `NEXUSCREW_TMUX` | tmux executable |
| `NEXUSCREW_FLEET=0` | Disable Fleet management |
| `NEXUSCREW_READONLY=1` | Disable server-side mutations |
| `NEXUSCREW_AUTO_UPDATE=0` | Disable the stable update scheduler |
| `NEXUSCREW_DEBUG=1` | Enable bounded verbose diagnostics |
| `NEXUSCREW_VOICE_URL` | Optional server-side speech-to-text endpoint |
| `NEXUSCREW_VOICE_TOKEN_FILE` | Token file for the optional STT endpoint |

Use `NEXUSCREW_CONFIG_FILE`, `NEXUSCREW_TOKEN_FILE`, `NEXUSCREW_FILES_ROOT`
and a separate `HOME`/XDG root when creating an isolated test runtime.

## Fleet settings

Fleet cells and engines are managed in **Settings → Fleet**. A cell records:

- logical cell name and tmux session
- working directory
- engine, provider and model
- permission policy
- optional system prompt or trusted Shell command
- boot state

Provider key values are not stored in cell or engine definitions. The PWA
reports whether a required variable is configured, but never returns its value.

## Browser-local settings

The following are local to the browser origin:

- deck layout and node collapse state
- session ordering and pins
- mobile key-bar and keyboard preferences
- per-cell draft, composer size and bounded prompt history
- spoken-notification opt-in and successful per-page voice priming

Browser-local state is not included in Fleet backups and can be cleared from
**Settings → System**.

## Speech input

Speech-to-text has two independent paths:

- Browser Web Speech where the browser exposes it.
- Optional server STT through `NEXUSCREW_VOICE_URL`.

If neither path is available, the microphone control is hidden. Server STT is
separate from optional spoken notifications, which use the device's browser
speech engine and send no text to a speech service.

## Token rotation

The browser token travels in the URL fragment (`#token=...`), not in the
initial HTTP request. To rotate it:

```bash
nexuscrew stop
rm ~/.nexuscrew/token
nexuscrew
```

Review the exact target before removing any alternate token file.

## Related guides

- [Fleet and terminals](FLEET.md)
- [Notifications](NOTIFICATIONS.md)
- [Security](SECURITY.md)
- [Operations](OPERATIONS.md)
