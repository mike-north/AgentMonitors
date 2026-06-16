---
'@agentmonitors/core': minor
---

Per-recipient baseline seam + per-recipient Diff (roadmap G10 PR-A, 002 §1.1.2)

The runtime now materializes **one** shared `monitor_events` row per observation and computes a
**per-recipient** delta for each projected lead session — the shaped artifact diffed against **that
session's own baseline cursor** — recorded on the new `session_event_state.diff_text`. Two sessions
at divergent stored baselines each receive the correct span from one shared observation (capability
C15). The shared object-level diff is retained on `monitor_events.diff_text` for `events
list`/history display.

A new durable table `session_object_cursor` holds each recipient's per-object baseline cursor
(unique on `(session_id, monitor_id, object_key, workspace_path)`, with `baseline_content`
denormalized for prune-immunity). Cursor semantics: a recipient's first projection of an object
seeds its cursor caught-up to the pre-event state (a late joiner hears only changes after it
registered); the cursor advances at claim (`markClaimed`); cursors persist across dormancy and
survive a daemon restart (BP1).

New public API on `RuntimeStore`: `getSessionObjectCursor` / `seedSessionObjectCursor` /
`advanceSessionObjectCursor` / `perRecipientDiffsForSession`, the `SessionObjectCursorRecord` type,
and a `diffText` field on `MonitorDeliveryProjection`. `insertEvent` takes an optional `baseline`
argument used to seed first-time cursors.

Backward compatible: a single lead session (or sessions co-registered at the same point) reproduces
the pre-G10 diff byte-for-byte; old DBs migrate additively (`CREATE TABLE IF NOT EXISTS` + a unique
index + `addColumnIfMissing(session_event_state, diff_text)`); a legacy `NULL`
`session_event_state.diff_text` falls back to the shared `monitor_events.diff_text`. The `net`
baseline strategy (G13) and the Interpret stage (G14) are behaviorally unchanged — they keep
operating over the shared baseline on top of this substrate (G10 PR-B rewires them per recipient).
