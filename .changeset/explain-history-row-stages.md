---
'@agentmonitors/core': patch
---

`monitor explain` no longer reports a recorded loss or a retry-drain report as a failed source call. Right after a terminal retry is skipped, after a span whose only observations a hold refused, after a failed retry attempt, or while a monitor is paused behind a terminal retry, the Observation stage now says which stage owns the row, and the verdict falls on Materialization. Materialization's retained-work reasons end with the oldest retry's last error. A genuine source failure still fails the Observation stage.
