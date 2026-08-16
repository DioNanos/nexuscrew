# The Live per-cell prompt

[← Documentation index](README.md)

When Live starts a native session (engine `codex-vl*`), the bridge
(`lib/live-host/bridge.js`) looks for a per-cell prompt file and, if it finds
one, sends its text as `developerInstructions` on `thread/start`. That text
**replaces** whatever global instructions the app-server would otherwise
inject — it is not appended to them. This page is about the template file
itself: what it must contain, exactly where it goes, and how to prove the
bridge actually reads it. For the Live host designation itself (which cell a
node's Live session lands on), see [`live`](../skills/live/SKILL.md).

## Where the file goes

```
<NexusFiles>/cloud-<Cell>/LIVE_PROMPT.md
```

- `<NexusFiles>` is the `filesRoot` NexusCrew resolves for the node running
  the bridge — `~/NexusFiles` unless overridden by configuration. This is
  the node's own home, not a remote peer's.
- `<Cell>` is the **Fleet cell name** — the `cell` field you get back from
  `nc_cells` or fleet status (for example `Dev`), not the tmux session name.
  A tmux session name carries a device prefix (`cloud-Dev`, `macair-Dev`,
  …); the cell name does not.
- The `cloud-` segment in the folder name is **fixed in the bridge's code
  today** (`readCellPrompt` in `lib/live-host/bridge.js`): it is prepended
  whenever the cell name does not already start with it, regardless of what
  prefix the device itself uses for tmux sessions. In practice this means
  the folder is always `cloud-<Cell>`, on every device — the file location
  does not follow the device's own naming.

To install a template: copy one of the files in
[`live-prompt-templates/`](live-prompt-templates/) next to that cell's
`PROMPT.md` and `ACTIVE_WORK.md`, and rename it to `LIVE_PROMPT.md`. Nothing
in the file needs editing — it never names the cell or the operator; the
voice discovers both at runtime through `nc_identity`/`nc_cells`, exactly as
the file tells it to.

## What the bridge does with it

`readCellPrompt(filesRoot, cellId)` has three distinct outcomes, and the
distinction matters for anyone debugging why a Live session sounds
unbriefed:

| Outcome | Cause | What happens |
|---|---|---|
| `applied: true` | file exists, reads, non-empty after trim | its text becomes `developerInstructions`; the app-server's own global/default chain does **not** run for this session |
| `applied: false`, `reason: "missing"` | no such file (`ENOENT`) | legitimate absence — the session starts with the app-server's normal global instructions, no error |
| `applied: false`, `reason: "unreadable"` or `"empty"` | file exists but can't be read, or is blank/whitespace-only | almost certainly a mistake — worth fixing, not silent |

Two things this table implies:

- A missing file is not a bug. Not every cell needs one.
- An unreadable or empty file is very likely one: something is there, and it
  is not doing what its presence suggests.

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
what the code merely appears to do reading it top to bottom. That test
(`'NATIVA con cella OCCUPATA...'`) is the proof this page's own claims are
checked against, and it is the pattern to extend if this contract ever
changes.

## See also

- [`live-prompt-templates/`](live-prompt-templates/) — the three template
  files (Italian, English, Spanish).
- [`live`](../skills/live/SKILL.md) — designating and permitting a node's
  Live host cell.
- [Fleet and terminals](FLEET.md) — what Live is and how a host cell is
  chosen.
