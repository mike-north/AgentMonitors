# sources/file-fingerprint Specification

## Purpose

The bundled `file-fingerprint` source: it detects created, modified, deleted, and descoped files by
SHA-256 fingerprinting the files matched by a monitor's globs on each `observe()` (polling), resolving
project-relative globs against the workspace root. It implements the `sources/contract` capability.

## Requirements

### Requirement: Source identity

The bundled source SHALL be named `file-fingerprint`, SHALL declare `stateful: true`, and SHALL detect change through `observe()` only (it does not implement `watch()`).

#### Scenario: Monitor selects the source

- **WHEN** a monitor declares `watch: { type: file-fingerprint, globs: '**/*.ts' }`
- **THEN** the runtime drives the bundled `file-fingerprint` source on the tick loop via `observe()`

### Requirement: Scope fields

The `file-fingerprint` config (the `watch:` block minus `type`) SHALL require `globs` and SHALL accept the optional fields `ignore` (string or array of strings), `cwd` (string), and `interval` (duration string).

#### Scenario: Full scope

- **WHEN** a monitor declares `watch: { type: file-fingerprint, globs: ['**/*.ts'], ignore: ['**/generated-*.ts'], cwd: /optional/base/path, interval: 30s }`
- **THEN** the config is valid

#### Scenario: Missing globs throws clearly

- **WHEN** `observe()` is called with a config that has no `globs`
- **THEN** it throws `scope.globs is required`

### Requirement: globs string shorthand and validation

`globs` SHALL accept either a single pattern as a bare string or an array of patterns OR-ed together; the string form SHALL be normalized to a one-element array. The source SHALL throw `scope.globs must be a string or an array of strings` for any other type, and `scope.globs must not contain empty patterns` for an empty array or an empty/blank pattern.

#### Scenario: Bare string equals one-element array

- **WHEN** a monitor declares `globs: notes.md`
- **THEN** it behaves identically to `globs: ['notes.md']`

#### Scenario: Wrong type rejected

- **WHEN** `globs: 42`
- **THEN** the source throws `scope.globs must be a string or an array of strings`

#### Scenario: Empty array rejected

- **WHEN** `globs: []`
- **THEN** the source throws `scope.globs must not contain empty patterns`

#### Scenario: Blank pattern rejected

- **WHEN** `globs: ['src/**', '  ']`
- **THEN** the source throws `scope.globs must not contain empty patterns`

### Requirement: ignore excludes matched files

`ignore` SHALL accept a single exclude pattern as a bare string or an array of exclude patterns (throwing `scope.ignore must be a string or an array of strings` or `scope.ignore must not contain empty patterns` otherwise). A path that matches `globs` and any `ignore` pattern SHALL be omitted from the baseline and from later change detection. Ignore patterns SHALL resolve against the same base as `globs` and SHALL NOT support gitignore negation.

#### Scenario: Action output does not retrigger the monitor

- **GIVEN** `globs: ['**/*.txt']` and `ignore: '**/notified-*.txt'`
- **WHEN** the monitor's action writes `notified-1700000000.txt`
- **THEN** no observation is emitted for that file and it never enters the baseline

#### Scenario: Ignore bare string equals one-element array

- **WHEN** a monitor declares `ignore: '**/notified-*.txt'`
- **THEN** it behaves identically to `ignore: ['**/notified-*.txt']`

### Requirement: Glob base resolution

For project monitors the effective `cwd` SHALL default to `ObservationContext.workspacePath` (the project directory containing `.claude`), so relative `globs` match project files. A relative `cwd` SHALL resolve against that root; an absolute `cwd` and absolute glob patterns SHALL be honored as-is. When no workspace/config root is supplied, the source SHALL fall back to Node/glob process-cwd behavior.

#### Scenario: Relative globs resolve against the workspace

- **GIVEN** `context.workspacePath` is `/repo` and `globs: ['src/**/*.ts']` with no `cwd`
- **THEN** the source matches files under `/repo/src`

#### Scenario: Relative cwd resolves against the workspace

