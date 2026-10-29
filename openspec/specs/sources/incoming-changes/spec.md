# sources/incoming-changes Specification

## Purpose

The bundled `incoming-changes` observation source (`@agentmonitors/source-incoming-changes`): watches a
local git ref and reports each file under configured paths that changed when the ref advanced. It is a
local commit-graph source; it never contacts remotes. Runtime timing and persistence stay with the
runtime per the `sources/contract` capability.

## Requirements

### Requirement: incoming-changes source registration

The system SHALL register the bundled source under the name `incoming-changes` from package `@agentmonitors/source-incoming-changes`, as part of the core source set, and SHALL offer it as an `agentmonitors init --type incoming-changes` template (issue #39) per the `cli/authoring-commands` capability.

#### Scenario: Source is available without extra installation

- **WHEN** the CLI resolves a monitor with `watch: { type: incoming-changes, paths: ['src/'] }`
- **THEN** the source registry resolves `incoming-changes` to the bundled source

### Requirement: incoming-changes scope

The scope SHALL require `paths`, an array of strings (path prefixes or globs passed as git pathspecs, schema `minItems: 1`), and accept optional `branch` (git ref, default `HEAD`) and `cwd` (repository working directory for all git calls, default the daemon process working directory). Invalid `paths` SHALL throw `scope.paths must be an array of strings`.

#### Scenario: Missing paths throws clearly

- **WHEN** a monitor omits `paths`
- **THEN** `observe()` rejects with `scope.paths must be an array of strings`

#### Scenario: Branch defaults to HEAD

- **WHEN** a monitor declares `paths: ['src/', 'lib/']` with no `branch`
- **THEN** the source resolves `HEAD`

### Requirement: incoming-changes baseline run

The source SHALL declare `stateful: true`. When there is no valid prior state, it SHALL resolve the current commit SHA via `git rev-parse`, return `nextState: { ref: '<sha>' }`, and return an empty `observations` array; it SHALL NOT report the existing tree as changed.

#### Scenario: First observation reports nothing

- **WHEN** an `incoming-changes` monitor is observed for the first time in a repo at commit `abc123`
- **THEN** `observations` is empty and `nextState` is `{ ref: 'abc123' }`

### Requirement: incoming-changes diffs the advanced range

On a subsequent call the source SHALL resolve the current SHA; if it equals the stored ref it SHALL emit nothing. Otherwise it SHALL run `git -c core.quotePath=false diff -z --name-status <previousRef>..<currentRef> -- <paths>` (NUL-delimited, no C-quoting of non-ASCII paths), emit one observation per changed file, and return `nextState: { ref: currentRef }`.

#### Scenario: Two changed files under paths

- **GIVEN** a baseline at `A`
- **WHEN** `HEAD` advances to `B`, modifying `src/a.ts` and adding `src/b.ts`
- **THEN** two observations are emitted and `nextState` is `{ ref: 'B' }`

#### Scenario: Changes outside paths are ignored

- **GIVEN** `paths: ['src/']` and a baseline at `A`
- **WHEN** `HEAD` advances to `B` touching only `docs/readme.md`
- **THEN** no observation is emitted and `nextState` is `{ ref: 'B' }`

#### Scenario: Non-ASCII path reported literally

- **WHEN** a commit adds `src/日本.ts`
- **THEN** the observation's `objectKey` is `src/日本.ts`, not a C-quoted escape sequence

### Requirement: incoming-changes change-kind mapping

The source SHALL map git `--name-status` letters to `changeKind`: `A` and `C` to `created`; `D` to `deleted`; `M`, `R`, `T`, and any other letter to `modified`. For renames and copies the reported path SHALL be the new path and `payload.status` SHALL keep the real letter (`R` or `C`).

#### Scenario: Copy reported as created with status C

- **WHEN** the diff reports a copy record `C100 src/a.ts src/a-copy.ts`
- **THEN** the observation has `objectKey` `src/a-copy.ts`, `changeKind` `created`, and `payload.status` `C`

#### Scenario: Rename reported as modified

- **WHEN** the diff reports `R100 src/old.ts src/new.ts`
- **THEN** the observation has `objectKey` `src/new.ts` and `changeKind` `modified`

### Requirement: incoming-changes observation shape

Each per-file observation SHALL carry `objectKey` (the path as reported by git), `title` and `summary` `Incoming change: <path> (<changeKind>)`, `payload` `{ path, status, fromRef, toRef }`, and `queryScope` `{ path }`. For `created`/`modified` text files, `snapshotText` SHALL be the content at `toRef` via `git show <toRef>:<path>`; it SHALL be absent for `deleted` and for binary (NUL-containing) files.

#### Scenario: Modified text file carries its new content

- **WHEN** `src/a.ts` is modified between `A` and `B`
- **THEN** the observation title is `Incoming change: src/a.ts (modified)`, `payload` is `{ path: 'src/a.ts', status: 'M', fromRef: 'A', toRef: 'B' }`, and `snapshotText` is the file content at `B`

#### Scenario: Deleted and binary files have no snapshot text

- **WHEN** one file is deleted and a binary file is added
- **THEN** both observations are emitted and neither carries `snapshotText`

### Requirement: incoming-changes reports the net diff after downtime

The resumption token SHALL be the last-seen commit SHA. When the daemon was offline across several commits, the next call SHALL diff from the stored SHA to the current ref and report the net change across all missed commits in a single batch (PP6).

#### Scenario: Three missed commits reported as one net batch

- **GIVEN** a stored ref `A`
- **WHEN** commits `B`, `C`, `D` land while the daemon is stopped, and `C` reverts `B`'s change to `src/x.ts`
- **THEN** the next observation reports `A..D` once, with no observation for `src/x.ts`

### Requirement: incoming-changes fires on any ref advance

The source SHALL fire on any advance of the watched ref that touches `paths` — a pull, merge, fast-forward, or local commit — without distinguishing whose change it is. A non-fast-forward advance (rebase, force-push) SHALL yield the net `git diff <prev>..<current>` and SHALL NOT crash.

#### Scenario: Local commit fires

- **WHEN** the user commits a change to `src/a.ts` locally
- **THEN** an observation for `src/a.ts` is emitted

#### Scenario: Rebase yields a net diff

- **WHEN** the watched branch is rebased so the new ref is not a descendant of the stored ref
- **THEN** the source reports the net diff between the two refs without throwing

### Requirement: incoming-changes never contacts remotes

The source SHALL observe the ref as resolved in the local workspace and SHALL NOT contact remotes, so upstream commits SHALL NOT be noticed until local refs advance. Watching a remote branch tip is the `command-poll` upstream-branch recipe per the `cli/authoring-commands` capability.

#### Scenario: Remote commit not yet fetched

- **WHEN** a new commit lands on `origin/main` but no fetch or pull has run locally
- **THEN** the source emits nothing for it

### Requirement: incoming-changes waits silently for an invalid repo or ref

When `git rev-parse` fails (not a git repository, unknown branch, or a `branch` value that would be parsed as an option), `observe()` SHALL return `{ observations: [] }` with no `nextState`. The user-supplied `branch` SHALL be passed after `--end-of-options` so it is always treated as a ref name, never a git flag.

#### Scenario: Not a git repository

- **WHEN** `cwd` points at a directory that is not a git repository
- **THEN** `observe()` resolves `{ observations: [] }` with no `nextState`

#### Scenario: Option-shaped branch is treated as a ref

- **WHEN** a monitor declares `branch: --help`
- **THEN** git is not given a `--help` flag; resolution fails as an unknown ref and the source returns no observations and no `nextState`

### Requirement: incoming-changes re-baselines when the diff fails

When `git diff` fails (for example the stored SHA was garbage-collected or history was rewritten), `observe()` SHALL re-baseline: return no observations, `nextState: { ref: currentRef }`, and `outcome: 'rebaselined'` so the runtime records a graceful re-baseline rather than a no-change tick.

#### Scenario: Garbage-collected stored SHA

- **GIVEN** a stored ref that no longer exists in the repository
- **WHEN** `observe()` runs
- **THEN** it returns no observations, `nextState: { ref: <current> }`, and `outcome: 'rebaselined'`

### Requirement: incoming-changes tolerates per-file snapshot failures

A failure of `git show` while fetching one file's snapshot SHALL be silenced: `snapshotText` is absent and the observation is still emitted. These guards SHALL keep source errors for repository state from propagating into the runtime tick loop.

#### Scenario: Unreadable blob still yields an observation

- **WHEN** `git show <toRef>:<path>` fails for a modified file
- **THEN** the observation for that file is emitted without `snapshotText`
