# @agentmonitors/source-file-fingerprint

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
