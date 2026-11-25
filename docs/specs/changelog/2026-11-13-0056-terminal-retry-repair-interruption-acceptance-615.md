## 2026-11-13 — Terminal retry repair interruption acceptance (#615)

- **004 §3.4.2:** require traced driver-write inventories for `monitor retry rearm`
  and `monitor retry skip`, with real-process SIGKILL and pre-write faults under
  immediate, debounce and rollup pacing. The shared ingress harness owns children,
  clocks, IPC barriers and cleanup; the serial CI step runs both suites.
- Require unchanged terminal state or one coherent repair outcome after restart,
  one automatic event/snapshot for a rearmed retry, one persistent loss for a skipped
  retry, and matching doctor counts. Successful controls exercise committed repairs;
  synchronous preload probes and a split-commit skip mutation guard the proof itself.
- Validation coverage only; repair behavior and public contracts are unchanged.

