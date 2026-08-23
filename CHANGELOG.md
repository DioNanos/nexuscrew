# Changelog

All notable changes to NexusCrew are tracked here.

## 0.9.12 — 2026-08-22 — "Build After The Bump"

- **Fixes 0.9.11, which would not start.** `frontend/dist/version.json` said
  `0.9.10` while the server said `0.9.11`, so the UI refused with «incomplete
  installation: frontend and server do not match». Everything else in that
  package was consistent; that one byte was enough. The cause is ordering:
  `vite.config.js` writes that file from `pkg.version` **at build time**, and
  the bundle had been built before the version was raised. **Use 0.9.12; 0.9.11
  is deprecated.**

- **A test now asserts what a checklist used to.** The frontend/package version
  match had been verified by hand at every release since 0.8.2 — and a check
  that lives only in a list is skipped the day someone is in a hurry. It now
  fails on its own, and it was seen failing on a wrong value before it was
  trusted on the right one.

## 0.9.11 — 2026-08-22 — "The Cell Gets Its Own Words"

- **A `vl` cell now starts with its own prompt and the model you picked in the
  UI.** It was the only engine that came up bare: the runtime had a branch for
  it that did nothing, and the code path that hands a cell its prompt skipped
  `vl` explicitly. The prompt is now written to a private per-cell file
  (`0600`, atomic replace, symlinks refused, credentials never written there)
  and passed by path, and the model/provider/base-url travel as environment.
  A version gate compares the binary FIELD BY FIELD, so an older `vl` degrades
  to the previous behaviour instead of being handed a flag it cannot parse —
  and when it degrades it says so in the `/fleet/up` payload rather than
  failing quietly.

- **"Inbox" in the paperclip menu: upload a file without the cell reading it.**
  File/Camera/Gallery upload the attachment AND put its path in the composer,
  so the next Send makes the model read it — and a model that cannot take
  images errors out and forces a restart. The new item keeps the file in the
  inbox, reachable from `nc_inbox` and the Files panel, and leaves the composer
  untouched: the operator decides when, and whether, it gets read. Contributed
  by @sadoc1184-droid; the bundle shipped here was rebuilt from source on our
  side rather than taken from the pull request.

- Terminal selection: xterm's EXCLUSIVE end is converted at the boundary, so
  consumers no longer see it as inclusive.

## 0.9.10 — 2026-08-19 — "What The Hand Expects"

- **Selecting text now behaves the way a hand expects it to.** 0.9.9 made the
  selection follow the gesture rather than the device; this release makes the
  gesture itself match the one people already know from their phone. The
  comparison was made line by line against a real terminal implementation
  rather than from memory, and it turned out most of it already matched — the
  handles were anchored on the right cell boundaries, they hung below the row,
  a long press on a space took just that space, and the grip was preserved
  while dragging. What did not match was on the vertical axis and at the edges.

  The touch offset was **two whole rows**, and near the top of the screen it
  **flipped sign**: the same distance between finger and handle picked a
  different cell depending on where you were. It is now a fraction of the
  handle's height, measured from the layout instead of counted in rows — and
  the flip is gone, not because it was removed but because the condition that
  made it necessary no longer exists.

  At the left and right edges the handles now **mirror themselves** instead of
  running off the screen or being clipped: the body swings to the other side
  and the selection point stays exactly where it was. A 50 ms gate stops them
  flickering at the boundary, while the first turn after you grab a handle
  still happens immediately.

  Still not covered by any test, and said plainly: shape, size and overlap are
  CSS. That half is judged by a finger.

- **The cell list no longer decides on a sentence.** Whether a fleet is
  unreadable or deliberately off was worked out by pattern-matching the
  server's human-readable explanation — so rewording a message silently
  changed what the interface did. One of the eight possible messages was
  already being read the wrong way: a migration that completed but could not
  be saved mentions the configuration file while actually being a blocked
  boot, so the list kept showing cells that were no longer there.

  The server already produced a machine code for exactly those cases and the
  status route was dropping it. It now travels, and the client decides on it.
  The client deliberately keeps **no list of known codes**: the presence of the
  field is enough, because a single place produces it and every code from that
  place means the same thing — a fixed list would send a newer server's code
  back to the prose, which is the original defect. For the messages that carry
  no code the text is still read, and that limit is written where it is read.

## 0.9.9 — 2026-08-19 — "Naming the Right Cause"

- **Selecting text now follows the gesture, not the device.** A touch selection
  gets the handles and the magnifier; a mouse selection gets neither, because a
  mouse re-selects with native precision and a third element on top of a
  resolved gesture is in the way. A laptop with a touchscreen switches between
  the two **gesture by gesture**, rather than being filed under one category
  forever. The first selection of a session defaults to touch, which is the
  conservative direction: showing handles that were not needed costs less than
  withholding handles that were.

  On the desktop the magnifier is **gone**, and `Shift`+click extends the
  nearer end of an existing selection — the desktop equivalent of dragging a
  handle. Double-click no longer asks for the on-screen keyboard.

  On mobile the magnifier is no longer a bar pinned to the top: it is a bubble
  **beside the handle you are holding**, visible only while the gesture lasts.
  It flips below when the selection is near the first rows, stays inside the
  edges, and follows the handle that moves. The two handles are asymmetric —
  one leans left, one leans right — and step apart vertically when the
  selection is short, so both ends stay separately grabbable.

  Copying is never automatic: the clipboard is not touched without an explicit
  gesture, and the button states its shortcut.

  The magnifier idea remains **@sadoc1184-droid**'s (PR #5); what changed here
  is where it sits, not the observation behind it.

- **A live session can reach the NexusCrew tools again.** A Live inherits the
  environment of a shared daemon, which carries no cell identity, so every tool
  that needs to know which cell is speaking refused to act — while still
  appearing in the tool list, which is why this read as "the tools are missing"
  rather than "the tools are refusing". The bridge already knew the answer: it
  hands each Live its exact session at start. Now it also says how to use it.
  Where no session is declared, it says so instead of suggesting a command that
  would fail.

- **A cell that is alive is no longer reported as stopped.** Two separate
  causes had been collapsed into one sentence: a readiness marker the interface
  produced but never displayed, and a failed *check* worded exactly like a cell
  that is genuinely down — so the reflex was to restart a cell that was
  working. A failed check now says it failed.

- **A notification delivered to zero channels no longer calls itself
  delivered.** The status is now derived from the delivery counts instead of
  being asserted alongside them, so the label and the measurement cannot
  disagree.

- **An uploaded file that never reached the cell says so.** Three outcomes used
  to share one silent `false` behind a 200: not requested, the terminal did not
  take it, and the text was refused. They are now three answers, and the status
  code separates "reached and not taken" from "never attempted, our fault".

- **A full disk is not an invalid name.** Saving an audio group answered 400
  "invalid group" for permission errors and out-of-space alike, sending the
  reader to fix a name while the filesystem was the problem. Validation still
  answers 400; a write that fails answers 500 and names the real cause.

- The 0.9.8 entry below was missing from this file: the release notes went into
  the commit and never reached the changelog, so the published package claimed
  0.9.7 was the newest version. Restored.

## 0.9.8 — 2026-08-18 — "What The Product Knows"

Eight fixes with one thread running through them: the product knew the real
cause and reported a different one, or reported something true it had never
checked. A message that names the wrong cause sends the reader to work in the
wrong place, and costs more than silence.

- Selecting text in the terminal behaves like a phone: a long press takes **the
  word under the finger**, at the exact point pressed. The two-row offset that
  pushed the selection away from the fingertip is gone — it existed only to
  keep the selection visible, and a 2x strip of the line being selected does
  that instead. Handles stop at the edge of double-width glyphs rather than
  landing inside an emoji.
  The strip is **@sadoc1184-droid**'s idea (PR #5); the implementation is ours,
  the observation was theirs.
- A cell list that empties no longer looks like lost cells: if the read fails
  the last known list stays, marked as such, and a fleet that is genuinely
  disabled says so with the server's own reason instead of showing cells that
  are not there.
- An answer past the size limit is **refused**, not silently truncated, and the
  error states both the limit and how long the text was.
- `--help` after a subcommand prints the help instead of running the command:
  `init --help` used to run `init` and print the panel URL **including the
  token** on the terminal of someone who only wanted to read the syntax.
- Updating regenerates both boot definitions and actually activates them, on
  both paths. A definition is ours only if it carries the exact shared line
  from the template: a third-party unit that merely mentions the product is no
  longer overwritten, and an unreadable one is skipped and declared.
- Three messages that gave one cause for several: the composer on a read-only
  view, download and delete in the file panel, and the audio test.
- "Up to date" is no longer said about a check that was never run.

Found while building, and already present in 0.9.7: a selection dragged
backwards left the handles swapped, and reading the raw range let a frozen
anchor resurrect a cancelled selection.

## 0.9.7 — 2026-08-18 — "Two Handles"

- **Selecting text in the terminal now has two draggable handles.** They mark
  the start and the end of the selection and can be moved **after** the
  selection is made — the gesture people already know from mobile terminals.
  It works in a tile, in the popup and in the main session, because they share
  one terminal.

  The selection itself stays where it belongs: **inside the terminal
  emulator**. The handles are a view recomputed from the emulator's own
  selection on every render and scroll, never a remembered position — which is
  how handles drift away from what they point at. Dragging one writes back
  through the emulator's API rather than recalculating which cells are
  selected.

  Three cases decide whether this is usable rather than merely present, and
  each is pinned by a test:

  - dragging a handle past the edge **scrolls** and extends the selection,
    because the range is held in buffer coordinates rather than screen ones —
    but **not** inside a full-screen application, where scrolling belongs to
    that application and taking it over would break it;
  - the handle hangs **below** the point it sets and follows the finger by the
    offset it was grabbed at, so the finger never has to cover the thing it is
    positioning;
  - the handles cannot cross each other, and the selection survives a redraw.

- **If the text underneath a live selection is overwritten, the interface now
  says so.** A selection is held against buffer coordinates, so output that
  rewrites those lines changes what a copy would produce while the reader still
  has the old text in mind. That is a consequence of the design rather than a
  defect — and consequences that a reader cannot see are the thing this project
  keeps removing, so it is stated instead of left implicit.

  The check reads only the rendered lines that intersect the selection, not the
  whole selection on every frame; a test pins the **cost**, not just the
  outcome, by asserting that output elsewhere reads nothing at all.

  Declared limit: a change to selected lines that never enters a rendered frame
  will not raise the notice. The indicator is a courtesy, not a correctness
  gate, and everything visible passes through a render.

## 0.9.6 — 2026-08-18 — "Causes With Names"

The previous release fixed a blank panel, a service that hung on a terminal, and
a message that named the wrong cause. They were three symptoms of one defect: a
value that collapsed different states into `null`, and a low level composing
sentences about facts it could not know. This release fixes the defect itself.

- **Resolving a public key now has five distinct outcomes instead of one
  `null`**: derived, no identity configured, identity present but the actual key
  unknown, the tool itself missing, and encrypted-or-unreadable. They are data,
  not prose — nothing downstream has to parse a sentence to learn what happened.
  The pairing response carries the outcome beside the text, so a consumer has
  the fact rather than an interpretation of it.

  Previously all five answered `null`, and the message that followed had to
  guess: "I cannot derive the public key" was shown for a missing file, a
  missing binary and an encrypted key alike, and only one of the three had
  anything to do with a passphrase.

- **The sentences are now composed in one place.** A single formatter turns each
  outcome into a cause and an action. Success stays silent — there is nothing to
  say when a thing works — and an outcome the formatter does not recognise is
  **named** rather than swallowed, because a silent default rebuilds exactly the
  collapse this removes.

- **The boot service no longer points at a path that expires.** The generated
  unit and launch agent recorded the interpreter path of the moment, which on
  package managers that version their install directory disappears at the next
  upgrade — and the entry point was versioned too, so fixing only the first
  produced a service that looked repaired and failed identically. Both are now
  resolved to a stable alias when one exists and points at the very same file;
  when none exists the current path is written **and the fact is declared**,
  because a path that will expire silently is worse than a warning.

- **Unreachable peers are no longer polled at a fixed rate forever.** Three
  stopped peers used to fill the console until the service worker gave up. The
  interval now backs off with a ceiling and recovers as soon as the peer answers
  — the recovery is what the test pins, because a backoff that never resets is a
  sentence rather than a protection.

  And three different answers stopped looking alike: a peer that is absent, one
  that is present and refuses, and one missing that route each say so, with the
  action they imply — wait, grant the permission **on the remote node**, update
  that node.

- **The panel window can be moved and resized**, remembers where it was, and
  can be recentred when it gets lost. Below the mobile breakpoint it stays full
  screen and dragging is genuinely disabled rather than merely hidden.

- **The panel no longer reports "ready" and then stops watching.** It now
  distinguishes a frame that loaded from one that failed, using the events the
  element actually emits — with the limit stated where it matters: a `load`
  event fires for an error page too, so it means "a response arrived", never
  "the panel is alive".

## 0.9.5 — 2026-08-17 — "Measured From Where It Breaks"

Almost everything in this release was already broken before it, and none of it
was found by the tests that were supposed to cover it. The pattern repeats often
enough to be worth naming: a check that runs from a convenient place reports
success for a mechanism it never actually crossed. The panel tunnel was declared
ready by measuring a local bind and never a request through it. A public key was
called valid by our own parser rather than by the program that would authenticate
with it. A test that promised "leaves no orphans" left one. Each of them was
green for weeks.

- **The per-cell panel could not load, and the interface said it was ready.**
  The viewing cookie was issued with `Path=/api/panel/<cell>`, but the dedicated
  panel port serves `/panel/<cell>` — the control-plane prefix is not there. A
  browser stores that cookie and never sends it back: the first request enters
  with its ticket, and every sub-resource of the panel is refused, as is the
  WebSocket upgrade, which looks for exactly that cookie. The panel stays blank.

  The cookie path now follows the mount the request actually entered through,
  taken from the router rather than from a constant, with a strict allow-list —
  an unrecognised mount fails closed instead of guessing a scope, and it is
  checked *before* the single-use ticket is spent, so a misconfiguration cannot
  burn a ticket belonging to someone who did nothing wrong.

  Present since the panel port was separated. It survived because a neighbouring
  function in the same file already handled *both* prefixes: someone had thought
  of the case, in one place out of two.

- **Deriving a public key could hang the foreground service for five seconds.**
  Reading a key ran `ssh-keygen -y -f`, with stdin closed and the askpass helper
  disabled. Neither matters: OpenSSH does not read a passphrase from stdin, it
  opens `/dev/tty`. Against an encrypted key on a terminal, the call waited out
  its whole timeout — and the pairing path calls it synchronously, so the event
  loop stopped with it.

  Now the prompt is forced away from the terminal and onto a helper that cannot
  run, so the attempt fails in a tenth of a second instead of five seconds.
  Below OpenSSH 8.4 that control does not exist and the timeout remains the net:
  slow, but never stuck. The limit is stated in the code rather than assumed.

  This one was invisible by construction: automated runs have no controlling
  terminal, so `/dev/tty` does not exist and the defect cannot appear. The test
  now **brings its own** terminal rather than skipping, and the probe *measures*
  whether it got one instead of trusting that it did.

- **The panel tunnel was authorised to fail.** The generated `authorized_keys`
  line restricted forwarding to the node port and never listed the panel port,
  which had been separated in an earlier release — so pairing negotiated the
  port, reserved the local side, wrote the line, and the server refused the
  channel. "Forward ready" was reported after checking the local bind only,
  which is the half that always succeeds. The channel is now exercised, the
  probe gives up on a budget instead of retrying forever, and when a key cannot
  be determined the product no longer promises a line it cannot produce.

- **A public key is now derived from the private one, not read from beside it.**
  Three rounds of hardening had gone into validating the `.pub` file, which
  proves that a file contains *a* valid key — never that it is *the* key for
  that identity. Deriving it removes the question. Relatedly, whether a key is
  acceptable is now decided by the program that will use it, not by our parser.

- **Replacing a degraded forwarding channel no longer leaves stray processes.**
  Stopping and waiting now happen at a single point before any replacement.
  The test that certified this used to leave an orphan of its own, and its
  guard identified processes by number rather than by what they were — a
  recycled id could satisfy it.

- **A pidfile declares its identity at birth**, its schema marker is one-way,
  and an obstacle to writing that marker now closes the window instead of
  holding it open forever. A refusal that was uniform across two different
  causes used to break updates; the two are separated.

- **A remote cell's row resolves against its own node's sessions.** Both the
  sidebar row and the popup could show data from a same-named local session.

### Notes for anyone reading the tests

Several fixes here are in tests that were passing while proving nothing: a guard
that matched too loosely to ever fail, a timing assertion that measured a
stopwatch instead of the signal it cared about, a cleanup check that read a file
it had already deleted, and one that could not fail because the shell it relied
on rejected the syntax it used. If a test has never been seen red for the right
reason, it has not been seen at all.

## 0.9.4 — 2026-08-17 — "The Interface Was Last Week's"

- **The published interface is the one this version was built from.** 0.9.3
  shipped a `frontend/dist` compiled eight hours before the interface work it
  was supposed to contain: the popup with its three sources, the telemetry
  line, the tier labels and the panel origin fix were all in the source and
  none of them in the bundle. The server was 0.9.3 and the interface was
  0.9.2, and everything about it looked fine — the package installed, the
  service started, the pages loaded.

  What caught it is worth stating: the product's own guard did, by comparing
  the version the interface declares against the version the server is running
  and refusing to pretend they were the same. Not a test, and not the release
  check — which verified that the fixes were present in `lib/` and never looked
  at the bundle. A smoke test that inspects only the half it thinks of is a
  smoke test with a blind side.

## 0.9.3 — 2026-08-16 — "A Receipt Is Not an Outcome"

The previous release fixed the Desktop engine and shipped the fix inert. Pulling
on that thread produced most of this one: a repair that was never called, a race
underneath it, a lock that reopened the race it closed, and — at the end — a
success reported for a write that never happened. A `200 OK` for a change that
was silently dropped is worse than a refusal, because nothing downstream has any
reason to look again.

