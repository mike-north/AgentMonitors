# @agentmonitors/source-file-fingerprint

## 0.4.0

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

- d519192: Fix a crash in `file-fingerprint` when a `watch.globs` pattern matches a directory entry.
  Globstar patterns like `docs/**` match the directory `docs/` itself, in addition to every file
  under it; the source previously tried to `fs.readFile` that directory entry and crashed with an
  unhandled `EISDIR`. Directory entries are now filtered out before fingerprinting, so `docs/**`
  behaves as "every file under `docs/`, recursively" and no longer crashes.

  `agentmonitors monitor test`'s "no files matched" message now names the configured `watch.globs`
  value, so authors can tell a genuinely bad glob apart from a glob that matched files with no
  changes since baseline.

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

## 0.3.1

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

## 0.3.0

### Minor Changes

- fe357f3: Accept a single `globs` pattern as a bare string in `file-fingerprint` scope (003 §3)

  The most common file-watching case — one file or one glob — can now be written as
  `globs: notes.md` instead of `globs: ['notes.md']`. `globs` accepts either a string (a single
  pattern) or an array of strings (multiple patterns, OR-ed together); the string form is normalized
  to a one-element array internally. The scope schema validates both forms, and empty patterns (an
  empty string, an empty array, or any blank entry) are rejected with a clear message. Backward
  compatible — every existing array-form monitor is unchanged.

- 3874f52: Add optional `ignore` exclude globs so file-fingerprint monitors can omit generated files from baseline and change detection.
- 5ce5979: `file-fingerprint` now emits `salience: 'high'` for `deleted` observations (file removed from disk — information permanently lost) and no `salience` for `created`, `modified`, or `descoped` observations. This makes RANGE urgency (`urgency: normal..high`) reachable end-to-end with a bundled source: a deletion fires at `high` urgency within the band; all other changes remain at the band floor (`normal`). Monitors with a bare scalar `urgency` are unaffected (backward compatible).

### Patch Changes

- 19f2d8d: `file-fingerprint` project monitor globs now resolve relative paths from the runtime workspace/config root instead of the daemon process cwd.

  Core now passes `workspacePath` to source observation contexts and records a distinct `no-files-matched` observation outcome when a source can tell that a zero-observation run matched no files. The bundled `file-fingerprint` source uses that context for relative `globs` and relative `cwd`, while preserving absolute `cwd` values and absolute glob patterns. `agentmonitors monitor test` now derives the same config root from the supplied `MONITOR.md` path so dry-runs match daemon ticks.

- 0b8fece: Clarify the file-fingerprint `cwd` schema description.

  The source schema now says omitted `cwd` defaults to the workspace/config root, that relative `cwd`
  values resolve against that root, and that absolute `cwd` values are used as-is. This metadata is
  visible through `agentmonitors source list`.

- ae664c7: Accept a bare string for `ignore` exclude globs, matching the existing `globs` shorthand.
- 1f27b2e: Surface the file-fingerprint observe interval in source metadata and CLI source listing.

  The file-fingerprint source schema now documents the `watch.interval` knob and its 30s default, and
  `agentmonitors source list` includes per-field descriptions so authors can see that the interval is
  tunable without reading source code.

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
