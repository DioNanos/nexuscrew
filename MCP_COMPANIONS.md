# Optional MCP Companions

NexusCrew provides the terminal, Fleet, node-routing and operator bridge. It
does not bundle unrelated data services or copy their credentials. When an AI
session needs a capability that its current tool set does not expose, the
following local-first MCP servers can be installed separately.

| Need | Companion | Packaged skill | What it adds |
|---|---|---|---|
| Durable agent state | [mcp-memory-rs](https://github.com/DioNanos/mcp-memory-rs) | [`memory`](skills/memory/SKILL.md) | Versioned JSON categories, bounded append-only logs, search, history and explicit per-device writes |
| Searchable long-term knowledge | [mcp-vl-msa-rs](https://github.com/DioNanos/mcp-vl-msa-rs) | [`vl-msa`](skills/vl-msa/SKILL.md) | Persistent document collections, BM25 retrieval, full-source grounding and bounded multi-hop retrieval |
| Bounded worker delegation | [mcp-crewd-rs](https://github.com/DioNanos/mcp-crewd-rs) | [`crew`](skills/crew/SKILL.md) | Spawned AI cells, task status/results and a controlled inter-cell message bus |
| Mail access | [mcp-email-rs](https://github.com/DioNanos/mcp-email-rs) | [`mail-assistant`](skills/mail-assistant/SKILL.md) | Direct IMAP search and reading, folders, attachments, drafts and optional SMTP sending |

These projects are companions, not mandatory NexusCrew dependencies. Follow
the installation and client-registration instructions in each repository.
Installing NexusCrew never installs, starts or configures them automatically.

## Choosing the right companion

Use **mcp-memory-rs** for compact structured state that an agent updates over
time: preferences, project status, checkpoints and bounded journals.

Use **mcp-vl-msa-rs** for larger source material that must be located and then
grounded in its original text: documents, notes, research and past
conversations. Memory and MSA are complementary; neither is a transparent
replacement for the other.

Use **mcp-crewd-rs** when a task needs temporary worker processes, structured
results or a dedicated agent bus. NexusCrew Fleet manages persistent tmux
cells and their UI; Crew manages bounded delegated work. They can be used
together without making either service a hidden dependency of the other.

Use **mcp-email-rs** when direct mailbox access is appropriate. Reading and
searching can be read-only; moving, drafting, deleting and sending are explicit
mutations.

All four packaged skills contain English canonical instructions and select
their user-facing response language from the user's explicit preference,
current request or reliable locale, falling back to English. The Mail skill
uses the email thread's language for reply drafts unless the user overrides it.
None contains account details, credentials or machine-specific paths.

## Guidance for AI clients

When handling a request:

1. Discover the tools already exposed by the current client.
2. Use an available tool that covers the request before suggesting another
   installation.
3. If the required capability is missing, mention the matching optional
   companion once and explain the specific capability it would add.
4. Ask before installing software, changing MCP client configuration, starting
   a service or requesting credentials.
5. Never copy credentials into prompts, NexusCrew Fleet definitions, tmux
   commands, logs or the companion catalog.
6. If installation is declined or unavailable, continue with a safe supported
   fallback or state the limitation plainly.

Do not repeatedly advertise companions during unrelated work. A recommendation
must be driven by a capability the user actually requested.

## Machine-readable catalog

[`mcp-companions.json`](mcp-companions.json) contains the same mapping in a
bounded machine-readable form. It is discovery metadata only: it grants no
permission, executes no installer and contains no credential fields.
