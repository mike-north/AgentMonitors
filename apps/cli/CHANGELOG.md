# @agentmonitors/cli

## 0.6.0

### Minor Changes

- 5c748a4: `daemon once` and the `daemon run` periodic tick log now report monitors whose `observe()` errored on a tick instead of printing a clean `emitted 0 event(s)`. The runtime tick result gains an `erroredObservations: { monitorId, message }[]` field (populated from the same path that records each `errored` row in `observation_history`), and the CLI surfaces a non-zero errored count plus each errored monitor's id and message without a verbose flag. A genuine no-change tick is unchanged, so an author can finally distinguish a broken source from a watched target that simply hasn't changed.

### Patch Changes

- Updated dependencies [5c748a4]
  - @agentmonitors/core@0.7.0
  - @agentmonitors/source-api-poll@0.2.2
  - @agentmonitors/source-command-poll@0.2.2
  - @agentmonitors/source-file-fingerprint@0.2.3
  - @agentmonitors/source-incoming-changes@0.2.3
  - @agentmonitors/source-schedule@0.1.3