- **GIVEN** `context.workspacePath` is `/repo` and `cwd: packages/app`
- **THEN** relative globs resolve under `/repo/packages/app`

#### Scenario: Absolute cwd changes resolution but not identity

- **GIVEN** `globs: ['src/**/*.ts']` and `cwd: /workspace`
- **WHEN** `/workspace/src/a.ts` changes
- **THEN** globs resolve under `/workspace` and the observation's `objectKey` and `queryScope.filePath` are the absolute path `/workspace/src/a.ts`

#### Scenario: Absolute glob ignores cwd

- **WHEN** a pattern is `/etc/hosts`
- **THEN** it is matched as-is regardless of `cwd` or `workspacePath`

### Requirement: Observe interval

`interval` SHALL be the per-monitor observe interval (a duration matching `^\d+[smhd]$`): the runtime calls `file-fingerprint` only when this monitor is due. When omitted the effective default SHALL be approximately `30s`. It is distinct from the daemon `--poll-ms` loop-wake interval, which controls how often the daemon checks whether any monitor is due.

#### Scenario: Omitted interval

- **WHEN** a `file-fingerprint` monitor omits `interval`
- **THEN** it is observed roughly every 30 seconds regardless of `--poll-ms`

### Requirement: Glob expansion and hashing

The source SHALL expand each glob with `absolute: true` and `nodir: true`, remove paths matched by `ignore` (expanded the same way), and compute a SHA-256 hash of each remaining file's content. A path matched by more than one glob SHALL be hashed and reported once.

#### Scenario: Overlapping globs report a file once

- **GIVEN** `globs: ['src/**/*.ts', 'src/a.ts']`
- **WHEN** `src/a.ts` changes
- **THEN** exactly one observation is emitted for it

### Requirement: Directory entries are never hashed

