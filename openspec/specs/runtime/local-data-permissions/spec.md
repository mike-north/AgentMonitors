# runtime/local-data-permissions Specification

## Purpose

Defines the local trust boundary: the filesystem modes Agent Monitors gives the data, hook-state,
socket, lock, coordination, and log artifacts it creates or owns, how pre-existing artifacts are
tightened safely, and when tightening degrades or fails closed (per BP4). Socket path resolution and
the IPC protocol are owned by `daemon/ipc`.

## Requirements

### Requirement: The current OS user is the trust boundary

Because persisted snapshots, events, diffs, and source state are private and the daemon socket is
unauthenticated (NP1), the system SHALL ensure no other local user can read persisted data, read
hook state, or reach the daemon socket, by establishing owner-only modes at creation time and
tightening pre-existing artifacts on startup (per BP4).

#### Scenario: Multi-user host with a permissive umask

- **GIVEN** a process umask of `022` on a multi-user host
- **WHEN** the CLI creates its database, hook state, and socket for the first time
- **THEN** none of them is readable or traversable by another local user

### Requirement: Owned directories are created 0700

The system SHALL create the per-workspace data directory, session directories (which hold hook
state), the socket directory the daemon creates, and the startup-lock directory with an explicit
`0700` (`rwx------`) mode, which a permissive umask cannot widen.

#### Scenario: Data directory mode

- **WHEN** the per-workspace data directory is created under umask `000`
- **THEN** its mode is `0700`

### Requirement: Owned files are 0600

The system SHALL write the SQLite database, its `-wal`/`-shm`/`-journal` sidecars, hook-state files,
the startup-lock pid file, the `.claude/agentmonitors.local.md` coordination file, and the `daemon
run --detach` `--log` file with mode `0600` (`rw-------`). The host tool's `.claude` directory itself
SHALL NOT be re-moded.

#### Scenario: Coordination file but not its directory

- **WHEN** the coordination file is written into an existing `.claude` directory with mode `0755`
- **THEN** the file is `0600` and the `.claude` directory remains `0755`

### Requirement: Databases are opened under a restricted umask

The system SHALL open on-disk databases under a restricted `0o077` process umask so the WAL and
shared-memory files SQLite creates itself are private from birth.

#### Scenario: WAL sidecar is private

- **WHEN** a new on-disk database is opened and SQLite creates its `-wal` file
- **THEN** the `-wal` file's mode grants no group or other bits

### Requirement: Detach log parent is tightened only at the default location

For `daemon run --detach`, the system SHALL create a missing log parent directory (default or a
missing ancestor of a custom `--log`) with mode `0700`, SHALL tighten a pre-existing parent only when
it is the default location (the workspace data directory), and SHALL leave a pre-existing custom
`--log` parent's mode unchanged.

#### Scenario: Custom shared log directory is untouched

- **GIVEN** an existing `--log` parent directory with mode `0775` chosen by the user
- **WHEN** `daemon run --detach --log <that-dir>/daemon.log` starts
- **THEN** the directory's mode remains `0775` and the log file itself is `0600`

### Requirement: Detach log file is owner-only and refuses symlinks

The system SHALL create the `--detach` log file `0600` if missing and tighten it if it already exists
as a regular file; it SHALL open it with `O_NOFOLLOW` and `fchmod` the resulting descriptor, never
the path. A symlink at the log path SHALL NOT be tightened or followed; it SHALL surface as a clean
spawn failure.

#### Scenario: Planted symlink at the log path

- **GIVEN** the `--log` path is a symlink to another file
- **WHEN** `daemon run --detach` starts
- **THEN** the spawn fails cleanly and neither the link nor its target is modified or appended to

### Requirement: Detach log descriptor tightening fails closed

When the final `fchmod` of the opened `--detach` log descriptor fails (for example `EPERM`/`EACCES`
for a log file owned by another user), the system SHALL close the descriptor and refuse to start the
detached daemon, reporting an actionable error naming the path and the underlying cause.
Rationale: the log carries workspace paths and failure details, so whether it can be secured gates startup.

#### Scenario: Log file owned by another user

- **GIVEN** a pre-existing `--log` file owned by another user that the caller can append to but not chmod
- **WHEN** `daemon run --detach` starts
- **THEN** the daemon does not start and the error names the log path and the `fchmod` cause

### Requirement: Socket is born private inside an owner-only directory

The system SHALL bind the daemon's Unix domain socket under a restricted `0o077` umask so it is born
`0600`, re-chmod it `0600` after bind as defense-in-depth, and place it inside an owner-only
directory, which is the load-bearing guard on platforms that ignore socket permission bits and
against a swapped-symlink race.

#### Scenario: Socket mode after startup

- **WHEN** `daemon run` binds its socket at the default location
- **THEN** the socket is `0600` and its parent directory is `0700`

### Requirement: Existing artifacts are tightened once per process on startup

On startup the system SHALL re-apply owner-only modes to existing databases, sidecars, hook-state
files, and Agent-Monitors-owned data, session, and socket directories — including the default socket
directory when the database is `:memory:`. Re-application SHALL be idempotent and performed once per
process, not on every steady-state hook-state write.

#### Scenario: Pre-hardening database is tightened

- **GIVEN** a database file left `0644` by an earlier version
- **WHEN** the CLI next starts and opens it
- **THEN** the database and its sidecars become `0600`

#### Scenario: In-memory database still tightens the default socket directory

- **GIVEN** a world-readable pre-existing default socket directory
- **WHEN** a daemon starts with a `:memory:` database
- **THEN** the default socket directory becomes `0700`

### Requirement: Tightening is symlink-safe

The system SHALL `lstat` a path before tightening it, SHALL refuse to act on a symlink, and SHALL
re-open the path with `O_NOFOLLOW` before `fchmod`, so a planted symlink cannot redirect a mode
change onto a file the user does not own.

#### Scenario: Symlinked hook-state path

- **GIVEN** a hook-state path that is a symlink to another user's file
- **WHEN** startup tightening runs
- **THEN** neither the symlink nor its target has its mode changed

### Requirement: User-chosen and shared directories are not tightened

The system SHALL NOT tighten a socket directory the user explicitly chose (`--socket` or
`AGENTMONITORS_SOCKET`) or a shared system directory; only Agent-Monitors-owned directories are
tightened.

#### Scenario: Explicit socket directory

- **GIVEN** `AGENTMONITORS_SOCKET` points into an existing `0755` directory
- **WHEN** the daemon starts
- **THEN** that directory's mode remains `0755`

### Requirement: Incidental tightening degrades gracefully

When tightening an artifact the system needs only to write fails with `EPERM`/`EACCES` (for example
a target owned by another user), the system SHALL emit one structured stderr warning per path per
process, leave the mode unchanged, and continue the operation rather than throw; the daemon SHALL
never die because an artifact it writes cannot be chmod'ed. The `--detach` log is the fail-closed
exception.

#### Scenario: Hook state in a shared group-writable directory

- **GIVEN** `--hook-state-path` names an existing file owned by another user in a group-writable directory
- **WHEN** hook state is written on two successive ticks
- **THEN** the write succeeds, exactly one warning is emitted for that path, and no error is thrown

### Requirement: No mode enforcement on Windows

On Windows, where POSIX modes are not meaningful, the system SHALL create these paths without mode
enforcement.

#### Scenario: Windows creation

- **WHEN** the data directory is created on Windows
- **THEN** creation succeeds without attempting POSIX mode changes
