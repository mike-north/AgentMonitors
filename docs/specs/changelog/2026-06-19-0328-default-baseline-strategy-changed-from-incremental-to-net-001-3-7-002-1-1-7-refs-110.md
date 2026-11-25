## 2026-06-19 — Default `baseline-strategy` changed from `incremental` to `net` (001 §3.7, 002 §1.1.7) — Refs #110

Implements the 2026-06-19 strategy-call decision: the standard delivery contract is now
**one before/after delta per changed object per notification window** (consolidate by object, not by
monitor; zero reasoning in the daemon).

- **001 §3.7 — default changed.** `baseline-strategy` now defaults to `net`. Omitting the field
  yields per-object consolidation (one delta per changed object per window). `incremental` is the
  explicit opt-out — declare it when the full ordered history of changes matters (e.g. comment
  threads where each reply is a discrete step).
- **002 §1.1.7 — contract updated.** The default-is-`net` semantics are now the normative contract.
  The mechanism is unchanged (per-recipient `collapseNetForClaim` at claim time, G10 PR-B): the
  shared `monitor_events` chain still records every observation (the incremental substrate), and the
  `net` collapse groups pending events per `(monitorId, objectKey, workspacePath)`, delivering only
  the newest per object — delta recomputed against the recipient's own cursor → endpoint — with older
  intermediates recorded claimed-but-suppressed.
- **Schema:** `baselineStrategySchema` (`libs/core/src/schema/monitor-schema.ts`)
  `.default('incremental')` → `.default('net')`.
- **Tests:** `libs/core/src/schema/monitor-schema.test.ts` ("defaults to net when omitted"),
  `libs/core/src/runtime/service.test.ts` ("omitting baseline-strategy defaults to net"),
  `libs/core/src/runtime/object-consolidation.test.ts` (new — canonical 15-saves case + two-object
  envelope + incremental opt-out, all end-to-end through the real runtime tick).
- **No runtime logic change** — only the schema default and the surrounding documentation. The
  per-recipient `net` collapse machinery (G10 PR-B, Refs #182) is unchanged.

