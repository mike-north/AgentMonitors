## MODIFIED Requirements

### Requirement: Source identity

The bundled source SHALL be named `file-fingerprint`, SHALL declare `stateful: true`, and SHALL implement both `watch()` and `observe()`. Watch mode SHALL be the default change-detection mechanism for long-lived `file-fingerprint` monitors.

#### Scenario: Monitor selects the source

- **WHEN** a monitor declares `watch: { type: file-fingerprint, globs: '**/*.ts' }` under `daemon run`
- **THEN** the runtime drives the bundled `file-fingerprint` source through its `watch()` implementation

### Requirement: Scope fields

The `file-fingerprint` config (the `watch:` block minus `type`) SHALL require `globs` and SHALL accept the optional fields `ignore` (string or array of strings), `cwd` (string), `interval` (duration string), and `backend` (string, default `auto`).

#### Scenario: Full scope

- **WHEN** a monitor declares `watch: { type: file-fingerprint, globs: ['**/*.ts'], ignore: ['**/generated-*.ts'], cwd: /optional/base/path, interval: 30s, backend: auto }`
- **THEN** the config is valid

#### Scenario: Missing globs throws clearly

- **WHEN** `observe()` is called with a config that has no `globs`
- **THEN** it throws `scope.globs is required`

### Requirement: Observe interval

`interval` (a duration matching `^\d+[smhd]$`, default approximately `30s`) SHALL be a fallback-only knob under `daemon run`: the polling cadence used when the watcher cannot be initialized, and the watch checkpoint cadence. It is distinct from the daemon `--poll-ms` loop-wake interval.

#### Scenario: Interval governs fallback polling

- **GIVEN** `backend: auto`, `interval: 1m`, and a watcher that fails to initialize
- **WHEN** the daemon runs
- **THEN** the monitor is polled via `observe()` roughly every minute

#### Scenario: Omitted interval

- **WHEN** a monitor falls back to polling and omits `interval`
- **THEN** it is polled roughly every 30 seconds regardless of `--poll-ms`

## ADDED Requirements

### Requirement: Watch implemented with @parcel/watcher

`file-fingerprint`'s `watch()` MUST be implemented via `@parcel/watcher` (auto mode by default), an in-process native addon with prebuilt binaries that needs no external daemon, preserving the local-first posture (PP9, NP1).

#### Scenario: No extra process

- **WHEN** a `file-fingerprint` watcher is running under `backend: auto` without Watchman installed
- **THEN** no additional daemon process is started for watching

### Requirement: observe is retained alongside watch

`file-fingerprint` MUST keep implementing `observe()`. `daemon once` MUST call `observe()` directly regardless of `watch()`, and polling remains the mechanism for filesystems that cannot deliver reliable events. While a watcher is active for a monitor, the tick loop MUST skip that monitor's `observe()` (NP4).

#### Scenario: daemon once polls

- **WHEN** `agentmonitors daemon once` evaluates a `file-fingerprint` monitor
- **THEN** it calls `observe()` and opens no watcher

#### Scenario: Active watcher suppresses tick-loop observe

- **GIVEN** an active watcher for a monitor
- **WHEN** the tick loop finds the monitor due
- **THEN** it does not call `observe()` for that monitor

### Requirement: Watch yields observe-equivalent observations

`watch()` SHALL open a subscription for the resolved glob tree (`cwd` + `globs` + `ignore`). On a filesystem event for a matched path it SHALL re-compute the file's SHA-256 fingerprint, compare against its in-memory fingerprint state, yield one observation per changed, created, or deleted path with the same shape, change-kind classification, and salience as `observe()`, then update the in-memory state.

#### Scenario: Modified file yields a modified observation

- **GIVEN** an active watcher whose in-memory state holds `/repo/a.ts`
- **WHEN** `/repo/a.ts` content changes on disk
- **THEN** the watcher yields one observation with `changeKind: modified` and `title: 'File changed: /repo/a.ts'`

#### Scenario: Deleted file keeps high salience

- **WHEN** a watched file is deleted while the watcher runs
- **THEN** the watcher yields a `deleted` observation with `salience: 'high'`

### Requirement: Watch coalesce window

The watcher MAY apply a small internal coalesce window (~50–100 ms) before emitting, to absorb editor atomic-save sequences (write temp file, then rename) as a single change. The window MUST NOT affect the observation shape.

#### Scenario: Atomic save yields one change

