---
'@mike-north/core': minor
---

Reject duplicate monitor IDs. Monitor IDs are derived from folder names and must be unique within a tree; previously, two folders with the same basename silently aliased each other's persisted monitor state. `scanMonitors` now reports collisions via a new `ScanResult.duplicateIds` field (`DuplicateMonitorId[]`), and the runtime tick refuses to run when any duplicate is present. The `agentmonitors validate` and `scan` commands surface duplicates (validate exits non-zero).
