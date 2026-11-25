## 2026-06-30 — Event-driven file watching for `file-fingerprint`: `watch()` opt-in, `backend` field, reconcile-on-start, and watch-checkpoint contract (003 §3.1, §3.8–§3.10; 002 §2.4) — Refs #192

Ratifies the 2026-06-30 design-session decision. All new rules are marked **target** (not current);
none of this is implemented yet. The `file-fingerprint` source graduates to the first production
adopter of the `watch()` path.

### 003 §3.1 — `backend` scope field added (target)

The `file-fingerprint` scope schema gains an optional `backend` field
(`auto` | `fs-events` | `watchman` | `inotify` | `kqueue` | `windows`, defaulting to `auto`).
The field controls which `@parcel/watcher` backend is used for the watcher. Its failure-policy
semantics are specified in §3.9.

### 003 §3.8 — `watch()` opt-in and reconcile-on-start (target)

`file-fingerprint` MUST implement `watch()`, making it the default change-detection mechanism for
long-lived monitors. The watcher uses `@parcel/watcher` in auto mode (FSEvents / inotify /
ReadDirectoryChangesW / Watchman transparently, in-process, no mandatory external daemon).
`observe()` is retained — non-negotiably — for `daemon once` and for filesystems that cannot
deliver reliable events.

**Reconcile-on-start**: at watcher boot the source MUST run a one-shot `observe()` diff against
the persisted fingerprint baseline to surface changes that occurred while the daemon was offline.
No downtime loss.

### 003 §3.9 — Backend failure policy (target)

Two distinct policies:

- **`auto` (default)**: watcher-init failure → fall back to polling + **loud warning** on the
  monitor (visible in `agentmonitors monitor explain`). Never silent.
- **Pinned backend** (`fs-events`, `watchman`, etc.): unavailable → **fail the monitor** with a
  clear error. No silent swap to another native backend, no silent poll fallback. The implementation
  MUST check backend availability itself before delegating to `@parcel/watcher`, because the library's
  own behavior is to fall back to its default backend when the pinned one is unavailable.

### 003 §3.10 — Periodic source-state checkpointing during watch (target)

During `watch()`, the source MUST periodically write back its updated `FingerprintState` to the
runtime via a new `context.checkpoint(nextState)` callback. This prevents mid-watch crash from
causing duplicate deliveries on restart. The checkpoint MUST be durable before any subsequent
observation is processed (G14 ordering).

### 002 §2.4 — Watch-mode source-state checkpointing contract (target, new section)

The runtime MUST support a `context.checkpoint?: (nextState: unknown) => Promise<void>` callback
on `ObservationContext`, available only to `watch()` implementations. The runtime MUST:

- Persist the provided `nextState` into the monitor's `monitorState.sourceState` durably before
  processing further observations from the same watcher (G14 ordering invariant).
- Serialize checkpoint writes with `ingest()` calls per-watcher to uphold this ordering.
- NOT deliver or materialize any observation as a side effect of a checkpoint.

A checkpoint failure MUST NOT abort the watcher; the source logs a warning and continues.

The former `### 2.4 Tick result` is renumbered `### 2.5 Tick result`; cross-references in §10.1
and §10.2 updated accordingly.

