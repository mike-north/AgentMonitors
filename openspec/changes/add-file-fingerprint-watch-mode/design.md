## Context

The runtime already supports continuous `watch()` execution (NP4; the tick loop skips a watched
monitor) and a watch-path source-state checkpoint (`context.checkpoint`, durable before the
accompanying observation is ingested). `file-fingerprint` is the first bundled source to opt in.
Source: 003 §3.8–§3.10.

## Goals / Non-Goals

**Goals:** event-driven change detection as the default for long-lived `file-fingerprint` monitors;
no lost changes across downtime or mid-watch crashes; never-silent degradation.

**Non-Goals:** changing the observation shape, change-kind classification, or salience policy;
removing polling; changing the core `watch()`/checkpoint contract.

## Decisions

- **`@parcel/watcher` in auto mode.** In-process N-API addon that picks the most capable backend
  (FSEvents, inotify, ReadDirectoryChangesW, or Watchman when installed), ships prebuilt binaries
  (no compile-on-install), and needs no external daemon — preserving the ordinary dev-tool process
  posture (PP9, NP1).
- **Keep `observe()` (non-negotiable).** `daemon once` runs a single in-process tick with no event
  loop to host a watcher, and network/FUSE/overlay/container filesystems cannot deliver reliable OS
  events; polling is the only correct mechanism there.
- **Reconcile-on-start before subscribing.** One `observe()` pass against the persisted baseline
  closes the downtime window; it flows through the normal notify → materialize → project pipeline.
- **Two failure policies.** `auto` degrades to polling with a loud, explain-visible warning; a pinned
  backend is a hard author requirement (typically chosen because `auto` would pick a weaker
  mechanism for a very large tree) and fails the monitor.
- **Source-side availability check for pinned backends.** `@parcel/watcher` natively falls back to
  its default backend when the pinned one is unavailable, so the source probes availability itself
  (e.g. the `watchman` binary or socket) before delegating.
- **Checkpoint roughly every `interval`.** Bounds re-delivery after a mid-watch crash to changes since
  the last checkpoint; a failed checkpoint is a transient durability gap, not a reason to stop
  watching.

## Alternatives rejected

- **Replace `observe()` with `watch()`.** Rejected: breaks `daemon once` and unreliable filesystems.
- **Silent fallback to polling under `auto`.** Rejected: masks infrastructure problems (e.g. a
  developer unaware a network mount cannot deliver events) and defeats backend selection.
- **Pinned backend falls back like `auto`.** Rejected: silently ignores an explicit author
  requirement with no signal.
- **Delegate the pinned-backend check to `@parcel/watcher`.** Rejected: the library's own fallback
  would violate the fail-loud policy.
- **No checkpointing (persist state only via `observe()`'s `nextState`).** Rejected: a mid-watch
  crash would re-observe from the last persisted baseline and re-deliver already-acknowledged
  changes.

## Risks / Trade-offs

- Native addon distribution: prebuilt binaries must be present for every supported platform in the
  published package; covered by the standalone-consumer and publish dry-run checks.
- The ~50–100 ms coalesce window trades a small latency for one event per atomic save.
