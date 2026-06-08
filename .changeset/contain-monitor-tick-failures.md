---
'@mike-north/core': minor
---

Contain per-monitor failures in the runtime tick loop. Each due monitor's `observe()` + ingest now runs inside a failure boundary, so an operational error thrown by one source (e.g. the `incoming-changes` source shelling out to git) no longer aborts the whole tick or starves the other due monitors. On failure the runtime records an `observation_history` row with the new `error` outcome (`observationData: { error: <message> }`), logs to stderr with the monitor id and source name, and leaves the failing monitor's persisted source/notify/`lastObservationAt` state untouched so it stays due and retries cleanly on the next tick. `ObservationOutcome` gains the `error` member and `agentmonitors monitor history` surfaces it. A monitor referencing an unknown source remains a hard tick failure (a configuration error, not an operational one). No DB migration — the `observation_history.result` column has no `CHECK` constraint.
