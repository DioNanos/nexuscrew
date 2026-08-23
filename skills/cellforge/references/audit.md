# Auditing a cell

An audit answers one question: **does this cell exist completely, and does it
match the standard?** Each check below says what to observe, because a check
whose result you cannot describe in advance is not a check.

Report everything, fix nothing until the user agrees. See the rule at the end —
it is the one that decides whether audits keep getting run.

## The checks

**1 · The definition loads and is the one you think.**
Observe the runtime listing, not the definitions file. Expect: the cell present,
with the engine, model and working directory you expect. A cell absent from the
listing but present in the file means the document failed validation — the whole
document, not just that entry.

**2 · The working directory is portable.**
Expect a relative form alongside the absolute one. Older cells often have only
the absolute path: not broken, but it will not survive being restored on another
machine. Offer to normalise.

**3 · The workspace exists and its links resolve.**
Expect the cell's directory under the files root, and the document links
resolving to real files. Two failure shapes: a **dangling link** (looks present
to anything that does not follow it) and a **real file where a link belongs**
(will be edited, will diverge, and both copies will look authoritative).

**4 · The internal prompt is this cell's.**
Read it. Expect it to name this cell's purpose and point at its documents.
A prompt copied from another cell passes every automated check and fails the
only one that matters. Also confirm it is a *pointer*, not a duplicate of the
canonical document — duplicates diverge.

**5 · No secrets in the prompt.**
Expect zero credentials, tokens or keys. This is not stylistic: with flag-style
delivery the prompt becomes a command-line argument, readable by other processes
of the same user. Report any find as a live exposure, not a style issue, and
treat rotation as the user's decision to make with full information.

**6 · The tool grant matches the purpose.**
Expect either an explicit server list, or a deliberate decision that this cell
gets everything. An empty list is the widest possible grant, and it is usually
absence of a decision rather than a decision. Report it as a question, not a
defect.

**7 · The checkpoint is within limits and correctly shaped.**
Expect it inside the line and byte limits (`lifecycle.md` gives concrete
starting numbers), with the sections in the order the install uses — the
template in `assets/checkpoint.template.md` is the reference shape — and a link
to the archived history. Over the limit is not a
style problem: the checkpoint is read at the start of every session.

**8 · The checkpoint's state is honest.**
Expect `open` to mean someone must resume it, and `closed` to mean verified
completion. The failure to look for is a checkpoint closed after a crash or a
restart — those interrupt work, they do not finish it.

**9 · The memory namespace exists and is split.**
Expect a state namespace and a journal namespace, scoped to this cell. Do not
check this by looking for a creation step — on many memory servers a namespace
simply exists once something is written to it. **Check the round trip**: the
cell writes its state, and reads it back.

Two failures worth naming: memory that never round-trips (the cell starts empty
every session, which reads as a model problem and can go unnoticed for weeks),
and **dated keys accumulating in state** (startup gets slower every week, and
nobody attributes it to this).

**10 · One checkpoint per cell per device.**
If the identity runs on more than one machine, expect one file per device.
A shared file means each device overwrites the others silently.

## Prove the audit can fail

Run the checks against a deliberately broken throwaway cell — remove a link,
close a checkpoint that should be open — and confirm the relevant check goes
red. A check that has passed on every cell you ever pointed it at may be
detecting nothing, and you will believe it precisely because it always agrees
with you.

This costs a few minutes once and is the difference between an audit and a
ritual.

## Report before you repair

Present findings and proposed fixes, and apply only what the user approves.

The reason is practical, not procedural: an audit that silently changes things
becomes a thing users are afraid to run. You want them running it often, which
means it must be safe — and "safe" means it never surprises them.

When you do apply fixes, apply them one at a time and re-run the specific check
after each. A batch that fails partway leaves nobody sure which half landed.