The matched set SHALL exclude directory entries via two layers: `nodir: true` at glob expansion (so `docs/**` means every file under `docs/`, recursively), and a symlink-following `stat` directory check immediately before hashing each surviving path. The source SHALL NOT crash with `EISDIR` on a directory-shaped match (issue #377).

#### Scenario: Globstar fingerprints only files

- **GIVEN** `globs: ['docs/**']`
- **WHEN** the source observes
- **THEN** only files under `docs/` are fingerprinted, never the `docs/` directory itself

#### Scenario: Ignore globs skip directory entries the same way

- **WHEN** an `ignore` pattern matches a directory entry
- **THEN** the directory entry is filtered without error

#### Scenario: Symlink to a directory is skipped

- **GIVEN** `docs/generated -> ../build/docs` and `globs: ['docs/**']`
- **WHEN** the source observes
- **THEN** the symlink is skipped without crashing

### Requirement: No files matched outcome

When a run matches zero files — including a glob that matches only directory entries — and emits no observations, the source SHALL return no observations with `outcome: "no-files-matched"`. This is a healthy, non-error outcome the runtime records distinctly from `no-change`; `agentmonitors monitor test` names the configured `watch.globs` value when surfacing it (per the `cli/monitor-commands` capability).

#### Scenario: Glob matching nothing

- **GIVEN** `globs: ['empty-dir/**']` where `empty-dir/` contains no files
- **WHEN** the source observes
- **THEN** it returns zero observations and `outcome: 'no-files-matched'`

#### Scenario: monitor test reports zero matches

- **WHEN** `agentmonitors monitor test` runs a zero-match `file-fingerprint` monitor
- **THEN** the output names the configured `watch.globs` value

### Requirement: Fingerprint state

The source SHALL store current fingerprints in `nextState.fingerprints`, a `Record<string, string>` keyed by absolute file path, and on each call SHALL compare each file's current hash against `context.previousState.fingerprints[filePath]`.

#### Scenario: State shape

- **WHEN** a run matches `/repo/a.ts`
- **THEN** `nextState` is `{ fingerprints: { '/repo/a.ts': '<sha256-hex>' } }`

### Requirement: Baseline run emits nothing

The first run SHALL only record fingerprints and emit no observations, so matched files are never reported as `created` on a first run. The baseline SHALL be detected by the absence of a valid prior fingerprint state in `context.previousState`.

#### Scenario: Stateful baseline returns no first-run observations

- **GIVEN** no prior source state and two matched files
- **WHEN** the source observes
- **THEN** it returns zero observations and `nextState.fingerprints` holds both files

### Requirement: Unchanged files emit nothing

After baseline, a matched file whose hash equals its prior fingerprint SHALL produce no observation.

#### Scenario: Unchanged file content does not emit observations

- **GIVEN** a baseline over `a.ts`
- **WHEN** the source observes again with `a.ts` unchanged
- **THEN** it returns zero observations

### Requirement: Created and modified classification

After baseline, a matched path with no prior fingerprint SHALL be reported with `changeKind: created`, and a matched path whose hash changed SHALL be reported with `changeKind: modified`.

#### Scenario: Changed file content emits an observation

- **GIVEN** a baseline over `a.ts`
- **WHEN** `a.ts` content changes
- **THEN** one observation with `changeKind: modified` is emitted for `a.ts`

#### Scenario: New file after baseline

- **WHEN** a new file matching the globs appears after baseline
- **THEN** one observation with `changeKind: created` is emitted for it

### Requirement: Deleted versus descoped classification

A previously tracked path no longer in the matched set SHALL be classified by stat-ing its absolute path: `deleted` when the path is gone from disk (stat reports not found), `descoped` when it still exists but is no longer matched (reachable only when the monitor's globs are edited).

#### Scenario: File removed from disk

- **WHEN** a tracked file is deleted
- **THEN** a `deleted` observation is emitted for it

#### Scenario: Globs narrowed

- **GIVEN** a tracked file `b.md` that still exists
- **WHEN** the monitor's globs are edited so `b.md` no longer matches
- **THEN** a `descoped` observation is emitted for `b.md`

### Requirement: Present-file observation shape

A `created` or `modified` observation SHALL have `title` and `summary` `File created: <absolute-path>` or `File changed: <absolute-path>`, `objectKey` the absolute path, `queryScope: { filePath }`, and `payload` and `snapshot` `{ filePath, previousHash, currentHash }` (`created` omits `previousHash`). It SHALL carry `snapshotText` (UTF-8 content) only when the file contains no null bytes.

#### Scenario: Modified text file

- **WHEN** text file `/repo/a.ts` changes
- **THEN** the observation has `title: 'File changed: /repo/a.ts'`, `objectKey: '/repo/a.ts'`, `queryScope: { filePath: '/repo/a.ts' }`, `payload: { filePath, previousHash, currentHash }`, and `snapshotText` equal to the new content

#### Scenario: Binary file omits snapshotText

- **WHEN** a matched file containing a null byte changes
- **THEN** its observation has no `snapshotText`

### Requirement: Absent-file observation shape

A `deleted` or `descoped` observation SHALL have `title` and `summary` `File deleted: <absolute-path>` or `File no longer matched by globs: <absolute-path>`, `objectKey` the absolute path, `queryScope: { filePath }`, `payload` and `snapshot` `{ filePath, previousHash }`, and no `snapshotText`.

#### Scenario: Deleted file has no content snapshot

- **WHEN** tracked file `/repo/b.ts` is deleted
- **THEN** the observation has `title: 'File deleted: /repo/b.ts'`, `payload: { filePath: '/repo/b.ts', previousHash }`, and no `snapshotText`

### Requirement: Salience policy

A `deleted` observation SHALL carry `salience: 'high'` because information is permanently lost. `created`, `modified`, and `descoped` observations SHALL carry no `salience`, so they deliver at the monitor's band floor per the clamp rule of the `sources/contract` capability.

#### Scenario: Deletion escalates within a band

- **GIVEN** a monitor with `urgency: normal..high`
- **WHEN** one watched file is deleted and another modified
- **THEN** the deletion delivers at `high` urgency and the modification at `normal`

#### Scenario: Scalar urgency is never escalated

- **GIVEN** a monitor with `urgency: normal`
- **WHEN** a watched file is deleted
- **THEN** the deletion delivers at `normal` urgency
