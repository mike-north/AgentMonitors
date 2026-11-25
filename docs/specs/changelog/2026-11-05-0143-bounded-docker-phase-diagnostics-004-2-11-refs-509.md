## 2026-11-05 — Bounded Docker phase diagnostics (004 §2.11) — Refs #509

Separate valid install/build output volume from the outer smoke helper's runaway-output bound.
Replace full phase streaming with capped periodic byte tails and final tails, preserving recent
phase/daemon evidence when retrieval fails and force removal destroys files. Add successful 21 MiB,
ordinary failure and active-termination regressions; retain the existing timeout/cleanup allocation
and zero-exit overflow guard. This test-fixture contract does not establish repeated-CI reliability.

