## 2026-11-05 — Validate early reaper cadence lookup (002 §2.0, 004 §2.5) — Refs #554

Dormant verify-session cleanup precedes observation preflight. Validate the source
scope before deriving a suppression lifetime from cadence; invalid or unavailable
config uses the existing five-minute fallback. Preserve valid interval + settle +
margin sizing and missing-definition behavior. Real-source regression reproduces
the malformed-duration throw before cleanup, then proves scratch retraction and
suppression, honest config skip, healthy sibling progress, and unchanged baseline
and held legitimate work. No new TTL policy or broad scheduler exception handling. The initial whole-scope
condition is superseded by the safely derivable cadence correction above.

