# Anatomy: the three places a cell lives

A cell is complete when all three exist and agree. Most breakage is one of them
missing or drifting, and none of the three reports the other two.

```
1. DEFINITION          the runtime record — engine, cwd, prompt, permissions
   written through the API, never by editing the file

2. RUNTIME WORKSPACE   ~/NexusFiles/<session>/
   inbox/  outbox/  + links to the cell's canonical documents

3. CANONICAL DOCUMENTS <docs-repo>/<cells-path>/<CellId>/
   prompt · checkpoint · history/
```

## 1. Definition

Covered in `definition.md`. The thing to carry here: it is what makes the cell
*run*, and it is the only one of the three that has schema validation. The other
two are conventions — nothing stops you from creating a malformed workspace, so
the discipline has to come from you.

## 2. Runtime workspace

Lives under the files root, in a directory named after the cell's session. What
you find inside:

- **`inbox/`** — files delivered to the cell.
- **`outbox/`** — files the cell offers back to the operator. Created when first
  needed rather than up front, so its absence on a new cell is normal, not a
  fault.
- **links to the canonical documents** — the cell's prompt, its checkpoint and
  its history are usually **symbolic links** pointing into the documentation
  repository, not real files.

That last point is the one that causes trouble. When you inspect a cell, resolve
the links before concluding anything: a checkpoint that looks present may be a
link to a target that no longer exists, which reads as "the file is there" to
anything that does not follow it. Equally, a *copy* where a link belongs is
worse than a missing file — it will be edited, it will diverge from the canonical
version, and both will look authoritative.

## 3. Canonical documents

The cell's durable identity, versioned in a documentation repository:

- **the internal-facing prompt document** — the long-form version of what the
  cell is, which the short boot prompt points at;
- **the checkpoint** — what the cell is doing right now, kept small enough to be
  read at the start of every session;
- **`history/`** — previous checkpoints, archived automatically, so the live
  checkpoint never has to carry the past.

`lifecycle.md` covers who writes these and when.

## Telling a complete cell from a half one

Check in this order — it goes from cheapest to most revealing:

1. **Does the runtime listing show it**, with the engine and model you expect?
   If the definition is missing, nothing else matters.
2. **Does the workspace exist**, and do its links resolve to real files? A
   broken link is the most common silent failure.
3. **Do the documents exist and describe this cell?** A prompt copied from
   another cell and never adapted is technically present and practically
   useless — read it, do not just check that it is there.
4. **Does the cell have somewhere to write its memory?** See `lifecycle.md`.
   A cell whose memory namespace was never created will appear to work and will
   quietly start every session with nothing.

A cell that fails 3 or 4 is the dangerous case: it runs, it answers, and it
forgets. Nobody notices until someone asks it what it did last week.
