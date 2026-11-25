## 2026-11-01 — Watch batches bind observations to source checkpoints (002 §2.4; 003 §2; 004 §3.4) — Refs #497, #294, #295

Record the user's accepted explicit-batch decision and its rationale: an independent opaque
checkpoint can skip not-yet-yielded work, and staging it until one later yield cannot recover the
covered span. Change watch to yield ObservationResult, remove context.checkpoint, reject legacy bare
observations, and atomically admit each complete batch before Interpret or the next pull. Empty
batches are valid; omitted/undefined state preserves and null retains the existing reset-to-{} behavior.
Whole admission failure stops the iterator with the old baseline and prior committed cache intact.
Read source/notify state and decide dispatch under the admission write lock; refuse batches whose
pre-acquisition source token no longer matches, preserving competing writers' checkpoints and held
work. Document breaking third-party migration, runtime-local ownership, source replay responsibility
and remaining retry-drain/crash-proof work. File-fingerprint's target watch design adopts the same contract.

