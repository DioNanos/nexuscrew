# The Live per-cell prompt

[← Documentation index](README.md)

When Live starts a native session (engine `codex-vl*`), the bridge
(`lib/live-host/bridge.js`) always sends `thread/start` a `developerInstructions`
field that opens with an identity header — which cell it is attached to, and
the exact tmux session the roster reports for it — and, if a per-cell prompt
file exists, appends its text after a blank line. How the app-server
combines that field with its other configured instructions is not
established here — a separate verification of that consumer is in progress.
This page is about the template file itself: what it must contain, exactly
where it goes, and how to prove the bridge actually reads it. For the Live
host designation itself (which cell a node's Live session lands on), see
[`live`](../skills/live/SKILL.md).

## Where the file goes

```
<NexusFiles>/<tmuxSession>/LIVE_PROMPT.md
```

- `<NexusFiles>` is the `filesRoot` NexusCrew resolves for the node running
  the bridge — `~/NexusFiles` unless overridden by configuration. This is
  the node's own home, not a remote peer's.
- `<tmuxSession>` is the **exact tmux session name the Fleet roster reports**
  for the designated cell (`cell.tmuxSession` in fleet status / `nc_cells`)
  — the same value the bridge puts in the identity header, not a name
  reconstructed from a device prefix. On a device whose sessions are named
  `cloud-*` this is `cloud-<Cell>`; on a device using a different prefix (or
  none) it is whatever that device actually calls the session. There is no
  fixed prefix to guess: **until 2026-08-16 the bridge assumed `cloud-` as a
  universal default, and on any device using a different prefix the prompt
  was never found** — this page described that assumption as the contract
  before it was understood to be the bug.
- If the roster does not report a `tmuxSession` for the cell at all, the
  bridge does not construct a path from the cell name as a fallback — see
  "What the bridge does with it" below for what happens instead.

To install a template: copy one of the files in
[`live-prompt-templates/`](live-prompt-templates/) into that session's
NexusFiles folder, next to that cell's `PROMPT.md` and `ACTIVE_WORK.md`, and
rename it to `LIVE_PROMPT.md`. Nothing in the file needs editing — it never
names the cell or the operator; the voice discovers both at runtime through
`nc_identity`/`nc_cells`, exactly as the file tells it to.

## What the bridge does with it

`readCellPrompt(filesRoot, tmuxSession)` has four distinct outcomes. The
distinction matters for anyone debugging why a Live session sounds
unbriefed — "I don't even know where to look," "I looked and it's not
there," and "it's there but useless" point to different fixes:

| Outcome | Cause | What happens |
|---|---|---|
| `applied: true` | file exists, reads, non-empty after trim | its text is appended to the identity header, separated by a blank line |
| `applied: false`, `reason: "session-unknown"` | the roster does not report a `tmuxSession` for this cell | no path is built at all — never a guess from the cell name; only the identity header (cell name, no session) is sent |
| `applied: false`, `reason: "missing"` | the session is known, but no such file exists there (`ENOENT`) | legitimate absence — the identity header still ships, no per-cell prompt is appended, no error |
| `applied: false`, `reason: "unreadable"` or `"empty"` | file exists but can't be read, or is blank/whitespace-only | almost certainly a mistake — worth fixing, not silent |

Three things this table implies:

- A missing file is not a bug. Not every cell needs one.
- `session-unknown` is not the same failure as `missing`, and collapsing them
  is exactly how the prefix bug hid: every session on a non-`cloud-` device
  looked "missing" when the real cause was "never looked, wrong assumed
  path." If this ever shows up in practice, it means the roster isn't
  reporting a tmux session for an active cell — worth investigating on its
  own, not something to silently fall back from.
- An unreadable or empty file is very likely a mistake: something is there,
  and it is not doing what its presence suggests.

## Engine scope

The prompt only ever reaches a **native** Live session — engine
`codex-vl*`, where the bridge opens its own thread on the app-server's
control socket and can pass `developerInstructions` directly. For any other
engine the bridge runs in **tmux mode**: no thread is opened, no
instructions are passed, and the response reports `prompt: { applied:
false, reason: "tmux-mode" }` even if a `LIVE_PROMPT.md` file is sitting
right there, correctly placed and readable. Placing the file for a
non-`codex-vl` cell is not wrong, it simply has no effect yet.

## Verifying it's not just a plausible story

The bridge's own test suite (`tests/live-host-bridge.test.js`) builds the
real bridge against a real HTTP hub and a real WebSocket daemon, writes a
`LIVE_PROMPT.md` file to disk at the exact path this page describes, and
asserts on what the fake app-server actually *received* on the wire — not on
what the code merely appears to do reading it top to bottom. Two tests are
the pattern to extend if this contract ever changes:

- `'NATIVA con cella OCCUPATA...'` — the ordinary case, file found and
  applied, identity header followed by the prompt text.
- `'BUG prefisso: un device con prefisso diverso da cloud- deve trovare
  comunque il prompt'` — a device whose sessions are named `macair-*`: the
  file is written under that exact session name, not under `cloud-`, and the
  bridge is expected to find it there. This is the test that would have
  caught the original bug — it fails against the pre-fix bridge and passes
  against the current one, with a sibling test pinning that the `cloud-`
  case does not regress.

## See also

- [`live-prompt-templates/`](live-prompt-templates/) — the three template
  files (Italian, English, Spanish).
- [`live`](../skills/live/SKILL.md) — designating and permitting a node's
  Live host cell.
- [Fleet and terminals](FLEET.md) — what Live is and how a host cell is
  chosen.