- **Every write to the fleet definitions now goes through a lock, and a
  surrendered write is no longer reported as success.** Ten code paths did
  read-modify-write on the same file with no mutual exclusion, so a concurrent
  update could be read, overwritten, and lost. The lock is taken by creating a
  file exclusively — one syscall, no window between checking and acting — and
  its owner is identified per acquisition rather than per process. Liveness is
  asked of the kernel: a lock is only broken when it is both old *and* its owner
  is gone, because age alone never proved a process dead. The first version of
  this guard evicted **live** owners, which is how a cure reopens the disease
  it was written for; the case is now pinned by tests in both directions.

  Two callers want opposite behaviour and now get it: an opportunistic
  migration gives up in silence, while a change a person asked for **fails**
  with its own cause — `409` when the lock is busy, `400` when the data is
  invalid. Previously both answered `200 OK`.

- **Creating the definitions for the first time also goes through the lock.**
  `init` wrote the file directly, so a first run racing with a live service
  could erase a configuration instead of creating one.

- **The panel's own password reaches the panel.** `Authorization` was stripped
  wholesale on the way in, so any panel behind HTTP authentication was
  impossible to log into by construction — not misconfigured, impossible. The
  header now travels for the schemes a panel actually uses (`Basic`, `Digest`,
  `NTLM`, `Negotiate`) and never for a bearer token, which belongs to the
  control plane and must not leak into a proxied application. It is a closed
  list, not a denylist: an unknown scheme is refused rather than forwarded.

- **A container that opens over the page instead of taking you away from it.**
  Opening a cell's preview, or its desktop panel, used to mean leaving whatever
  you were looking at. There is now one popup — closed by `Escape`, by clicking
  outside it, never by clicking inside it, and it takes focus when it opens —
  reached from the status dot beside each cell in the list and from the cell's
  own tile in the grid. The panel was previously reachable **only** from an
  enlarged cell, so opening a browser meant leaving the grid first. The popup
  now holds all three sources — preview, live stream, desktop panel — and on
  narrow screens they get real buttons instead of one small dot carrying three
  meanings. Looking at a cell never selects it.

  One defect found on the way, worth stating because it was invisible: the
  popup held onto the **row** it was opened from — a single frame of a list
  that refreshes every few seconds. Left open across a refresh it could show
  another cell's preview, or a dead one's. It now holds the key and re-resolves
  it on every render; a cell that disappears closes its own popup.

- **The panel opened from the list is served from its own origin again.** A
  panel reached through the new popup was passed no port, and with no port the
  frame falls back to a relative path — same-origin with the control plane,
  which is precisely what 0.9.1 separated so that a panel's own scripts cannot
  reach the operator's token. The new entry point had quietly reopened it, with
  nothing to show for it: the panel opened and worked. The port is now resolved
  per row by the same function the grid uses, and a remote cell whose node has
  no negotiated port still gets none rather than borrowing the local one —
  a wrong origin is not a fallback.

- **A lock is no longer held by a process that merely inherited its number.**
  Liveness was decided by asking the kernel whether a pid existed, but pids are
  reused: once the number was handed to an unrelated process, the lock was
  never considered abandoned and every write to the fleet definitions gave up
  in silence. The lock's token now also records **when** its owner started, so
  two processes that held the same number at different times are told apart.
  Where that cannot be read — systems without `/proc` — the lock is left alone:
  a delayed write, never an eviction. That case is documented, not closed.

  Also: a lock whose token could not be written is no longer treated as owned.
  The write was best-effort, so a failure left an **empty** lock that named
  nobody, and thirty seconds later a live owner could be evicted from it.

- **A migration no longer overwrites work committed while it was running.**
  The concurrency check compared a snapshot taken *after* the migration's own
  work, so anything written during it was already inside the snapshot: the
  comparison passed and the older state won. The baseline is now taken at the
  source, covering the whole window.

- **The cell list shows free context and tier usage, where the cell can report
  them.** The numbers come from a small file written beside the cell's own
  files; a documented snippet is included for producing it
  (`docs/STATUSLINE_TELEMETRY.md`), and nothing is written automatically. Three
  rules govern the display: a reading older than five minutes is dropped rather
  than shown as current, cells that cannot report simply have no such line —
  no dash, no "n/a" — and an unreadable or malformed file degrades to nothing
  without failing the list. Values are accepted only as integers already in
  percent: a `null` would otherwise have been converted to a perfectly credible
  `0%` — and the same conversion was found in the documented snippet, on the
  writing side, where the reader cannot defend against it: a zero written in
  place of nothing is a valid integer and would have passed.

  Freshness is checked in **both** directions. A reading stamped in the future
  was never older than the limit, so it would have stayed "current" forever;
  beyond a small tolerance for clock skew it is now dropped like any other
  unusable value. And every number carries its own direction in its label —
  `context 71% free · 5h used 33%` — because a comment claiming the labels said
  so was not the same as the labels saying so, and next to a "free" the reader
  supplies the missing word themselves.

- **The voice interface knows which cell it is attached to.** It received the
  working directory and a prompt, never an identity, so a Live session had to
  go looking through terminal sessions to guess where it was — and could
  describe another cell's work as its own. The bridge now always prepends the
  designated cell's identity to the instructions it sends, alone when no
  per-cell prompt exists. The identity travels on the bridge rather than in the
  prompt on purpose: a prompt may legitimately be absent, and if identity
  depended on it, a missing prompt would have meant a Live with no idea who it
  was. The exact session name is included only when the roster declares it,
  never inferred.

  **Please note, if you set `developer_instructions` in your configuration.**
  The bridge sends that field on every Live session now, and the consumer
  *replaces* its configured value with what it receives rather than adding to
  it. A cell with no per-cell prompt therefore no longer receives the global
  developer instructions it used to get. This is accepted rather than worked
  around: changing the field's meaning would be a new contract for every
  client, and the intended place for a cell's own instructions is its
  `LIVE_PROMPT.md`.

- **The per-cell prompt is found on machines that name their sessions
  anything.** Its directory was built by pinning the literal prefix `cloud-` in
  front of the cell name, so on a host whose sessions are named otherwise the
  file was either looked for where it does not exist, or under an invented
  path. Both ended in "absent" — the same answer as a file that genuinely is
  not there, so the defect hid inside the branch meant to report it. The
  directory is now the session the roster declares, and when the roster
  declares none there is a distinct outcome: no path is built at all, rather
  than a prefix guessed.

- **Ready-to-copy prompt templates** in `docs/live-prompt-templates/`, in
  English, Italian and Spanish, with `docs/LIVE_PROMPT.md` describing where the
  file goes and the four outcomes the bridge can report. They name no cell, no
  operator and no host: the voice takes its identity from the tools at runtime,
  so the file works as copied.

## 0.9.2 — 2026-08-16 — "Offered and Then Refused"

Both defects in this release were found by using the product, not by a test —
and both were invisible to the suite for the same reason: each test exercised
one piece in isolation, and neither defect exists in isolation.

- **The Desktop engine could be selected but never saved.** It declared
  `command: 'docker'` — a bare name — while engine validation requires an
  absolute path, so it appeared in the list and was rejected on save with
  *"command must be an absolute path"*: a message describing the shape of the
  value instead of saying the command had not been resolved. The path is now
  resolved from `PATH` through `realpath`, which matters because validation
  uses `lstat` and rejects symlinks — and in many installs the first hit on
  `PATH` is exactly that. Where Docker is absent the fallback makes the
  refusal say *"not accessible (ENOENT)"*, naming the real cause.

  Installations that already had the engine are **repaired**: the backfill
  skips what already exists, so fixing the default alone would have changed
  nothing precisely where the defect was seen. The repair only touches a
  command that is both non-absolute and still named `docker` — an absolute
  path, or a command you changed yourself, is left alone.

- **The panel reloaded without pause, leaving no time to interact with it.**
  A panel behind a login was unusable: the sign-in prompt appeared and the
  frame remounted before it could be completed. `route` is an array, so it was
  a new prop on every parent render — and the parent re-renders continuously
  to poll the fleet. With the array among the effect's dependencies, every
  render requested a fresh ticket and remounted the iframe. The dependency is
  now keyed on content, so the panel reopens when the route actually changes
  and not otherwise.

## 0.9.1 — 2026-08-16 — "What the Guard Was Not Guarding"

- **The panel now lives on its own origin, so its JavaScript can no longer
  reach the operator's token.** The panel was served from the same origin as
  the control plane, in an iframe with no `sandbox` and no CSP, while the
  token sat in `localStorage` — meaning a panel's own scripts could take it
  and act as the operator. It is now served by a second loopback listener
  (`NEXUSCREW_PANEL_PORT`, default 41821) that mounts `/panel/*` and nothing
  else: no control API, no bearer. The port is part of the origin, so the
  browser's same-origin policy does the enforcing rather than a convention.
  For a **remote** node the port is negotiated during pairing
  (`panelLocalPort`/`panelRemotePort`, as an obligatory pair) and travels on
  its own forward. A node paired before this release keeps working on the old
  path, and a remote cell without a negotiated port gets none — never a
  borrowed local one.

- **A cookie set by a panel no longer reaches our origin — including through
  the WebSocket handshake.** `Set-Cookie` was stripped on the HTTP path but
  copied verbatim on the `101` upgrade, so the same property held on one route
  and not the other. A panel could overwrite the legitimate viewing cookie and
  break the user's own panel from the inside. Hop-by-hop headers still pass on
  the upgrade — there they *are* the response.

- **Designating the Live cell works from a remote node.** The star now
  commands the node that *owns* the cell rather than the one serving the page,
  which was the main defect of 0.9.0. `liveHostAccess` is a per-peer
  permission, denied by default, granted with `nexuscrew nodes live-host <node>
  on`, and a refusal names its cause instead of failing silently. Turning the
  star **off** across federation is now covered end to end, not just turning
  it on.

- **"Retry" is offered only where retrying can change the outcome.** Any `403`
  without a named reason — a read-only node refusing a federated mutation, for
  instance — was classified as an expired ticket, so the interface said "your
  ticket is no longer valid" and offered a button that could not succeed.
  Permanent refusals and invalid credentials now have their own causes and
  messages, with no button; transient ones keep it.

- **The published-tree guard no longer reports "clean" without having
  looked.** Any blob it failed to read was silently skipped: with reads
  failing, the gate stayed green having inspected nothing at all. An unreadable
  blob is now a failure, and the number of inspected files must match the
  tree — an empty result no longer counts as "no traces found".

- **The test suite stopped measuring the machine.** Five tests that raced a
  millisecond budget turned red under load and green in isolation; each false
  alarm cost three isolated re-runs to dismiss, and a gate that is sometimes
  red for no reason teaches people to distrust red. They now wait for an
  observable condition instead. Where time *is* the property — deadlines,
  grace periods — the clock was already injectable and those tests were left
  alone. No timeout was raised and no assertion was loosened.

- **New skills: `live`, `aidesktop`, and `nexuscrew` as the entry point.**
  `aidesktop` ships a Docker recipe — Dockerfile, CDP relay, example compose —
  for a desktop a browser-driving MCP can attach to. It documents the security
  trade it makes rather than implying one it does not: the browser inside runs
  unsandboxed, because the changes that would sandbox it are exactly the ones
  that weaken the container, and on a loopback-only desktop the container is
  the stronger boundary. What that costs you is stated plainly.

## 0.9.0 — 2026-08-15 — "The Star Keeps Its Promise"

- **A cell panel finally opens — through our own route, not the raw URL.** An
  `<iframe src>` is a browser navigation and carries no headers, so the
  bearer-only gate was locking out the one consumer it existed for; and a token
  in the query string would not have saved it, because the page's
  sub-resources have relative URLs and no query — a white frame. The panel is
  now served from a first-party path. The authenticated app requests a
  one-use ticket (opaque, 30 s, bound to one cell); the frame's first request
  consumes it — truly one-use: it is torn even if the check fails — and the
  answer sets a viewing cookie: HttpOnly, SameSite=Strict, one hour, and
  `Path` scoped to that cell's panel subtree, so relative sub-resources pass
  and nothing else does. The node token never reaches the browser, a log or a
  Referer. No credential of any kind is forwarded to the panel origin: the
  ticket is stripped from the forwarded query, and `referer` joins the
  stripped headers. Tickets and cookies are not compared at all: they are
  256-bit random secrets looked up by key. The WebSocket upgrade
  accepts the cookie — the panel's sockets start from inside the frame and
  cannot carry headers — while bearer and `?token=` keep working as before.

- **A panel is reachable from another machine, but only toward peers that
  were granted it.** In the pairing model a federated peer is treated as the
  operator itself, which is a coherent choice for everything else — but not
  for panels: behind a panel sits a browser with sessions already
  authenticated, and that kind of access is not revoked by rotating a key.
  `panelAccess` is therefore a per-peer permission, denied by default and
  never inherited: a record written before the field existed does not earn
  the permission by seniority. It is granted one node at a time with
  `nodes panel <node> on|off`, and the redacted view shows it, because it is
  an operator decision, not a secret. The gate is enforced on **two** paths —
  the HTTP route and the WebSocket `forwardUpgrade`, which does not go
  through the route handler and shares none of its checks: a gate written on
  one side only would be a closed door next to an open one, and for a panel
  the open one is the door that matters. A test breaks on exactly that
  removal. The check runs before the allowlist, so a peer without the
  permission cannot even learn whether that cell has a panel.

- **On the federated path the node's own token no longer opens a panel — and
  the viewing cookie finally arrives.** A local process of the hub node could
  reach the federated panel route with no hub token at all: the iframe bypass
  forwarded the request, the last hop re-entered the owner node's API with
  the bearer the proxy had injected for itself, and the owner's panel gate
  accepted it as if it were the local app. The panel *content* of every
  granted peer walked out — not just the status codes. Provenance is now
  decided by a per-process hop proof, signed over method, path and chain and
  verified with a secret no local client can compute: with a verified hop,
  the node bearer no longer earns the content — only a ticket or a cookie
  issued by the owner node does; with no hop, local traffic works as it
  always did; with a hop that fails verification, the request is refused
  rather than guessed at. The same boundary is written twice, on the HTTP
  path and on the WebSocket upgrade, for the reason above. Closing it
  uncovered a second defect that had been hiding behind the first: the
  sanitizer stripped the entire `cookie` header on federation hops, so the
  viewing cookie never reached the owner node and a remote panel served the
  page and nothing else — a frame that looks loaded and stays empty. Now the
  one panel cookie — opaque, per-cell, short-lived, recognizable only by the
  node that issued it — crosses the federation on panel resources, and every
  other browser cookie stays home.

- **A Live gets a designated host cell, a bridge to it, and an eligibility
  that tells the truth.** One cell per node can be designated as the Live
  host — the sidebar star cycles through favorite, host, none — with a
  compare-and-set on a persisted revision: two concurrent designations
  cannot leave two cells marked, and a caller that omits the expected
  revision is refused rather than guessed about. A stopped cell *preserves*
  its designation: eligibility is derived from the roster at read time and
  never persisted. Federation cannot designate someone else's cell — the
  refusal is a distinct 403, not the anti-transitive 404. At startup the
  Live bridges to the designated cell: on native engines it opens its own
  conversation with the cell's working directory and the per-cell prompt;
  the connection is on-demand and never permanent, so a busy cell is not
  disturbed. Every `none` outcome is distinct and declared — disabled, no
  designation, host ineligible, unknown cwd, timeouts, read-only — and past
  the bridge timeout the Live simply starts unpointed, which is the standard
  behavior. Eligibility now looks at the supervisor lease, not just at a
  living session: during grace it is `false` — a supervisor that is dying is
  not a host — and when the lease provider is absent the status says
  `unavailable` instead of quietly promising a guarantee nobody confirmed.

- **Supervisor leases: a host that promised to be alive can prove it.** The
  supervisor of a Live host cell now holds a lease from the server: a stable
  permissioned endpoint, a periodic refresh, an EOF that arms a grace with a
  deadline that cannot be extended, and a reconnect — within the grace, with
  a verifiable transition — that reconstructs the lease after a supervisor
  restart. A server restart is fail-closed: no lease survives it, and the
  recovery needs no shared secret, because the proof is signed with a
  per-installation key. The durable bound is always valued — a missing bound
  used to read as "no limit" and fail open; the refresh renews the bound on
  disk *before* the acknowledgment, so a failed write means no ack and no
  proof; persisted entries are validated for shape and plausibility at boot
  instead of being trusted; and the generation transition accepted at
  reconnect is exactly `+1`, not "anything not older". The supervisor's
  capability never crosses into the child environment.

- **A hung gate is now a red, not a wait.** A test file that leaves handles
  open — servers not fully closed, sockets alive, timers without `unref` —
  produced no failure: every test passed and the process simply never
  exited. The gate hung, and hung looks like slow instead of broken, which
  is the worst way to fail: nobody goes looking for a defect in something
  that still appears to be working. The runner now arms an exit grace once
  the summary is printed, and — because the real occurrences hung *before*
  any summary, on a file whose child process stayed alive — a stall watchdog
  that looks at progress, not at a stopwatch: no reporter output for N
  minutes means hung, and it fails naming the cause. A slow gate is never
  touched: if it works, it prints. The watchdog reads a second TAP reporter
  written to a throwaway file, so watching costs nothing on stdout — the
  first version piped the output and its backpressure sat exactly on the
  tests that measure time. Test concurrency is capped, with the reason
  measured: on a saturated box, timing-sensitive tests fell at random, and a
  gate that teaches you to ignore reds is not a gate. Along the way, the
  temporal thresholds inside the tests were reworked one by one to
  event-driven waits: a test that measures a time without asserting anything
  about the time is not protected by a tight threshold — it is exposed by it.

- **GLM-5.3 in the Z.AI catalog, top effort by default.** The provider
  switched its Coding Plan to GLM-5.3 and answers 5.3 even when 5.2 is asked
  — verified on the wire — so the catalog now says the truth about what
  runs. Only the three Z.AI entries moved: the other sources still serve
  5.2, and aligning them would have been copying a name, not updating a
  configuration. `glm-5.2[1m]` remains selectable: rollback must not require
  a code change. The `[1m]` suffix stays for a reason — it is the CLI's
  window flag, stripped before the HTTP request; the literal string does not
  exist on the wire. Maximum reasoning effort is now the default, extended
  from the previous model: the provider's own measurement has accuracy up
  and tokens-per-task down at the top level, which on a time-window plan
  pays for itself.

