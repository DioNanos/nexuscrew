# Choosing an engine, tools and MCP servers for a purpose

This is the step where a cell becomes useful or becomes generic. The goal is a
recommendation the user can correct, not a questionnaire and not a default.

## Start from the work, not from the roles that already exist

The strong temptation on an install with existing cells is to clone the nearest
one. Resist it: you inherit its assumptions, its tool grants and its blind
spots, and the new cell ends up describing itself in someone else's words.

Instead, ask what the work actually looks like, because that maps to engines and
tools far better than a job title does:

- **Is it mostly reading and drafting, or mostly changing things?** Drafting
  work wants a capable model and few dangerous tools. Work that edits real
  systems wants tighter permissions and a reviewer.
- **Does it need to reach outside** — the web, mail, a calendar, a repository
  host? Each of those is an MCP server, and each is a grant.
- **How long is a single task?** Work that runs for hours needs a cell that
  checkpoints well and can hand off. Work in short bursts does not.
- **Does the output need to be trusted by someone else?** If yes, plan a second
  cell to review it. A single cell approving its own work is not a review, and
  no prompt wording changes that.

## A role the install has never seen

"Marketing", "Support", "Legal ops" — a role with no precedent is the normal
case, not the exception, and it is where cloning fails hardest.

Work it out from first principles:

1. **What does it produce?** Documents, decisions, messages, code, analysis.
2. **What does it need to see** to produce that, and what should it never see?
   This is the MCP list, and phrasing it as "never see" surfaces limits a
   capability list would miss.
3. **What is irreversible in its domain?** Sending, publishing, spending,
   deleting. These become explicit confirmations in the prompt.
4. **Who checks it?** Either a person, or a second cell, or nobody — and if
   nobody, say so out loud, because that is a decision.

Then propose engine, model and tools with a sentence of reasoning each, and mark
what you are unsure about. A recommendation with visible reasoning can be
corrected; a confident list cannot.

## Scoping MCP servers

A cell with no explicit server list inherits **everything** the client engine
has. That is the widest grant available, and on most installs it is the default
simply because nobody set the field.

For a new cell, propose the narrow list: the servers its purpose actually needs.
The cost is one array, and the benefit is that a drafting cell cannot reach a
tool that deletes things.

Two cautions:

- **Do not narrow an existing cell without asking.** Something it does today may
  depend on a server you are about to remove, and the failure will appear later
  and somewhere else.
- **Names, not definitions.** The server definitions live in the client
  configuration and stay there. A per-cell list selects from them; it never
  redefines them, because two definitions of the same server will drift.

## Permissions and the reviewer

Match the permission posture to what the cell can break, not to how much you
trust the model. Some engines only accept the standard posture — the API will
refuse the others, which is a useful signal rather than an obstacle.

When work needs a verdict, the reviewer must be **structurally** independent: a
different cell, which did not do the work and cannot quietly fix it. A cell that
implements and then audits its own output will approve it — not from
dishonesty, but because it is checking against the same understanding that
produced the work. That is the whole reason the second cell exists.
