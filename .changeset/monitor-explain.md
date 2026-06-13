---
'@agentmonitors/core': minor
'@agentmonitors/cli': minor
---

Add `agentmonitors monitor explain`, a read-only daemon-backed diagnosis report for a monitor's definition, scheduling, observation, notify, event materialization, and delivery projection state. A genuinely idle monitor (the watched target hasn't changed) reports a distinct `healthy` stage status (rendered `○`) with an affirmative "not a bug" verdict rather than a failure; the report is scoped to the explained workspace so a same-id monitor in another workspace cannot leak its events or projections; and the command surfaces a real daemon-side error instead of masking it as "daemon not running".
