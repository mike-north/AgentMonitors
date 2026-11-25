## 2026-06-28 — file-fingerprint project globs resolve from config root, not daemon cwd (002 §10.7, §15; 003 §3.1, §3.2; 005 §6) — Refs #193

Project-level `file-fingerprint` monitors now resolve relative `globs` and relative `cwd` from the
runtime workspace/config root (`ObservationContext.workspacePath`), not from the daemon process cwd.
Absolute `cwd` values and absolute glob patterns remain unchanged.

When a run matches zero files, `file-fingerprint` sets
`ObservationResult.outcome: "no-files-matched"`. The runtime records that distinct
`observation_history` outcome instead of ordinary `no-change`, so authors can diagnose a broken
glob/cwd separately from a watched file set with no content changes.

- **Core API:** `ObservationContext` gained optional `workspacePath`; `ObservationResult.outcome`
  gained `"no-files-matched"`; `ObservationOutcome` gained `"no-files-matched"`.
- **Runtime/CLI:** `tick()` and `watch()` pass `workspacePath` into source contexts, and
  `monitor test` derives the config root from the supplied `MONITOR.md` path for direct source
  dry-runs. `monitor test` also short-circuits `no-files-matched` results as an authoring
  diagnostic: it exits 1, prints an explicit `watch.globs` / `watch.cwd` message, and does not
  establish a baseline.
- **Tests:** `plugins/source-file-fingerprint/src/index.test.ts` covers relative glob/cwd
  resolution, absolute path preservation, and zero-match outcome. `libs/core/src/runtime/service.test.ts`
  covers runtime context propagation and the distinct history outcome.