- **`removePidfile` verifies the subject.** It was a bare `unlink`: any
  process could delete *another* process's pidfile — the very proof that
  process is alive — leaving whoever governs it believing it dead, or
  adopting an occupied slot. Removal is now legitimate in exactly three
  cases, checked inside the function: the file is ours, the pid is stale, or
  the file is not a readable pidfile at all. `allowLive` is the caller's
  attestation after a verified kill, not a bypass. A test keeps the bad case
  red: another live process's pidfile survives a removal attempt and becomes
  removable again only when that process dies.

## 0.8.58 — 2026-08-11 — "The Numbers Behind the Wire"

- **OpenCode Go models now declare their context.** 0.8.57 shipped the provider
  without a single context window, on the grounds that the preflight measured
  which wire/model pairs answer, not how much context they hold. That was the
  wrong silence: a Codex client with no catalog has no model metadata at all
  and falls back to a default of its own, Claude compacts at a threshold
  unrelated to the model in use, and the generated Pi extension was declaring
  128k for models that hold a million. The limits come from the `models.dev`
  catalogue for this provider — the source the project already treats as
  authoritative for context and output — transcribed for the 22 models in use.
  They remain *declared* numbers rather than ones we measured: a model behaving
  as though it had less should be suspected here before the client.

- **The context follows the model, and only the model.** `glm-5.1` gets its
  202752, not the million belonging to `deepseek-v4-flash`. An id that is
  admitted because it was declared for the engine, but absent from the limits
  table, receives no context at all — inheriting another model's number would
  be worse than having none, and a test breaks on exactly that case.

- **Codex gets a real catalogue.** `opencode-go.json` covers the six pairs
  measured on the Responses wire, with context and truncation policy per model.
  It was loaded into the actual client before being wired in, and each of the
  three reasoning levels it offers was exercised against every one of those six
  models on the live API — eighteen combinations, all accepted — so the menu it
  presents contains no option that fails on use.

## 0.8.57 — 2026-08-11 — "Three Wires, One Subscription"

- **OpenCode Go is a managed provider on Claude Code, Codex-VL and Pi.** One
  subscription, one environment variable (`OPENCODE_API_KEY`), three profiles —
  because the gateway is not one uniform API but three: Anthropic Messages,
  OpenAI Responses and Chat Completions. Each client gets the wire it actually
  speaks, with `deepseek-v4-flash` as the default model on all three.

- **The model lists were measured, not copied from the docs.** The published
  endpoint table assigns each model a single wire, but the gateway translates
  between them, so the table understates what works and overstates it in
  places. Every one of the 25 advertised model IDs was tried on all three
  wires, and a second pass re-tried the failures with sane parameters to tell a
  wire refusal apart from a request the gateway forwarded empty. What went into
  the catalog is that matrix: 12 models on Messages, 6 on Responses, 21 on
  Chat. Three IDs the live catalog still advertises are dead upstream — two
  deprecated, one unavailable — and are in none of the lists.

- **The Claude profile sends the key as `x-api-key`, not as a bearer token.**
  This gateway's Messages endpoint answers `401 Missing API key` to
  `Authorization: Bearer`, which is the shape every other gateway in the
  catalog uses. Copying the neighbouring profile would have produced a cell
  that fails at first use with an authentication error and no obvious cause.
  A test breaks on exactly that substitution.

- **The URL roots differ by client and both are easy to get wrong.** Claude
  receives the root without `/v1`, because the client appends `/v1/messages`;
  Codex-VL receives the base *with* `/v1` and appends `/responses`. A doubled
  `/v1` is a 404.

- **The Pi profile requires the key instead of delegating it.** Auth delegation
  belongs to the providers Pi resolves from its own login store. This one
  exists only as a generated extension whose API key is an environment
  reference, so delegating would have reported a cell as configured while no
  key existed anywhere — a failure deferred to first use. It now fails closed
  before launch, like the other extension-based provider.

- **No context window is declared for these models.** Their real limits on this
  provider have not been measured, and an invented number would quietly become
  the threshold at which cells compact.

- **What is not verified yet.** These profiles are proven at the protocol
  level: every advertised pair was exercised against the live API. They have
  not been exercised inside a running cell, so streaming, tool calls,
  interleaved reasoning and resume remain unverified. The provider also does
  not expose `/v1/messages/count_tokens`, which Claude Code uses for context
  accounting; whether the client degrades quietly or reports an error is not
  yet known.

## 0.8.56 — 2026-08-08 — "The Catalog Learns Its Order"

- **Grok Build is a managed client (`grok.native`).** xAI's `grok` TUI joins
  the engine catalog with authentication fully delegated to the CLI's own
  login (browser, API key or device-code): NexusCrew reads no credential,
  copies no token, and puts nothing secret on argv. The binary is resolved
  from its non-standard install path (`~/.grok/bin`) before the usual
  locations. Like Agy it is backfilled platform-aware on Linux and macOS
  outside Termux — the official aarch64 binary is statically linked and looks
  promising there, but stays out until it is actually proven on a device. A
  cell set to `unsafe` maps to `grok --always-approve`, the flag the CLI
  really has.

- **VL is a managed client (`vl.native`).** The Vivling runtime's inline TUI
  joins the catalog as a local client: authentication belongs to the runtime
  itself, so NexusCrew passes no credential at all. The CLI has no approval
  flags, so the client is standard-only — an `unsafe` request has no argv
  counterpart and is refused fail-closed, including through the per-cell
  override path, and both directions are now pinned by tests. A cell prompt
  cannot be delivered to `vl` (the CLI has no prompt surface); the limitation
  is declared in code and tracked for a UI hint.

- **The catalog's order is now a contract, not an accident.** The array that
  feeds the client menu, the provider menu and the fresh-install seed is
  reordered deliberately and documented as contractual: clients by first
  appearance (Claude, Codex-VL before Codex, Grok, VL, Pi, Agy, Kimi, Shell
  last), providers inside each client by category (native, subscription,
  cloud, local, custom last), legacy entries in a separate closing section.
  Labels drop the redundant `Pi · ` prefix. The seed keeps the same five
  defaults with `claude.native` first — what changes is their order, never
  their set. Six Pi providers stay deliberately out of the UI catalog,
  declared as such in place.

## 0.8.55 — 2026-08-08 — "The Mirror Needs No Hands"

- **Building the public tree is now a pure export.** Five test fixtures existed
  in a sanitized form only on the public branch: every release rebuilt that
  sanitization by hand, and the comparison between the two branches could never
  reveal a miss, because they matched exactly on the unsanitized side. On
  2026-08-07 the step was in fact missed, and the sweep — not the process —
  caught it. Those files are now sanitized at the root, so the public line is
  the working tree minus a fixed list of internal paths, with nothing left to
  redo by hand. The package-cleanliness test introduced in 0.8.54 guards the
  npm side; this closes the same gap on the mirror side.

## 0.8.54 — 2026-08-07 — "Why the Tunnel Was Left Behind"

- **An automatic update no longer leaves the reverse channel behind.** 0.8.53
  said the reason a node stayed down after a restart was not established. It is
  now, and it was not the platform: a manual restart has always stopped the
  tunnel supervisors first, and the automatic update — on the runtime where no
  service manager owns the process — did not. The new service then found a
  supervisor still alive that it could not attribute to itself, so it neither
  stopped it nor started its own, and the reverse channel stayed attached to an
  orphan nobody reconciled. The peer read as down until someone intervened by
  hand. What isolated it was a count, not a theory: on one device, restarts run
  by hand left the peer up twice out of twice, and restarts run by the updater
  left it down twice out of twice. The difference between those two paths was
  this one step.

  Failing to stop the tunnels does not block the update — that is the main job —
  but it is now reported rather than swallowed, because a silent failure here is
  what made this take a day to find.

- **The tool bridge documents all of its tools.** The skill shipped alongside
  NexusCrew described twelve of the twenty tools the bridge exposes; the audio
  surface, the caller-identity probe and the per-cell start diagnostics were
  missing entirely. An agent that cannot read what a tool does uses it by
  guessing. It now covers all of them, along with the mistakes that have
  actually been paid for: a receipt means the text was pasted and submitted, not
  that anything was accepted; a terminal that queues an incoming message while
  it works is healthy, and telling that apart from a stuck one means reading CPU
  time from the right process; a node does not listen on the port you happen to
  know, since each installation picks a free one; and answering a remote caller
  by writing into your own inbox reaches nobody, because that directory is
  per-installation.

- **The published package is checked by a test, not by a checklist.** The sweep
  before publishing was done by hand, from a list rebuilt from memory each time.
  On 2026-08-07 that list covered paths, hostnames and AI attribution but not
  the names of internal working sessions, and 0.8.53 shipped a comment naming
  one. Nothing secret — and nothing that can be taken back, since a version is
  never republished. The check now runs with the rest of the suite, reads the
  published directories from the package manifest rather than repeating them,
  and states a reason for every pattern so that no entry can be quietly dropped
  to make the suite pass. A second test proves the patterns still bite, so an
  emptied list fails instead of turning green.

## 0.8.53 — 2026-08-07 — "Coming Back Up, and Saying So"

Automatic updates are on by default and check every six hours, so a node
installs a new release and restarts itself without anyone watching. That makes
the restart path the most consequential code in the product, and this release
is about what happens when it doesn't work: today a node was measured staying
down for over twenty minutes after a restart, with its tunnel still up, while
nothing anywhere said so.

- **A restart now confirms the service came back.** `nexuscrew restart` used to
  report success as soon as the restart *command* returned — which says the
  command ran, not that anything is answering. The two look identical to whoever
  reads the exit code. The check already existed and was already used by two
  other paths: the auto-updater waits for health and fails if it doesn't come,
  and the Fleet bootstrap does the same, with a comment that literally says "a
  verified restart is needed". It was missing precisely on the command a person
  types by hand — the one where no other code is checking on your behalf.

- **A service that exited after a restart is brought back, once.** On a phone
  there is no service manager to raise the process again: if it goes, it stays
  gone. That was measured — a node stayed down for over twenty minutes after a
  restart, with its reverse tunnel still up, and nothing brought it back. Now,
  when the service does not answer, the port decides what happens: free means
  the process is gone and it is started again *once*; still busy means something
  is holding it without serving, and retrying would only hide that. Once and no
  more — repeating turns a fault into a loop. On a machine where a service
  manager owns the runtime nothing is started alongside it: that is the
  manager's job, and a process it does not know about would race its own unit
  for the port and outlive a stop.

  **Why the process exited is not established.** A plausible story — that the
  restart did not wait for the old process before starting the new one — turned
  out to be wrong on inspection: it does wait, and has since 0.8.17. So this is
  a recovery for a failure whose cause is still open, not a fix for a known one,
  and it is worth knowing which of the two you are relying on.

- **"Peer unreachable" no longer covers two different failures.** With a reverse
  SSH channel, a device that is not connected leaves no listener and the
  connection is *refused*; a device that is connected but whose NexusCrew has
  died accepts the connection and then *resets* it. Those need opposite
  remedies — one is fixed on the network, the other by going to the device —
  and one message sent the investigation to the wrong place half the time. It
  did: four hours were spent in federation and pairing while the defect was a
  service that had not come back on a phone. The two are now named, with the
  port, and an error nobody recognises is still reported as before rather than
  guessed into a layer.

- **The interface reloads itself after the node updates.** With automatic
  updates on, a node updates and restarts while an open app keeps running the
  old bundle. The only way out was closing and reopening it — the banner had to
  be tapped, and because of a service-worker defect fixed in 0.8.52, tapping it
  did not work either. The app now applies the new bundle by itself. Only for
  the case a reload can fix: when the package on the server is newer than the
  interface it serves, no amount of reloading changes that, and it is left
  alone. If the mismatch survives the reload it is not retried — a reload loop
  makes the app unusable, which is far worse than a banner, so the banner
  remains as the fallback. What you were typing is not lost: the composer draft
  was already kept across reloads, which is what made this acceptable. The
  version check now also repeats about once a minute rather than running only
  when the app starts — an app left open in front of someone is precisely the
  case this exists for, and checking only at startup would have made it work
  solely for people who had already closed and reopened it.

- **`nexuscrew autoupdate on|off|status`.** The switch already existed — a
  persisted setting, on by default, with a checkbox in Settings. It was missing
  from the command line, which is where you need it: when a node has updated
  itself and the service did not come back, the interface is the thing you
  cannot open. With the service running the command goes through the API rather
  than writing the file, because writing the file would leave the running
  process with the old value — the setting would read "off" while updates kept
  happening on schedule, and a switch that reads off without switching anything
  off is worse than no switch. If the service is up but not answering, nothing
  is written at all.

- **An error now says when the tool bridge is older than the hub.** Updating
  NexusCrew does not update the MCP bridge of an already running session: that
  process started with the previous code and keeps it until the session is
  restarted. The symptom is cruel — you install a fix, try again, and get the
  *old* error, so you conclude the fix does not work and go looking where the
  defect is not. The check runs only on the error path, which costs nothing in
  normal use and is the only moment it helps; it cannot be cached at startup
  either, since the version that changes is the hub's, and it changes while the
  bridge is running.

- **A long message sent to a cell is no longer pasted and left unsent.** The
  wait between the bracketed paste and the Enter was a constant, while the time
  a terminal interface needs to swallow a paste grows with its size — above a
  certain length the client collapses it, the Enter lands while it is still
  being processed, and it is swallowed. The message then sat in the composer
  while the sender got a delivery receipt. Measured on the same target eleven
  minutes apart: 2900 characters were never processed for nine hours, sixty
  characters were being worked on in twelve seconds. The wait now grows with the
  text, and below 500 characters nothing changes — those were already reliable,
  and slowing them would be a cost paid by everyone for a defect that is not
  theirs. This narrows the window rather than closing it: a receipt still means
  paste and Enter, not acceptance.

## 0.8.52 — 2026-08-07 — "What a Peer May See, and What a Cell May Reach"

- **Each node now has a cryptographic identity, and it changes nothing yet.**
  Every installation generates an Ed25519 key pair; the private half stays in
  its own file, readable only by its owner, and never leaves the device. Public
  halves are exchanged during pairing — inside the act that consumes the
  one-time invite, which is the only moment at which the operator has decided,
  *on both machines*, that these two nodes know each other. Binding a key
  anywhere else would bind it to a channel the peer controls alone.

  Nothing is gated on it. A node running an older version sends no key and
  pairs exactly as before; a malformed key is ignored rather than refused,
  because a fault here must never be able to stop you from pairing a device.
  This is the first step of a per-node authority model, and it is deliberately
  the step with no effect: what it buys is *time*. A key bound today has a
  history in six months; one bound when permissions start depending on it has
  none.

  Pairing is the only thing that writes a key: no other path sets one, so no
  key can be replaced by anything a peer merely asserts. That is the property
  worth having, and it is currently guaranteed by there being no second writer
  rather than by a check — the check belongs with the first path that learns a
  key outside pairing, and arrives with it.

  **What this does not do yet**: peers paired before this version have no key
  and will not have one until they are paired again, so on an existing
  installation the directory starts out empty. Keys are learned only during
  pairing, and replacing one on a peer that already has it means removing that
  peer and pairing it again.

- **A paired node can now be restricted to a subset of your cells.** Pairing
  was all or nothing: a peer saw every cell on the hub and could act on all of
  them. The permission lives in the node store of the hub that owns the cells,
  never in the body of a request, and it is keyed on the cell id — which is
  unique and immutable — rather than the tmux session, which is derived and
  accepts non-canonical overrides. A missing field means `all`: a fail-closed
  default would have silenced an entire fleet on the first upgrade without
  anyone deciding anything, so narrowing stays an explicit act. `selected` with
  an empty list means *no cells*, and it is a different thing from an absent
  field — which is exactly why the mode is its own field instead of being
  inferred from the array.

  The guard sits at the head of the `/api` router rather than on each route,
  because the channels a cell name leaks through are many and growing: reads
  (`/cells`, `/fleet/status` — the list the remote PWA actually uses,
  `/fleet/definitions`, `/sessions` including the terminal `preview`, `/decks`,
  and the `records` of `/diagnostics/logs`) and actions (fleet up, down,
  restart, engine, boot; `cells/send`; creating and deleting sessions; files)
  pass through the same predicate. Every route declares its target in a table
  instead of having one guessed, and an undeclared route that names a cell is
  refused — a 403 on something legitimate is noticed and fixed, a channel
  nobody sees is not. Defining cells is denied to a restricted peer, or it
  would create the cell it is missing and act on that.

  The WebSocket attach honours it too, and without that the rest would be
  decoration: `/ws` attaches a PTY *by session name*, so a peer whose cell we
  had hidden from every list could still attach by guessing `cloud-X`. An
  out-of-scope session is treated as nonexistent — the same code as one that
  really is not there, because answering "it exists but you may not" reveals
  precisely what the scope hides. The scope is set from the node's sheet in the
  interface and with `nexuscrew nodes cells <node> all|none|Cell1,Cell2`.

  **This is not the admin/user class.** Within what it can see, a node in scope
  is still trusted as its owner. Scope answers *which cells*, not *what
  authority* — the second is a layer that does not exist yet.

- **A peer that is not yours does not inherit a restriction of yours.** Two
  peers of the same hub, which do not know each other, stopped seeing each
  other's cells. On the node that answers, the chain is [A, B, C]: the delivering
  peer B is in its store, the origin A is not — and has no reason to be, since a
  transitive peer arrives through a hub that was authorized to route it.
  Treating the unknown as `none` looked like prudence and was a door shut in the
  face of legitimate traffic. The delivering peer's restriction still applies in
  full, and an origin that *is* in the store still carries its own across
  multiple hops; an unknown *deliverer* stays fail-closed, because that one
  spoke to us and authenticated.

- **VL micro-devices are nodes inside NexusCrew.** A bounded bridge carries a
  micro-device's cells to the hub: the node appears in the Settings list and in
  the sidebar, its session is readable in full width, and its commands come from
  the capabilities the device declares rather than from a hardcoded list. The
  hub accepts the `prompt` verb with the same 4 KiB ceiling as the device — two
  different numbers would mean handing the node commands it will refuse while
  returning a `submitted` that reads as "it left". Nodes are aggregated across
  *all* authorized owners, not just the local one: an owner that does not answer
  shows as unavailable instead of silently reading as "no nodes", every node is
  tagged with the owner it came from, and a command is routed to the node's
  actual owner rather than quietly to the local endpoint.

  What does **not** cross the boundary: the arguments and results of tools.
  They are at once the largest and the most dangerous — files, command output,
  possible secrets — and they do not leave even truncated. On the hub the events
  stay in memory and nothing more, one ring per node, lost on restart: the
  durable copy is the journal on the device, and persisting here would extend
  in time a visibility that today is only live. A gap is always reported with
  its count, because a silent absence reads as "nothing happened".

