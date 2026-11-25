## 2026-06-01 — Observation history audit trail (G6)

- The runtime now **writes `observation_history`** — for each due monitor per tick it records the
  outcome (`triggered` / `suppressed` / `no-change`) plus a `{ observed, emitted }` summary, via the
  new `RuntimeStore.recordObservationHistory` / `listObservationHistory`
  ([002 §"Persistence Schema"](./002-runtime-delivery.md)).
- Added a daemon IPC method `history.list` and the `agentmonitors monitor history [monitorId]`
  command to read it ([005 §6](./005-cli-reference.md)) — a "why didn't my monitor fire?" diagnostic.
- Closes roadmap **G6** (the dead table now has a write path **and** a reader). Runtime + CLI
  integration tests added; minor `@agentmonitors/core` changeset (new `RuntimeStore` methods, exported
  `ObservationHistoryRecord` / `ObservationHistoryQuery` / `ObservationOutcome` types, runtime write).

