## 2026-11-05 — Doctor preserves rejected-config diagnostics (002 §2.0, 004 §2.5) — Refs #554

Doctor must not schedule a scope already rejected by `validateWatchScope`. A malformed
file-fingerprint interval previously threw from scheduling and aborted the report.
Return the shared validation error, no due time, and healthy sibling results without
mutating durable state. Add real bundled-source and built-CLI red-to-green regressions.
Correct the core Changeset to minor under the established pre-1.0 incompatible-change
policy; the skipped-result union and documented consumer migration remain unchanged.

