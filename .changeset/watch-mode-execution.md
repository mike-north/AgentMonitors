---
'@agentmonitors/core': minor
---

Drive continuous `watch()` source execution (G5). The runtime now drives watch-capable sources via the new `AgentMonitorRuntime.watchMonitors(monitorsDir, workspacePath)`, which consumes each source's `AsyncIterable<Observation>` and funnels every yielded observation through the same notify dispatch → event materialization → session projection pipeline as `observe()`. It returns a `WatchHandle` whose `stop()` aborts and awaits the watchers; a watched monitor is skipped by the one-shot tick loop so it is never driven twice. Adds `ObservationContext.signal?: AbortSignal` (passed to `watch()` for teardown) and the exported `WatchHandle` type. `observe()` remains required on every source as the one-shot fallback.
