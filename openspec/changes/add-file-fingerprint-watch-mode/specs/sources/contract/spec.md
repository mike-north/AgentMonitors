## MODIFIED Requirements

### Requirement: Runtime drives observe and watch

The runtime SHALL drive `observe()` on the tick loop for every source and SHALL additionally drive `watch()` continuously for sources that implement it (NP4). A watched monitor SHALL be driven only by its watcher; the tick loop skips its `observe()`. Scheduling and watcher lifecycle are specified by the `runtime/tick-scheduling` capability. The bundled `file-fingerprint` source implements `watch()`.

#### Scenario: Watched monitor is not double-driven

- **GIVEN** a source that implements `watch()` and a running daemon watching one of its monitors
- **WHEN** the tick loop finds that monitor due
- **THEN** the tick loop does not call `observe()` for it, and observations arrive only through the watcher

#### Scenario: Bundled source opts into watch

- **WHEN** `daemon run` loads a `file-fingerprint` monitor
- **THEN** the runtime drives it through `watch()`
