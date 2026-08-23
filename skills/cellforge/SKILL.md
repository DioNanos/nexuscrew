---
name: cellforge
description: Use when creating, changing, auditing or retiring a NexusCrew cell — an AI working identity with its own engine, prompt, workspace, memory and lifecycle documents. Covers first-run setup on a fresh install ("set up a cell for marketing", "add a research assistant", "I need a cell that does X"), changing an existing cell (engine, model, internal prompt, permissions, working directory), and auditing cells against the standard. Use it even when the request sounds like a small edit — a cell lives in three places at once, and changing one of them alone is the most common way to end up with a cell that half-exists.
---

# CellForge — build a cell that actually exists

A **cell** is a stable working identity: a name, an engine, a working directory,
an internal prompt, a memory namespace and a set of documents that survive
restarts. It is not a process and not a chat window.

The single most useful thing to know before touching anything:

> **A cell lives in three places at once, and a cell that exists in only two of
> them is broken in a way nothing reports.**

| where | what lives there | who writes it |
|---|---|---|
| **Definition** | the runtime record: id, engine, model, working directory, internal prompt, permissions | the NexusCrew API — never the file by hand |
| **Runtime workspace** | `~/NexusFiles/<session>/` — inbox, outbox, links to the cell's documents | the service, plus the cell itself |
| **Canonical documents** | the cell's prompt, checkpoint and history | the cell, following its own protocol |

Where the canonical documents live is an **install convention, not a product
rule** — ask, do not assume a repository exists.

Create only the definition and the cell boots into an empty identity with no
memory of what it is for. Create only the documents and nothing runs. Both
failures look like "it sort of works" for a while.

## Before you build: ask, don't assume

A cell is cheap to create and expensive to live with, because a vague one
produces vague work forever. Four questions decide everything else, and you
should ask them in the user's own terms rather than presenting a form:

1. **What is this cell for?** One sentence a stranger could act on. "Marketing"
   is a department, not a purpose; "drafts and reviews campaign copy, owns the
   content calendar" is a purpose.
2. **What does it own, and what is off-limits?** Ownership is what makes a cell
   different from a chat: a directory, a repository, a domain of documents. The
   off-limits half matters as much — it is what keeps two cells from fighting.
3. **What must it never do without asking?** Publishing, sending, deleting,
   deploying, spending. Write these down now; they become the part of the prompt
   that protects the user later.
4. **Does it work alone, or with a reviewer?** A cell that implements and audits
   its own work will approve it. If the work needs a verdict, plan a second cell
   whose independence is structural, not a promise.

If the user cannot answer (1) crisply, that is the finding — help them sharpen it
before creating anything. A cell created around a fuzzy purpose is the most
expensive thing in this skill.

Then propose the engine, the tools and the MCP servers **as a recommendation
with reasons**, and let the user correct you. See `references/choosing.md` for
how to match a purpose to an engine and a toolset without over-fitting to the
roles that already exist on the install.

## Building it

Work in this order. Each step is verifiable, and the order exists so that a
failure leaves a cell that plainly does not exist, rather than one that
half-does.

**0. Look before you build.** One call to the fleet status gives you the
existing cells (so you do not collide), the engine ids you need to fill the
definition, and the capabilities you actually have. `references/operations.md`
has this and every other "how do I observe it" answer — read it first if you
are about to touch a real install.

1. **Write the documents first.** Ask where they should live if the install has
   no convention yet, and prefer somewhere version-controlled: the checkpoint's
   value comes from its history. The prompt and the checkpoint are the cell's
   identity; the definition just launches it. Templates in `assets/`. Adapt
   them — a template pasted unchanged is how you get twelve cells that all
   describe themselves the same way.
2. **Choose the id carefully — it is immutable**, and it will appear in the
   workspace path, in the memory namespaces and in every reference from another
   cell. Name the function, not the moment: `Marketing` outlives
   `Marketing-Q4-launch`.