- **Models can be declared in the configuration, without waiting for a
  release.** The model catalogue lived in the package, so a provider publishing
  a new id made it unusable until the next version — four managed profiles have
  `strictModels`, and there an out-of-catalogue id is not a warning, it is a
  cell that does not start. `fleet.json` now accepts `models` alongside
  `engines`, persisted with them: id, the managed profile it applies to, and the
  fields the client expects. The built-in catalogue remains the list of *known*
  models and becomes a default rather than a wall.

  Before declaring one you can ask whether it works, from the models window:
  the check queries the provider's model list — which costs no tokens and
  answers exactly the question asked — and replies with a closed set of
  outcomes. A provider that does not expose the list gives `unverified`, never
  `unknown-model`: "I don't know" must not read as "it does not exist", or the
  right model would be declared nonexistent. And `unverified` is not `ok`: a
  proof that was not obtained does not authorize saying it works.

  Declared models travel with the backup — a round trip used to lose them, and
  the engine that used them was then refused on restore — and they are written
  *before* the engines, in the same mutation, because that order is what makes
  the restore succeed. They also follow the engines across the federation:
  `define-engine` was federated and `define-model` was not, so administering a
  paired node stopped halfway, and the models window now acts on the node you
  are *looking at* — testing a remote node's model against your own fleet
  answers a different question than the one asked.

- **`qwen3.8-max-preview` became `qwen3.8-max` without stopping the cells that
  used the old name.** The preview was promoted and the id changed; with
  `strictModels` that is not a warning but a cell that will not start, and two
  cells in the live configuration used the old name. The rename goes through an
  alias declared in one place and applied *before* the gate, so the old name
  resolves — and resolves to the new one, which means the configuration
  converges by itself at the first rewrite instead of lagging behind a silent
  compatibility. The alias covers declared renames, not arbitrary ids.

- **The same model with and without a tag now gets the same context window.**
  `deepseek-v4-flash:0731` found itself with 180k instead of 1M after upgrading
  to 0.8.51: the context map is keyed without the tag, the direct lookup missed
  it, and the generic 200000 fallback took over — the cell started, worked, and
  had a fifth of the context it should have. The fix is not to truncate at the
  first colon, because some keys have a tag that is part of the model's identity
  (`qwen3.5:397b`, `mistral-large-3:675b`) and a blind normalization would break
  those two to fix this one. The exact key is tried first, the base name only
  after.

- **A cell can be given a named subset of MCP servers.** Cells share one
  configuration, so every cell reached every tool the operator had installed,
  and there was no way to say otherwise. A cell may now declare
  `mcp` with the names it is allowed, and an absent field is not an empty one —
  without it nothing changes, which is what every existing cell gets. Only
  *names* travel, in the process arguments:
  the obvious design would generate one file per cell containing the server
  *definitions*, and on a real installation some of those carry credentials in
  their environment, so the secrets would have been duplicated once per cell.
  Granting is done by denying the complement, because a broader deny beats a
  narrower allow in the client; `mcp: []` uses the wildcard and is therefore the
  exact case. The complement is enumerated from the three sources a session
  really loads — the user configuration, the local scope of the cell's working
  directory, and a project `.mcp.json` — and the window says so, since a server
  from a source nobody enumerates would pass while the operator believed it
  excluded.

- **A cell isolated by credential no longer loses its tools.** NexusCrew gives
  the Claude client a private configuration directory on certain credential
  profiles, which is right — it separates the keys. But the client keeps the MCP
  list in that same file, and in a private profile that list is empty: measured,
  0 servers against the 8 of the main configuration. A cell there ran with no
  memory, no notifications and no web access, and from outside it just looked
  like a cell that does not use its tools. The private profile now points at the
  main configuration for the server list, so the isolation stays on the keys
  where it belongs.

- **A failed cell lookup now says which of the three things went wrong.** One
  message covered every failure — cell absent, node unreachable, id unknown to
  this hub — and it named the cell, so a mistyped node id was read as a missing
  cell and the investigation went where the defect was not. The three cases are
  now distinguished, and the third suggests copying the id from the directory
  rather than retyping it. The same diagnosis was applied to the VL tools.

- **An alert to the operator now crosses the federation.** The notification
  channel was born as cell → operator *on the same host*, with three local
  anchors: the bridge speaks only to loopback, the event hub is a set in that
  process's memory, and the push keys are files of that installation. Anyone
  working from another node received nothing, while the reply reported success
  because those counters count *attempts*, not deliveries. A notification now
  accepts an exact target instance; with a remote one the request travels the
  existing federated route and the node that owns the screen delivers with its
  own subscriptions and its own keys — so a real web push, with the app closed.

- **A refusal the hub writes down nowhere does not exist.** A node could not
  enable Share and the hub refused it thirty times, leaving no trace: the error
  lived only in the toast on the device, which is the one place the hub's
  administrator cannot look. The cause — a reverse-port grant that named another
  peer's port — surfaced only by reading sshd's log as root. The hub now records
  what it refused and why, with the port it attempted, because "channel not
  ready" does not say where to look. The record lives in the diagnostic buffer
  in memory, so it is readable while the service runs and is lost on restart —
  which is enough for the case it was written for, a refusal repeating now, and
  is not a durable audit trail. Related: `nodes test` with no argument now
  tests every direct peer in parallel and ends with the line that existed
  nowhere — which nodes report themselves as shared while their reverse channel
  does not answer.

- **Minting a pairing invite works again on a paired installation.** After
  0.8.51 moved minting to the local installation, the button could not succeed
  on a hub-paired node: the interface still implicitly picked the first outbound
  peer and delegated the minting to it — a path that now answers 404 — and the
  local form disappeared entirely whenever a hub existed, so no route was left.
  An invite is now always minted for the installation that issues it, and the
  panel says which one, which was half the reason the previous behaviour went
  unnoticed.

- **The "new version" banner can be dismissed.** The update button messaged a
  waiting service worker and waited for it to take over, but the worker
  registered no message listener: the message fell into nothing, the fallback
  reload fired, the worker stayed waiting, and on reload the banner came back.
  Permanent by construction, with a button that could not turn it off. Anyone
  with a stuck worker needs to do nothing — the new one activates itself.

- **Mobile fixes.** The keyboard closed on every letter typed into a node's
  prompt field: the sheet's focus effect was armed on a callback the parents
  recreate on each poll, so every polling round stole the focus back from under
  your thumb. `prompt` is now a field rather than a trigger — the interface
  built its buttons from the declared capabilities and sent every verb with no
  arguments, which the device correctly refused. The models window can be left
  without saving: it had only a save button, and while it also closes with
  Escape or a click outside, a phone has no Escape and the backdrop may be out
  of reach. VL cells no longer appear twice in the switcher, and the VL event
  list is idempotent by sequence number — on a slow link the poll period expired
  before the answer, the next tick started from the old cursor, and identical
  rows piled up.

- **Interface language.** Three labels stayed in English whatever the language;
  the cell prompt now explains what it does outside Italian too; two help texts
  promised things about credentials that had stopped being true, and one
  described a backup content that had changed. The end-of-turn label said
  "session ended" on every reply — host, node, cell and pump were all measurably
  alive.

- **The governance surface is pinned by name.** The routes that change who may
  do what on a node are unreachable from the federation for an implicit reason:
  they are not in the allowlist. That holds until someone adds a line, and on
  2026-08-04 the opposite had happened. A test now enumerates them and fixes
  them — and declares what it does *not* cover: `/vl-nodes/invite` is federated
  by design, and if that ever changes it should change with someone noticing.

## 0.8.51 — 2026-08-04 — "Who May Let Someone In"

- **Minting a pairing invite no longer crosses the federation.** An invite is
  bound to the hub's instance id: whoever consumes it joins the hub, not the
  node that asked for it. Exposed through the federated allowlist, any paired
  node could obtain a live invite from your hub and hand it to a third party,
  and the hub's operator would neither act nor know — trust became transitive
  without a decision. A paired node is otherwise trusted as its owner, and that
  is deliberate; this one is different in kind, because it is the capability
  that *admits* a further node. Invites are now minted on the installation that
  will host the new node, and the refusal says so rather than returning a bare
  404. The route had been federated since 0.8.10.

- **The product now says what pairing grants.** A paired node can create a
  session — including a shell — attach to it over the federated WebSocket and
  type into it as the user running NexusCrew, and can define engines and cells.
  That is owner-equivalent authority, it is a property of the current design,
  and until now it was written nowhere. README and `docs/SECURITY.md` state it:
  pair only devices you own. Per-node authority that can be granted, attenuated
  and revoked is on the roadmap and is not implemented.

- **A node row now opens a sheet instead of holding everything.** Each row
  carried its own visibility control, a checkbox for every node on the network,
  an inline editor and a delete confirmation, all expanded at once — with four
  nodes the node's name was already pushed off a phone screen, and the one
  destructive action sat inside a list you scroll with a thumb. The row now
  carries identity and a derived summary; the rest lives in a sheet that rises
  from the bottom on a narrow screen and opens at the side on a wide one.
  Selection shows what is *granted* plus a search, never the whole network as
  checkboxes, and a grant whose node has left the inventory stays visible and
  says so — it is still live on the server.

- **The interface no longer shows Italian to English readers.** Strings in the
  file panel, the grid tiles and the key bar were written in one language, so
  they stayed Italian whatever the interface language was; four new keys now
  carry them in all three. The scroll help also described behaviour that
  changed in 0.8.48, and a guard now pins what that help must explain rather
  than how it phrases it.

- A selection now survives the trip to the Copy button. An application that
  enables any-motion tracking — Claude Code does, Codex does not — receives
  every pointer movement as input, and xterm discards a selection on any input.
  Once a drag ended the gesture was no longer shielded, which is exactly when
  you start moving toward the button: the selection died halfway there, and the
  text stayed copyable only if the mouse never moved — that is, only from the
  keyboard. While a local selection is alive, pointer movement no longer
  reaches the terminal. There is no new mode and no way out to learn: a click
  without Shift still passes through and the selection goes away on its own,
  which is how one cancels a selection anyway.

  0.8.50 kept the selected *text* across this, which is why the keyboard
  shortcut worked; it did not keep the *highlight*, and the highlight is what
  tells you what you are about to copy.

## 0.8.50 — 2026-08-04 — "What You Selected, What You Rely On"

- Selected text no longer disappears before you can copy it. xterm discards a
  selection on any input sent to the application: a keystroke, and — when the
  application has enabled mouse tracking, as Claude Code does and Codex does
  not — a single click, because that click becomes an SGR mouse report. A row
  resize does the same, so on a phone the virtual keyboard alone is enough. The
  practical result was selecting with Shift, releasing Shift to reach the Copy
  button, and finding nothing left to copy before the button was pressed. The
  selected text is now kept locally until you act on it: copy or cancel. The
  highlight may still vanish, since it belongs to the terminal emulator, but
  what you copy does not.

- Touch selection works above your finger everywhere. A long press already
  lifted the working point two rows and drew a caret, so you could see what you
  were taking; selection mode — the branch reached through the SELECT key and on
  every touch after the first — instead used the cell under the fingertip, the
  one cell you cannot see while choosing it. Both paths now behave the same.

- A reverse pool that cannot be fully verified now says what that costs.
  Rotation deliberately refuses to move into a pool whose slots are not all
  proven, and the watcher that would notice a degraded channel is never armed
  while the pool is unverified — so the reverse channel has no self-healing at
  all, and nothing said so. On a live link the active slot proves and the
  standby slots do not, because nothing listens on a reserved port, which makes
  that the steady state rather than an exception. The verdict and the safety
  gate are unchanged; the state is now reported for what it is. A verification
  run also no longer stops at the first slot that fails to prove, so one broken
  standby can no longer hide a healthy one behind it, and the outcome carries
  which slots failed and with which code.

## 0.8.49 — 2026-08-04 — "Whose Identity"

- Share can be enabled over a reverse channel again. A reverse slot listener
  answers an ownership challenge signed over `(port, generation, instanceId)`,
  and the far end builds that challenge with the id of *this* installation —
  us, as seen from there. The listener announced the id of the **remote** node
  instead, so the two ends signed different tuples and the proof never matched.
  The refusal arrives as a typed `409`, which is final by design, so no amount
  of retrying could help and Share stayed off. Present since 0.8.45. The
  listener now announces its own instance id, and refuses to open at all when
  that id is unknown rather than opening one nobody can validate.

- A failed Share now says why. The server had already classified the failure
  and redacted it — `code` and `detail` travelled in the response — but the
  interface showed only the headline, which is the same four words whether the
  peer is unreachable, the credential was refused, the hub answered 5xx or a
  slot proof was refused. Both are now shown.

## 0.8.48 — 2026-08-04 — "Federated Terminal, Scroll and Names"

- Federated terminals no longer stay black. A WebSocket upgrade arriving on a
  reverse slot listener now takes the same routing as the primary listener.
  Until now those per-slot listeners served the Express app but had no
  `upgrade` handler, so the upgrade fell through to the SPA catch-all and the
  peer answered `200` with `index.html` instead of `101 Switching Protocols`:
  the cell was listed but its terminal never received a byte. Every peer
  reached through the reverse pool was affected. `attachUpgrade` is now a
  required dependency of the slot listeners, so a listener that serves the app
  without upgrade routing cannot be created by omission.

- Scrolling now reaches the application that owns it. Wheel and finger drag
  used to always drive tmux copy-mode, so in a cell running an app that
  enables mouse tracking (Claude Code does, Codex does not) the gesture
  browsed a scrollback that app never wrote as a log — repaint frames and
  status bars instead of a transcript. When the application has enabled mouse
  tracking with SGR encoding, wheel and drag are now delivered to it as SGR
  wheel reports and it scrolls itself; every other case keeps the previous
  behaviour, and a readonly terminal still never sends PTY input. Tracking
  negotiated with a legacy (non-SGR) encoding also keeps the previous
  behaviour rather than sending bytes the application cannot decode. A terminal
  reset clears that negotiation too, and coordinates negotiated in pixels keep
  the previous behaviour rather than sending cell numbers under a pixel
  contract.

- A WebSocket that never authenticates is now closed. The upgrade is accepted
  before authentication because the token travels in the first frame, and
  nothing bounded the wait for it: a socket that never sent an attach stayed
  open and unauthenticated indefinitely, on every listener serving the app.

- Turning Share on right after a pairing no longer fails. The reverse channel
  is established a moment before it is announced, so the hub could not accept
  it yet and answered with a bare 409: the peer treated that temporary state
  as final, rolled the whole transaction back and left Share off until the
  operator tried again by hand. The hub now marks it with a typed
  `share-channel-not-ready` code and waits a longer but still bounded window,
  and the peer retries a bounded number of times before giving up. Only what is
  demonstrably transient is retried — a channel not up yet, a slot proof that
  could not be obtained, a peer answering 5xx — while an invalid credential, a
  mismatched slot proof and the wrong node at the end of the tunnel are final
  and reported as such.

- Turning Share off no longer claims more than it proved. Closing the reverse
  channel returns false when ownership cannot be demonstrated, which quarantines
  the channel rather than tearing it down; that outcome was dropped, so the
  store could read private while the pool was still alive. Both the off path and
  the rollback now report it as `reversePoolPending`, including when the close
  throws, and the operator sees it in Settings instead of reading "revoked".

- A cell can now carry a readable name, and that name travels. Until now a cell
  was known only by its id, which is also its tmux session name, so a node
  reached over the federation showed the remote id rather than what the operator
  had called the cell. A cell definition accepts an optional `label`, editable
  from Fleet, kept distinct from the id and from the tmux session; it is
  reported by fleet status, `/api/cells`, the MCP cell tools, the federated
  directory and the node topology in transit, and it survives an export/restore
  round trip and a stale topology cache. A label is self-declared data: it is
  trimmed, required to be printable and bounded to 64 characters at every
  boundary it crosses, including the ones a peer can reach, and a routed peer's
  label is marked as reported rather than verified.

## 0.8.47 — 2026-07-31 — "Kimi First-Run Corrective"

- The Kimi engines (`kimi.native` and the Claude Code "Kimi Code" provider)
  no longer receive the cell prompt on the process command line. The prompt
  is delivered to the interactive prompt only, at most once per process
  generation, after a real readiness classification of the visible terminal.
- Login screens, the Claude custom-API-key consent dialog and
  onboarding/trust dialogs are treated as **not ready**: nothing is pasted
  and no Enter is sent, so a bootstrap prompt can never be lost behind a
  dialog, and the cell session is left alive for the operator. When the
  terminal stays not ready past a bounded wait, the up response carries a
  bounded `actionRequired` code with a constant-catalog recovery hint — for
  "Kimi Code" the `/config` → "Use custom API key" path (never the Anthropic
  `/login` flow), for `kimi.native` the CLI's own device-code login.
- Prompt delivery is a single bracketed paste followed by a separate Enter on
  the exact pane, with a random per-send buffer and a `0600` temporary file.
  There is no automatic retry after any paste attempt (a partial composer
  state can never be doubled); a supervised restart performs at most one new
  classified delivery for the new generation. Legacy `send-keys` custom
  engines keep their paste-without-Enter contract on the same safer
  transport.
- The PWA surfaces the recovery hint when an up action reports
  `actionRequired` (App, session list and Fleet tab).

## 0.8.46 — 2026-07-31 — "Native Kimi"

- The Fleet gains a native Kimi Code CLI engine (`kimi.native`) that launches
  the official `@moonshot-ai/kimi-code` binary directly in the cell's working
  directory. Authentication and providers stay with the CLI (device-code
  login, `config.toml`); NexusCrew never reads, stores or injects Kimi
  credentials, and existing installations receive the engine through an
  idempotent, collision-safe backfill.
- The engine defaults to interactive (standard) permissions. The unsafe
  policy maps to `--yolo`, which auto-approves regular tool calls while the
  agent may still ask questions; the fully autonomous `--auto` mode is
  deliberately not exposed.
