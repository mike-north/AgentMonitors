---
'@agentmonitors/core': patch
---

Add `skippedMonitors` field to `RuntimeTickResult`

`RuntimeTickResult` now includes `skippedMonitors: SkippedMonitor[]`, populated from the same scheduling decision that gates evaluation. Each entry carries `monitorId` and `nextDueAt` (the earliest time the monitor will be due). `SkippedMonitor` is exported from the public API surface.