3. **Create the definition through the API**, never by editing the definitions
   file. The API validates, enforces caps, and refuses states the file format
   would happily hold. `references/definition.md` has the schema, the fields
   that are immutable after creation, and the exact endpoints.
4. **Sort out its memory** — state and journal are two different mechanisms,
   not two files (`references/lifecycle.md`). How a namespace comes into being
   depends on the memory server, so confirm the cell can write and read back
   rather than assuming a creation step exists.
5. **Boot it, then verify it is the cell you meant**: right engine, right
   working directory, **prompt actually delivered**. That last one cannot be
   read off the definition — the field is present either way — so check it the
   way `operations.md` describes for the engine's delivery mode.

## Changing a cell that already exists

Two fields are **immutable after creation**: the cell's `id` and its tmux
session. Everything else is patchable, but the interesting failures are not
about what is allowed — they are about what changes underneath:

- **Changing the engine can silently change the prompt delivery.** Engines
  differ in how the internal prompt reaches the cell (command-line flag versus
  typed into the session). A prompt that worked may simply stop arriving.
  Verify delivery after an engine change; do not assume it carried over.
- **Changing the working directory changes which instructions the cell loads**,
  because per-directory instruction files are picked up by location. A cell can
  keep its name and quietly become a different worker.
- **Editing the internal prompt does not touch the documents**, and editing the
  documents does not touch the internal prompt. They are separate stores. When
  a cell's purpose changes, both change — otherwise the cell is told one thing
  at boot and another by its own canon.

Apply changes one at a time and confirm each. A batch patch that fails partway
leaves you guessing which half landed.

## Auditing

Audit answers one question: **does this cell exist completely, and does it match
the standard?** Run through `references/audit.md`, which is written as checks
with an expected observation rather than a list of virtues.

Two rules make an audit worth running:

- **Report before you repair.** Show the findings and the proposed fixes, and
  apply them only when the user says so. An audit that silently fixes things
  teaches the user that the audit is the thing that changes their system, and
  they stop running it.
- **A check you have never seen fail proves nothing.** If a check passes on
  every cell you point it at, break one deliberately — on a throwaway cell —
  and confirm the check goes red. Checks that cannot fail are decoration, and
  they are worse than no check because they are believed.

## Rules that protect the user

- **Never put a secret in the internal prompt.** With flag-style delivery the
  prompt becomes a command-line argument, and command lines are readable by
  other processes belonging to the same user. Reference credentials by the name
  of the mechanism that holds them; never by value.
- **Confirm before anything outward-facing or hard to undo** — removing a cell,
  stopping one that is mid-task, overwriting a checkpoint. Creating is cheap;
  removing throws away the identity and the history attached to it.
- **A cell's checkpoint belongs to that cell.** Do not write another cell's
  checkpoint even to be helpful: the owner will overwrite it, and both of you
  will believe a state that no longer holds.
- **Prefer portable forms.** Where a definition can express a path relative to
  the user's home directory, use it: absolute paths bind the cell to one machine
  and quietly break when the definition is restored on another.
- **The running system wins over any document, including this one.** Check the
  live listing and the tool surface actually exposed before acting on what you
  remember.

## Reference material

Read the file that matches what you are doing; they are written to be read one
at a time.

- `references/operations.md` — **how to look and how to act**: the read calls,
  what capabilities mean and why they are discovered rather than granted, how to
  verify prompt delivery, and which parts depend on the install rather than the
  product. Read this one before touching a real system.
- `references/anatomy.md` — the three places, what is a real file and what is a
  link, and how to tell a complete cell from a half one.
- `references/definition.md` — the definition schema, validation limits,
  immutable fields, and the endpoints that write it.
- `references/lifecycle.md` — prompt, checkpoint, history and memory: who
  writes what, when, and the difference between durable state and a bounded
  journal.
- `references/choosing.md` — matching purpose to engine, tools and MCP servers,
  including how to handle a role the install has never seen before.
- `references/audit.md` — the checks, each with what you should observe.
- `assets/` — starting templates for the internal prompt and the checkpoint.
