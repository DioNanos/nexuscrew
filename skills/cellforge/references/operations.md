# Operations: how to look, and how to act

The rest of this skill says *what* to do. This file says *how to observe it*,
because a step you cannot verify is a step you are guessing at.

Everything here is the product's own interface, under the fleet API. Where
something depends on the install rather than on the product, it says so —
guessing a command is worse than admitting the gap, because a wrong command
fails in a way that looks like a broken cell.

## Where the API is, and how you reach it

Everything below is under the service's HTTP API. Two things you need before the
first call, and neither is guessable:

- **The address.** The service listens on the loopback interface, on a port
  chosen per installation — there is no fixed port to assume. Get it from the
  product's own status command on **that machine**: a health check pointed at a
  port you remembered from elsewhere will declare a perfectly healthy service
  dead.
- **The credential.** Calls carry a bearer token. The product has a command that
  prints an authenticated URL for the local UI, and there is a trap worth
  knowing: **that command prints a URL, not the token.** The token is the
  fragment inside it, after the `#`. Passing the whole URL as a bearer gets you
  `401`, and the failure looks like a permission problem rather than a
  copy-paste one.

Never put either value in a prompt, a document, or a message. Read them where
they live, use them, and do not repeat them.

## Look first: one call tells you almost everything

```
GET  <api-base>/fleet/status
```

Open to any authorised caller — no special capability. It returns whether the
fleet provider is `available`, which `provider` is in use, the **`capabilities`
list**, and the cells with their engine and state.

This is the call to make **before** anything else, for three reasons:

1. it is how you learn which cells already exist, so you do not collide with one;
2. it gives you the engine ids you need to fill a definition — an `engine` value
   that does not match an existing engine **fails the whole definition**;
3. it tells you what you are allowed to do, which is the answer to "how do I get
   permission" (see below).

```
GET  <api-base>/fleet/definitions     # capability: definitions
GET  <api-base>/fleet/schema          # capability: schema
```

`definitions` returns the stored records — the ground truth for an audit, and
the only way to see fields the status view does not show. `schema` returns the
shape the server will accept, which is more reliable than any documentation
including this file.

## Capabilities are not granted, they are discovered

There is no request-permission step. The fleet provider either supports an
operation or it does not, and the set is reported in `capabilities` from
`/status`. Attempting an unsupported one returns:

```
501  not supported by this fleet provider
```

So the honest sequence is: read `capabilities`, and if the one you need
(`define`, `edit`, `remove`, `restore`, `definitions`, `schema`) is missing,
**say so to the user** rather than retrying. A `501` here is a statement about
the provider, not about your payload — do not start rewriting the body.

Separately, a provider in read-only mode refuses writes with `403`. Two
different refusals with two different meanings: `501` says "this provider can
never do that", `403` says "not right now".

## Identity: the id, and where the session name comes from

The cell `id` is `[A-Za-z0-9._-]`, 1–32 characters, and it is **immutable** —
along with the session name, it is one of the only two fields an edit refuses to
change. Choose it as you would a directory you cannot rename:

- **name the function, not the moment.** `Marketing` outlives
  `Marketing-Q4-launch`.
- **short, because it appears everywhere**: in the workspace path, in memory
  namespaces, in every reference from another cell.
- **no personal names**, no project code names that will be retired.

**When you define a cell, the id is yours to choose and it is required** — a
definition without one is rejected. There is a separate path, *adopting an
existing session* into a cell, where an id may be derived from the session name
if you do not supply one; that is a different operation with different inputs,
and it is the only place the derivation applies. Do not carry it over to
creation.

For the workspace path, do not construct the session name from the id by hand:
**read the actual session from `/status`**, which reports it per cell. The two
are related by convention on most installs and by nothing at all on some.

## Verifying that the prompt actually arrived

You cannot conclude this from the definition: the field is present either way.
What varies is the engine's delivery mode, and it is a property of the **engine**,
not of the cell — read it from the engine record (`definitions`, or the schema
if you want the allowed values).

- **flag delivery** — the prompt is appended to the launch command as an
  argument. Observable in the process's command line.
- **typed delivery** — the prompt is sent into the session after start-up and
  re-sent on restart. Observable in the session's own scrollback.

So the verification is: start the cell, then look at the place that matches its
delivery mode. If you cannot look at either, say the delivery is **unverified**
rather than assuming it worked — this is precisely the check that silently
breaks after an engine change.

The security consequence of flag delivery is covered in `definition.md`, and it
is worth repeating once: **command lines are readable by other processes of the
same user, so a prompt must never contain a secret.**

## What depends on the install, not on the product

Be explicit with the user about these rather than inventing a procedure:

- **Where canonical documents live.** The product does not impose a documents
  repository — that is an install convention. On a fresh install, ask where the
  cell's documents should live and whether they should be version-controlled
  (they should: the checkpoint's value comes from its history). If there is no
  repository yet, creating one is a decision for the user, not a side effect of
  creating a cell.
- **How the workspace links get created.** The runtime workspace appears under
  the files root; the links to the canonical documents are a convention on top.
  Check whether they exist after first run, and create them if the install
  expects them — do not assume something made them for you.
- **Memory namespaces.** These belong to the memory companion, not to the fleet
  API. In practice a namespace comes into existence when first written, so the
  reliable move is: have the cell write its state once at the end of its first
  session, then confirm it reads back. "Create it beforehand" is only meaningful
  if the install's memory server has an explicit creation step — check its tool
  surface rather than guessing.
- **Which MCP servers exist to choose from.** The names come from the client's
  configuration, not from the fleet API. Read that configuration's server list —
  most AI CLIs also expose a command that prints it. You need real names: the
  per-cell list matches by name, and a name that does not exist grants nothing
  while looking like it does.
- **Checkpoint tooling.** Nothing in the product enforces the checkpoint
  contract. If the install has tooling that archives and validates, use it. If
  not, the contract still holds and you enforce it by hand — see
  `lifecycle.md` for the limits and the section order.

## `boot`: when to set it

`boot: true` starts the cell with the service. Use it for cells that must be
reachable without anyone thinking about it — the ones others send work to.
Leave it false for cells used in bursts: a cell that boots but is never used
still holds a session, and on a busy install the cost is paid every restart.

It is trivially changeable later, so when unsure start false. That is the
direction with the cheaper mistake.

## A note on language

The templates in `assets/` are written in English so they can be adapted
anywhere. A cell's prompt should be in **the language its operator thinks in** —
translate the template rather than making someone work through a second
language on every session. The structure is what matters; the wording is yours.
