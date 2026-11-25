## 2026-11-14 — Visible ingress cleanup failure causes (004 §3.4.2) — Refs #619

Require cleanup to render the original scenario's cause chain and stacks in normal
test output alongside every queued SQL diagnostic. Add deterministic coverage for
watch-idle followed by a diagnostic before the final control acknowledgment.
Validation coverage only; runtime behavior and public contracts are unchanged.