- Because the CLI documents no interactive prompt flag (`kimi -p` is
  non-interactive and skips the TUI), the cell prompt is never placed on the
  command line: it is delivered with bracketed paste once the session is
  ready, including on supervised restarts.
- The Claude Code "Kimi Code" provider (`claude.kimi-code`) is unchanged and
  remains the managed K3 path with the 1M-context profile. The PWA presents
  the two paths under distinct names ("Kimi Code CLI" vs "Kimi Code") with an
  explanatory notice, and login-delegated engines no longer show a misleading
  credential KEY section.

## 0.8.45 — 2026-07-30 — "Resilient Directory"

- Fleet cell-directory reads no longer wait for external model catalog discovery.
  A stalled optional engine binary therefore cannot make the MCP bridge present
  a reachable local Fleet as unavailable.
- External model discovery has a bounded five-second budget and caches failures
  as well as successful results, preventing repeated hung subprocess calls.
- The MCP cell directory now marks a local timeout explicitly, so a degraded
  bridge can be distinguished from an unreachable remote node.
- Share activation now performs an authenticated, non-scanning preflight on
  the hub-assigned reverse port. A listener owned by the same verified peer is
  accepted; an unverified occupied port returns an actionable conflict without
  restarting or publishing the private tunnel.
- Peer health reports a reverse listener that remains active while Share is
  disabled, while `nexuscrew status` now states Share enabled or disabled for
  inbound peers. These diagnostics never terminate a peer tunnel automatically.
- Shared peers can use an operator-preauthorized three-port reverse pool. The
  product never writes `authorized_keys`; legacy or incompletely granted peers
  remain private/usable and are diagnosed as not rotatable instead of guessing
  another SSH port.
- A peer proposes a pool slot over its existing private channel and the hub
  assigns a bounded lease and generation. Rotation runs only after all slots
  have been independently verified, tries one candidate per ten-minute window,
  and quarantines failures rather than killing unknown listeners.
- Slot ownership now uses a per-slot HMAC proof with a fresh challenge. The
  hub never sends a peer bearer credential to a listener it is investigating;
  a relayed proof from a different slot is rejected. Retired pool bases are
  never reused automatically, protecting against stale `permitlisten` grants.

## 0.8.44 — 2026-07-28 — "Deliberate Switch"

- The mobile cell quick rail now separates selection from switching: choose a
  row, then use the explicit open action, which rechecks the target live before
  changing terminal. A touch on the rail never switches session on its own.
- Reorder cells with their dedicated drag handle. The saved order is shared by
  the mobile rail, main roster and desktop sidebar; it retains unmanaged tmux
  sessions and restores an inactive cell to its earlier place when it returns.
- The quick rail continues to show freshly verified active cells by default,
  retains degraded cells as warnings, refreshes routed Fleet state while open,
  and keeps an explicit all-cells view for inventory and recovery work.

## 0.8.43 — 2026-07-28 — "Quick Truth"

- The mobile cell switcher is now a bottom-left quick rail that lists only
  freshly verified live cells by default. It refreshes local and routed Fleet
  state while open, verifies a target again before switching, retains degraded
  cells as explicit warnings, and keeps a deliberate **all cells** view for
  Fleet inventory and recovery work.

## 0.8.42 — 2026-07-28 — "Steady Hand"

- Touch selection no longer hides its own endpoint under the finger. A long
  press keeps its anchor and moves an offset caret two rows above the touch
  point, inverted near the top edge, so the text being selected stays visible.
- KeyBar arrow and page keys repeat while held, like a physical keyboard: an
  initial delay, then a steady stream that stops on release, on leaving the key,
  on cancel, and when the page loses focus or visibility.
- The Settings tab bar is a single scrollable row with edge cues and auto-scroll
  to the active tab, instead of a grid that left an empty cell and used a third
  of a phone screen.
- The mouse wheel now browses tmux history in every case, matching the finger
  drag. The Shift modifier no longer switches to application page keys.
- Updates the frontend build toolchain (postcss 8.5.23) to clear a path
  traversal advisory in the source-map loader. Build-only dependency: the
  published package was never affected.

## 0.8.41 — 2026-07-28 — "Open Screen"

- New NexusCrew-created sessions keep tmux `alternate-screen` off by default, scoped only
  to the created session and its later windows. Full-screen TUI output now
  remains in tmux history for mobile drag and normal scrolling; set
  `alternateScreen: true` or `NEXUSCREW_ALTERNATE_SCREEN=1` to opt out. The
  change is not retroactive, so a `vim`, `less` or `htop` screen remains visible
  after it exits.
- `nexuscrew doctor` warns, without changing tmux configuration, when the
  normal-screen mode is active and `history-limit` is below 10000.
- Moves diagnostics under System in settings and groups the System panel; the
  alternate-screen toggle lives in the diagnostics section.
- Explains what a shared audio group does before stating what it is not.
- Adds a mobile cell switcher: a left drawer opens from the key bar for fast
  switching between cells without returning to the session list.

## 0.8.40 — 2026-07-27 — "Shared Voice"

- Adds opt-in **Audio Share**, a backend-native TTS path for a specific
  authorized node with an actual speaker. It is distinct from the existing
  browser-only notification voice, so synthesis no longer depends on a PWA
  tab remaining focused in the foreground.
- Supports local native adapters on Android/Termux (`termux-tts-speak`), macOS
  (`say`), and Linux (`espeak-ng`, with an explicit `spd-say` fallback). The
  implementation reports adapter start rather than inventing audibility from a
  successful exit code; physical output remains a device-side check.
- Adds local Audio settings: consent defaults off, redacted capability,
  fixed-text explicit test and a sovereign local Stop. Share, visibility and
  audio consent remain three independent controls; a remote peer cannot grant
  audio consent through federation.
- Adds signed MCP commands for exact node speech and caller-scoped receipts:
  `nc_speak`, `nc_speak_status` and `nc_speak_stop`. The MCP bridge derives a
  live Fleet origin through a node-local HMAC proof; a UI token, body field or
  header cannot impersonate a cell.
- Adds local named target groups (up to eight exact instance IDs): ordered
  primary/failover or explicit fan-out, per-endpoint receipts, target-side
  ACL/consent/READONLY/rate checks, group Stop, bounded TTL storage and no
  aggregate success boolean. `nc_play_audio` is deliberately not introduced.
- Makes reverse-forward Share failures recoverable: a repeated bind/forward
  failure enters a diagnosed degraded state and retries at a bounded cadence,
  instead of requiring the user to toggle Share off and on after a mobile
  reconnect.
- Adds explicit Fleet credential-source policy (`auto`, environment or
  NexusCrew store), preserves legacy cells as no-op `auto`, and removes the
  conflicting provider environment set when the local store is selected.

- New NexusCrew-created sessions keep tmux `alternate-screen` off by default, scoped only
  to the created session and its later windows. Full-screen TUI output now
  remains in tmux history for mobile drag and normal scrolling; set
  `alternateScreen: true` or `NEXUSCREW_ALTERNATE_SCREEN=1` to opt out. The
  change is not retroactive, so a `vim`, `less` or `htop` screen remains visible
  after it exits.
- `nexuscrew doctor` warns, without changing tmux configuration, when the
  normal-screen mode is active and `history-limit` is below 10000.

## 0.8.39 — 2026-07-25 — "Honest Peer"

- Fixes `nexuscrew nodes test` and `nexuscrew nodes doctor` falsely reporting a
  broken pairing for healthy outbound peers. The commands no longer present a
  per-peer federation credential to `/api/config`, which correctly accepts only
  the remote browser/UI token and therefore returned a misleading `401`.
- Probes the authenticated `/federation/health` endpoint instead, matching the
  live topology health path and binding a successful response to the expected
  peer instance ID. A real federation `401` remains an actionable `token-ko`;
  transport, payload and identity failures remain distinct health failures.
- Keeps the diagnostic read-only, never returns or logs the peer credential,
  and preserves the existing inbound, tunnel-down and missing-token behavior.
- Gate: **1,068 isolated Node tests** (1,067 pass / 1 platform skip),
  **300/300 frontend tests**, production PWA build and zero production
  dependency vulnerabilities in both dependency trees.

## 0.8.38 — 2026-07-25 — "Right Voice"

- Adds an optional, validated `lang` field to `nc_notify` and carries it through
  the HTTP API, live event frame and Web Push metadata. Supported Italian,
  English and Spanish locales accept both base and BCP-47 forms such as
  `it-IT`; malformed or unsupported values fail closed.
- Makes spoken alerts prefer the notification's declared content language
  instead of the interface language. Existing MCP clients that do not yet send
  `lang` retain a conservative compatibility path: only a sufficiently strong
  body-language signal can override the UI fallback, while short and mixed
  technical titles never decide the voice.
- Normalizes full locale tags, case and whitespace. Unknown language now leaves
  `SpeechSynthesisUtterance.lang` as the empty browser default instead of
  silently forcing `en-US` or assigning a stringified `undefined` sentinel.
- Selects an installed voice that matches the resolved language when available.
  The cache is populated synchronously, refreshed by `voiceschanged`, never
  delays or reorders the speech queue, and leaves `utterance.voice` untouched
  while the browser reports no matching voices.
- Labels fixed Italian service notifications for questions and delivered files
  explicitly, preserves the localized preview/priming gate, and keeps all
  existing queue, focus, privacy, redaction and visual-delivery boundaries.
- Gate: **1,063 isolated Node tests** (1,062 pass / 1 platform skip),
  **300/300 frontend tests**, production PWA build and zero production
  dependency vulnerabilities in both dependency trees.

## 0.8.37 — 2026-07-25 — "Wheel History"

- Restores desktop mouse-wheel browsing of tmux history inside writable
  alternate-screen TUIs such as Codex, Claude, vim, less and htop. A normal
  wheel gesture now enters or advances tmux copy-mode instead of accumulating
  against a page-sized threshold and appearing inert.
- Keeps an explicit escape hatch for applications that own their viewport:
  `Shift` + wheel continues to send raw PageUp/PageDown input. Normal-screen
  and readonly terminals remain server-side, mode changes discard incompatible
  remainders, and action bursts stay bounded.
- Leaves the mobile touch path unchanged. Finger drag continues to browse tmux
  history with the existing touch-specific scroll override.
- Replaces the mismatched animated mobile showcase in the public README with
  one consistently scaled static terminal view and removes the obsolete GIF.
- Gate: **1,059 isolated Node tests** (1,058 pass / 1 platform skip),
  **295/295 frontend tests**, production PWA build (168 modules) and zero
  production dependency vulnerabilities in both dependency trees.

## 0.8.36 — 2026-07-24 — "Clean Relaunch"

- Makes macOS service and Fleet LaunchAgent reinstalls wait until `launchd`
  has actually removed the previous job before bootstrapping the replacement,
  preventing intermittent unload/bootstrap races during upgrades.
- Bounds the unload check to five seconds and fails closed instead of leaving a
  partially applied activation when a successfully stopped job never
  disappears.
- Keeps Settings service regeneration non-activating on every platform: the
  unit is rewritten atomically, but applying it still requires the explicit
  service restart already shown by the UI.
- Adds opt-in, browser-local spoken alerts for new live PWA notifications.
  Enabling the setting runs an honest native delivery test and speech remains
  gated on a successful test for the current page session; unsupported, silent
  or failing engines degrade without affecting the visual toast or SSE channel.
- Speaks only from the visible, focused NexusCrew window and cancels on blur,
  background, opt-out or unmount. Duplicate reconnect frames are suppressed
  for 60 seconds, the normal queue keeps at most the two newest pending alerts,
  high urgency preempts it, and a 30-second watchdog advances past a stuck
  browser utterance.
- Leaves Web Push unchanged as the best-effort hidden/closed-app path. Speech
  uses the device voice and current UI language without a server audio route;
  credential-shaped values and private home paths are redacted first. The
  preference is off by default, works under server READONLY and is synchronized
  across windows for the same browser origin.
- Documents the one-speaker boundary: focus prevents duplicate speech across
  windows on one device, while separately opted-in devices can each speak by
  design. Persisted questions are never replayed; only new live notification
  frames enter the speech manager.
- Gate: **1,059 isolated Node tests** (1,058 pass / 1 platform skip),
  **293/293 frontend tests**, production PWA build (168 modules) and zero
  production dependency vulnerabilities in both dependency trees.

## 0.8.35 — 2026-07-23 — "Contained Fleet"

- Keeps Fleet rows inside the Settings panel on phones and narrow windows.
  Long cell and node names now truncate with an ellipsis instead of widening
  the row and clipping its controls; desktop layouts and Fleet dialogs remain
  unchanged.

## 0.8.34 — 2026-07-23 — "Local Forms"

- Adds the portable `fill-forms` skill for locally inspecting, filling and
  visually validating PDF and DOCX forms. It supports named AcroForm fields,
  coordinate overlays, checkboxes, character boxes, optional user-provided
  fonts and explicitly authorised signature images.
- Ships bounded Python helpers for PDF inspection, atomic PDF output, DOCX
  placeholder replacement and signature-background cleanup. They preserve the
  blank source, refuse silent field omissions and existing-output replacement,
  install no dependency automatically and make no network request.
- Keeps canonical instructions in English while selecting the user-facing
  language from the explicit preference, current request or reliable locale.
  Document wording and field values remain unchanged unless translation is
  explicitly requested. Filling never implies authorisation to sign, send or
  submit.
- Self-heals stale tunnel pidfiles after Android reuses a PID under another
  app UID. An `EPERM` ownership probe is no longer accepted as a live
  NexusCrew supervisor: the foreign process is never signalled, the stale
  pidfile is removed and the configured OpenSSH tunnel starts normally.
- Repairs legacy Termux:Boot definitions automatically on service start and
  restart. Both the HTTP runtime and Fleet companion enter the stable user
  home before they can create tmux, then installed scripts are regenerated
  atomically without changing the configured port, token, pairing state or
  the user's boot opt-in.

## 0.8.33 — 2026-07-23 — "Cold Boot"

- Restores Fleet on a true cold boot where no tmux server or default socket
  exists yet. The expected `error connecting to … (No such file or directory)`
  response is now treated as an empty tmux inventory, allowing the boot
  companion to create the shared server and start every `boot:true` cell. The
  migration inventory command uses the POSIX `C` message locale while
  preserving UTF-8 character handling, so this classification remains
  deterministic on localized Linux, macOS and Termux hosts.
- Keeps migration fail-closed for unexpected tmux failures such as permission
  errors, malformed output, ambiguous legacy sessions and rename collisions.
  The regression reproduces the exact stderr observed after reboot and verifies
  both provider availability and safe persistence of dotted cell identities.
- Adds an optional MCP companion guide and machine-readable catalog for
  structured Memory, searchable MSA knowledge, bounded Crew delegation and
  Mail. Agents discover existing tools first, recommend a companion only for a
  requested missing capability and never install or configure it without
  consent.
- Ships generic public `memory`, `vl-msa`, `crew` and `mail-assistant` skills.
  Their canonical instructions are in English and user-facing output follows
  the user's explicit preference or request language; Mail reply drafts follow
  the thread language unless overridden. No account, identity, folder,
  credential or machine-specific path is bundled.

## 0.8.32 — 2026-07-22 — "Touch History"

- Restores continuous mobile finger-drag navigation of tmux history in every
  terminal buffer, including alternate-screen AI clients such as Codex, Claude
  and Agy. Each 24 px of vertical travel again enters/advances tmux copy-mode by
  three lines, so a normal phone swipe is no longer discarded at touch end.
- Keeps desktop-wheel ownership unchanged: writable alternate-screen programs
  still receive bounded Page Up/Page Down input, while normal and readonly
  terminals use server-side tmux scrolling. Double tap, long-press selection,
  multi-touch cancellation, KeyBar and virtual-keyboard controls are unchanged.
- Stops composer controls from refocusing the textarea after dictated or typed
  input. Send hides/blurs the virtual keyboard best-effort, while history
  selection and input-size controls remain unfocused; only a direct textarea
  tap (or the configured terminal double tap) opens it.
- Adds a realistic regression using a 120 px swipe inside a 300 px terminal;
  the test fails on 0.8.31 with zero actions and passes only when five tmux
  scroll actions are emitted.

## 0.8.31 — 2026-07-22 — "Safe Identity"

