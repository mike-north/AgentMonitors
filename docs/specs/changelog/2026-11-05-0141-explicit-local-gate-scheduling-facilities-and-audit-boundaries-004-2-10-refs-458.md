## 2026-11-05 — Explicit local gate scheduling, facilities, and audit boundaries (004 §2.10) — Refs #458

Preserve valid job metadata in negative guard fixtures, reject prerequisites that could
skip the mandatory test job, and report optional local jq preset-reduction coverage as
skipped rather than a passing no-op. CI still requires jq; available jq runs real cases.
Document and guard the existing independent live dependency-audit exclusion, including
its separate command and the distinction from script-suite audit fixtures/version floors.
The aggregate sequence, security workflow cadence, and website exclusion are unchanged.

