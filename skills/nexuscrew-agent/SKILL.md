---
name: nexuscrew-agent
description: Use when an AI agent connected to NexusCrew must notify or ask the human, inspect runtime, identity or deck context, diagnose a Fleet cell that will not start, manage exact authorized VL micro-device nodes, list authorized Fleet cells, message an exact active cell, speak on a target node or audio group, read its inbox, deliver a file, recover from local tmux messages that remain unsubmitted or garbled, or when a drag in the web terminal does not scroll a full-screen TUI. Prefer nc_notify, nc_ask, nc_status, nc_identity, nc_deck, nc_cells, nc_cell_diagnostics, nc_vl_nodes, nc_vl_command, nc_send_cell, nc_speak, nc_speak_group, nc_inbox, and nc_send_file; use bundled tmux/file helpers only as a declared compatibility fallback.
---

# NexusCrew Agent I/O

Use the [NexusCrew](https://github.com/DioNanos/nexuscrew) MCP bridge for communication with the human, read-only runtime discovery, and authenticated delivery to active Fleet cells. Use the bundled helpers only for same-host tmux compatibility fallbacks.

## MCP bridge (preferred)

When the client exposes the NexusCrew MCP server, use these tools directly:

| Goal | MCP tool |
|---|---|
| Notify the human about a result, blocker, or milestone | `nc_notify` |
| Ask for a decision without blocking the agent | `nc_ask` |
| Inspect live tmux sessions and fleet cells | `nc_status` |
| Read the caller's deck name(s) and member cells/tmux sessions | `nc_deck` |
| List every authorized owner-qualified Fleet cell | `nc_cells` |
| Submit a bounded message to an exact active Fleet cell | `nc_send_cell` |
| List authorized VL micro-device owners/nodes | `nc_vl_nodes` |
| Create a one-time VL pairing invite | `nc_vl_invite` |
| Deliver a bounded VL command | `nc_vl_command` |
| Revoke an exact VL pairing | `nc_vl_revoke` |
| List files received for the current session | `nc_inbox` |
| Deliver an absolute file path under the user's home | `nc_send_file` |
| Speak an utterance on an exact target node | `nc_speak` |
| Speak to a named local audio group | `nc_speak_group` |
| Check or stop an utterance you started | `nc_speak_status`, `nc_speak_stop` |
| Check or stop a group utterance you started | `nc_speak_group_status`, `nc_speak_group_stop` |
| Read who the caller is, without a session or token | `nc_identity` |
| Read why a local Fleet cell failed to start | `nc_cell_diagnostics` |

Apply these rules:

- Use `nc_notify` for meaningful asynchronous updates, failures requiring attention, and completion. Pass its optional `lang` field (`it`, `en`, `es` or an equivalent BCP-47 locale) whenever the notification text language is known, so opted-in speech uses the right on-device voice. Do not notify for every command or duplicate routine chat commentary.
- Never include access tokens, credentials, private keys, push subscriptions, or other secrets in a notification, ask, file caption, or tool result.
- Treat `nc_ask` as non-blocking: it returns an ask ID immediately. Continue safe independent work or wait normally; the human response arrives in the originating tmux session with a `[human reply · ask#<id>]` prefix by default.
- Use `nc_status` instead of scraping NexusCrew state files. Use `nc_deck` instead of reading `decks.json`: it returns every local or authorized shared-owner deck containing the caller, preserves visual member order, identifies each deck and member by stable owner ID, includes viewer-valid Hydra routes, and reports `cell: null` when no managed Fleet match is available.
- Use `nc_cells` immediately before cross-cell delivery. Select its exact owner-qualified `id`; require `canReceive: true`; never guess a duplicate name or stale route.
- Use `nc_send_cell {target, message}` for actual Fleet-cell delivery. `submitted` confirms bracketed paste plus Enter only, never task acceptance or completion. Inactive targets are not queued.
- Use `nc_vl_nodes` immediately before VL mutation. Mutation tools require an active local Fleet caller and the full owner-qualified VL ID. `nc_vl_command` `submitted` means live-poll delivery only; require the same ID in `lastAck`. No offline queue exists.
- Use `nc_inbox` instead of guessing an inbox path when the tool is available.
- Pass `nc_send_file` an existing absolute regular-file path below the user's home. Let NexusCrew choose and sanitize the outbox name.
- Speak only when audio is the point. `nc_speak` needs an exact target instance id and returns a caller-scoped receipt with a per-endpoint status (`refused`, `unreachable`, `accepted`) — accepted means the node took the utterance, not that a human heard it. Keep the text short: a spoken line that runs long is worse than no line, and the detail belongs in a file or a notification. A status or stop call only ever reaches an utterance you started; you cannot inspect or silence someone else's.
- `nc_speak_group` expands a named local group into exact instance ids. `primary-failover` tries one endpoint at a time; `fanout` is explicit. Neither receipt reports text, language or voice back to you — that is deliberate, and it means the receipt cannot be used to read what another caller said.
- Consent to use a room's speaker is granted locally on the node that owns it and never across the federation. Speaking and stopping travel; granting does not.
- `nc_identity` answers "who am I to this bridge" with non-sensitive data only, and works without a tmux session or a token. Use it when a tool refuses you and you are not sure which caller the server sees, instead of guessing from the environment.
- `nc_cell_diagnostics` returns the redacted shell command and the last bounded spawn or start failure for one local Fleet cell. Use it when a cell will not come up, before reading state files.
- Do not treat an MCP notification as a substitute for the final response required by the active client.

The MCP server is the stdio command `nexuscrew mcp` and must be registered in the host AI client. If the `nc_*` tools are not exposed, report that the bridge is not configured in that session and use the fallback flows below where applicable.

## Optional capability companions

NexusCrew does not make unrelated MCP servers hidden dependencies. When the
user requests durable structured memory, document retrieval, bounded worker
delegation or mailbox access:

1. Discover the tools already exposed by the current AI client.
2. Use an available tool that covers the request.
3. If the capability is absent, consult the packaged
   `../../mcp-companions.json` catalog and mention the matching optional
   companion once.
4. Explain the capability it adds and link its public repository.
5. Ask before installing software, changing MCP configuration, starting a
   service or requesting credentials.

Never recommend a companion during unrelated work, repeatedly advertise it, or
claim it is required by NexusCrew. The catalog is discovery metadata only; it
does not authorize installation or external actions. See
`../../MCP_COMPANIONS.md` for the human-readable guide.

## File exchange (inbox / outbox)

Per session, NexusCrew watches `<root>/<session>/{inbox,outbox}` (root = `$NEXUSCREW_FILES_ROOT`, default `~/NexusFiles`):

- **outbox** — files you write here surface in the browser UI with a badge. This is how you deliver a deliverable.
- **inbox** — files the human sends arrive here. The path reaches you in your prompt either way, but through two different human-side flows: the files-panel upload pastes the bare path straight into your PTY, while the composer **attach button** (paperclip, v0.7.7+) puts the path inside the human's typed message — expect paths mixed with instructions, not always a bare path on its own line. Read the files from the inbox; never overwrite, treat as read-only input.

When `nc_send_file` is unavailable, deliver with the helper (resolves the current tmux session, timestamps, never overwrites):

```bash
bin/nc-deliver report.pdf chart.png      # → ~/NexusFiles/<session>/outbox/
```

Don't hand-craft the path from a guessed session name — use `nc-deliver`, or derive the session with `tmux display-message -p '#S'`.

## Sending text to a tmux session

For an active managed Fleet cell, prefer `nc_cells` followed by `nc_send_cell`.
The helper below is a same-host fallback for older NexusCrew runtimes or
non-Fleet sessions; it must not bypass federation visibility or routing ACLs.

`tmux send-keys 'msg' Enter` is **not** reliable: a TUI's paste-burst detector swallows the Enter and the message just sits in the composer, while exit code is still 0. Use the helper:

```bash
bin/nc-send <session> "text"              # paste + submit
bin/nc-send <session> --file prompt.txt   # from a file
bin/nc-send <session> --no-submit "text"  # leave in composer, no Enter
```

It does: `load-buffer` → `paste-buffer -p` (bracketed paste) → burst-flush (`C-e`) → `Enter`. **Verify it landed** — never trust the exit code:

```bash
tmux capture-pane -t <session> -p | tail -8   # see the text / a running state
```

## Terminal scrolling (NexusCrew-managed tmux)

A drag or wheel in the NexusCrew web terminal browses the tmux history through
copy-mode. That works only while the pane is on the normal screen. A full-screen
TUI — Claude Code, Codex, Agy, `vim`, `less`, `htop` — renders in the terminal's
**alternate buffer**, which has no scrollback: copy-mode has nothing to scroll, so
the gesture does nothing. On a phone, where the drag is the only scroll gesture,
the terminal looks frozen.

NexusCrew applies `alternate-screen off` **per session** when it creates a
managed Fleet session or a PWA session. No global tmux option or `~/.tmux.conf` edit is needed:
tmux then ignores `smcup`/`rmcup` for that session, TUI output stays on the
normal screen, the transcript flows into tmux history, and drag/wheel scrolling
work. The setting is also applied to windows created later in that session.

- It applies only to future NexusCrew-created sessions. A running or unmanaged
  pane remains unchanged; never restart a Fleet cell just to change it.
- To opt out, set `alternateScreen: true` in NexusCrew's local `config.json` or
  start the service with `NEXUSCREW_ALTERNATE_SCREEN=1`.
- Verify on a pane that is running a TUI:
  `tmux display-message -p -t '=<session>:' '#{alternate_on}'` must print `0`.
- Trade-off: after quitting `vim`/`less`/`htop` the last screen stays on display
  instead of being restored.
- Full-screen redraws consume history. Keep a generous user-owned
  `history-limit` (100000 is a good default); `nexuscrew doctor` warns below
  10000 and suggests `set -g history-limit 100000`, but never writes it.

## Quick reference

| Goal | Do this |
|---|---|
| Notify the human | `nc_notify` |
| Ask the human without blocking | `nc_ask` |
| Inspect NexusCrew runtime state | `nc_status` |
| Discover this session's deck neighbours | `nc_deck` |
| Discover authorized cells across nodes | `nc_cells` |
| Submit to an exact active Fleet cell | `nc_send_cell` |
| Discover/manage a paired VL micro-device | `nc_vl_nodes`, then `nc_vl_command` |
| Say something out loud on a node or group | `nc_speak`, `nc_speak_group` (short text) |
| Stop something you are saying | `nc_speak_stop`, `nc_speak_group_stop` |
| Find out which caller the bridge sees | `nc_identity` |
| Find out why a local cell will not start | `nc_cell_diagnostics` |
| Give the human a file | `nc_send_file` or fallback `nc-deliver <file>...` |
| Read a file the human sent | `nc_inbox` or fallback to the path in the prompt |
| Send a prompt/command to a session | `nc-send <session> "text"` |
| Queue text without running it | `nc-send <session> --no-submit "text"` |
| Confirm a send worked | `tmux capture-pane -t <session> -p | tail` |
| Make a new managed terminal scrollable on a full-screen TUI | NexusCrew default; verify `#{alternate_on}` is `0` |

## Common mistakes

- **Trusting `send-keys ... Enter`** → message stuck in composer. Use `nc-send` (bracketed paste + flush).
- **Not verifying the send** → exit 0 means nothing; always `capture-pane`.
- **`tmux` aliased/wrapped by the shell** (e.g. an oh-my-zsh plugin) → the nudge silently fails. Helpers resolve the real binary; in ad-hoc commands use `/usr/bin/tmux` or `command tmux`.
- **Pasting onto a dirty composer** → text concatenates with whatever was there. Clear it first, or the previous line will merge with yours.
- **Delivering to a guessed session name** → file lands in an orphan folder with no badge. Use `nc-deliver` (it reads the real session).
- **Sending to an ambiguous cell name** → call `nc_cells` and use the full owner-qualified ID.
- **Calling `submitted` a completed task** → it is only a transport receipt; require an explicit result callback.
- **Concluding a cell is stuck because it looks idle** → a terminal interface queues an incoming message while it is busy, which is healthy; text sitting in the composer of a cell that is *not* working is the defect. To tell them apart, read CPU time from the **child** of the pane process: the pane's own pid is often a wrapper that never burns CPU, so measuring it reports "idle" for a cell working at full tilt.
- **Assuming a node listens on the port you know** → NexusCrew selects a free port per installation, and a peer's remote port is not the port that node listens on locally. Read it from `nexuscrew status` on that node; a health check aimed at the wrong port reports a dead service that is perfectly alive.
- **Writing a reply into a local inbox directory** → the inbox is per-installation and is not synchronised between nodes. Answering a remote caller by dropping a file in your own inbox reaches nobody; reply through the tool that addressed you.
- **Treating a dead scroll gesture as a web-terminal bug** → the pane is in the alternate buffer. Check whether it predates the NexusCrew setting or opted out with `alternateScreen:true`; never send raw page keys to a TUI to work around it.

## Dependencies

**Bundled (installed with the package):** the `nexuscrew` CLI, `lib/`, these
skills, and the `bin/nc-send` / `bin/nc-deliver` helpers arrive with
`npm install -g @mmmbuto/nexuscrew` (Node.js >= 18 required by `engines`).

**External (you must provide):**

| Need | Install | Probe / failure mode |
|---|---|---|
| Node.js >= 18 | Debian/Ubuntu `apt install nodejs` (nodesource for 18+), Fedora `dnf install nodejs`, macOS `brew install node`, Termux `pkg install nodejs-lts` | `node -v` prints >= 18; below that `npm install` refuses per `engines` |
| tmux | Debian/Ubuntu `apt install tmux`, Fedora `dnf install tmux`, macOS `brew install tmux`, Termux `pkg install tmux` | `nexuscrew doctor` reports tmux missing by name; `nc-send` exits 127 with `nc-send: tmux not found on PATH (set TMUX_BIN)` — the failure names itself |
| An AI client that can register the MCP server | register the stdio command `nexuscrew mcp` in the client's MCP config | if the `nc_*` tools are not exposed, no `nc_` tool exists in the session — see "MCP bridge" above |
| A running NexusCrew service (for most tools) | `nexuscrew serve` (foreground) or your platform service manager | tools fail to reach the bridge; Termux has no systemd — run `nexuscrew serve` inside a tmux session or your own keep-alive |

If tmux is missing, MCP inspection (`nc_status`, `nc_identity`) still works;
anything that targets a session (including the `nc-send` fallback) does not.