- **tmux session naming for dotted cell ids.** tmux silently normalizes `.` to `_`
  in session names, so a cell whose id contains a dot (e.g. `agy.native`) could no
  longer be targeted by its nominal `cloud-<id>` name. Dotted ids now map
  deterministically to a dot-free, collision-free session name (`cloud-v2-…`, 55
  chars); ids without a dot keep the historical `cloud-<id>` name, so the existing
  sessions are never renamed. The real `tmuxSession` for any cell is always
  available from `nc_cells` and the Fleet UI — use that rather than guessing
  `cloud-<Cell>` for dotted ids. Cell launches are now staged (inert placeholder →
  window-local `remain-on-exit` on `@N` → `respawn-pane` on `%N`) so setup and
  early-exit diagnostics use stable tmux object IDs. Any pre-existing legacy
  session is migrated in place via `rename-session -t $N`
  (preserving the session id and the operator's attach).
- **Agy as a managed primary client** on Linux and macOS (non-Termux), with auth
  delegated to Agy's own local login (no credential store read or copied),
  `standard`/`unsafe` permission policies (`unsafe` adds
  `--dangerously-skip-permissions`, consistent with the other clients),
  free-text model selection, and an optional `--prompt-interactive` prompt passed
  as the last argument. Termux and Windows keep using Agy through `shell.local`
  with a per-cell `agy` command. Added to existing installs by an idempotent,
  non-destructive, platform-aware backfill.
- **Share revocation now converges as authorization, not availability.** Turning
  Share off persists private intent, withdraws the node from its hub over the
  still-live private forward, and only then replaces the local tunnel without
  its reverse channel. Authorized operational discovery (topology, decks and
  MCP cell directories) removes the owner after the hub acknowledgement, while
  a merely unreachable node remains visible as stale/offline. Partial failures
  remain explicit and are retried with bounded, structured boot diagnostics.

- **Selective mobile-UX PR #1 (UI only).** Three client-only behaviours ported
  onto the 0.8.31 candidate, no merge of PR #1:
  - **Optional compact KeyBar.** A new `keybarLayout: "full" | "compact"`
    preference (default `full`) renders a one-row compact bar with an expand
    toggle that temporarily reveals the exact full key set without rewriting
    the stored preference; the tall Enter and `showKeybarEnter=false` (no gap)
    apply to both layouts. Editable in Settings → Input (IT/EN/ES), reset-safe
    and synced across windows; a layout change never remounts xterm or
    reconnects its WebSocket.
  - **Live-DOM composer submit during IME.** Explicit submit reads
    `textareaRef.current.value`, syncs the React draft and sends the visible
    text after newline normalization — preserving the empty no-op, the
    failed-send draft, history, STT and the focus policy.
  - **Alternate-screen scroll as PageUp/PageDown.** A pure bounded plan routes
    writable alternate-screen (vim/less/htop) vertical gestures to raw
    `ESC[5~`/`ESC[6~` PTY input with a page-sized threshold; normal-screen and
    any readonly terminal keep the server-side `scroll-up`/`scroll-down`
    actions. Integrated into both wheel and touch paths without weakening
    double-tap unlock, long-press selection, multi-touch or VirtualKeyboard.

## 0.8.30 — 2026-07-22 — "Focused Control"

- Makes every owner/node name in the top deck bar an explicit expand/collapse control. Newly seen
  nodes start collapsed, each deck shows a compact live activity dot, and browser-local choices
  synchronize across open NexusCrew windows without exposing topology or presence to other nodes.
- Adds a full-height mobile Enter key beside Page Up/Page Down and a dedicated **Settings → Input**
  panel. Key-bar and speech-to-text actions keep the software keyboard closed by default, terminal
  input requires a nearby double tap, and every behavior can be changed or reset per browser.
- Hardens the mobile gesture state machine for movement, long press, cancel, blur, VirtualKeyboard
  geometry changes, visual-viewport recovery and sequential two-finger releases. Preference changes
  do not remount xterm or reconnect the terminal WebSocket.
- Runs configured Shell commands through an interactive login invocation on known POSIX shells so
  user PATH entries such as `agy` resolve while retaining the private launch broker. Immediate
  non-zero exits now surface a bounded `SHELL_COMMAND_FAILED` cause; successful one-shot completion
  and commands that remain active are reported distinctly.
- Adds the read-only `nc_cell_diagnostics` MCP tool for one exact local Fleet cell. It returns the
  configured Shell command with bounded credential redaction and the latest closed spawn/start
  failure cause, rejects remote targets, and preserves the existing local active-caller ACL.
- Extends regression coverage for cross-window input preferences, listener cleanup, IME relocking,
  multi-touch cancellation, redaction of generic uppercase environment assignments and the complete
  DeckBar/mobile-input/Shell/MCP integration.
- Gate: **998 isolated Node tests** (997 pass / 1 platform skip), **192/192 frontend tests**,
  production PWA build and zero production dependency vulnerabilities in both dependency trees.

## 0.8.29 — 2026-07-21 — "Stable Fleet Boot"

- Keeps the optional Fleet boot companion rooted at the stable user home on Linux, macOS and
  Termux. It can no longer create the shared tmux server from a replaceable npm package directory
  and leave later cells with an orphaned working directory after an update.
- Makes smart startup inspect and migrate both the main service and the Fleet companion. Startup
  fails closed unless regeneration, service activation and an explicit runtime restart all succeed,
  so an already-active unit cannot keep the old working directory. A private durable marker retries
  interrupted or failed migrations on the next start; a missing optional companion remains a
  non-blocking doctor warning.
- Validates imported Fleet working directories before persistence and redacts the active Shell
  command together with the existing prompt and environment secret values.
- Extends source-side diagnostic redaction to macOS home-directory paths in addition to Linux
  and Android home paths.
- Gate: **987 isolated Node tests** (986 pass / 1 platform skip), **93/93 frontend component
  tests**, production PWA build and zero production dependency vulnerabilities in both dependency
  trees.

## 0.8.28 — 2026-07-21 — "Portable Workspaces"

- Makes Fleet backups portable across devices. Version 3 archives store a validated home-relative
  `cwdRel` instead of an absolute working directory; legacy v1/v2 archives remain readable, while
  foreign or missing paths fail closed and can be repaired explicitly from Settings.
- Adds **Shell** as a standard device-local Fleet engine. NexusCrew resolves the interactive shell
  at launch time, so no device-specific executable path is persisted. An optional per-cell command
  runs through the same shell as one opaque `-lc` string, disables restart supervision and returns
  the cell to the stopped state when complete.
- Keeps Shell commands bounded and private to cell definitions and portable backups. They are never
  exposed through status, topology, node inventory or diagnostics; prompt, model and unsafe policy
  controls do not apply to Shell.
- Preserves bounded Fleet launch causes as closed `code`/`phase` metadata. Preflight, launch-broker,
  tmux creation, readiness and spawn failures remain distinguishable without recording raw paths,
  arguments, environment values, prompts or credentials.
- Roots generated Linux services and Termux:Boot scripts at the stable user home, matching the
  macOS fix from 0.8.27. Smart startup repairs legacy service definitions, and `nexuscrew doctor`
  detects orphaned tmux working directories and stale or untrusted Termux server preloads without
  killing user sessions automatically.
- Gate: **980 isolated Node tests** (979 pass / 1 platform skip), **93/93 frontend component
  tests**, production PWA build and zero production dependency vulnerabilities in both dependency
  trees.

## 0.8.27 — 2026-07-21 — "Portable Control"

- Restores Fleet and shell launches on current Android/Termux builds by preserving only a
  validated, owner-safe `libtermux-exec` preload under the active Termux prefix. The related
  Node-shebang workaround now detects the Termux runtime layout even when Node reports Linux.
- Surfaces stable, sanitized `ENOENT`/`EACCES` client-spawn diagnostics without exposing command
  paths, arguments, environment values or credentials, and adds an actionable `nexuscrew doctor`
  check for the Termux execution bridge.
- Keeps macOS LaunchAgents rooted at the stable user home rather than the replaceable runtime
  directory, with a blocking doctor check for stale launchd working directories.
- Adds viewer-local aliases for routed nodes, keyed by stable instance identity and stored in a
  private local file. Aliases change display text only; remote labels, routes, owners and topology
  remain untouched and the mutation is never federated.
- Adds **Settings → Diagnostics** with bounded, structured, source-redacted records, temporary
  5/15/30/60-minute verbose windows, filtering, pause, export, clear and routed read access.
  Warning and error records remain available while verbose mode is off.
- Uses the logical Fleet cell name as the visible cell title on mobile, desktop overlays and grid
  tiles, while retaining technical route context only as non-primary metadata.
- Updates the production lock to `body-parser@1.20.6`.
- Gate: **931 isolated Node tests** (930 pass / 1 platform skip), **70/70 frontend component
  tests**, production PWA build and zero production dependency vulnerabilities in both dependency
  trees.

## 0.8.26 — 2026-07-20 — "MCP Identity"

- Makes MCP caller resolution directly diagnosable through the read-only `nc_identity` tool.
  The diagnostic works without a token or resolved session, reports only non-sensitive source
  and presence metadata, and returns stable missing/invalid identity codes with remediation.
- Keeps identity-gated tools fail-closed while improving their error contract. A missing or
  invalid tmux identity can no longer be mistaken for a transport failure, and `nc_notify`
  continues to degrade safely to an unknown sender.
- Documents the explicit `env_vars` name allowlist required by clients that clear the MCP stdio
  environment, including the matching repeatable `codex-vl mcp add --env-var NAME` form. Values
  remain outside command arguments and configuration files.
- Extends `nexuscrew doctor` with a non-failing MCP identity check: PWA-only users receive at
  most an informational warning, while MCP users can see whether `TMUX` or
  `NEXUSCREW_MCP_SESSION` is observable in the current process.
- Stabilizes the writable-provider-file security fixture across differing CI umasks without
  weakening the production permission check.
- Gate: **888 isolated Node tests** (887 pass / 1 platform skip), **39/39 frontend component
  tests**, production PWA build and zero production dependency vulnerabilities in both the root
  and frontend dependency trees.

## 0.8.25 — 2026-07-19 — "Token Plan"

- Adds Alibaba Token Plan Personal as a first-class managed provider for Claude Code,
  Codex-VL and Pi, with `qwen3.8-max-preview` as the default and one fixed local credential
  reference, `ALIBABA_CODE_API_KEY`. Credential values stay in the existing write-only
  credential layer and selected child environment; they never enter engine definitions,
  generated extensions, argv, status responses, logs or the package.
- Configures Claude Code against the plan's Anthropic-compatible base with isolated private
  state, a 983,616-token context and explicit Qwen aliases for model, Sonnet, Opus, Haiku,
  subagents and Fable. The API-key variable remains empty while the resolved value is supplied
  only through the authentication-token variable expected by the client. Selecting a non-default
  plan model keeps every alias aligned with that model and omits qwen3.8-only context and effort
  overrides.
- Configures Codex-VL through the Responses wire API with a Qwen-only plan allowlist and a
  packaged qwen3.8 catalog: 95% effective context, `xhigh` default reasoning, text and image
  input, original image detail and parallel tool calls disabled. The profile has no OpenAI or
  pay-as-you-go fallback.
- Gives Pi a private, value-free provider extension. Response-capable Qwen models use Pi's
  Responses adapter; GLM and DeepSeek use Chat Completions with `reasoning_content` preserved
  across assistant and tool replay. Standard permissions remain the only supported policy.
- Packages the portable `alibaba-token-media` skill for Claude Code, Codex, Codex-VL and Pi.
  Its dependency-free CLI provides dry-run-first Wan 2.7 image/edit and HappyHorse video
  workflows with fixed Token Plan endpoints, one concurrent submit, explicit Credit/high-cost
  consent, private file handling and safe unique downloads under the user's Downloads folder.
- Keeps the existing public Z.AI surface unchanged: `claude.zai` remains the only generic
  Claude profile, while the historical A/P names stay hidden compatibility aliases.
- Makes the mobile Fleet header count live cells and unmanaged tmux sessions across local and
  routed inventories, so an inventory-only or Hydra view can no longer report zero while cells
  are active.
- Adds a direct per-cell boot toggle to the mobile and desktop rosters. It changes only the next
  reboot preference, never the current power state, and stays synchronized with the same boot
  setting used by the existing power sheet; desktop settlements are acknowledged once so a
  sidebar remount cannot replay stale state.
- Keeps Python bytecode outside the npm package even when skill compilation runs before packing,
  with an isolated compile-before-pack regression test for the exact `files[]` behaviour.
- Gate: **878 isolated Node tests** (877 pass / 1 platform skip), **39/39 frontend component
  tests**, production PWA build, zero production dependency vulnerabilities, sanitized package
  inspection and an offline install smoke. Provider calls and Token Plan credit consumption are
  intentionally outside the release build gate.
- Known debt: the minified PWA main chunk is 806.50 kB (231.11 kB gzip), so Vite's 500 kB
  advisory remains visible and code splitting stays on the performance backlog.

## 0.8.24 — 2026-07-18 — "Safe Pairing"

- Gives every joining installation an explicit, editable local route handle that is separate
  from its display label. The default is deterministic and readable, combines the label or
  hostname with a stable node-ID suffix, stays within 32 characters and never sends bare
  `localhost` from Termux devices.
- Keeps `nodeId` as the peer identity while treating the route slug only as a unique handle.
  Older clients that omit `localName` receive the same safe server-side derivation, so two
  phones whose operating system hostname is `localhost` can join the same hub independently.
- Returns a deterministic replacement handle when a committed or pending peer already owns the
  requested name. The PWA applies that suggestion, preserves the freely editable display label
  and retries with the same unconsumed invitation; headless pairing exposes matching
  `--local-name` and `--local-label` options.
- Restores `nexuscrew init` as a public, idempotent command with validated `--port` and
  side-effect-free `--dry-run` support, so first-run recovery instructions always name a command
  that the dispatcher actually accepts.
- Gate: **861 isolated Node tests** (860 pass / 1 platform skip), **34/34 frontend component
  tests**, production PWA build and zero production dependency vulnerabilities.

## 0.8.23 — 2026-07-18 — "Fleet Ready"

- Repairs partial or migrated installations that have NexusCrew configuration and a token but no
  `fleet.json`. Runtime startup now creates the built-in Fleet defaults only when the file is
  absent, including service-manager and Termux:Boot paths; an existing invalid file remains
  fail-closed and is never overwritten.
- Makes smart startup restart an already-running runtime when it has just repaired the missing
  definitions, so provider selection is refreshed before the PWA is reused. `nexuscrew doctor`
  now reports missing, invalid, intentionally disabled and valid Fleet definitions explicitly.
- Separates Fleet editor loading, API failure and genuinely unavailable-provider states in the
  PWA. A disabled provider can expose a safe operational reason instead of the misleading
  “builtin provider only” message shown during initial loading or on partial Termux installs.
- Contains shared-tmux failure containment: generated Linux services require `KillMode=process`,
  lifecycle commands fail closed if that protection is absent, shared servers pin
  `exit-empty off` and guard `kill-server`, and cleanup tests require a unique private `-L`
  socket instead of ever targeting the operator's default server.
- Gate: **854 isolated Node tests** (853 pass / 1 platform skip), **33/33 frontend component
  tests**, production PWA build and zero production dependency vulnerabilities.
- Release scope at the time: npm `latest` only; 0.8.24 now carries the same changes into the
  public GitHub history.

## 0.8.22 — 2026-07-17 — "Sole Authority"

- Makes NexusCrew the only Fleet owner. The legacy executable adapter, discovery paths,
  `fleetBin` configuration and alternate boot ownership are removed; `NEXUSCREW_FLEET=0`
  remains the explicit kill switch.
- Supervises every built-in cell behind the private one-shot launch broker. A client that exits
  after readiness is restarted with bounded exponential backoff and a rapid-failure circuit
  breaker; explicit stop disarms relaunch even during backoff, while restart remains intentional.
- Adds a canonical hub peer inventory to Settings with separate direct hubs, inbound clients and
  routed inspect-only nodes. Direct peers expose direction-aware **Edit**, **Disconnect** and
  **Delete** actions, stale routed peers no longer appear healthy, and labels now have one
  server-backed source across Settings, desktop and mobile.
- Expands the headless CLI with stable `name|nodeId` lookup for list/show/doctor, edit/rename,
  visibility, connect/disconnect/reconnect, Share, revoke/remove, invite and stdin-only pair/join.
  Every mutation honors READONLY; pairing capabilities never need to appear in argv.
- Gate: **845 Node tests** (844 pass / 1 platform skip), **30 frontend component tests**, a
  production build and zero production dependency vulnerabilities.

## 0.8.21 — 2026-07-17 — "Reconciled Share"

- Reconciles the detached SSH supervisor with the persisted Share state even when the requested
  value is unchanged. A pre-upgrade process that still carries `-R` while the store says private
  is replaced through the existing verified, spec-aware pidfile lifecycle before the hub is
  notified.
- Keeps the Share checkbox usable while the tunnel is down and adds an explicit **Reconnect and
  reconcile** action that reapplies the current state without toggling consent. Desired Share
  state, verified reachability and a down private connection now have distinct UI messages.
- Reverse-forward diagnostics extract the negotiated listen port from OpenSSH and show the exact
  `permitlisten="127.0.0.1:<port>"` restriction to verify, while retaining neutral wording when a
  port collision and a key/server policy denial cannot yet be distinguished.
- Gate: **855 Node tests** (854 pass / 1 platform skip), **30 frontend component tests** and a
  production build with aligned package/UI version `0.8.21`.
- Release scope: published to npm `latest` and installed on the local runtime. GitHub commit,
  push, tag and release remain outside this maintenance rollout.

## 0.8.20 — 2026-07-17 — "Reliable Routes"

- OpenRouter is now a first-class provider for Claude Code and Codex-VL. Claude uses the
  Anthropic-compatible endpoint without guessed context limits; Codex-VL uses the beta,
  stateless Responses wire API, direct no-shell command authentication and a ten-minute stream
  idle timeout. Kimi K3 receives packaged one-million-token model metadata.
- Kimi Code is available as a non-default Claude provider with `k3[1m]`, its documented coding
  endpoint, model-specific context and effort settings, and an isolated Claude configuration
  that leaves native Anthropic account state unchanged.
- Built-in provider editors gain a write-only KEY section with value-free configured source and
  target-local “used by” impact. Credential values remain outside engine definitions, backups,
  federation payloads, argv, tmux state, logs and API responses.
- Shared-node reverse ports are reserved across pending and active pairings and bind-probed before
  use. Share desired state now fails safely, reconciles after restart, rejects duplicate peer
  names without burning invitations and returns actionable allocation conflicts.
- Remote inventory survives a missing tmux socket and partial peer failures. Topology probes are
  parallel and bounded, repeated reverse-forward failures stop retrying, and diagnostics no
  longer claim that the SSH server denied forwarding without supporting evidence.
- Desktop and mobile node groups support browser-local rename and reorder controls without
  changing node identity, routes, credentials, Share state, deck identity or cell ordering.
- Gate: **853 Node tests** (852 pass / 1 platform skip), **30 frontend component tests**,
  production build, zero dependency vulnerabilities and sanitized npm package inspection.

## 0.8.19 — 2026-07-17 — "Live Activity"

- Fleet status dots now distinguish all three cell states on mobile and desktop: gray when off,
  fixed green when powered but idle, and a pulsing green signal only while the attached AI client
  is actively working. Reduced-motion preferences disable the pulse without hiding the text state.
- Each cell keeps a single useful subtitle. Powered-off rows show the engine, credential profile
  and model when available; powered-on rows switch to a live localized status such as working,
  the current task label, or idle. The same contract covers expanded, compact and remote rosters.
- Working detection uses the tmux pane title's Braille progress frame as the primary cross-client
  signal. Pi receives a narrowly gated capture fallback, while activity timestamps and persistent
  transcript text cannot mark unrelated or stale cells as busy. The sessions API adds bounded,
  sanitized activity fields without breaking older peers.
- Gate: **830 Node tests** (829 pass / 1 platform skip), **25 frontend component tests**,
  production build and zero dependency vulnerabilities.

## 0.8.18 — 2026-07-15 — "Persistent Composer"

- The input composer now expands for long prompts and keeps a separate browser-local draft,
  size preference and bounded prompt history for each owner-qualified tmux cell. State survives
  route renames and reloads, synchronizes safely between tabs and can be cleared from System
  settings; it is never federated or included in Fleet backups.
- History can be selected from the composer menu or recalled with ArrowUp/ArrowDown only at safe
  textarea boundaries. Active IME composition is left untouched, failed sends preserve the draft,
  and a delayed successful send cannot erase newer typing or another cell's draft.
- Persistence is bounded by per-entry, per-cell and browser-wide limits with 30-day expiry and
  quota-aware eviction. Regression coverage includes long Unicode prompts above 32 KiB, async
  send races, owner/session identity changes, cross-tab ordering, hostile stored objects and
  mounted-state reset.
- Gate: **825 Node tests** (824 pass / 1 platform skip), **22 frontend component tests**,
  production build and zero dependency vulnerabilities.

## 0.8.17 — 2026-07-15 — "Modular Core"

- Termux can now start the first managed cell when no tmux server exists. NexusCrew reconstructs
  the canonical `PREFIX`, `TMPDIR` and `TMUX_TMPDIR=$PREFIX/var/run` values even when it starts
  outside an interactive shell, while generated NexusCrew and Fleet boot scripts create and
  export the same runtime paths explicitly. Existing custom `TMUX_TMPDIR` values remain
  authoritative; Linux and macOS behavior is unchanged.
- The Fleet runtime/launch layer, CLI lifecycle, MCP tool directory, pairing coordinator, shared
  roster model and Fleet settings components are split into focused modules without changing
  their public routes, commands, payloads or security boundaries. This keeps the current product
  behavior while making the next gateway and federation work reviewable in smaller units.
- Regression coverage includes a real private-socket cold start with no existing tmux server,
  profile-less Termux environment reconstruction, generated boot scripts and the extracted module
  boundaries. Gate: **819 Node tests** (818 pass / 1 platform skip), **12 frontend component
  tests**, production build and zero production dependency vulnerabilities.

## 0.8.16 — 2026-07-14 — "Honest Tunnel"

- One-link pairing now treats its embedded SSH endpoint as portable routing rather than a
  transferable identity. Authentication and SSH-stage failures automatically expose the local
  override, where a device can use the same Host alias that already selects its own key, agent,
  port or ProxyJump. The override is saved only in that node's local routing configuration;
  private keys never enter the link, NexusCrew configuration, logs or federation payloads.
- A supervised `ssh` process is no longer reported ready merely because it remains alive.
  After the stability window NexusCrew probes the exact loopback `-L` port and advertises
  transport readiness only when that forward accepts TCP; unreachable connects are bounded by
  OpenSSH's 15-second timeout and remain in an explicit probing state.
- Startup, stop and restart reconcile strict NexusCrew tunnel pidfiles against the authoritative
  node store. Verified supervisors left by a removed node or interrupted older runtime are
  stopped safely, while configured nodes, unrelated processes, symlinks and invalid names are
  untouched.
- Regression coverage exercises exact SSH argv, local-alias recovery in the real pairing
  component, TCP-forward readiness versus a merely live child, generation ownership, safe
  orphan reconciliation, server startup ordering and lifecycle cleanup. Gate: **788 Node
  tests** (787 pass / 1 platform skip), **12 frontend component tests**, production build and
  zero production dependency vulnerabilities.

## 0.8.15 — 2026-07-14 — "Steady Link"

- One-link pairing now waits against a real 20-second readiness deadline with bounded retries.
  Immediate loopback refusals can no longer exhaust the probe in 3.75 seconds and tear down a
  valid SSH session just as key negotiation completes on Termux, Linux, or macOS.
- Per-tunnel diagnostics are never empty by design: NexusCrew writes safe supervisor lifecycle
  markers and forces SSH error-level diagnostics even when a user Host stanza requests quiet
  logging. The 0600 log omits synthetic argv dumps, key contents, tokens and credentials;
  OpenSSH's own error text may identify the failed target.
- Local and federated deck tabs can be reordered inside their owner group with a dedicated
  Pointer Events handle on mouse, touch, or pen, plus keyboard left/right controls. The
  owner-qualified order autosaves per browser, survives polling/reload, and follows rename and
  deletion without changing deck ownership.
- Regression coverage includes delayed SSH readiness at eight seconds, bounded permanent
  failure, safe tunnel logging, owner-isolated deck ordering, pointer input, keyboard input,
  and cross-owner rejection. Gate: **785 Node tests** (784 pass / 1 platform skip), **11
  frontend component tests**, production build, and zero production dependency vulnerabilities.

## 0.8.14 — 2026-07-14 — "Private Launch"

- Managed provider credentials can now be supplied per node from the PWA when they are absent
  from that device's runtime environment or compatible user-owned provider files. The local
  store is write-only through the API, owner-only on disk, never federated or backed up, and the
  UI reports only configured/source state plus the exact active cells affected by a change.
- Secret-bearing launches use a private one-shot Unix-socket broker. The tmux command receives
  only the helper path, socket path and a short-lived random nonce; provider values never enter
  process arguments, `tmux -e`, tmux global/session environment, temporary files or logs. The
  helper validates the bounded payload and directly spawns the configured CLI without a shell.
- Credential lookup is deterministic across Linux, macOS and Termux: service environment,
  node-local store, `providers.zsh`, canonical `ai.env`/secure files, then the legacy store.
  Mixed-case environment names are accepted, unsafe files/symlinks are rejected, and unresolved
  shell expansion is never interpreted as a credential.
- Unmanaged tmux sessions can be explicitly marked technical. They stay hidden from normal
  all/pinned/active/off views, appear in a dedicated technical view, and every Local/Hydra count
  reflects only the rows currently displayed; managed cells remain protected from relabeling.
- Fleet reorder handles now use one Pointer Events implementation for mouse, touch and pen.
  Destination highlighting, pointer capture, edge auto-scroll, release-only commit and
  Escape/cancel rollback preserve the same owner-qualified order on mobile, expanded desktop
  and compact desktop while keeping native card-to-deck drag separate.
- Tests: **781 total** (780 pass / 1 platform-dependent skip) in the isolated Node harness plus
  8 passing frontend component tests; production build and dependency audit required before
  publication. Real cross-device drag and provider launches remain operator field tests.

## 0.8.13 — 2026-07-14 — "Fleet Network"

- The MCP bridge now exposes `nc_cells` and `nc_send_cell`. An active managed cell can discover
  the owner-qualified Fleet directory allowed by the current Hydra topology and submit bounded
  text to one exact active destination. Remote ingress is bound to the authenticated route,
  inactive cells are never silently queued, and `submitted` means only verified paste plus
  Enter—not model acceptance or task completion.
- Cell submission uses an exact Fleet-cell/tmux match, bracketed paste, pane revalidation and a
  separate submit. Codex and Codex-VL receive a paced burst flush before Enter to avoid long
  composer input loss; the printable envelope prevents Pi from treating a trailing newline as
  a second submit.
- The desktop and mobile Fleet rosters now persist the same owner-qualified manual order.
  Dedicated mouse/touch handles and keyboard move controls avoid accidental power actions,
  preserve pin priority and keep compact and expanded desktop views consistent.
- Selective backup schema v2 exports cells and reusable engines independently, accepts legacy
  cell-only v1 files, previews conflicts and confirms every overwrite before mutation. Archives
  contain environment-variable names only; secret values, tokens, live tmux IDs and provider
  credentials remain local.
- Provider variables can be resolved by name from the service environment or a user-owned
  `~/.config/ai-shell/providers.zsh` parsed strictly as data. The file is never sourced or
  executed, and values are never copied into NexusCrew config, services or backups.
- Share is now a property of the local device and uses one selected, existing hub connection.
  Outbound target cards no longer imply that the hub itself is being shared; inbound shared
  clients retain hub-controlled network/relay/selected visibility, and publication waits for a
  bounded authenticated readiness acknowledgement.
- Every Local or remote deck owner has its own inline `+ new` action, with no fallback to a
  different owner. Deck tile layout and Fleet roster order continue to autosave independently.
- npm update checks and generated services use a stable NexusCrew working directory, parse npm
  JSON-scalar and plain-semver output, and preserve a deterministic UTF-8 environment. Local
  PTYs inherit only reviewed cross-platform variables; loader injection remains stripped.
- Real Termux launches npm-installed Codex and Codex-VL scripts through the active Node binary
  when `/usr/bin/env` is unavailable, while native clients such as Pi stay direct. Immediate
  managed-client exits produce bounded, redacted diagnostics and zero-window tmux phantoms are
  removed from both session discovery and Fleet state.
- The packaged and canonical NexusCrew/tmux messaging skills plus shared AGENTS/CLAUDE guidance
  document the eight-tool contract and prefer authenticated cell delivery over direct tmux
  injection. Persistent offline queues, attachments and delegated capability workers remain
  explicitly deferred rather than being represented as implemented.
- Tests: **770 total** (769 pass / 1 platform-dependent skip) in the isolated Node harness plus
  5 passing frontend component tests; production build PASS. Real Mac–hub–Pixel end-to-end
  pairing and delivery remain an operator field test and are not represented as automated.

## 0.8.12 — 2026-07-13 — "Mobile Roster"

- The mobile Fleet home now uses the same per-location roster contract as the desktop sidebar.
  Local and every Hydra route can be collapsed independently and filtered by all, pinned,
  active, or off; state persists under one shared key.
- Mobile pins are route-qualified, remote cells are pinnable, and both surfaces use the same
  deterministic order: pinned, live, fresh output, recent activity, then label. Search counts
  and scans the complete multi-node roster instead of only local sessions.
- New jsdom component tests exercise real filter, collapse, persistence, pin and multi-node
  search interactions. The official Node harness also gives every test worker its own private
  tmux socket, eliminating cross-file server-exit races without touching operator sessions.
- The SSH supervisor continuously proves ownership of its pidfile generation. Losing ownership
  or failing a state write now terminates the child SSH process and supervisor instead of
  leaving an invisible retry loop.
- Explicit Share fails closed unless its local NexusCrew port is present; reverse forwarding
  can no longer substitute the hub's remote port. macOS shutdown detects zombie supervisors
  through argv-safe `ps` when `/proc` is unavailable.
- Generated Linux user units now pull in `network-online.target`. Doctor warns when user linger
  is disabled and explains that a Termux boot script still requires the Termux:Boot app to be
  installed and launched once.
- Tests: **749 total** (748 pass / 1 platform-dependent skip), production build PASS, root and
  frontend dependency audits clean. Mac–Pixel–hub end-to-end pairing was not executed in this
  release gate.

## 0.8.11 — 2026-07-13 — "Tmux Survival"

- Linux service lifecycle is now tmux-safe. Generated units use `KillMode=process`, and an
  existing installation receives a narrow atomic systemd drop-in plus `daemon-reload` before
  `nexuscrew stop` or `nexuscrew restart`. If that protection cannot be installed, lifecycle
  commands fail closed without touching the service or its tunnels.
- Managed SSH supervisors are closed before a service restart and restored only through the
  normal autostart path. The npm updater now rejects an unverified restart result instead of
  continuing to health checks or reporting a successful update.
- Token rotation verifies the tmux-safety guard before changing credentials and reports an
  incomplete operation if the runtime cannot be restarted; the direct update helper likewise
  returns failure instead of claiming that the new code is active.
- `nexuscrew doctor` treats an unsafe Linux `KillMode` as a blocking failure and explains that
  restarting the HTTP service could terminate the shared tmux server.
- The official test harness removes inherited `TMUX` identity and places every real tmux smoke
  test on a private socket below its disposable test root. Tests can no longer attach to,
  resize, or terminate an operator session.
- The mobile roster footer now keeps endpoint/version metadata and the IT/EN/ES language
  controls aligned at narrow widths, with bounded ellipsis instead of overlap.
- Tests: **739 total** (738 pass / 1 platform-dependent skip), targeted lifecycle isolation and
  full-suite before/after tmux inventory checks, production build PASS, dependency audit clean.

## 0.8.10 — 2026-07-13 — "Hydra Federation"

- Hydra pairing now creates one supervised OpenSSH connection per hub: the private `-L`
  channel is automatic, while `-R` exists only after an explicit Share toggle and a real
  authenticated readiness probe. The retired rendezvous/node-role runtime can no longer
  start a second hidden tunnel, and pairing cannot self-escalate to shared.
- Tunnel liveness no longer mistakes a surviving `autossh` wrapper for a healthy SSH child.
  `ssh` is the single runtime transport and a blocking doctor requirement; `autossh` is
  reported separately as optional and unused. PWA failures no longer recommend private or
  nonexistent CLI commands.
- The read-only MCP bridge adds owner-aware `nc_deck`: a cell can discover every local or
  authorized shared-owner deck containing its tmux session and read visually ordered members
  with stable owner IDs, Fleet cell names, exact tmux sessions, viewer-valid Hydra routes and
  self identity. The packaged NexusCrew skill documents discovery without direct state access.
- Decks are owner-qualified and resolve their tiles from the viewer's route, so identically
  named sessions on different nodes never collapse or fall back to a local session. Shared
  owner decks are read through the existing scoped Hydra channel and remain visibly unavailable
  when their owner is offline.
- The Fleet roster keeps its desktop chrome fixed and groups every local or remote location
  behind independent collapse and all/pinned/active/off controls. Pins use route-qualified
  identities and deterministic ordering; the mobile header now remains fixed while its roster
  scrolls naturally without hiding the last card under the create button.
- Fleet Settings separates location management from the whole-network overview. Managed-cell
  power opens the shared launch editor, while delete/import and engine definitions remain in
  Settings and preserve the selected Hydra route.
- A stopped managed session can restart inside its existing deck tile: only the terminal
  generation is replaced, and transient WebSocket reconnects are bounded without reviving a
  deliberately exited terminal.
- Public `status`, `stop`, and `restart` now reconcile service-managed and portable runtimes,
  clean stale PID ownership safely, stop NexusCrew-managed SSH supervisors, and refuse a silent
  HTTP-port move when paired peers depend on the configured endpoint.
- Tests: **726 total** (725 pass / 1 platform-dependent skip), frontend production build PASS,
  dependency audit clean, isolated HOME clean, and package/public-tree verification required
  before publication. Real Mac–Pixel–hub interoperability remains an external follow-up and is
  not represented as an automated test.

## 0.8.9 — 2026-07-12 — "Hydra Workspaces"

- Remote Fleet tiles now attach to their real `tmuxSession`, including an idempotent migration
  for persisted 0.8.8 deck references. Automatic grid growth preserves visual row order,
  widths, tile heights and zoom; deck switches and renames flush dirty state before moving.
- Named decks switch inside the current PWA by default; only `↗` detaches a browser window.
  Fleet dialogs are viewport-owned with Escape, focus trapping/restoration and visible errors,
  while long sidebar names stay within their cards without covering actions.
- Pairing link creation reuses the configured rendezvous without confusing its published
  NexusCrew HTTP port with the SSH transport port. Peers exchange roles, so intermittent
  inbound clients become neutral `passive` entries while real node/auth failures remain errors.
- Clipboard images and OS-dropped files upload directly to the receiving terminal session,
  including federated routes, with progress and per-file errors. Saved paths are pasted without
  Enter; normal text paste and private session-card drag/drop are unchanged.
- Settings → Fleet adds selective, schema-closed cell/system-prompt backup and restore with
  engine mapping, overwrite confirmation, atomic writes, secret exclusion and explicit
  `needsRestart` reporting for active cells.
- Global npm installs gain stable-only automatic updates with no downgrade, a per-home
  interprocess lock, exact CLI/runtime verification, same-port restart, one exact-version
  rollback and blocked retry after an unhealthy update. Errors and logs are bounded/redacted.
- Tests: **693 total** (692 pass / 1 platform-dependent skip), with production build and
  package/audit verification performed before local installation.

## 0.8.8 — 2026-07-12 — "Reliable Composer"

- The PWA composer now sends long and multiline drafts through xterm's explicit paste path,
  preserving the terminal application's bracketed-paste mode. Enter travels as a separate
  input only after the complete paste was accepted, so agent TUIs no longer absorb submission
  into a non-bracketed paste burst.
- WebSocket input delivery is observable instead of silently dropping writes while reconnecting.
  If the terminal is not ready or disconnects during paste, the composer keeps the full draft
  and shows a localized retry message; successful sends continue to keep the mobile keyboard
  focused.
- The README mobile Fleet image is now one metadata-free animated GIF built from the two current
  phone captures, with a compact cursor-only second frame to avoid full-screen flicker.
- Tests: **664 total** (663 pass / 1 platform-dependent skip), production dependency audit
  clean, plus a real xterm smoke proving an exact 3,000-character bracketed payload.

## 0.8.7 — 2026-07-12 — "One-Link Pairing"

- Settings → Nodes and the first-run wizard now share one prominent **Connect with one link**
  card. Deliberate paste, the clipboard button, QR scan and deep links use the same controller;
  a complete v2 link connects automatically, while old or incomplete links reveal only the
  routing details still required.
- The QR flow now opens a live rear-camera scanner with distinct permission, no-camera and
  unsupported-browser errors plus a photo fallback. Its scan region covers the QR instead of
  cropping a code that fills the phone preview, and every success, cancel or unmount releases
  the camera immediately.
- Pairing reports structured validation, SSH start/readiness, invite exchange, final tunnel,
  confirmation and health stages. Transport and protocol requests are bounded, ambiguous
  one-time joins are never replayed, provisional state is rolled back, and success requires
  authenticated federation health plus an identity match with the original link.
- Retry controls now follow the server's actual retryability, manual Enter applies embedded v2
  fields before submission, and the wizard cannot be dismissed while a pairing request is in
  flight.
- Tests: **660 total** (659 pass / 1 platform-dependent skip), production dependency audit
  clean, plus a real Chrome camera smoke that reads a generated pairing QR, enters the shared
  card and verifies MediaStream cleanup.

## 0.8.6 — 2026-07-12 — "Connected Fleet"

- Cell power now opens one shared launch editor from Home, the sidebar and Settings. When a
  cell is off, engine, model, permission policy and boot can be reviewed before every start;
  choices are remembered per cell and per engine. Provider and credential definitions remain
  in Settings → Fleet, while Pi is always constrained to Standard permissions.
- Settings → Fleet now inventories managed and unmanaged tmux sessions across Local and every
  reachable Hydra route. A live unmanaged session can be explicitly adopted as a managed cell;
  legacy `cloud-X` sessions become cell `X`, and the operator must choose an already declared
  engine so no provider or model is inferred.
- Pairing links now support a strict v2 payload containing the display label, route slug,
  OpenSSH target or Host alias, and optional SSH port. Paste, QR scan and first-run deep links
  pre-fill the same form before **Test and connect**; v1 links remain compatible. No SSH key,
  API key or PWA token is added to the link.
- Fleet inventory actions now follow the selected Hydra route and its real capabilities,
  including READONLY. Power, restart, import and removal are shown only where the remote
  provider actually permits them.
- External Fleet discovery is portable across Linux, macOS and Termux: configured paths,
  `$PREFIX/bin/fleet` and `~/.local/bin/fleet` use the same runtime and boot-owner resolver.
  Explicit external pins fail closed instead of falling through to another executable.
- Claude-compatible managed launches set matching context and auto-compaction windows,
  including one-million-token profiles where declared. Permission overrides cannot bypass
  Pi's Standard-only policy.
- Tests: **636 total** (635 pass / 1 platform-dependent skip), plus a clean production build
  and zero production dependency vulnerabilities.

## 0.8.5 — 2026-07-12 — "Clean Fleet"

- The primary `+` now creates a managed Fleet cell on Local or a selected reachable Hydra
  node. Cell IDs accept uppercase characters, and every configured node remains visible in
  the Fleet inventory while unreachable destinations are clearly disabled for creation.
- Managed cell cards expose direct power and Settings buttons. Start, stop, restart and edit
  are explicit in Settings → Fleet; deletion is confined to that settings surface, removing
  the ambiguous three-dot/delete-only lifecycle.
- The power sheet is lifecycle-only and responsive: it no longer mixes engine/provider/model
  selection into start/stop, and boot changes are persisted without resetting an existing
  boot choice on quick start.
- Fresh fleets provide four clean CLI adapters: Claude Code, Codex, Codex-VL and Pi. Provider
  choices are scoped to the selected CLI, with documented native/cloud/local options and a
  renameable custom fallback. Legacy Z.AI A/P credential profiles remain runtime-compatible
  but are absent from the new-provider catalog.
- Claude enterprise providers launch through their dedicated Bedrock, Vertex or Foundry
  environment selectors; Codex OpenAI API uses `OPENAI_API_KEY`; Pi can use its own configured
  default without NexusCrew forcing a provider or model.
- Node pairing now focuses and explains missing fields and makes explicit that the loopback
  address in a pairing link is intentional and transported through the user's SSH Host.
- Tests: **602 total** (601 pass / 1 platform-dependent skip), plus a clean production build
  and zero production dependency vulnerabilities.

## 0.8.4 — 2026-07-12 — "Hydra Everywhere"

- The fleet roster is global rather than active-only: local, direct and transitive sessions
  remain visible with route/location labels, stable slugs and offline last-seen state.
- Session creation and Fleet engine/cell management can target Local or any reachable Hydra
  route. Remote lifecycle controls use route-qualified identity and inbound peer health is
  verified instead of trusting a running tunnel process alone.
- Node cards restore explicit tunnel power controls and expose label rename independently of
  the stable route slug; pairing and capabilities remain relay-policy scoped.
- macOS terminal copying now supports Shift-drag / Shift-Control-drag local selection and
  mobile terminals support long-press then drag selection without sending mouse events to tmux.
- The composer send button writes text plus a real carriage return and preserves textarea
  focus, keeping the mobile software keyboard open between messages.
- Linux x64/ARM64, macOS x64/ARM64 and Termux Android ARM64 now resolve scriptless platform
  PTY prebuilds only. Global installs no longer require native install-script approval.

## 0.8.3 — 2026-07-12 — "Simple and Clean"

- `nexuscrew` starts or reuses the loopback server in the background, prints a compact
  status/guide, and exits. Only the first run opens the PWA wizard. `nexuscrew show` opens
  the PWA, while `nexuscrew show token` prints the clickable authenticated fragment URL.
- Startup persistence is explicit: `nexuscrew boot` installs/enables the native user service
  on Linux/macOS or the Termux:Boot script; `boot off|status` controls and reports it. A normal
  first run no longer silently opts the host into boot persistence.
- The Hydra roster retains transitive peers as offline entries with last-seen information
  while a relay is unavailable, then reconciles them when the relay returns or is removed.
- Node tunnel power is restored as a direct action in both mobile and desktop lists. Session
  menus remain session-only, avoiding ambiguity between killing a session and controlling its link.
- Settings → Fleet now selects Local or any reachable Hydra route for engine and cell
  management. Federated Fleet requests use the scoped, hop-bounded allowlist and honor READONLY.
- Managed engines expose an explicit permission policy. New Claude engines, including Z.AI,
  default to `--dangerously-skip-permissions` with a Standard opt-out; Codex and Codex-VL
  default to Standard with an opt-in for `--dangerously-bypass-approvals-and-sandbox`.
- The Nodes UI describes pairing as connecting an existing NexusCrew installation: every
  installation remains local and peer-capable, with no artificial client/server role.
- Tests: **538 total** (537 pass / 1 platform-dependent skip), including first-run PWA,
  multi-hop Fleet routing, stale roster reconciliation, boot opt-in and contaminated env runs.

## 0.8.2 — 2026-07-11 — "Simple Federated Hydra"

- Replaces client/node roles in first-run UX with one local node plus a single **Nodes**
  surface for reciprocal PWA pairing.
- One-time ten-minute link/QR pairing creates scoped per-peer credentials; the main PWA
  token is never exchanged. Invites and peer state remain local 0600 stores.
- Uses an existing OpenSSH Host alias without creating keys or editing `authorized_keys`;
  auto-selects autossh or supervised SSH and restores outbound links at boot.
- Adds bounded four-hop topology discovery and a separate capability-allowlisted federation
  ingress for HTTP and WebSocket routing. Relay visibility is enforced symmetrically.
- Session list, creation, terminal, files and termination are location-aware across Local and
  federated routes. Fleet remains local to its node.
- Reads legacy nodes schema v1 while writing the extended v2 peer schema; legacy rendezvous
  runtime behavior remains available during migration.
- Tests: **528 total** (527 pass / 1 platform-dependent skip).

## 0.8.0 — 2026-07-11 — "Many Nodes, Many Monitors"

The multi-node + multi-monitor release: one UI for the tmux fleets of several hosts,
named multi-window decks, a real CLI, an MCP operator bridge, and a first-run wizard.

- feat(mcp): **MCP bridge** — `nexuscrew mcp` runs a minimal stdio MCP server (hand-rolled
  JSON-RPC 2.0, newline-delimited, no SDK deps) that brings NexusCrew inside AI sessions as
  the cell→human channel: `nc_notify` (UI toast + web push), `nc_ask` (question with deferred
  answer pasted back into the caller's tmux session as `[human reply · ask#<id>] …`
  by default (`NEXUSCREW_REPLY_LABEL` configures the neutral operator label),
  `nc_send_file` (copy into the session outbox with badge + notification), `nc_status` and
  `nc_inbox` (read-only). Caller identity from `$TMUX` (`display-message #S`) with
  `NEXUSCREW_MCP_SESSION` fallback; fail-closed on malformed input (garbage never crashes,
  JSON-RPC errors instead).
- feat(server): notification plumbing — `POST /api/notify` (rate limit global per token +
  per session, capped LRU buckets), SSE `GET /api/events` for live UI frames, web push
  (`web-push` dep, lazy VAPID keys in `~/.nexuscrew/vapid.json` 0600, https-only endpoints
  with private-host rejection and a subscription cap, subscriptions in `push.json` 0600
  with dead-endpoint cleanup), asks store persisted in `asks.json` 0600 (hard cap on open
  asks, rate-limited creation). Answer route is READONLY-gated (paste is a PTY write),
  claims the ask atomically (concurrent answers cannot double-paste) and only commits
  after a successful paste. READONLY is a floor: ask creation and outbox delivery are 403,
  VAPID keys are never generated in READONLY, and secret stores (`vapid/push/asks.json`)
  with unsafe mode/owner or symlinked are refused fail-closed.
- feat(ui): notification toasts + open-asks panel with reply box/option buttons and counter
  badge (all views, i18n it/en/es); push enable/disable in Settings → System; service worker
  handles `push` and `notificationclick` (deep-link `/#ask=<id>`).

- feat(cli): **unified CLI** — `nexuscrew` alone smart-ups (zero-question init → start →
  URL + QR); new subcommands `up|down`, `url [--qr]`, `token rotate`, `logs [-f]`,
  `doctor`, `update`, and an extended `status [--json]` with roles and per-node tunnel
  state. The server startup log no longer prints the token.
- feat(nodes): **multi-node foundation** — `~/.nexuscrew/nodes.json` secret store (0600,
  atomic writes, strict schema) and an SSH tunnel manager with dedicated restricted keys,
  explicit loopback binds, `ExitOnForwardFailure`, and retry with backoff. CLI commands
  cover node registration, tests, tunnel lifecycle, token setup, and reachable-node mode.
- feat(proxy): **single-origin multi-node** — the hub reverse-proxies `/node/<name>/…`
  over HTTP and WebSocket. Local auth happens before node resolution; remote tokens stay
  server-side; client credentials and hop-by-hop headers are stripped; READONLY blocks
  mutations and remote PTY attach.
- feat(deck): **multi-window decks** — named workspaces at `/deck/<name>`, with one
  remembered tile layout per browser and deck. Deck tiles attach with `ignore-size`; the
  focused tile becomes size owner so browser windows do not fight real terminals.
- feat(ui): **remote nodes, settings, and first-run wizard** — per-node groups and remote
  attach in the sidebar, grid, and decks; a three-tab settings panel for roles, nodes, and
  system actions; and a skippable three-step setup wizard. Mutations use a closed-list,
  READONLY-gated API with strict validation and token-redacted responses.
- security: proxy upgrade failures return a controlled 502; WebSocket upgrades
  pre-authenticate through the injected header; local query tokens are stripped before
  forwarding; token rotation invalidates live sessions after restart.
- i18n: all new surfaces in English, Italian, and Spanish.
- tests: suite grows from 262 to **495 tests** (494 pass / 1 skip).

## 0.7.7

- feat(composer): **attachment button** to the left of the input — a File / Camera / Gallery
  menu for quick file send. The picked file lands in the session inbox and its path is
  appended to the composer text (you send it explicitly, so you can add a message). The
  camera uses the native capture hint on mobile and falls back to a picker on desktop.
- feat(fleet): **built-in fleet** — engine/cell definitions in `~/.nexuscrew/fleet.json`
  (editable, schema-validated), provider selection `external | builtin | disabled` chosen
  once at startup, and a single boot companion service installed by `nexuscrew init` (only
  when the built-in provider is active, with a migration gate that refuses a silent double
  boot). Launch path is argv-direct (no shell), with a hard command/env/cwd trust boundary.
- feat(fleet): fleet HTTP API hardening — `READONLY` blocks every mutation at the route
  level (external providers included), capability negotiation returns `501` for unsupported
  methods, `status` exposes `provider`/`bootOwner`/`capabilities`, a `restart` capability,
  and secrets (env values, prompts) are redacted from error output.

## 0.7.2

- fix(grid): fleet cell cards in the desktop sidebar are now clickable (add tile) and
  draggable into the grid when their tmux session is alive — they only exposed the
  power button before, so on fleet-only hosts nothing could be dragged. Verified
  end-to-end in a real browser (click → live tile, drag → new column).

## 0.7.6

- docs: README "License" section said MIT — corrected to Apache-2.0 (badge and LICENSE
  file were already correct since 0.7.1). No code changes.

## 0.7.5

- feat(grid): **open tiles are movable** — drag a tile by its header and drop it anywhere
  (same directional zones as sidebar drags: side-by-side, stack, new column).

## 0.7.4

- fix(desktop): **black screen** on desktop in 0.7.3 — the stale-bundle banner was declared
  inside the mobile branch but referenced by the desktop tree (TDZ ReferenceError).
  Hoisted before both branches; the banner now also covers the mobile single view.
- fix(keybar): 8+8 keys — ↑ aligned exactly above ↓ (added ⌨ composer toggle in row 2,
  matching the reference layout).

## 0.7.3 — "Window Management"

- feat(grid): directional drop zones (VS Code-style) — hover quadrant decides: left/right
  edges place side-by-side, top/bottom stack, with live preview overlay. Balanced click
  placement (grid-like growth, no endless narrow columns).
- feat(size): sessions follow the focus — `window-size latest`, web clients participate:
  going back to a bigger client and typing restores its size (real-tmux gated).
- feat(ui): collapsible + resizable sidebar (mini 48px with instant tooltips), pin sessions
  and cells to top (persisted) + activity-based auto-sort, Termux-style two-row KeyBar
  (ESC ☰ / — HOME ↑ END PGUP | ⇥ CTRL ALT ← ↓ → PGDN) with sticky ALT.
- fix(grid): xterm refits when its tile is resized (ResizeObserver) — adding tiles or
  dragging dividers adapts live terminals; resize listeners cleaned on cancel/blur/unmount;
  aborted drags clear the preview; tile cap enforced fail-safe.
- fix(mobile): high-visibility round action buttons (power/pin), SVG power icon
  (U+23FB was tofu on Android), stale-bundle update banner (tap to reload).
- Two security review passes on the cycle (all findings addressed); 155-test suite.

## 0.7.1

- License corrected to **Apache-2.0** (0.7.0 was published with MIT metadata by mistake;
  0.7.0 is deprecated on npm). Added NOTICE. No code changes.

## 0.7.0 — "Fleet Deck"

- feat(grid): desktop multi-session grid — drag from the sidebar,
  tiling a colonne con auto-reflow, divisori trascinabili, focus singolo, composer
  per-tile a scomparsa, layout persistito (`nc_grid_v1`). Tile con `takeSize:false`
  (mai resize delle sessioni vive). Zero dipendenze nuove.
- feat(fleet): logica flotta nella UI — sidebar/home unificate: celle fleet anche da
  spente (⏻ up/down, engine picker, key A/P, boot persist, stato degraded) + sessioni
  tmux generiche. Server: `lib/fleet/` shell serializzato sul binario `fleet`
  (feature-detected con trust check: no symlink, no world-writable, schema
  `kind:"ai-fleet"` obbligatorio) + `GET/POST /api/fleet/*` dietro Bearer.
- feat(sessions): lifecycle dalla UI — `POST /api/sessions` (preset allowlistati,
  cwd realpath sotto home) e `DELETE /api/sessions/:name` (409 SEMPRE su `cloud-*`,
  anche con fleet assente). Card ricche: activity, comando corrente, preview ultima
  riga (cap 240, strip ANSI, cache 3s, best-effort).
- feat(ui): mobile restyle — home grouped by Fleet/Other sessions,
  card con preview e tempo relativo, FAB nuova sessione, vista singola rifinita.
- feat(i18n): UI multilingua IT/EN/ES, picker persistito, zero deps.
- Optional fleet integration contract: `fleet status --json` (schemaVersion 1); the host
  binary is trust-checked and schema-validated, feature-detected (absent → hidden UI).
- Suite: 150 tests (149 pass + 1 skip); two independent security review passes on design
  and implementation (all findings addressed).

## 0.4.3

- fix(mobile): adapt the layout to the soft keyboard. The app now uses `100dvh` and
  `interactive-widget=resizes-content`, so when the keyboard opens the view shrinks and the
  KeyBar stays visible above it (previously the bottom KeyBar was pushed behind the keyboard
  and looked missing). The terminal also refits on `visualViewport` changes.

## 0.4.2

- fix(attach): smart resize default. When no other client is attached to the session, the
  browser now drives the size (so a small phone gets a usable, non-clipped view and clean line
  editing instead of a session frozen at a larger width). When a real terminal is already
  attached, it still defaults to `ignore-size` to avoid shrinking that terminal's window.
- feat(keybar): add the keys mobile keyboards lack — `tab`, always-available arrows (← ↑ ↓ →),
  and a sticky `ctrl` modifier that folds the next typed character into its control code.

## 0.4.1

- fix(install): make `node-pty` an optional dependency. On Termux/Android it has no prebuild
  and `node-gyp rebuild` fails (`Undefined variable android_ndk_path`), which previously aborted
  the whole global install and left the `nexuscrew` bin unlinked. As optional, its build failure
  is non-fatal: the install completes and the runtime falls back to the platform PTY provider
  (`@mmmbuto/node-pty-android-arm64` on Termux, `@lydell/node-pty-linux-x64` on Linux x64).

## 0.4.0 — "pty-core"

Core rewrite from screenshot-and-poll to a faithful tmux client.

- replaced screenshotting with a **real PTY**: each attach runs `tmux attach` and bridges its
  bytes to xterm.js over a WebSocket — full color, copy-mode scroll, special keys, panes, windows
- **stateless**: tmux is the persistence; no database, no accounts
- **localhost-only**: binds `127.0.0.1` and refuses any non-loopback bind
- non-destructive default: attaches with `-f ignore-size` so a small client never resizes a
  session a real terminal is holding (`takeSize` to opt in)
- window/pane navigation moved to **server-side, allowlisted tmux commands** instead of fragile
  client-side prefix keys
- WebSocket hardening: close on protocol violation, no second attach, clamped geometry,
  backpressure cutoff, JSON errors with codes
- token delivered via URL fragment (never logged), 0600 file, constant-time compare

## 0.2.4

- added host-scoped tmux/session discovery so active session truth comes from the selected host
- bucketed launcher discovery into runnable, detected-only, and internal/plumbing entries
- improved send/interrupt flow with explicit host context and remote pane polling fallback
- added regression tests for host-scoped routes and launcher classification

## 0.2.3

- fixed npm CLI `bin` metadata so the published package exposes `nexuscrew` correctly
- kept the corrected stable line on the main npm dist-tags

## 0.2.2

- moved runtime to standalone tmux sessions instead of an implicit master tmux session
- made active tmux sessions the only valid chat targets
- added explicit tmux creation from detected launchers
- switched launcher discovery to runtime/shell-driven detection
- gated shell-file-only detections so they are not treated as runnable automatically
- aligned workspace defaults to the runtime user home

## 0.2.1

- older release line, now deprecated in favor of the current stable line
