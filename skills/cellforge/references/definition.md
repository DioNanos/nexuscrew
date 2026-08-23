# The cell definition

The definition is the runtime record of a cell: what it runs, where, with which
prompt and permissions. It is stored in the fleet definitions file, but **you
never edit that file** — you go through the API, which validates the whole
document and refuses to write a state the file format would happily hold.

## Write path

| operation | endpoint | capability required |
|---|---|---|
| create a cell | `POST /define-cell` | `define` |
| change a cell | `POST /edit-cell` | `edit` |
| delete a cell | `POST /remove-cell` | `remove` |
| bulk restore | `POST /restore-cells` | `restore` |
| create / change / delete an engine | `POST /define-engine`, `/edit-engine`, `/remove-engine` | `define` / `edit` / `remove` |

Two behaviours worth knowing before you are surprised by them:

- **Read-only mode refuses every write with `403`.** If a define or edit comes
  back refused and the payload looks correct, check whether the fleet provider
  is read-only before you start rewriting the payload.
- **Validation is all-or-nothing.** A malformed optional field does not collapse
  into "absent" — it fails the whole definition. This is deliberate: absent and
  malformed are opposite outcomes that look alike, and silently treating one as
  the other is how a cell ends up running with a setting nobody chose.

## Fields

`id` and the tmux session are **immutable after creation** — an edit that
includes either is refused. Everything else is patchable.

| field | required | shape and limit |
|---|---|---|
| `id` | yes | `[A-Za-z0-9._-]`, 1–32 chars. Human-readable identity; the dot is allowed |
| `cwd` | yes | working directory, ≤4096 chars |
| `cwdRel` | recommended | the same directory expressed relative to the user's home |
| `engine` | yes | must reference an existing engine id; a dangling reference fails the definition |
| `boot` | no | boolean, default false — whether the cell starts with the service |
| `model` / `models` | no | model selection; validated against the engine's catalogue when the engine is managed |
| `prompt` | no | the internal prompt, ≤8192 bytes |
| `permissionPolicies` | no | per-engine permission posture; some engines accept only the standard one |
| `commands` | no | per-engine command string, shell engines only, ≤4096 chars, no control characters |
| `panelUrl` | no | HTTP(S) endpoint of an associated panel, ≤512 chars |
| `mcp` | no | **names only**, up to 64, each matching `[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}` |
| `label`, `tmuxSession` | varies | display label ≤64 chars; session name ≤64 chars, immutable |

Ceilings on the document as a whole: **32 cells**, **24 engines**. These are not
close to most installs, but a restore that silently dropped entries would be
worse than one that fails, so a document over the cap is rejected rather than
truncated.

## `cwd` and `cwdRel`: portability is a write-time invariant

`cwdRel` is the portable form: the working directory relative to the user's
home. The distinction matters when a definition moves between machines — an
absolute path that exists on one install may not exist on another, and the cell
comes back pointing somewhere wrong or nowhere at all.

Reading tolerates a definition that has only `cwd`, so older entries keep
loading. **Writing does not**: create and edit resolve the pair together and
refuse input that is not portable. When you write a definition, always provide
the relative form — and when you audit an install, expect to find older cells
that predate it and offer to normalise them.

## `mcp`: the field that grants tools, and why it is probably empty

`mcp` lists **which MCP servers this cell gets, by name**. Only names: the
server definitions live in exactly one place, the client configuration, and
duplicating them per cell would create two sources of truth that drift.

Expect to find this field unset on most installs — and understand what that
means: **a cell with no `mcp` list inherits every server the client engine has.**
That is convenient and it is also the widest possible grant.

When you create a cell, propose the narrow list that matches its purpose. A
marketing cell that drafts copy has no business holding a tool that can delete
files or move money, and the cost of scoping it is one array. Say plainly that
this is a change from the install's habit, and let the user decide — do not
narrow an existing cell's tools without asking, because something it does today
may depend on a server you are about to take away.

## The internal prompt, and the one rule about it

The internal prompt is the text the cell receives at boot. Keep it small — a
bootstrap that tells the cell who it is and points at its canonical documents,
not a copy of them. The limit is 8 KB, but the reason to stay far below it is
that a prompt duplicating the documents will disagree with them within a week.

**How it is delivered depends on the engine**, and this has a security
consequence:

- **flag delivery** — the prompt is appended to the launch command as an
  argument. Command lines are visible to other processes of the same user.
- **typed delivery** — the prompt is sent into the session after it comes up,
  and re-sent on restart.

So: **never put a credential, token or key in a cell prompt.** Refer to the
mechanism that holds the secret, never the value. This holds regardless of
delivery mode — you should not have to know the engine's delivery style to be
safe, and an engine change must never turn a safe prompt into an exposed one.

The second consequence: **changing the engine can change whether the prompt
arrives at all.** Verify delivery after any engine change rather than assuming
the field carried over — the field is still there either way, which is what
makes this easy to miss. `operations.md` §Verifying that the prompt actually
arrived has the method for each delivery mode.
