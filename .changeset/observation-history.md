---
'@mike-north/core': minor
---

Record an observation-history audit trail. Each tick the runtime now writes one `observation_history` row per due monitor capturing its outcome (`triggered` / `suppressed` / `no-change`) and a `{ observed, emitted }` summary, via the new `RuntimeStore.recordObservationHistory` / `listObservationHistory` and `AgentMonitorRuntime.listObservationHistory`. Adds the exported `ObservationHistoryRecord`, `ObservationHistoryQuery`, and `ObservationOutcome` types. (The `agentmonitors monitor history` CLI reads it over the daemon socket.)
