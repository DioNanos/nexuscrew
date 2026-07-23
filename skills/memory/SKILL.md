---
name: memory
description: Use when reading or writing persistent AI-agent state through a Memory MCP server, including category discovery, versioned reads and writes, merge patches, optimistic concurrency, bounded append-only journals, search, context loading and history. Keep durable state separate from bounded logs and choose the user-facing language from the request.
---

# Memory

Use the exposed Memory MCP tools rather than reading or editing the server's
database, cache or state files directly.

## Select response language

Choose the language for explanations and summaries in this order:

1. the user's explicit language preference;
2. the language of the current request;
3. a reliable client or system locale;
4. English.

Keep category names, tool names, JSON fields, paths and quoted source text
unchanged unless the user explicitly asks to translate them.

## Understand the model

- A category is a named JSON document. `memory_read` takes a `category`, not a
  nested key.
- Reads may be broadly available while writes are scoped by the server's
  device or actor ACL.
- Every write is versioned; inspect `memory_history` when provenance matters.
- Treat recalled state as a snapshot. Verify live files, flags and services
  before acting on drift-prone facts.

## Warm up narrowly

1. Call `memory_list` to discover available categories.
2. Read only relevant categories with `memory_read`, or load a bounded set with
   `memory_context`.
3. Use `memory_search` when the category is unknown.

Do not load every category by default.

## Write safely

`memory_write {category, content}` replaces the category by default.

- Set `merge:true` for a top-level patch: supplied keys are inserted or
  overwritten, JSON `null` deletes a key, and untouched keys remain.
- Pass `expected_hash` from the prior read/list result for read-modify-write
  workflows so concurrent updates fail instead of being overwritten.
- Never write another device's namespace unless the server ACL and the user's
  request explicitly authorize it.

## Separate state from journals

Use `memory_append` for a bounded append-only log category. The server stamps
entries and prunes them according to retention.

- Do not simulate a journal by adding ever-growing dated keys to a normal
  memory category.
- Do not use `memory_write` on a log category.
- Do not use `memory_append` on a normal memory category.

A useful convention is:

- `<name>_state`: lean declarative state, updated with `memory_write`;
- `<name>_log`: bounded event journal, updated with `memory_append`.

Facts that must never be pruned belong in normal durable state or an external
document store, not in a bounded log.

## Search and inspect

- Use `memory_search` for BM25 full-text retrieval across categories.
- Use `memory_search_semantic` only when the server exposes and supports it.
- Use `memory_history` to inspect versions before restoring or explaining a
  change.
- Report writes only after the tool confirms them.

If no Memory MCP tool is available and this skill is packaged with NexusCrew,
the optional companion is documented in `../../MCP_COMPANIONS.md`. Explain the
missing capability and ask before installing or configuring anything.
