---
applyTo: 'docs/specs/**/*.md,agent-plugins/**/*.md,**/SKILL.md,**/README.md'
---

# Spec And Documentation Accuracy Guidance

- Behavioral claims in specs, docs, and code comments MUST match the
  implementation. When prose describes runtime behavior, cite the implementing
  file so the claim can be checked against code.
- Be precise about load-bearing words. "Verbatim" / "unchanged" / "as-is" mean
  the output is NOT sanitized, escaped, truncated, or length-capped — only use
  them when the renderer genuinely passes the content through untouched.
- Be precise about lifecycle and urgency timing (see
  `docs/specs/002-runtime-delivery.md` §13 and `claimDelivery`): high-urgency
  events surface at `turn-interruptible` (after the 15s settle window); normal
  reminders surface at `turn-interruptible`; low-urgency defers to `turn-idle`.
  Do not write a table or sentence that places low urgency at
  `turn-interruptible`.
- When a table and the adjacent prose describe the same behavior, verify they
  agree — drift between a summary table and its explanatory paragraph is a
  recurring defect. Past examples: a "verbatim" claim where the renderer
  sanitizes + truncates; a lifecycle table row that contradicted the runtime's
  actual `turn-idle` deferral for low urgency.
