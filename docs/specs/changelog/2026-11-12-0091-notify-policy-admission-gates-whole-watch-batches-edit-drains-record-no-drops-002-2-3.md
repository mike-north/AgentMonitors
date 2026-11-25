## 2026-11-12 — Notify-policy admission gates whole watch batches; edit drains record no drops (002 §2.3/§2.4/§4.6, 004 §2.5) — Refs #497, #537

Reconcile effective notify-policy edits with explicit watch batches and span admission outcomes.
The notify admission gate now governs whole batches: while it is closed, a yielded batch waits
unadmitted on the consumer's stack and the iterator is not pulled again; the gate, cancellation
and ownership token are rechecked in the same synchronous turn as the batch's transaction. The
former checkpoint-teardown rules (closing a checkpoint queue, draining accepted checkpoints) are
restated for batches: one batch is admitted at a time, so completion or an iterator error retires
the watcher's slot and lease only after its last admitted batch settled; abort releases a waiting
batch unadmitted, and a superseded watcher's batch is never admitted. A watcher is released "after
its admitted batch settles" (§2.3). An edit drain stays all-or-nothing and records no drop and
queues no retry when a held envelope cannot materialize; blocked work records neither; a drop is
not held work and stays outstanding across an edit unless a drained event supersedes it under §2.
A retained poll result is later admitted against the source baseline it was observed from.
004 restates the #537 watcher scenarios for batches and requires the edit/admission-outcome
interaction tests.

