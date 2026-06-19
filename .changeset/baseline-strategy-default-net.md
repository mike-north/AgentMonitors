---
'@agentmonitors/core': minor
---

Default `baseline-strategy` changed from `incremental` to `net` (per-object consolidation, Refs #110)

The standard delivery contract is now **one before/after delta per changed object per notification
window**: monitors that omit `baseline-strategy` now receive `net` behavior by default.

**Before (old default):** omitting `baseline-strategy` yielded `incremental` — every observation in
a recipient's catch-up span was delivered as its own ordered delta (play-by-play). A recipient that
missed N saves received N events.

**After (new default):** omitting `baseline-strategy` yields `net` — the catch-up span is collapsed
per `(monitorId, objectKey)` to a single before/after delta (cursor → endpoint), with intermediate
saves recorded claimed-but-suppressed. A recipient that missed N saves of one object receives one
event carrying the net before/after change. Multiple objects changed in the same window each produce
their own event in the claim envelope (per object, not per monitor).

**Migration:** monitors that need the full ordered play-by-play history (e.g. comment threads where
each reply is a discrete step) must now declare `baseline-strategy: incremental` explicitly.
Monitors that want "where things stand now vs. my baseline" (the common case for spec docs, shared
files, and any monitor where intermediate churn is noise) work correctly with the new default and
need no change.

No runtime logic was changed — only the schema default
(`z.enum(['incremental', 'net']).default('incremental')` → `.default('net')`). The per-recipient
`collapseNetForClaim` machinery (shipped in G10 PR-B) is unchanged.
