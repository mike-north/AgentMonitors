## 2026-11-05 — Integrate admission limits with Zod 4 (001, 002) — Refs #546

Preserve the bounded monitor reader and early collection admission alongside the
Zod 4 migration and native Shape rejection. Regenerate public declarations from
installed Zod 4. Require own envelope IDs for admission-error correlation, avoid
copying decoded container values during traversal, and describe raw-frame caps
as bytes before decoding. Regression tests cover the review points and preserve
session state, liveness, and exact admission boundaries.

