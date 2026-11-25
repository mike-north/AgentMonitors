## 2026-06-16 — Per-recipient baseline seam + per-recipient Diff shipped (roadmap G10 PR-A; 002 §1.1.2, §5.2, §6) — Refs #182

Implements roadmap **G10 PR-A**, moving the per-recipient Diff substrate of
[002 §1.1.2](../002-runtime-delivery.md#112-the-shared--per-recipient-seam) from _target_ to
_current_. PR-B (rewiring the `net` collapse, §1.1.7, and Interpret, §1.1.8, to span per recipient)
remains open under G10.

- **002 §1.1.2 — per-recipient Diff (current substrate).** The runtime materializes **one** shared
  `monitor_events` row carrying the shaped artifact (the shared object-level diff is retained on
  `monitor_events.diff_text` for `events list`/history), then computes a **per-recipient** delta for
  each projected lead session — the artifact diffed against **that session's own baseline cursor** —
  recorded on the new `session_event_state.diff_text`. Two sessions at divergent stored baselines
  each receive the correct span from one shared observation (capability C15). The per-recipient diff
  is computed inside `insertEvent`'s projection loop, so all durable writes complete **before** any
  Interpret await (the `ingest()` ordering invariant is preserved).

- **New durable table `session_object_cursor`.** One row per
  `(session_id, monitor_id, object_key, workspace_path)`, unique on those keys
  (`COALESCE(workspace_path, '')` collapses the global/`NULL` case). `baseline_content` is
  **denormalized** (the full artifact text) so a recipient's baseline is prune-immune. Cursor
  semantics (product decisions): a recipient's **first** projection of an object seeds its cursor to
  the **pre-event** state, so a session that registered late hears only changes **after** it
  registered (not a full-current-state first delta); the cursor **advances at claim** (`markClaimed`
  moves it to the artifact the recipient was just shown) — materialization only **seeds**, never
  advances; cursors **persist across dormancy and restart** (002 §3, BP1).

- **Backward compatibility.** A single lead session (or sessions co-registered at the same point)
  reproduces the pre-G10 shared diff **byte-for-byte** (the degenerate single-baseline case). Old
  DBs migrate additively (`CREATE TABLE IF NOT EXISTS session_object_cursor` + a unique index +
  `addColumnIfMissing(session_event_state, diff_text)`); a legacy `NULL`
  `session_event_state.diff_text` falls back to the shared `monitor_events.diff_text`. G13 (`net`)
  and G14 (Interpret) are **behaviorally unchanged** — they keep operating over the shared baseline
  on top of this substrate (PR-B rewires them per recipient).

- **Proof.** `libs/core/src/runtime/per-recipient-diff.test.ts`: divergent-baseline fan-out (THE
  proof — A spans artifact2→artifact3, B spans artifact1→artifact3 from one shared obs3), cursor
  restart-safety, session isolation, single-session backward-compat + legacy-`NULL` fallback, and
  the late-joiner new-session seed. The full G11–G15 core suite stays green unchanged.

