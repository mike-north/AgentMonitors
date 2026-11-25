## 2026-06-02 — Watch-mode source execution (G5)

- The runtime now drives continuous `watch()` for opt-in sources:
  `AgentMonitorRuntime.watchMonitors(monitorsDir, workspacePath)` consumes each watch-capable
  source's `AsyncIterable<Observation>` and funnels every yielded observation through the **same**
  notify dispatch → materialization → projection pipeline as `observe()` (extracted into a shared
  `ingest()` helper, which also records the `observation_history` audit row, so watch-mode
  observations are audited identically to ticked ones). Returns a `WatchHandle` whose `stop()` aborts
  and awaits the watchers ([002 §2.3](../002-runtime-delivery.md)). `daemon run` starts/stops watchers
  around its tick loop.
- A watched monitor is skipped by the tick loop's `observe()` (no double-processing); a watcher that
  throws outside its own abort is surfaced via `onError` and released so the tick loop resumes it.
- Added `ObservationContext.signal?: AbortSignal` (passed to `watch()` for teardown) and the exported
  `WatchHandle` type. Promoted **NP4** from "the runtime does not define watch-mode" to
  "watch-mode is opt-in and additive" ([000](../000-principles.md), [003 §2](../003-source-plugins.md)).
- Closes roadmap **G5**. No bundled source opts into `watch()` yet, but the path is exercised
  end-to-end (`libs/core/src/runtime/service.test.ts`). Minor `@agentmonitors/core` changeset
  (new `watchMonitors` method, `WatchHandle` type, `ObservationContext.signal` field).

