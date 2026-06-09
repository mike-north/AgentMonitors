---
'@mike-north/core': minor
---

Add `body` field to `DeliveryEventSummary` so delivery transports can surface the monitor's body-instructions alongside the title and summary. The field carries the raw `MonitorEventRecord.body` (`observation.body ?? monitor.instructions`) and is populated in both the settled-high and recap delivery paths.