- **WHEN** an editor writes `a.ts.tmp` and renames it over `a.ts` within 50 ms
- **THEN** the watcher yields a single `modified` observation for `a.ts`

### Requirement: Watch stops on abort

When `context.signal` fires (daemon shutdown, monitor removal, or watcher error), `watch()` MUST close the underlying `@parcel/watcher` subscription and stop yielding.

#### Scenario: Monitor removal closes the subscription

- **GIVEN** an active watcher
- **WHEN** its monitor is removed and the runtime aborts `context.signal`
- **THEN** the subscription is closed and no further observations are yielded

### Requirement: Reconcile on watcher start

When a watcher boots (daemon startup or restart) it MUST, before opening the subscription: load the persisted fingerprint baseline; run one full `observe()` pass against the current tree, emitting any resulting observations through the normal ingest pipeline; and record the updated state as the in-memory watcher baseline. Changes made while the daemon was offline SHALL NOT be lost (PP1, PP6).

#### Scenario: Downtime changes are reconciled

- **GIVEN** a persisted baseline over `foo.ts` and `bar.ts` and a daemon stopped for two minutes during which `foo.ts` is modified and `bar.ts` deleted
- **WHEN** the daemon restarts and the watcher boots
- **THEN** a `modified` observation for `foo.ts` and a `deleted` observation for `bar.ts` are emitted before the subscription opens

#### Scenario: Reconcile precedes OS events

- **WHEN** a test stops the daemon, mutates a watched file, restarts, and immediately runs the watcher boot sequence
- **THEN** the mutation is surfaced as a reconcile observation before any OS-level watcher event arrives

### Requirement: Backend selection

The optional `backend` scope field SHALL select the watching mechanism: `auto` (default; Watchman if installed, otherwise FSEvents / inotify / ReadDirectoryChangesW / kqueue), `fs-events` (macOS FSEvents), `watchman` (Watchman, installed separately), `inotify` (Linux), `kqueue` (BSD/macOS), or `windows` (ReadDirectoryChangesW).

#### Scenario: Omitted backend

- **WHEN** a monitor omits `backend`
- **THEN** the source uses `auto`

### Requirement: Auto backend falls back to polling loudly

If watcher initialization fails under `backend: auto` (e.g. a network mount that delivers no events, or the native addon cannot load), the source MUST fall back to the `observe()` poll path at the `interval` cadence (default 30s) and MUST surface a warning on the monitor, visible in `agentmonitors monitor explain`, that watch mode is unavailable and the monitor is polling. Degradation MUST NOT be silent.

#### Scenario: Forced init failure under auto

- **GIVEN** `backend: auto` and watcher initialization forced to fail
- **WHEN** the daemon runs the monitor
- **THEN** the monitor is polled via `observe()` and `agentmonitors monitor explain` shows the watch-unavailable warning

### Requirement: Pinned backend fails loudly

If a pinned backend (`fs-events`, `watchman`, `inotify`, `kqueue`, `windows`) is unavailable, the source MUST fail the monitor with a clear, actionable error and MUST NOT fall back to another native backend or to polling. Because `@parcel/watcher` itself falls back silently, the source MUST check backend availability before delegating to it.

#### Scenario: Watchman pinned but not installed

- **GIVEN** `backend: watchman` on a machine without Watchman
- **WHEN** the daemon starts the monitor
- **THEN** the monitor fails with `file-fingerprint: pinned backend 'watchman' is not available on this system`, surfaced in `daemon once` / `daemon run` error output and in `agentmonitors monitor explain`
- **AND** the monitor is not polled and no other backend is used

### Requirement: Watch checkpoints fingerprint state

While `watch()` runs, the source MUST periodically checkpoint its updated fingerprint state through `context.checkpoint` (per the `runtime/tick-scheduling` capability), roughly every `interval` (default 30s). The checkpoint MUST be durable before the runtime interprets the accompanying observation (G14). A failed checkpoint write SHOULD be treated as transient: log a warning and keep watching.

#### Scenario: Crash after checkpoint does not re-deliver

- **GIVEN** a watcher that yielded and checkpointed changes A and B, then observed change C
- **WHEN** the daemon crashes before the next checkpoint and restarts
- **THEN** the reconcile-on-start pass reports only changes after the last checkpoint and does not re-report A or B

#### Scenario: Checkpoint failure does not abort the watcher

- **WHEN** a checkpoint write fails
- **THEN** the watcher logs a warning and continues yielding observations
