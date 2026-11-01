## Why

`file-fingerprint` detects change only by polling: every `interval` (default ~30s) it re-globs and
re-hashes the whole matched tree. That adds up to an interval of latency and repeated full-tree work
for long-lived monitors. The runtime already drives continuous `watch()` for sources that opt in
(G5/NP4, shipped) and already exposes a watch-mode source-state checkpoint (`context.checkpoint`,
002 §2.4, shipped), but no bundled source uses either. This change makes event-driven watching the
default change-detection mechanism for long-lived `file-fingerprint` monitors while keeping
`observe()` for the cases that need it.

Source: 003 §3.1 (the `backend` field and TARGET note), §3.8, §3.9, §3.10. No GitHub issue is cited
by the source doc.

## What Changes

- `file-fingerprint` implements `watch()` via `@parcel/watcher` (auto mode by default): an
  in-process native addon with prebuilt binaries and no external daemon.
- `observe()` is retained (required for `daemon once` and for filesystems that cannot deliver
  reliable events); a monitor with an active watcher is not also polled.
- Watch yields observations with the same shape, change-kind classification, and salience as
  `observe()`; an optional ~50–100 ms coalesce window absorbs editor atomic saves.
- Reconcile-on-start: on watcher boot, one `observe()` pass against the persisted fingerprint
  baseline surfaces changes made while the daemon was offline before the subscription opens.
- New optional `backend` scope field: `auto` (default) | `fs-events` | `watchman` | `inotify` |
  `kqueue` | `windows`.
- Failure policy: under `auto`, watcher-init failure falls back to polling with a loud warning
  visible in `agentmonitors monitor explain`; a pinned backend that is unavailable fails the monitor
  with an actionable error (the source checks availability itself rather than trusting
  `@parcel/watcher`, which silently falls back).
- The watcher periodically checkpoints its in-memory fingerprint state via `context.checkpoint`
  (roughly every `interval`), so a mid-watch crash does not re-deliver already-delivered changes.
- **Behavior change:** `interval` becomes a fallback-only knob (polling cadence when the watcher
  cannot be initialized, and the checkpoint cadence) for `daemon run`; `daemon once` is unchanged.

Principles: relies on NP4 (watch execution contract), PP1/PP6 (durable baseline-then-detect; no
downtime loss), PP9/NP1 (local-first, no extra daemon process), and the G14
durable-write-before-Interpret ordering. Resolves no existing contradiction.

## Capabilities

### New Capabilities

_None._

### Modified Capabilities

- `sources/file-fingerprint`: adds watch mode, reconcile-on-start, `backend` selection and failure
  policy, and watch checkpointing; `interval` semantics change.
- `sources/contract`: the bundled-source statement "no bundled source implements `watch()`" no
  longer holds.

## Impact

- `plugins/source-file-fingerprint` (new `@parcel/watcher` dependency; dependency audit must stay
  clean; prebuilt native binaries must work in the standalone-consumer and publish dry-run checks).
- `apps/cli` `monitor explain` surfaces the polling-fallback warning and pinned-backend failure
  (command surface per `cli/monitor-commands`); `daemon run`/`daemon once` error output.
- No core contract change: `watch()`, `context.signal`, and `context.checkpoint` already exist.
- Published packages: `@agentmonitors/source-file-fingerprint`, possibly `@agentmonitors/cli`
  (changeset); `apps/website` file-fingerprint docs.
