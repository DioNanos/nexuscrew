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
| `~/.nexuscrew/audio.json` | Local Audio Share consent (default off) |
| `~/.nexuscrew/audio-groups.json` | Local named Audio Share target groups |
| `~/.nexuscrew/audio-bridge.key` | Local HMAC proof for MCP Audio Share calls |
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

### Engine credentials

A managed engine resolves its credential from the first source that has it, in
this order:

```text
environment -> NexusCrew store -> user shell (providers.zsh)
            -> keys files -> legacy file
```

The keys group is **two files**, read in this order:

```text
~/.config/keys/ai.env  ->  ~/.config/secure/.env
```

**The last one wins.** A value in `secure/.env` overrides the same variable in
`ai.env`, on purpose: it is the place to put an override without touching the
canonical file. Until now that precedence was not documented anywhere, so the
only way to notice an override was to compare the files by hand — and an engine
running on a revoked key looked exactly like an engine running on a good one.

NexusCrew now reports the origin of the credential it resolved: the source, the
file path, its modification time and the first 8 hex characters of the SHA-256
of the value. **The value itself is never shown, logged or returned.** When the
same variable is defined in more than one file with a *different* value, the
engine stays configured but says so — in the doctor's `engine credentials`
section, in the engine status `reason`, and in the `credentialConflict` field of
`GET /fleet/status`.

The order is fixed. An engine can change **where** it looks with
`credentialSourcePolicy` in its managed profile:

| Policy | Meaning |
|---|---|
| `auto` (default) | the order above |
| `environment` | only the service environment |
| `nexuscrew-store` | only the NexusCrew store (`~/.nexuscrew/credentials.json`) |

Common overrides:

| Variable | Purpose |
|---|---|
| `NEXUSCREW_PORT` | Loopback HTTP port |
| `NEXUSCREW_CONFIG_FILE` | Alternate config file, useful for isolated tests |
| `NEXUSCREW_TOKEN_FILE` | Alternate bearer-token file |
| `NEXUSCREW_FILES_ROOT` | Alternate per-session file root |
| `NEXUSCREW_TMUX` | tmux executable |
| `NEXUSCREW_FLEET=0` | Disable Fleet management |
| `NEXUSCREW_ALTERNATE_SCREEN=1` | Keep tmux's standard alternate-screen behavior for newly created NexusCrew sessions |
| `NEXUSCREW_READONLY=1` | Disable server-side mutations |
| `NEXUSCREW_AUTO_UPDATE=0` | Disable the stable update scheduler |
| `NEXUSCREW_DEBUG=1` | Enable bounded verbose diagnostics |
| `NEXUSCREW_VOICE_URL` | Optional server-side speech-to-text endpoint |
| `NEXUSCREW_VOICE_TOKEN_FILE` | Token file for the optional STT endpoint |

Use `NEXUSCREW_CONFIG_FILE`, `NEXUSCREW_TOKEN_FILE`, `NEXUSCREW_FILES_ROOT`
and a separate `HOME`/XDG root when creating an isolated test runtime.

## Session and Fleet settings

| `config.json` key | Default | Effect |
|---|---:|---|
| `alternateScreen` | `false` | New sessions created through Fleet or the PWA keep full-screen TUI output on the normal screen, where it enters tmux history and remains scrollable. Set `true` to restore the standard tmux alternate screen. |

The setting applies only when NexusCrew creates a session through Fleet or the
PWA; active and unmanaged sessions are not changed. `NEXUSCREW_ALTERNATE_SCREEN=1` has the usual
environment precedence. For the normal-screen mode, keep the user-owned tmux
`history-limit` at least 10000 (100000 is a practical value). `nexuscrew doctor`
warns when it observes a lower value but never changes `~/.tmux.conf`.
In the PWA, the same local setting is available at **Settings → System →
Diagnostics**.

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
- [Audio Share and native TTS](AUDIO_SHARE.md)
- [Security](SECURITY.md)
- [Operations](OPERATIONS.md)
