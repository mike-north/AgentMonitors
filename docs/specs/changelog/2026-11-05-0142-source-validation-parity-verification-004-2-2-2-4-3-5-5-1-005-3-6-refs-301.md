## 2026-11-05 — Source validation parity verification (004 §2.2/§2.4/§3.5/§5.1, 005 §3/§6) — Refs #301

Clarify the existing pre-observation `validateWatchScope` contract for `monitor test` and its
shared diagnostics with `validate`, retaining each command's text/JSON channels and exit code 1.
Replace the incomplete verification evidence with a paired-command invalid-scope matrix covering
enums, unknown properties, types, required fields, nested collections, and composite parts. Live
HTTP and command/file sentinels prove rejection precedes source effects; valid controls establish
that both sentinels detect execution. Correct the stale 004 §5.1 bullets to reflect current duplicate
ID rejection by `validate` and full source-schema validation shared with `monitor test`.
Persistent runtime tick validation remains separately tracked. No production behavior changes.

