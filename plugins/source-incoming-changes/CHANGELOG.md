# @agentmonitors/source-incoming-changes

## 0.4.0

### Minor Changes

- 2380ebe: Commit each finite poll span, its ordered retry suffix, and source/notify checkpoints together before optional interpretation. Preserve committed recipient-cache state when admission rolls back.

  When the retry outbox cannot hold a failed observation's whole ordered suffix, because the monitor's outbox is full or a value cannot be stored (such as a BigInt payload), that observation is recorded as `errored` with the reason. Its siblings still materialize and the source checkpoint advances, so the monitor keeps making progress. A rollup window clears its held batch only in the same commit as the flushed observations. A flush that fails leaves the window held and reports the error.

  Breaking source-plugin migration (pre-1.0): `watch()` now yields finite `ObservationResult` batches,
  not individual observations, and `ObservationContext.checkpoint` is removed. Yield
  `{ observations: [...], nextState }` so all covered observations and the source checkpoint commit
  together before interpretation or the next iterator pull. Empty batches support baseline-only
  updates. Failed admission stops the iterator and preserves the old baseline; legacy bare yields
  are rejected. Poll signatures are unchanged.

  The five bundled source packages publish the same source contracts through their exported types and
  default source values. Their minor releases carry this breaking type migration too, even though
  their own implementations use polling and require no runtime changes.

### Patch Changes

- d6c56a3: Report unavailable incoming-changes repositories and refs as recoverable source errors instead of successful empty baselines. Resolve authored revision expressions unchanged, then verify the resolved object ID peels to a commit; reject blob paths without changing valid commit-search semantics in SHA-1 or SHA-256 repositories. Capture Git stderr and retain the last-good source state for recovery. Source consumers must now handle observation rejection for unavailable inputs through the existing error contract.

  Require initial state before monitor test claims a baseline. Include source errors in history text and explain using bounded single-line display, without rewriting stored audit data. Existing source-error retry cadence and held-notification deferral remain unchanged.

- Updated dependencies [ab9b6ad]
- Updated dependencies [71c44fa]
- Updated dependencies [2380ebe]
- Updated dependencies [65351d0]
- Updated dependencies [cb92b95]
- Updated dependencies [d30c9a1]
- Updated dependencies [3b205ed]
- Updated dependencies [57e2878]
- Updated dependencies [3b205ed]
- Updated dependencies [f194a12]
- Updated dependencies [e9f3fdf]
- Updated dependencies [aa5b437]
- Updated dependencies [820c190]
- Updated dependencies [36307ad]
- Updated dependencies [587d0a9]
- Updated dependencies [caa2452]
- Updated dependencies [2380ebe]
- Updated dependencies [7265259]
- Updated dependencies [d6c56a3]
- Updated dependencies [ae08f21]
- Updated dependencies [587d0a9]
- Updated dependencies [1cbef80]
- Updated dependencies [2380ebe]
- Updated dependencies [8ce3139]
- Updated dependencies [587d0a9]
- Updated dependencies [28e6e00]
- Updated dependencies [7c30c92]
- Updated dependencies [d1649cf]
- Updated dependencies [2380ebe]
  - @agentmonitors/core@0.14.0

## 0.3.2

### Patch Changes

- Updated dependencies [81ac973]
- Updated dependencies [b474d10]
- Updated dependencies [784e627]
- Updated dependencies [dea1510]
- Updated dependencies [fde6b6a]
- Updated dependencies [97b0673]
- Updated dependencies [8084b10]
- Updated dependencies [9e6cf2f]
- Updated dependencies [fde6b6a]
- Updated dependencies [518f610]
- Updated dependencies [c8d16cd]
- Updated dependencies [dea1510]
  - @agentmonitors/core@0.13.0

## 0.3.1

### Patch Changes

- Updated dependencies [2f0a9d3]
  - @agentmonitors/core@0.12.0

## 0.3.0

### Minor Changes

- 24e7685: Re-export `ChangeKind`, `JsonSchema`, `Observation`, `ObservationContext`, `ObservationResult`,
  `ObservationSource`, and `Urgency` (all from `@agentmonitors/core`) from each package's own entry
  point.

  Every bundled source's default export is typed `ObservationSource`, but that type — and the core
  types its interface shape transitively references — were previously reachable only via
  `@agentmonitors/core` directly, not from the source package itself. Enabling API Extractor's report
  generation (issue #285) surfaced this as `ae-forgotten-export` warnings embedded in each package's
  checked-in API report; re-exporting resolves it with a clean signature. No runtime behavior changes.

### Patch Changes

- Updated dependencies [24e7685]
- Updated dependencies [a7b5729]
- Updated dependencies [8638936]
- Updated dependencies [e201c48]
- Updated dependencies [89e705f]
- Updated dependencies [36a2e48]
- Updated dependencies [9f141bb]
- Updated dependencies [720d072]
- Updated dependencies [4e46c41]
  - @agentmonitors/core@0.11.0

## 0.2.6

### Patch Changes

- fd2aeff: Declare the supported Node runtime and complete npm package metadata on every published package.
  Each package now declares `"engines": { "node": ">=24" }` — a floor at Node 24, the version CI tests — so
  an install on an unsupported Node release gets an actionable npm compatibility warning instead of
  an opaque runtime/native-addon failure. Each package also declares consistent
  `repository`/`bugs`/`homepage` metadata (pointing at its subdirectory of this repo) and ships a
  `README.md`, and the root README states the Node 24 requirement in its install instructions. The
  release-collateral validation run by `pnpm publish:packages:dry-run` (and CI's `publish-dry-run`
  job) now fails loudly if any published package is missing `engines.node`, `repository`, `bugs`,
  `homepage`, `README.md`, or `LICENSE`.
- d4299cf: Relicense the published packages under the MIT License. Each package now declares `"license": "MIT"` and ships a `LICENSE` file in its published tarball.
- Updated dependencies [a4c642f]
- Updated dependencies [867f8b7]
- Updated dependencies [fd2aeff]
- Updated dependencies [697b525]
- Updated dependencies [77d9568]
- Updated dependencies [d4299cf]
- Updated dependencies [0504103]
- Updated dependencies [b7e2711]
  - @agentmonitors/core@0.10.0

## 0.2.5

### Patch Changes

- Updated dependencies [8dbda37]
- Updated dependencies [dcb7ae9]
- Updated dependencies [0dd2223]
- Updated dependencies [33e2f0d]
- Updated dependencies [1836f04]
- Updated dependencies [19f2d8d]
- Updated dependencies [50db864]
- Updated dependencies [745b6fb]
- Updated dependencies [094fc2b]
- Updated dependencies [3ecc9bb]
- Updated dependencies [3e197fc]
- Updated dependencies [8a9388c]
- Updated dependencies [7ab21d3]
- Updated dependencies [e0b52bd]
- Updated dependencies [14c6b94]
  - @agentmonitors/core@0.9.0

## 0.2.4

### Patch Changes

- Updated dependencies [dfb124a]
- Updated dependencies [07f8cf7]
  - @agentmonitors/core@0.8.0

## 0.2.3

### Patch Changes

- Updated dependencies [5c748a4]
  - @agentmonitors/core@0.7.0
