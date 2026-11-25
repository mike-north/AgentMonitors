## 2026-06-15 — Source contract: snapshots-not-diffs (§2.5) made current; composite observation (§2.6) shipped (003 §2.5–§2.6; roadmap G11) — Refs #173

Implements roadmap **G11**. Both rules were **target**; both are now **current** with `verified:`
references. Capability study rows C2/C6/C40/C43,
[§S1, §S4](../../product/monitoring-capability-exercises.md).

- **003 §2.5 — snapshots-not-diffs, now current.** The contract that sources return current-state
  snapshots + `nextState` and the runtime is the sole producer of the consumer-baseline diff is now
  documented on the `Observation` / `ObservationResult` types (`libs/core/src/observation/types.ts`,
  doc-comments only — no type-shape change) and proven against a **bundled** source: a
  `file-fingerprint` unit test asserts the observation is the full current file content with no diff
  field, and an end-to-end test drives the source through the real runtime and asserts the runtime —
  not the source — materializes the `diffText`
  (`plugins/source-file-fingerprint/src/index.test.ts`, "snapshots-not-diffs (003 §2.5)" block;
  reinforced by `libs/core/src/runtime/service.test.ts` "computes a diff against the prior snapshot").

- **003 §2.6 — composite observation, shipped.** The bundled `api-poll` source gains a
  `change-detection.composite` mode that assembles **one** observation from **many** sub-resource
  calls under **one** `object-key`. Parts are rendered sorted by `id` so call ordering never churns
  the snapshot (deterministic, per §2.6); a failed underlying call fails the whole observation
  (baseline preserved, 002 §3); composite and keyed-collection (§12) are mutually exclusive. Verified:
  `plugins/source-api-poll/src/composite.ts` + wiring in `plugins/source-api-poll/src/index.ts`;
  `plugins/source-api-poll/src/index.test.ts` (the "composite observation (003 §2.6)" unit block and
  the "composite × runtime integration" block reducing N calls into one event under one `objectKey`
  with the runtime computing the diff).

- **Roadmap G11** retired (both proof criteria met). A changeset bumps
  `@agentmonitors/source-api-poll` (minor — new authoring surface). `@agentmonitors/core` changes are
  doc-comment-only, so no core changeset and no api-report drift (api-report generation is disabled in
  the base config).

