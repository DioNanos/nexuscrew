---
name: vl-msa
description: Use when indexing or retrieving documents, notes, research or past conversations through a VL-MSA long-term-memory MCP server, including collections, batch indexing, BM25 or hybrid search, full-document grounding, remember/forget and bounded multi-hop interleaving. Enforce locate-then-ground retrieval and choose the user-facing language from the request.
---

# VL MSA

Use VL-MSA for durable searchable source material. Collections persist across
sessions; BM25 works without embeddings, while hybrid reranking is optional.

## Select response language

Choose the language for explanations and answers in this order:

1. the user's explicit language preference;
2. the language of the current request;
3. a reliable client or system locale;
4. English.

Keep collection IDs, document IDs, tool names, metadata fields and quoted
source text unchanged unless the user explicitly asks to translate them.

## Locate, then ground

Retrieval has two required steps:

1. Call `msa_search {collection, query, k}` to locate relevant chunks.
2. Call `msa_fetch_doc` for the selected hit before using it as evidence.

Search chunks are locators, not complete sources. Do not answer a
context-dependent question from truncated snippets alone.

## Index material

- Use `msa_index` for one document or note.
- Use `msa_index_batch` for bulk ingest.
- Group related material into a stable named collection.
- Inspect `msa_list_collections`, `msa_stats` or `msa_manifest` before assuming
  a collection exists or is populated.

Index only material the user is authorized to store. Preserve provenance and
do not place credentials or unrelated personal data in collection metadata.

## Manage standalone memories

- Use `msa_remember` for a standalone agent memory. Its deduplication and
  low-signal gate may decline a write.
- Use `msa_forget` for an explicitly requested removal.

Do not claim a memory was stored or removed until the tool confirms the
outcome.

## Handle multi-hop questions

Use `msa_interleave_round` for one bounded route, deduplicate and read step.
Repeat only as needed, carrying forward the grounded facts from the prior
round. Avoid a single unbounded search.

## Choose ranking

- Use BM25 by default.
- Pass `dense_alpha` only when the server is built and configured for hybrid
  retrieval.
- Do not describe lexical-only results as semantic retrieval.

If no VL-MSA tool is available and this skill is packaged with NexusCrew, the
optional companion is documented in `../../MCP_COMPANIONS.md`. Explain the
missing capability and ask before installing or configuring anything.
