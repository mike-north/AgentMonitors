## MODIFIED Requirements

### Requirement: Glob base resolution

For project monitors the effective `cwd` SHALL default to `ObservationContext.workspacePath` (the project directory containing `.claude`). A relative `cwd` SHALL resolve against that root; an absolute `cwd` SHALL be honored as-is. Absolute and home-relative patterns SHALL NOT involve `cwd`. Without a workspace root, a non-user-level monitor SHALL fall back to Node/glob process-cwd behavior; a user-level monitor MUST NOT.

#### Scenario: Relative globs resolve against the workspace

- **GIVEN** `context.workspacePath` is `/repo` and `globs: ['src/**/*.ts']` with no `cwd`
- **WHEN** the source observes
- **THEN** the source matches files under `/repo/src`

#### Scenario: Relative cwd resolves against the workspace

- **GIVEN** `context.workspacePath` is `/repo` and `cwd: packages/app`
- **WHEN** the source observes
- **THEN** relative globs resolve under `/repo/packages/app`

#### Scenario: Absolute cwd changes resolution but not identity

- **GIVEN** `globs: ['src/**/*.ts']` and `cwd: /workspace`
- **WHEN** `/workspace/src/a.ts` changes
- **THEN** globs resolve under `/workspace` and the observation's `objectKey` and `queryScope.filePath` are the absolute path `/workspace/src/a.ts`

#### Scenario: Absolute glob ignores cwd

- **WHEN** a pattern is `/etc/hosts`
- **THEN** it is matched as-is regardless of `cwd` or `workspacePath`

#### Scenario: Project-relative project monitor is unchanged

- **GIVEN** a project-level monitor with `globs: ['src/**/*.ts', 'package.json']`
- **WHEN** the source observes
- **THEN** both patterns resolve against `context.workspacePath` exactly as before this change

## ADDED Requirements

### Requirement: Scope class by leading character

The scope class of every pattern in a monitor's `globs` and `ignore` SHALL be determined per pattern by its leading character, with no separate `scope:` field: `/` is absolute (passed to glob expansion unchanged), `~` is home-relative (expanded, then treated as absolute), and any other character is project-relative (resolved against `context.workspacePath` and `cwd`).

#### Scenario: Classifying patterns

- **WHEN** a monitor's patterns are `/var/log/app.log`, `~/inbox.txt`, and `src/**/*.ts`
- **THEN** they are classified absolute, home-relative, and project-relative respectively

### Requirement: Home-relative expansion

A pattern whose first character is `~` MUST be expanded using the OS home directory before glob expansion: `~` alone becomes the home directory and `~/…` becomes the home directory followed by `/…`. The expanded result SHALL be an absolute pattern expanded with no `cwd` involvement.

#### Scenario: Home-relative user-level monitor observes files under home

- **GIVEN** a user-level monitor with `globs: ['~/notes/x.md']` and a home directory `/home/alice`
- **WHEN** the source observes
- **THEN** it fingerprints `/home/alice/notes/x.md`

#### Scenario: Bare tilde is the home directory itself

- **GIVEN** a user-level monitor with `globs: ['~']` and a home directory `/home/alice`
- **WHEN** the pattern is expanded
- **THEN** it becomes exactly `/home/alice`

### Requirement: Tilde-user forms are rejected

A pattern beginning with `~` followed immediately by a character other than `/` (a `~user` form) SHALL NOT be supported and MUST be rejected at `agentmonitors validate` with the error `` `~user` home expansion is not supported. Use an absolute path or `~/…` instead. ``

#### Scenario: ~alice rejected

- **WHEN** `agentmonitors validate` checks a monitor with `globs: ['~alice/notes.md']`
- **THEN** it exits non-zero with a message saying `~user` expansion is not supported and directing the author to an absolute path or `~/…`

### Requirement: Scope classes are not mixed with project-relative patterns

All patterns within one monitor's `globs` (and within its `ignore`) MUST share a scope class with respect to project-relative patterns: absolute + project-relative and home-relative + project-relative MUST be rejected at `agentmonitors validate` with an error directing the author to split into two monitors, one per scope class. Absolute + home-relative SHALL be accepted; `validate` SHOULD warn that it is unusual and MUST NOT reject it.

#### Scenario: Absolute mixed with project-relative

- **WHEN** `agentmonitors validate` checks a monitor with `globs: ['/var/log/x', 'src/foo.ts']`
- **THEN** it exits non-zero with `Mixed glob scope classes in one monitor: found absolute and project-relative patterns. Split into two monitors — one per scope class.`

#### Scenario: Home-relative mixed with project-relative

- **WHEN** a monitor declares `globs: ['~/notes.md', 'src/foo.ts']`
- **THEN** `agentmonitors validate` rejects it and directs the author to split into two monitors

#### Scenario: Absolute mixed with home-relative

- **WHEN** a monitor declares `globs: ['/var/log/app.log', '~/inbox.txt']`
- **THEN** `agentmonitors validate` accepts it, optionally with a warning

### Requirement: User-level monitors reject bare-relative globs

A MONITOR.md in a user-level monitors root (the global config root rather than a project `.claude/monitors/` directory) MUST NOT use bare-relative `globs`, and `agentmonitors validate` MUST reject it with a clear error referencing #258. Validate SHALL apply this check when invoked with `--user-level` (or equivalent context) and otherwise accept bare-relative patterns as project-relative.

#### Scenario: Bare-relative rejected at user level

- **WHEN** `agentmonitors validate --user-level` checks a monitor with `globs: ['src/**/*.ts']`
- **THEN** it exits non-zero with: Bare-relative globs in a user-level monitor are not supported (Refs #258). Use `/…` for absolute paths or `~/…` for home-relative paths instead.

#### Scenario: Bare-relative accepted without user-level context

- **WHEN** `agentmonitors validate` (no user-level context) checks a monitor with `globs: ['src/**/*.ts']`
- **THEN** the pattern is accepted as project-relative

#### Scenario: Absolute user-level monitor accepted

- **WHEN** `agentmonitors validate --user-level` checks a monitor with `globs: ['/var/log/x.log']`
- **THEN** it is accepted

#### Scenario: Fixed single file accepted

- **WHEN** `agentmonitors validate --user-level` checks a monitor with `globs: ['/etc/hosts']`
- **THEN** it is accepted as the simplest workspace-agnostic form

### Requirement: User-level monitors produce workspace-agnostic events

A user-level `file-fingerprint` monitor whose `globs` are all absolute or all home-relative SHALL produce events with `workspacePath: null`, projected into all lead sessions through the existing workspace-agnostic projection path (per the `delivery/session-projection` capability). No new projection machinery is introduced.

#### Scenario: Absolute user-level event is workspace-agnostic

- **GIVEN** a user-level monitor with `globs: ['/var/log/x.log']`
- **WHEN** `/var/log/x.log` changes
- **THEN** the materialized event has `workspacePath: null`

#### Scenario: Cross-session projection

- **GIVEN** a user-level monitor with `globs: ['~/notes/x.md']` and a lead session whose `workspacePath` is a project directory unrelated to where the monitor is defined
- **WHEN** `~/notes/x.md` changes
- **THEN** the event projects into that lead session
