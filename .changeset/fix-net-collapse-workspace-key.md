---
'@agentmonitors/core': patch
---

Fix: `collapseNetForClaim` now includes `workspacePath` in its object-identity key (regression #186)

`collapseNetForClaim` grouped claim candidates by `(monitorId, objectKey)` without `workspacePath`.
For a global (null-workspace) lead session — which receives projections from all workspaces — a
`net` monitor with the same `(monitorId, objectKey)` materialized in two distinct workspaces had
both events folded into one net group. Only the globally-newest event was delivered; the other
workspace's newest event was wrongly recorded as `net_suppressed`, silently dropping a delivery and
violating workspace isolation (002 §1.1.7).

The grouping key in both the candidate-group pass and the newest-per-group pass is now the 3-tuple
`[monitorId, objectKey, workspacePath ?? '']`, matching `advanceCursorsForClaimedEvents` and the
`session_object_cursor` UNIQUE index. Single-workspace collapse behaviour is unchanged.
