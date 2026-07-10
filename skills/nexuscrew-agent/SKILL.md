---
name: nexuscrew-agent
description: Use when an AI agent in a NexusCrew tmux session must hand a file to the human (report, screenshot, export) or send text/input to a tmux session, or when a tmux send-keys message is ignored, sits unsubmitted in the composer, or a pasted prompt arrives garbled.
---

# NexusCrew Agent I/O

Two things an agent does inside [NexusCrew](https://github.com/DioNanos/nexuscrew): **hand files to the human** and **send input to a tmux session**. Both have a reliable way and a way that silently fails.

## File exchange (inbox / outbox)

Per session, NexusCrew watches `<root>/<session>/{inbox,outbox}` (root = `$NEXUSCREW_FILES_ROOT`, default `~/NexusFiles`):

- **outbox** — files you write here surface in the browser UI with a badge. This is how you deliver a deliverable.
- **inbox** — files the human sends arrive here. The path reaches you in your prompt either way, but through two different human-side flows: the files-panel upload pastes the bare path straight into your PTY, while the composer **attach button** (paperclip, v0.7.7+) puts the path inside the human's typed message — expect paths mixed with instructions, not always a bare path on its own line. Read the files from the inbox; never overwrite, treat as read-only input.

Deliver with the helper (resolves the current tmux session, timestamps, never overwrites):

```bash
bin/nc-deliver report.pdf chart.png      # → ~/NexusFiles/<session>/outbox/
```

Don't hand-craft the path from a guessed session name — use `nc-deliver`, or derive the session with `tmux display-message -p '#S'`.

## Sending text to a tmux session

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

## Quick reference

| Goal | Do this |
|---|---|
| Give the human a file | `nc-deliver <file>...` |
| Read a file the human sent | look in `<root>/<session>/inbox/` (path is in your prompt) |
| Send a prompt/command to a session | `nc-send <session> "text"` |
| Queue text without running it | `nc-send <session> --no-submit "text"` |
| Confirm a send worked | `tmux capture-pane -t <session> -p | tail` |

## Common mistakes

- **Trusting `send-keys ... Enter`** → message stuck in composer. Use `nc-send` (bracketed paste + flush).
- **Not verifying the send** → exit 0 means nothing; always `capture-pane`.
- **`tmux` aliased/wrapped by the shell** (e.g. an oh-my-zsh plugin) → the nudge silently fails. Helpers resolve the real binary; in ad-hoc commands use `/usr/bin/tmux` or `command tmux`.
- **Pasting onto a dirty composer** → text concatenates with whatever was there. Clear it first, or the previous line will merge with yours.
- **Delivering to a guessed session name** → file lands in an orphan folder with no badge. Use `nc-deliver` (it reads the real session).
