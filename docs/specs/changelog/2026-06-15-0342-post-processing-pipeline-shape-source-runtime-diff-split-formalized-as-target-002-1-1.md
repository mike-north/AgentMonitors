## 2026-06-15 — Post-processing pipeline shape + source/runtime diff split formalized as _target_ (002 §1.1, 003 §2.5–§2.6)

Formalizes resolved decisions from the monitoring capability study
([`docs/product/monitoring-capability-exercises.md`](../product/monitoring-capability-exercises.md)
§S1, §S4, §S5; ledger rows C40/C6/C43/C15). Spec-only; every new rule is marked **target**, not
current — the current runtime implements a subset under different names and is reaffirmed, not changed.

- **002 §1.1 — locked pipeline stage order (target).** Names the conceptual stages an observation
  flows through and fixes their order:
  `Observe → [Compose] → Shape → Pace → ⟦seam⟧ → Diff → Interpret → Deliver → [React]` (bracketed
  stages optional). Each stage's responsibility and side of the seam is defined. Shape runs before
  Pace and before Diff (settle and diff the shaped/rendered artifact, not the raw source).
- **002 §1.1.2 — shared / per-recipient seam (target).** Everything left of the seam (Observe…Pace)
  is computed **once** and shared across all recipients; everything right (Diff…Deliver) is **per
  recipient**, against that recipient's baseline/cursor. Identical baselines may dedupe. This is the
  structural reason fan-out is cheap (C15). The current object-level diff (§5.2) is named as the
  degenerate **shared-baseline** case of the target per-recipient Diff — a refinement, not a
  contradiction. §5.2 gains a back-reference.
- **003 §2.5 — sources return snapshots, not diffs (target; reaffirms PP3/AP3).** The source contract
  now states explicitly that a source observes **current state** (+ its own `nextState`
  change-detection state) and the **runtime is the sole producer of the delivery diff**, parameterized
  by the consumer's baseline. A source's `nextState` is its internal "did anything change" cursor, not
  any recipient's baseline; a source MUST NOT compute "what is new for recipient X."
- **003 §2.6 — composite observation (target, C40).** One `Observation` MAY be assembled from many
  source queries/calls into a single stable whole-state snapshot under one `objectKey` — the
  `[Compose]` stage, on the shared side of the seam. Modeling, determinism, and partial-failure rules
  specified.
- Glossary entries added (post-processing pipeline, the seam, composite observation). Roadmap gains
  target gaps **G10** (pipeline stages + per-recipient seam) and **G11** (snapshots-not-diffs +
  composite observation), each with proof criteria.
- Spec-only — no implementation or published-package behavior change, so no changeset.

