---
name: crew
description: Use when spawning or coordinating bounded AI worker cells through a Crew MCP fabric, including cell discovery, idempotent spawn, status monitoring, structured results, follow-up tasks, cancellation and the inter-cell message bus. Covers safe worktree isolation, durable audit reports and user-language selection.
---

# Crew

Use Crew for bounded delegated work. A coordinator submits tasks to worker
cells through an MCP server; spawning is asynchronous and returns a thread ID.

## Select response language

Choose the language for user-facing explanations and summaries in this order:

1. the user's explicit language preference;
2. the language of the current request;
3. a reliable client or system locale;
4. English.

Keep cell names, engine/profile IDs, thread IDs, tool names, paths and quoted
worker output unchanged unless the user explicitly asks to translate them.
Tell a worker which output language is required when its deliverable is
user-facing.

## Discover before spawning

1. Use `cell_list` to inspect the cells and engines visible to the caller.
2. Select an engine/profile appropriate to the bounded task.
3. Verify that the worker's `cwd` contains the instructions and project context
   it needs.
4. Do not assume an embedded worker inherits the coordinator's MCP servers.
   Required servers must be configured explicitly in the Crew daemon and
   verified inside a fresh worker.

If no Crew tools are exposed and this skill is packaged with NexusCrew, the
optional companion is documented in `../../MCP_COMPANIONS.md`. Explain the
missing capability and ask before installing, configuring or starting it.

## Spawn, monitor and collect

1. Call `cell_spawn` with a bounded task, explicit `cwd`, background mode and a
   caller-stable `idempotency_key`.
2. Keep the returned `crewd_thread_id`; a replayed idempotency key must resolve
   to the existing thread rather than duplicate work.
3. Monitor with `cell_status`. Use the host's loop or scheduler for waits rather
   than a tight manual poll.
4. Treat `idle` as normal turn completion. Also handle `timeout`, `failed`,
   `interrupted` and `failed_unknown`; do not wait for a fictional `finished`
   state.
5. Read `cell_result` and inspect `exit_status`, `final_answer` and the bounded
   event tail.
6. Verify the worker's files and tests yourself before accepting code changes.

A timeout may leave partial edits. Never report success from a thread state
alone.

## Isolate code work

- Do not let two mutating workers edit the same worktree concurrently.
- Give parallel code tasks separate git worktrees.
- Preserve unrelated user changes and review every worker diff.
- Use follow-up tasks only when the original thread and scope remain valid.
- Cancel only the exact thread the user authorized.

## Require durable audit evidence

For audits, reviews and release gates:

1. Choose an authorized absolute report path before spawning, preferably
   outside the repository being audited.
2. Require scope, evidence, findings by severity, residual risks and a terminal
   verdict in the report.
3. Require the worker callback to identify the report path and verdict.
4. Verify that the report is a non-symlink regular file, read it completely and
   confirm its verdict matches the callback.
5. Recalculate important hashes and gates independently.

Chat output or `cell_result.final_answer` is not a substitute for the verified
report.

## Use the message bus deliberately

- `cell_send` is fire-and-forget.
- `cell_ask` plus `cell_await` is appropriate when a reply is required.
- `cell_send_task` starts a follow-up turn on an existing thread.
- `cell_inbox` reads queued bus messages.

Transport receipts do not prove task acceptance or completion. Report only
results that have been verified.
