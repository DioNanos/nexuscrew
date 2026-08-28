# Lifecycle: prompt, checkpoint, history, memory

Four mechanisms carry a cell across sessions. They are easy to confuse because
they all "remember things", so start with what each is actually for:

| mechanism | answers | changes |
|---|---|---|
| **internal prompt** | who am I, where do I look | rarely — when the purpose changes |
| **canonical prompt document** | the long-form version of the same | occasionally |
| **checkpoint** | what am I doing *right now*, and what blocks it | constantly |
| **memory** | durable facts and a running journal | every session |

## The internal prompt: small on purpose

The boot prompt should establish identity and point at the canonical documents,
not restate them. Two reasons, and the second is the one people learn the hard
way:

1. It is capped (8 KB), so a prompt that grows into a manual eventually stops
   fitting.
2. **Duplicated instructions diverge.** When the prompt and the document say
   different things, the cell follows whichever it read last, and no one can
   tell which that was. One source, one pointer.

## The checkpoint: a resume point, not a diary

The checkpoint answers "if this session ended right now, what would the next one
need?" That framing decides what belongs in it far better than any rule.

What makes checkpoints work in practice:

- **Hard limits.** A line count and a byte size — as a starting point, **200
  lines and 24 KB**, with roughly **three days** of operational detail and older
  work compressed to a summary. They are not bureaucracy: the checkpoint is read
  at the start of every session, so a bloated one costs context forever.
  Nothing in the product enforces this. If the install has tooling that
  validates and archives, use it; if not, the contract still holds and you keep
  it by hand — which mostly means deleting what is no longer true each time you
  write.
- **A fixed section order**, so a reader finds the current task, the evidence,
  the blockers and the next step in the same place every time.
- **Automatic archiving.** Replacing the checkpoint should snapshot the previous
  one into a history tree and leave a link behind. This is what lets the live
  file stay short without losing anything: the past is one click away, not in
  your context.
- **Closed only when verified.** A crash, a reboot, a device change or "I think
  it worked" do not close a task. Open means someone must resume it.

**Write it even when nothing happened.** A session that starts, finds nothing to
do and updates the timestamp is doing the right thing: the next session learns
that the state was checked at a known moment, which is different from not
knowing.

**One cell writes one checkpoint.** If the same cell identity runs on more than
one machine, give each device its own checkpoint file — a shared one means each
device silently overwrites the others, and nobody notices until two sessions
disagree about reality.

## Memory: state and journal are different mechanisms

Not two files — two behaviours, and using the wrong one is the usual cause of a
slow, bloated startup.

- **State** — a declarative snapshot of what is true now. Written whole (or
  patched key by key), read at every startup. It must stay lean, which means
  **never accumulate dated keys in it**. "What happened on the 14th" is not
  state; state is "where the work stands".
- **Journal** — an append-only, bounded event stream. Each entry is stamped and
  old entries are pruned automatically. Bounded is the contract, not a defect:
  anything that must survive pruning does not belong here, it belongs in the
  canonical documents.

Because the journal is bounded and multi-writer safe, it is the right place for
"what I did this session". Because state is read at every boot, it is the wrong
place for anything historical.

**Scoping.** Give each cell its own state and journal namespace, tied to a
per-cell device identity. Reads are typically open across cells — that is what
lets one cell understand another's situation — while **writes are scoped to the
owner**. Design for that: a cell should never need to write outside its own
namespace to do its job, and if it does, the boundary is drawn wrong.

**Getting the namespace to exist** is the memory server's business, not the
fleet API's, and servers differ: on many, a namespace simply comes into being
the first time something is written to it, and there is no separate creation
step to perform. So do not go looking for a command that may not exist — check
the memory server's own tool surface, and verify the round trip instead: have
the cell write its state once, then read it back.

Verify it, though. A cell whose memory has nowhere to go does not fail loudly;
it just starts every session empty, and that reads as a model problem rather
than a setup problem — which is why it can go unnoticed for weeks.

## Retiring a cell

Removing a cell throws away an identity and orphans its documents. Before doing
it, confirm with the user and decide explicitly what happens to the canonical
documents and the memory namespace — usually they should be kept, because they
are the record of work that actually happened. Stopping a cell is reversible;
removing its definition and deleting its history is not.
